// Pencarian & pemahaman market Up/Down 5 menit dari /api/v1/feed.
// Format persis market 5 menit tidak dijelaskan rinci di dokumentasi, jadi
// parsing di sini sengaja toleran: memeriksa beberapa nama field sekaligus.
// Gunakan `npm run discover` untuk melihat market apa saja yang cocok/ditolak.

const ASSET_PATTERNS = {
  BTC: /\b(btc|bitcoin)\b/i,
  ETH: /\b(eth|ethereum|ether)\b/i,
  SOL: /\b(sol|solana)\b/i,
  CC: /\b(cc|canton(\s*coin)?)\b/i,
};

const UPDOWN_TEXT = /\b(up|down|higher|lower|above|below|naik|turun)\b/i;
const UP_LABEL = /\b(up|higher|above|rise|naik|long)\b/i;
const DOWN_LABEL = /\b(down|lower|below|fall|turun|short)\b/i;
const YES_LABEL = /^\s*(yes|ya)\s*$/i;
const NO_LABEL = /^\s*(no|tidak)\s*$/i;
const FIVE_MIN_TEXT = /\b5\s*-?\s*(m|min|mins|minute|minutes|menit)\b/i;

const START_FIELDS = ['startTime', 'openTime', 'windowStart', 'openStartsAt', 'tradingStartTime', 'startsAt'];
const END_FIELDS = ['endTime', 'closeTime', 'windowEnd', 'resolvesAt', 'endsAt', 'resolutionTime'];
const STRIKE_FIELDS = [
  'strikePrice',
  'strike',
  'referencePrice',
  'openPrice',
  'startPrice',
  'priceToBeat',
  'targetPrice',
  'threshold',
  'baselinePrice',
  'initialPrice',
];

export function assetPattern(asset) {
  return ASSET_PATTERNS[asset] ?? new RegExp(`\\b${asset.replace(/[^A-Za-z0-9]/g, '')}\\b`, 'i');
}

/** Ubah item feed (market tunggal + binary_group) menjadi daftar market datar. */
export function flattenFeed(items = []) {
  const out = [];
  for (const item of items) {
    if (item?.type === 'market' && item.market) {
      out.push({ ...item.market });
    } else if (item?.type === 'binary_group' && item.group) {
      for (const m of item.group.markets ?? []) {
        out.push({ ...m, _groupTitle: item.group.title, _groupSlug: item.group.slug });
      }
    } else if (item?.id && item?.question) {
      out.push({ ...item });
    }
  }
  return out;
}

export function marketText(m) {
  return [m.question, m.title, m.slug, m.groupLabel, m._groupTitle, m._groupSlug].filter(Boolean).join(' | ');
}

function parseTime(v) {
  if (v === undefined || v === null || v === '') return null;
  const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function firstField(obj, fields, parse) {
  for (const f of fields) {
    for (const src of [obj, obj?.metadata, obj?.config, obj?.params]) {
      if (src && src[f] !== undefined && src[f] !== null) {
        const v = parse(src[f]);
        if (v !== null) return { field: f, value: v };
      }
    }
  }
  return null;
}

/** Waktu buka dan tutup window market (ms). */
export function windowTimes(m, durationSec) {
  const end = firstField(m, END_FIELDS, parseTime);
  const start = firstField(m, START_FIELDS, parseTime);
  const endMs = end?.value ?? null;
  let startMs = start?.value ?? null;
  let startSource = start?.field ?? null;
  if (startMs === null && endMs !== null) {
    startMs = endMs - durationSec * 1000;
    startSource = 'end-duration';
  }
  return { startMs, endMs, startSource };
}

function parsePriceValue(v) {
  if (typeof v === 'number') return v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/([0-9]*\.?[0-9]+)\s*([kKmM])?/);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
  return n > 0 ? n : null;
}

/** Harga acuan (strike) bila tersedia di data market atau tertulis di pertanyaan ("... above $84,250"). */
export function extractStrike(m) {
  const f = firstField(m, STRIKE_FIELDS, parsePriceValue);
  if (f) return { value: f.value, source: `field:${f.field}` };
  const q = m.question ?? m.title ?? '';
  const match = q.match(/\$\s?([0-9][0-9,]*(?:\.[0-9]+)?\s*[kKmM]?)/);
  if (match) {
    const v = parsePriceValue(match[1]);
    if (v) return { value: v, source: 'question' };
  }
  return null;
}

/**
 * Tentukan outcome mana yang berarti "naik" dan mana "turun".
 * @returns {{up:{index:number,label:string,engineId?:string}, down:{...}} | null}
 */
export function outcomeSides(m) {
  const outcomes = (m.outcomes ?? []).map((o, i) => ({
    index: o.index ?? i,
    label: String(o.label ?? o.name ?? ''),
    engineId: o.engineId ?? o.engine_id,
  }));
  if (outcomes.length !== 2) return null;

  const up = outcomes.find((o) => UP_LABEL.test(o.label) && !DOWN_LABEL.test(o.label));
  const down = outcomes.find((o) => DOWN_LABEL.test(o.label) && !UP_LABEL.test(o.label));
  if (up && down && up !== down) return { up, down };

  const yes = outcomes.find((o) => YES_LABEL.test(o.label));
  const no = outcomes.find((o) => NO_LABEL.test(o.label));
  if (yes && no) {
    const q = m.question ?? m.title ?? '';
    const asksUp = /\b(up|higher|above|rise|naik)\b/i.test(q);
    const asksDown = /\b(down|lower|below|fall|turun)\b/i.test(q);
    if (asksUp && !asksDown) return { up: yes, down: no };
    if (asksDown && !asksUp) return { up: no, down: yes };
  }
  return null;
}

/**
 * Periksa apakah market adalah market Up/Down 5 menit untuk salah satu aset.
 * @returns {{ok:boolean, reason:string, asset?:string, sides?:object, window?:object}}
 */
export function classifyMarket(m, { assets, durationSec = 300, marketRegex = '' }) {
  const text = marketText(m);
  const matched = assets.filter((a) => assetPattern(a).test(text));
  if (matched.length === 0) return { ok: false, reason: 'aset tidak dikenali' };
  if (matched.length > 1) return { ok: false, reason: `aset ambigu (${matched.join(',')})` };
  const asset = matched[0];

  if (m.status && m.status !== 'ACTIVE') return { ok: false, asset, reason: `status ${m.status}` };

  if (marketRegex) {
    if (!new RegExp(marketRegex, 'i').test(text)) return { ok: false, asset, reason: 'tidak cocok MARKET_REGEX' };
  } else if (!UPDOWN_TEXT.test(text) && !outcomeSides(m)) {
    return { ok: false, asset, reason: 'bukan market up/down' };
  }

  const win = windowTimes(m, durationSec);
  if (win.endMs === null) return { ok: false, asset, reason: 'endTime tidak ada' };

  if (!marketRegex) {
    const tol = 60_000;
    let durationOk = false;
    if (win.startSource && win.startSource !== 'end-duration') {
      durationOk = Math.abs(win.endMs - win.startMs - durationSec * 1000) <= tol;
    } else if (FIVE_MIN_TEXT.test(text)) {
      durationOk = true;
    } else {
      const created = parseTime(m.createdAt);
      if (created !== null) durationOk = Math.abs(win.endMs - created - durationSec * 1000) <= 90_000;
    }
    if (!durationOk) return { ok: false, asset, reason: 'durasi bukan 5 menit / tidak diketahui' };
  }

  const sides = outcomeSides(m);
  if (!sides) {
    const labels = (m.outcomes ?? []).map((o) => o.label).join('/');
    return { ok: false, asset, reason: `outcome tidak bisa dipetakan ke Up/Down (${labels || 'tanpa outcomes'})` };
  }

  return { ok: true, reason: 'ok', asset, sides, window: win };
}

/**
 * Ambil semua market aktif yang relevan dari feed.
 * @param {import('./api.js').UnhedgedApi} api
 */
export async function discoverMarkets(api, cfg, { includeRejected = false } = {}) {
  const seen = new Map();
  const queries = cfg.assets.map((a) => ({ search: a.length >= 2 ? a : undefined }));
  // Satu query umum tanpa search sebagai cadangan (bila search tidak mencocokkan simbol).
  queries.push({});

  for (const q of queries) {
    for (let offset = 0; offset < 300; offset += 100) {
      const res = await api.feed({
        status: 'ACTIVE',
        sort: 'ending_soonest',
        limit: 100,
        offset,
        category: cfg.feedCategory || undefined,
        ...q,
      });
      const items = res?.items ?? [];
      for (const m of flattenFeed(items)) if (m.id && !seen.has(m.id)) seen.set(m.id, m);
      if (items.length < 100) break;
    }
  }

  const accepted = [];
  const rejected = [];
  for (const m of seen.values()) {
    const c = classifyMarket(m, { assets: cfg.assets, durationSec: cfg.marketDurationSec, marketRegex: cfg.marketRegex });
    if (c.ok) accepted.push({ market: m, ...c });
    else if (includeRejected && c.asset) rejected.push({ market: m, ...c });
  }
  accepted.sort((a, b) => a.window.endMs - b.window.endMs);
  return { accepted, rejected, total: seen.size };
}

export function marketType(m) {
  return String(m.marketType ?? 'ORDER_BOOK').toUpperCase();
}
