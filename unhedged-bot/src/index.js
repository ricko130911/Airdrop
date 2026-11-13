#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { UnhedgedApi } from './api.js';
import { PriceFeed } from './prices.js';
import { Bot } from './bot.js';
import { startDashboard } from './dashboard/server.js';
import { discoverMarkets, extractStrike, marketText, marketType, resolverInfo, bookTop, marketTakerFee, priceSourceOf } from './markets.js';

const HELP = `Bot Unhedged Up/Down 5 menit

Perintah:
  node src/index.js run        Jalankan bot (default DRY_RUN=true / simulasi)
  node src/index.js discover   Tampilkan market yang cocok & yang ditolak (beserta alasannya)
                               Tambah --raw [ASET] untuk melihat JSON mentah market (mis. --raw CC)
  node src/index.js check      Cek koneksi ke sumber harga resmi (Binance, Bybit) dari server ini
  node src/index.js status     Tampilkan saldo, equity, order terbuka, dan posisi (butuh API key)

Konfigurasi lewat file .env (salin dari .env.example).`;

async function main() {
  const cmd = process.argv[2] ?? 'run';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  const cfg = loadConfig();
  const log = createLogger({ level: cfg.logLevel, dir: cfg.logDir });
  const api = new UnhedgedApi({ baseUrl: cfg.apiBaseUrl, apiKey: cfg.apiKey, logger: log });

  if (cmd === 'discover') return discover(api, cfg);
  if (cmd === 'check') return check(api, cfg, log);
  if (cmd === 'status') return status(api);
  if (cmd !== 'run') {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  if (!cfg.dryRun && !cfg.apiKey) throw new Error('DRY_RUN=false membutuhkan UNHEDGED_API_KEY di .env');
  const prices = new PriceFeed({ api, logger: log });
  const bot = new Bot({ cfg, api, prices, log });

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info(`${sig} diterima, berhenti...`);
    await bot.stop().catch((e) => log.error(e.message));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (cfg.dashboardEnabled) startDashboard({ bot, cfg, log });
  await bot.start();
}

async function discover(api, cfg) {
  const { accepted, rejected, total } = await discoverMarkets(api, cfg, { includeRejected: true });
  console.log(`\nTotal market aktif yang diperiksa: ${total}`);
  console.log(`\n=== COCOK (${accepted.length}) ===`);
  for (const a of accepted) {
    const m = a.market;
    const left = Math.round((a.window.endMs - Date.now()) / 1000);
    const strike = extractStrike(m);
    const r = resolverInfo(m);
    const b = bookTop(m, a.sides);
    const f = (x) => (x === null || x === undefined ? '-' : x.toFixed(2));
    console.log(
      `- [${a.asset}] ${m.question ?? m.title} | tipe=${marketType(m)} | tutup dalam ${left}s | id=${m.id}\n` +
        `    sumber resolusi: ${r.venue ?? '?'} ${r.symbol ?? '?'} (${r.method ?? '?'}) | fee taker ${(marketTakerFee(m) * 100).toFixed(1)}%\n` +
        `    acuan: ${strike ? `${strike.value} (${strike.source})` : 'belum ada (window belum dimulai)'}\n` +
        `    order book: UP bid ${f(b.up.bestBid)} / ask ${f(b.up.bestAsk)} · DOWN bid ${f(b.down.bestBid)} / ask ${f(b.down.bestAsk)}`,
    );
  }
  console.log(`\n=== DITOLAK, aset cocok (${rejected.length}) ===`);
  for (const r of rejected.slice(0, 40)) {
    console.log(`- [${r.asset}] ${marketText(r.market).slice(0, 120)} -> ${r.reason}`);
  }
  const rawIdx = process.argv.indexOf('--raw');
  if (rawIdx >= 0) {
    // Opsional: --raw CC  -> tampilkan JSON market aset tertentu
    const want = (process.argv[rawIdx + 1] ?? '').toUpperCase();
    const sample = (want && accepted.find((a) => a.asset === want)?.market) ?? accepted[0]?.market ?? rejected[0]?.market;
    console.log('\n=== JSON mentah (contoh) ===');
    console.log(JSON.stringify(sample ?? null, null, 2));
  }
  if (!accepted.length) {
    console.log(
      '\nTidak ada market yang cocok. Jalankan dengan --raw untuk melihat format market, lalu atur MARKET_REGEX / FEED_CATEGORY di .env.',
    );
  }
}

/** Cek apakah sumber harga resmi tiap aset bisa diakses dari server ini. */
async function check(api, cfg, log) {
  const prices = new PriceFeed({ api, logger: log });
  const { accepted } = await discoverMarkets(api, cfg);
  for (const a of accepted) prices.setAssetSource(a.asset, priceSourceOf(a.market, a.asset));
  console.log('\nCek sumber harga (harus sama dengan sumber resolusi Unhedged):');
  let ok = true;
  for (const asset of cfg.assets) {
    const src = prices.sourceFor(asset);
    const label = src ? `${src.venue} ${src.symbol}` : 'tidak diketahui';
    const data = await prices.series(asset).catch(() => null);
    const now = Math.floor(Date.now() / 1000) * 1000;
    const closes = await prices.secondCloses(asset, now - 30_000, now).catch(() => ({ count: 0, source: 'error' }));
    const good = !!data && data.source === src?.venue && closes.count >= 20;
    if (!good) ok = false;
    console.log(
      `- ${asset.padEnd(4)} ${good ? 'OK   ' : 'GAGAL'} sumber=${label} | harga=${data ? data.spot : '-'} (dari ${data?.source ?? '-'})` +
        ` | penutupan per detik 30s terakhir: ${closes.count}/30 (${closes.source})`,
    );
  }
  console.log(ok ? '\nSemua sumber harga OK.' : '\nAda sumber yang gagal. Kemungkinan diblokir dari lokasi VPS ini; bot akan memakai cadangan yang kurang presisi.');
}

async function status(api) {
  const [bal, eq, open, pos] = await Promise.all([
    api.balance(),
    api.equity().catch(() => null),
    api.openOrders(),
    api.positions({ limit: 100 }),
  ]);
  const b = bal?.balance ?? {};
  console.log(`Saldo: available=$${b.available} lockedEngine=$${b.lockedEngine} lockedBets=$${b.lockedBets} total=$${b.total}`);
  if (eq?.equity) console.log(`Equity: total=$${eq.equity.total} PnL hari ini=$${eq.equity.dayPnl} 7 hari=$${eq.equity.sevenDayPnl}`);
  console.log(`\nOrder terbuka (${open.length}):`);
  for (const o of open) console.log(`- #${o.id} ${o.side} ${o.outcome} ${o.quantity}@${o.price} terisi=${o.cum_quantity} market=${o.market_id}`);
  console.log(`\nPosisi aktif (${pos?.positions?.length ?? 0}):`);
  for (const p of pos?.positions ?? []) {
    console.log(`- ${p.market?.question ?? p.marketId} | ${p.outcomeName} | modal $${p.totalBetAmount} | nilai $${p.currentValue} | PnL $${p.unrealizedPnl}`);
  }
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
