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

export function loadConfig() {
  loadDotEnv();
  const cfg = {
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
    repriceThreshold: num('REPRICE_THRESHOLD', 0.02),

    marketDurationSec: num('MARKET_DURATION_SEC', 300),
    marketRegex: str('MARKET_REGEX'),
    feedCategory: str('FEED_CATEGORY'),

    pollMs: num('POLL_MS', 4000),
    discoveryMs: num('DISCOVERY_MS', 30000),
    logLevel: str('LOG_LEVEL', 'info'),
    logDir: str('LOG_DIR', 'logs'),
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
  if (errs.length) throw new Error('Konfigurasi tidak valid:\n - ' + errs.join('\n - '));
}
