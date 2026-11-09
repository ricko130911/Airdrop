#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { UnhedgedApi } from './api.js';
import { PriceFeed } from './prices.js';
import { Bot } from './bot.js';
import { discoverMarkets, extractStrike, marketText, marketType } from './markets.js';

const HELP = `Bot Unhedged Up/Down 5 menit

Perintah:
  node src/index.js run        Jalankan bot (default DRY_RUN=true / simulasi)
  node src/index.js discover   Tampilkan market yang cocok & yang ditolak (beserta alasannya)
                               Tambah --raw untuk melihat JSON mentah market pertama
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
    console.log(
      `- [${a.asset}] ${m.question ?? m.title} | tipe=${marketType(m)} | tutup dalam ${left}s` +
        ` | UP="${a.sides.up.label}" DOWN="${a.sides.down.label}"` +
        ` | strike=${strike ? `${strike.value} (${strike.source})` : 'diambil dari harga saat open'}` +
        ` | start dari ${a.window.startSource} | id=${m.id}`,
    );
  }
  console.log(`\n=== DITOLAK, aset cocok (${rejected.length}) ===`);
  for (const r of rejected.slice(0, 40)) {
    console.log(`- [${r.asset}] ${marketText(r.market).slice(0, 120)} -> ${r.reason}`);
  }
  if (process.argv.includes('--raw')) {
    const sample = accepted[0]?.market ?? rejected[0]?.market;
    console.log('\n=== JSON mentah (contoh) ===');
    console.log(JSON.stringify(sample ?? null, null, 2));
  }
  if (!accepted.length) {
    console.log(
      '\nTidak ada market yang cocok. Jalankan dengan --raw untuk melihat format market, lalu atur MARKET_REGEX / FEED_CATEGORY di .env.',
    );
  }
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
