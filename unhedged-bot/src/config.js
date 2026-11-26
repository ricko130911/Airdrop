import fs from 'node:fs';
import path from 'node:path';

/** Muat file .env sederhana (tanpa dependensi). Variabel yang sudah ada di environment tidak ditimpa. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function num(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Config ${name} harus berupa angka, didapat "${raw}"`);
  return v;
}

function bool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return /^(1|true|yes|ya|on)$/i.test(raw);
}

function str(name, def = '') {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? def : raw;
}

/**
 * File .env yang dipakai. Default `.env`; untuk akun lain jalankan dengan ENV_FILE=.env.akun2
 * (ecosystem.config.cjs melakukannya otomatis untuk setiap file .env.<nama>).
 */
export function envFilePath() {
  const f = process.env.ENV_FILE;
  return f ? path.resolve(process.cwd(), f) : path.resolve(process.cwd(), '.env');
}

/** Nama akun dari nama file: .env -> '' (akun utama), .env.akun2 -> 'akun2'. */
export function accountFromEnvFile(file) {
  const base = path.basename(file);
  return base.startsWith('.env.') ? base.slice(5) : '';
}

export function loadConfig() {
  const envFile = envFilePath();
  if (process.env.ENV_FILE && !fs.existsSync(envFile)) throw new Error(`ENV_FILE ${envFile} tidak ditemukan`);
  loadDotEnv(envFile);
  const fileAccount = accountFromEnvFile(envFile);
  const cfg = {
    envFile,
    // Nama akun (tampil di dashboard & Telegram). Kosong = akun utama
    accountName: str('ACCOUNT_NAME', fileAccount),
    apiKey: str('UNHEDGED_API_KEY'),
    apiBaseUrl: str('API_BASE_URL', 'https://api.unhedged.gg').replace(/\/+$/, ''),
    dryRun: bool('DRY_RUN', true),
    assets: str('ASSETS', 'BTC,ETH,SOL,CC')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),

    maxOrderUsd: num('MAX_ORDER_USD', 5),
    kellyFraction: num('KELLY_FRACTION', 0.25),
    bankrollUsd: num('BANKROLL_USD', null),
    maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 25),
    maxOpenExposureUsd: num('MAX_OPEN_EXPOSURE_USD', 20),

    minEdge: num('MIN_EDGE', 0.05),
    maxPrice: num('MAX_PRICE', 0.92),
    minPrice: num('MIN_PRICE', 0.05),
    tradeWhenSecondsLeft: num('TRADE_WHEN_SECONDS_LEFT', 180),
    stopSecondsLeft: num('STOP_SECONDS_LEFT', 15),
    sigmaMultiplier: num('SIGMA_MULTIPLIER', 1.3),
    momentumWeight: num('MOMENTUM_WEIGHT', 0.2),
    repriceThreshold: num('REPRICE_THRESHOLD', 0.03),
    hysteresis: num('HYSTERESIS', 0.05),
    // Fee per kontrak (fraksi harga). Kosong = pakai tarif taker tier 0 dari data market (5%)
    feeRate: num('FEE_RATE', null),
    feeModel: str('FEE_MODEL', 'official'),

    // Strategi: 'sniper' (tembak di akhir round, default) atau 'model' (strategi lama)
    strategy: str('STRATEGY', 'sniper').toLowerCase(),
    snipeMaxSec: num('SNIPE_MAX_SEC', 45),
    snipeMinSec: num('SNIPE_MIN_SEC', 4),
    snipeMinProb: num('SNIPE_MIN_PROB', 0.97),
    snipeMaxPrice: num('SNIPE_MAX_PRICE', 0.97),
    // Ask di bawah ini saat bot >=97% yakin dianggap data basi/anomali dan tidak diambil
    snipeMinPrice: num('SNIPE_MIN_PRICE', 0.8),
    // Ask di bawah SNIPE_CHEAP_PRICE (pasar kurang yakin) hanya ditembak bila bot yakin >= SNIPE_CHEAP_MIN_PROB.
    // SNIPE_CHEAP_PRICE=0 mematikan pengaman ini.
    snipeCheapPrice: num('SNIPE_CHEAP_PRICE', 0.93),
    snipeCheapMinProb: num('SNIPE_CHEAP_MIN_PROB', 0.995),
    // Lama jeda menembak setelah Unhedged menolak order karena maintenance (ms)
    maintenancePauseMs: num('MAINTENANCE_PAUSE_MS', 5 * 60_000),
    snipeMinEv: num('SNIPE_MIN_EV', 0.015),
    snipeUsd: num('SNIPE_USD', 3),
    // Ukuran dinamis: naik bila yakin, tapi hanya setelah sniper terbukti
    snipeMaxUsd: num('SNIPE_MAX_USD', 10),
    snipeKellyFraction: num('SNIPE_KELLY_FRACTION', 0.05),
    snipeTrustTrades: num('SNIPE_TRUST_TRADES', 30),
    // Taruhan lebih besar saat hasil round "terkunci" (jarak aman >= SNIPE_LOCK_Z standar deviasi)
    snipeLockZ: num('SNIPE_LOCK_Z', 5),
    snipeLockedUsd: num('SNIPE_LOCKED_USD', 6),
    // Taruhan besar hanya bila jarak aman bertahan & tidak menyusut selama N detik terakhir (0 = mati)
    snipeLockConfirmSec: num('SNIPE_LOCK_CONFIRM_SEC', 3),
    // Pengaman: JANGAN menembak (berapa pun taruhannya) bila jarak aman menyusut lebih dari
    // (1 - SNIPE_SHRINK_TOL) dalam SNIPE_SHRINK_SEC detik terakhir = harga bergerak mendekati batas.
    snipeBlockShrink: bool('SNIPE_BLOCK_SHRINK', true),
    // Maksimal percobaan order per market (order yang tidak terisi dibatalkan lalu dicoba lagi)
    snipeMaxAttempts: num('SNIPE_MAX_ATTEMPTS', 3),
    snipeShrinkSec: num('SNIPE_SHRINK_SEC', 3),
    snipeShrinkTol: num('SNIPE_SHRINK_TOL', 0.9),
    // Pengaman hanya berlaku bila jarak aman sekarang < nilai ini (di atasnya hasil praktis pasti)
    snipeShrinkMaxZ: num('SNIPE_SHRINK_MAX_Z', 5),
    snipePollMs: num('SNIPE_POLL_MS', 1000),
    snipeMaxLossesPerDay: num('SNIPE_MAX_LOSSES_PER_DAY', 2),
    dailyProfitTargetUsd: num('DAILY_PROFIT_TARGET_USD', 0),
    // Selalu aktif: bila sniper tidak menembak, kirim order percobaan 1 kontrak di detik akhir.
    // Default hanya aktif di mode simulasi (DRY_RUN) karena tujuannya mengumpulkan data.
    snipeProbeEveryRound: bool('SNIPE_PROBE_EVERY_ROUND', bool('DRY_RUN', true)),
    snipeProbeAtSec: num('SNIPE_PROBE_AT_SEC', 12),
    snipeProbeMinProb: num('SNIPE_PROBE_MIN_PROB', 0.9),
    snipeProbeMaxPrice: num('SNIPE_PROBE_MAX_PRICE', 0.99),

    // Pembelajaran dari hasil sendiri
    adaptive: bool('ADAPTIVE', true),
    adaptiveMinTrades: num('ADAPTIVE_MIN_TRADES', 25),
    calibrationMinSamples: num('CALIBRATION_MIN_SAMPLES', 40),
    probeTrades: bool('PROBE_TRADES', true),

    marketDurationSec: num('MARKET_DURATION_SEC', 300),
    // Durasi market yang diikuti (detik): 300 = 5 menit, 900 = 15 menit, 3600 = 1 jam
    marketDurations: str('MARKET_DURATIONS', '300,900,3600')
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x) && x > 0),
    marketRegex: str('MARKET_REGEX'),
    feedCategory: str('FEED_CATEGORY'),

    pollMs: num('POLL_MS', 4000),
    discoveryMs: num('DISCOVERY_MS', 30000),
    logLevel: str('LOG_LEVEL', 'info'),
    // Tiap akun WAJIB punya folder log sendiri (riwayat, rem harian, statistik terpisah)
    logDir: str('LOG_DIR', fileAccount ? `logs-${fileAccount}` : 'logs'),
    // Batas request publik Unhedged per detik untuk proses ini. Batas resmi 600/menit PER IP,
    // jadi bila beberapa akun berjalan di VPS yang sama, jatahnya dibagi (ecosystem mengaturnya).
    publicRps: num('PUBLIC_RPS', 8),

    // Notifikasi Telegram (token dari @BotFather, chat id dari `node src/index.js telegram`)
    telegramBotToken: str('TELEGRAM_BOT_TOKEN'),
    telegramChatId: str('TELEGRAM_CHAT_ID'),
    telegramNotifyDry: bool('TELEGRAM_NOTIFY_DRY', false),

    // Pengukur ping VPS -> server Unhedged (ms), tampil di bagian atas dashboard
    latencyIntervalMs: num('LATENCY_INTERVAL_MS', 15_000),

    dashboardEnabled: bool('DASHBOARD_ENABLED', true),
    dashboardHost: str('DASHBOARD_HOST', '0.0.0.0'),
    dashboardPort: num('DASHBOARD_PORT', 3005),
    dashboardUser: str('DASHBOARD_USER', 'admin'),
    dashboardPassword: str('DASHBOARD_PASSWORD'),
    // true = halaman utama bisa dilihat tanpa login (mis. Smart TV); tombol kontrol tetap di /admin
    dashboardPublicView: bool('DASHBOARD_PUBLIC_VIEW', true),
  };
  validate(cfg);
  return cfg;
}

function validate(cfg) {
  const errs = [];
  if (!cfg.assets.length) errs.push('ASSETS kosong');
  if (cfg.minEdge < 0 || cfg.minEdge >= 0.5) errs.push('MIN_EDGE harus di antara 0 dan 0.5');
  if (!(cfg.minPrice > 0 && cfg.maxPrice < 1 && cfg.minPrice < cfg.maxPrice))
    errs.push('MIN_PRICE/MAX_PRICE harus 0 < MIN_PRICE < MAX_PRICE < 1');
  if (cfg.kellyFraction <= 0 || cfg.kellyFraction > 1) errs.push('KELLY_FRACTION harus di (0, 1]');
  if (cfg.stopSecondsLeft >= cfg.tradeWhenSecondsLeft)
    errs.push('STOP_SECONDS_LEFT harus lebih kecil dari TRADE_WHEN_SECONDS_LEFT');
  if (cfg.sigmaMultiplier < 1) errs.push('SIGMA_MULTIPLIER sebaiknya >= 1');
  if (cfg.maxOrderUsd <= 0) errs.push('MAX_ORDER_USD harus > 0');
  if (!['sniper', 'model'].includes(cfg.strategy)) errs.push("STRATEGY harus 'sniper' atau 'model'");
  if (!['flat', 'risk', 'official'].includes(cfg.feeModel)) errs.push("FEE_MODEL harus 'official', 'flat', atau 'risk'");
  if (!(cfg.snipeMinSec >= 1 && cfg.snipeMinSec < cfg.snipeMaxSec)) errs.push('SNIPE_MIN_SEC harus >= 1 dan < SNIPE_MAX_SEC');
  if (!(cfg.snipeMinProb > 0.5 && cfg.snipeMinProb < 1)) errs.push('SNIPE_MIN_PROB harus di antara 0.5 dan 1');
  if (!(cfg.snipeMaxPrice > 0 && cfg.snipeMaxPrice < 1)) errs.push('SNIPE_MAX_PRICE harus di antara 0 dan 1');
  if (cfg.snipeUsd <= 0) errs.push('SNIPE_USD harus > 0');
  if (!(cfg.snipeCheapPrice >= 0 && cfg.snipeCheapPrice < 1)) errs.push('SNIPE_CHEAP_PRICE harus di antara 0 dan 1 (0 = mati)');
  if (!(cfg.snipeCheapMinProb > 0.5 && cfg.snipeCheapMinProb <= 1)) errs.push('SNIPE_CHEAP_MIN_PROB harus di antara 0.5 dan 1');
  if (cfg.snipeMaxUsd < cfg.snipeUsd) errs.push('SNIPE_MAX_USD harus >= SNIPE_USD');
  if (!(cfg.publicRps >= 1 && cfg.publicRps <= 10)) errs.push('PUBLIC_RPS harus di antara 1 dan 10');
  if (!(cfg.snipeMaxAttempts >= 1)) errs.push('SNIPE_MAX_ATTEMPTS harus >= 1');
  if (!(cfg.snipeShrinkSec >= 1 && cfg.snipeShrinkSec <= 20)) errs.push('SNIPE_SHRINK_SEC harus di antara 1 dan 20');
  if (!(cfg.snipeShrinkTol > 0 && cfg.snipeShrinkTol <= 1)) errs.push('SNIPE_SHRINK_TOL harus di (0, 1]');
  if (cfg.snipeLockConfirmSec < 0 || cfg.snipeLockConfirmSec > 20) errs.push('SNIPE_LOCK_CONFIRM_SEC harus di antara 0 dan 20');
  if (!(cfg.snipeKellyFraction > 0 && cfg.snipeKellyFraction <= 0.5)) errs.push('SNIPE_KELLY_FRACTION harus di (0, 0.5]');
  if (errs.length) throw new Error('Konfigurasi tidak valid:\n - ' + errs.join('\n - '));
}
