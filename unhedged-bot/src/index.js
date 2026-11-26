#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { UnhedgedApi } from './api.js';
import { PriceFeed } from './prices.js';
import { Telegram, escapeHtml } from './notify.js';
import { LatencyMonitor } from './latency.js';
import { Bot } from './bot.js';
import { startDashboard } from './dashboard/server.js';
import { Learner, loadRecords, groupSummary, timeBucket, TIME_BUCKETS, priceBucket, PRICE_BUCKETS } from './analytics.js';
import { SNIPE_REASON_LABEL } from './strategy.js';
import path from 'node:path';
import { discoverMarkets, extractStrike, marketText, marketType, resolverInfo, bookTop, marketTakerFee, priceSourceOf } from './markets.js';

const HELP = `Bot Unhedged Up/Down 5 menit

Perintah:
  node src/index.js run        Jalankan bot (default DRY_RUN=true / simulasi)
  node src/index.js discover   Tampilkan market yang cocok & yang ditolak (beserta alasannya)
                               Tambah --raw [ASET] untuk melihat JSON mentah market (mis. --raw CC)
  node src/index.js check      Cek koneksi ke sumber harga resmi (Binance, Bybit) dari server ini
  node src/index.js analyze    Analisis hasil: untung/rugi per zona waktu & aset, kalibrasi model
  node src/index.js telegram   Atur & uji notifikasi Telegram (isi TELEGRAM_CHAT_ID)
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
  const api = new UnhedgedApi({ baseUrl: cfg.apiBaseUrl, apiKey: cfg.apiKey, logger: log, publicRps: cfg.publicRps });
  if (cfg.accountName) log.info(`Akun: ${cfg.accountName} (${cfg.envFile}) · log di ${cfg.logDir}`);

  if (cmd === 'discover') return discover(api, cfg);
  if (cmd === 'check') return check(api, cfg, log);
  if (cmd === 'analyze') return analyze(cfg);
  if (cmd === 'telegram') return telegramSetup(cfg);
  if (cmd === 'status') return status(api);
  if (cmd !== 'run') {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  if (!cfg.dryRun && !cfg.apiKey) throw new Error('DRY_RUN=false membutuhkan UNHEDGED_API_KEY di .env');
  const prices = new PriceFeed({ api, logger: log });
  const notifier = new Telegram({ token: cfg.telegramBotToken, chatId: cfg.telegramChatId, log });
  if (notifier.enabled) log.info('Notifikasi Telegram aktif');
  else if (cfg.telegramBotToken) log.warn('TELEGRAM_CHAT_ID kosong: jalankan `node src/index.js telegram` untuk mengisinya');
  const latency = new LatencyMonitor({ url: cfg.apiBaseUrl, intervalMs: cfg.latencyIntervalMs, log });
  latency.start();
  const bot = new Bot({ cfg, api, prices, log, notifier, latency });

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info(`${sig} diterima, berhenti...`);
    await bot.stop().catch((e) => log.error(e.message));
    await notifier.flush().catch(() => {});
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
      `- [${a.asset} ${a.durationSec >= 3600 ? a.durationSec / 3600 + ' jam' : Math.round(a.durationSec / 60) + ' mnt'}] ${m.question ?? m.title} | tipe=${marketType(m)} | tutup dalam ${left}s | id=${m.id}\n` +
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

/** Bantu mengisi TELEGRAM_CHAT_ID dan kirim pesan uji. */
async function telegramSetup(cfg) {
  if (!cfg.telegramBotToken) {
    console.log('TELEGRAM_BOT_TOKEN belum diisi di .env. Buat bot di @BotFather lalu isi tokennya.');
    process.exitCode = 1;
    return;
  }
  const tg = new Telegram({ token: cfg.telegramBotToken, chatId: cfg.telegramChatId });
  try {
    const me = await tg.call('getMe');
    console.log(`Bot Telegram: @${me.username}`);
  } catch (e) {
    console.log(`Token tidak valid / tidak bisa menghubungi Telegram: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (!cfg.telegramChatId) {
    const updates = await tg.call('getUpdates', { limit: 50 }).catch(() => []);
    const chats = new Map();
    for (const u of updates) {
      const c = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
      if (c) chats.set(String(c.id), c.title ?? [c.first_name, c.last_name].filter(Boolean).join(' ') ?? c.username);
    }
    if (!chats.size) {
      console.log('Belum ada pesan ke bot. Buka bot Anda di Telegram, kirim /start, lalu jalankan perintah ini lagi.');
      return;
    }
    console.log('Chat yang ditemukan:');
    for (const [id, name] of chats) console.log(`  ${id}  (${name})`);
    const [first] = chats.keys();
    console.log(`\nTambahkan ke .env:\n  TELEGRAM_CHAT_ID=${first}\nLalu jalankan perintah ini lagi untuk mengirim pesan uji.`);
    return;
  }
  const acc = cfg.accountName ? `<b>[${escapeHtml(cfg.accountName)}]</b> ` : '';
  tg.send(`${acc}✅ <b>Uji notifikasi Unhedged bot berhasil.</b>\nAnda akan menerima kabar setiap tembakan dan hasil round.`);
  await tg.flush(15_000);
  console.log(tg.queue.length ? 'Pesan uji GAGAL terkirim (cek TELEGRAM_CHAT_ID).' : 'Pesan uji terkirim. Cek Telegram Anda.');
}

/** Analisis hasil bot dari logs/decisions.jsonl: di mana bot untung/rugi & seberapa tepat modelnya. */
function analyze(cfg) {
  const onlyLive = process.argv.includes('--live');
  const file = process.argv.slice(3).find((a) => !a.startsWith('--')) ?? path.join(cfg.logDir, 'decisions.jsonl');
  const L = new Learner({
    enabled: cfg.adaptive,
    minZoneTrades: cfg.adaptiveMinTrades,
    minCalibrationSamples: cfg.calibrationMinSamples,
  });
  const all = loadRecords(file);
  L.addRecords(onlyLive ? all.filter((x) => x.live === true) : all);
  const r = L.report();
  const pct = (x, d = 1) => (x === null || x === undefined ? '-' : (x * 100).toFixed(d) + '%');
  const usd = (x) => (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2);
  const row = (g, label) =>
    `${String(label ?? g.key).padEnd(9)} ${String(g.n).padStart(5)}  ${pct(g.winrate).padStart(7)}  ${pct(g.breakeven).padStart(7)}  ${usd(g.pnl).padStart(9)}  ${pct(g.roi).padStart(7)}${g.blocked ? '  DIBLOKIR' : ''}`;
  const head = `${'zona'.padEnd(9)} ${'trade'.padStart(5)}  ${'menang'.padStart(7)}  ${'impas'.padStart(7)}  ${'PnL'.padStart(9)}  ${'ROI'.padStart(7)}`;

  console.log(`\nFile: ${file}${onlyLive ? '  (HANYA trade uang asli / LIVE)' : '  (simulasi + live; tambahkan --live untuk uang asli saja)'}`);
  console.log(`Market selesai: ${r.markets} | trade: ${r.total.n} | PnL ${usd(r.total.pnl)} | ROI ${pct(r.total.roi)} | menang ${pct(r.total.winrate)} vs impas ${pct(r.total.breakeven)}`);
  if (!r.markets) {
    console.log('\nBelum ada data versi baru. Biarkan bot berjalan dulu.');
    return;
  }
  const sc = L.snipeScanSummary(cfg.snipeMinEv);
  if (sc.rounds) {
    const pc = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '-');
    const labels = SNIPE_REASON_LABEL;
    console.log('\n== Peluang sniper per round ==');
    console.log(`Round dipantau: ${sc.rounds} | sniper menembak: ${sc.fired} | probe: ${sc.probes}`);
    console.log(`Round dengan penjual di sisi pemenang saat bot yakin: ${sc.eligibleWithSeller} (${pc(sc.eligibleWithSeller, sc.rounds)})`);
    console.log(`Peluang sniper sungguhan (yakin + ada penjual + untung >= ${(cfg.snipeMinEv * 100).toFixed(1)}¢): ${sc.eligible} (${pc(sc.eligible, sc.rounds)})`);
    console.log(`Sisi pilihan model di momen terbaik benar: ${sc.bestSideRight}/${sc.bestSideKnown} (${pc(sc.bestSideRight, sc.bestSideKnown)})`);
    const reasons = Object.entries(sc.reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${labels[k] ?? k} ${n}x`);
    if (reasons.length) console.log(`Alasan tidak menembak (per detik): ${reasons.join(', ')}`);
  }
  console.log('\n== Menurut strategi ==');
  console.log(head);
  for (const g of r.byStrategy) console.log(row(g, g.key === 'sniper-probe' ? 'probe' : g.key));
  if (r.byDuration.length) {
    console.log('\n== Sniper menurut durasi market ==');
    console.log(head);
    for (const g of r.byDuration) console.log(row(g, g.key >= 3600 ? `${g.key / 3600} jam` : `${Math.round(g.key / 60)} mnt`));
  }
  // ---- Khusus sniper (tanpa campuran strategi lama)
  const sn = L.trades.filter((t) => t.strategy === 'sniper');
  if (sn.length) {
    console.log('\n== SNIPER menurut sisa waktu saat terisi ==');
    console.log(head);
    for (const g of groupSummary(sn, (t) => (t.secondsLeft === null ? null : timeBucket(t.secondsLeft)), TIME_BUCKETS.map((b) => b.key))) {
      if (g.n) console.log(row(g));
    }
    console.log('\n== SNIPER menurut aset ==');
    console.log(head);
    for (const g of groupSummary(sn, (t) => t.asset)) console.log(row(g));
    console.log('\n== SNIPER menurut harga terisi (murah = pasar kurang yakin dibanding bot) ==');
    console.log(head);
    for (const g of groupSummary(sn, (t) => priceBucket(t.price), PRICE_BUCKETS.map((b) => b.key))) {
      if (g.n) console.log(row(g));
    }
    console.log('\n== SNIPER: harga terisi dibanding ask yang dilihat bot ==');
    console.log(head);
    const vsAsk = (t) => (t.ask === null ? 'ask ?' : t.price < t.ask - 0.005 ? 'lbh murah' : 'sama ask');
    for (const g of groupSummary(sn, vsAsk, ['sama ask', 'lbh murah', 'ask ?'])) {
      if (g.n) console.log(row(g));
    }
    const losses = sn.filter((t) => !t.won);
    console.log(`\n== Kekalahan sniper (${losses.length}) ==`);
    for (const t of losses) {
      const dur = t.durationSec >= 3600 ? `${t.durationSec / 3600} jam` : `${Math.round((t.durationSec ?? 300) / 60)} mnt`;
      console.log(
        `- ${String(t.ts ?? '').slice(0, 16).replace('T', ' ')}  ${t.asset} ${dur}  ${t.side.toUpperCase()} ${Math.round(t.quantity)} @ ${t.price.toFixed(2)}` +
          `${t.ask !== null && Math.abs(t.ask - t.price) >= 0.005 ? ` (ask terlihat ${t.ask.toFixed(2)})` : ''}` +
          `  sisa ${t.secondsLeft ?? '?'} dtk  yakin ${t.prob !== null ? (t.prob * 100).toFixed(1) + '%' : '?'}` +
          `${t.probRaw !== null ? ` (mentah ${(t.probRaw * 100).toFixed(1)}%)` : ''}  ${usd(t.pnl)}`,
      );
    }
  }

  console.log('\n== Menurut sisa waktu saat order terisi (SEMUA strategi) ==');
  console.log(head);
  for (const g of r.byTime) console.log(row(g));
  console.log('\n== Menurut aset (SEMUA strategi) ==');
  console.log(head);
  for (const g of r.byAsset) console.log(row(g));
  console.log('\n== Menurut keyakinan model saat terisi (kalibrasi trade) ==');
  console.log(`${head}  ${'p rata2'.padStart(8)}`);
  for (const g of r.byProb) console.log(`${row(g)}  ${pct(g.avgProb).padStart(8)}`);
  console.log('\n== Kalibrasi peluang per titik waktu (semua market) ==');
  console.log(`${'titik'.padEnd(7)} ${'sampel'.padStart(6)}  ${'k'.padStart(5)}  ${'Brier mentah'.padStart(12)}  ${'Brier kalibrasi'.padStart(15)}  status`);
  for (const c of r.calibration) {
    const b = (x) => (x === null || x === undefined ? '-' : x.toFixed(4));
    console.log(
      `${(c.checkpoint + 's').padEnd(7)} ${String(c.n).padStart(6)}  ${c.k.toFixed(2).padStart(5)}  ${b(c.brierRaw).padStart(12)}  ${b(c.brierCal).padStart(15)}  ${c.active ? 'AKTIF' : `menunggu ${r.minCalibrationSamples} sampel`}`,
    );
  }
  console.log(
    '\nCara membaca: "menang" harus di atas "impas" agar untung. k < 1 = model terlalu yakin (dikoreksi), k > 1 = kurang yakin.' +
      `\nZona dengan >= ${r.minZoneTrades} trade dan ROI negatif otomatis DIBLOKIR (hanya order probe 1 kontrak).`,
  );
}

/** Cek apakah sumber harga resmi tiap aset bisa diakses dari server ini. */
async function check(api, cfg, log) {
  // Akun: pastikan API key di file .env ini milik akun yang dimaksud
  console.log(`\nAkun${cfg.accountName ? ` ${cfg.accountName}` : ''} (${cfg.envFile}) · mode ${cfg.dryRun ? 'SIMULASI (DRY_RUN=true)' : 'LIVE (uang asli)'}`);
  if (!cfg.apiKey) {
    console.log('- UNHEDGED_API_KEY kosong');
  } else {
    try {
      const me = await api.me();
      const bal = await api.balance().catch(() => null);
      const avail = Number(bal?.balance?.available);
      console.log(`- Login sebagai: ${me?.username ?? me?.id ?? '?'}${Number.isFinite(avail) ? ` · saldo tersedia $${avail.toFixed(2)}` : ''}`);
      console.log(`- API key: ${cfg.apiKey.slice(0, 6)}…${cfg.apiKey.slice(-4)}`);
    } catch (e) {
      console.log(`- API key TIDAK VALID: ${e.message}`);
    }
  }
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
