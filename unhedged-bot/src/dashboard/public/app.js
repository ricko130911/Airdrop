// Unhedged Desk: klien dashboard (tanpa framework).
const $ = (sel, root = document) => root.querySelector(sel);
const SVGNS = 'http://www.w3.org/2000/svg';

const COIN_GLYPH = { BTC: '₿', ETH: 'Ξ', SOL: '◎', CC: 'C' };
let state = null;
let serverOffset = 0; // waktu server - waktu lokal

// ---------------------------------------------------------------- format
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
function money(x, { sign = false } = {}) {
  if (!isNum(x)) return '—';
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (x < 0 ? '−$' : sign && x > 0 ? '+$' : '$') + s;
}
function price(x) {
  if (!isNum(x)) return '—';
  const d = x >= 1000 ? 2 : x >= 1 ? 3 : 5;
  return '$' + x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const pct = (x, d = 1) => (isNum(x) ? (x * 100).toFixed(d) + '%' : '—');
const hhmm = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
const hhmmss = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} hari ${h} jam` : h ? `${h} jam ${m} mnt` : `${m} mnt ${s % 60} dtk`;
}
function deltaHtml(x, text) {
  if (!isNum(x) || x === 0) return `<span class="delta">${esc(text)}</span>`;
  return `<span class="delta ${x > 0 ? 'pos' : 'neg'}"><span class="ic" aria-hidden="true">${x > 0 ? '▲' : '▼'}</span>${esc(text)}</span>`;
}

// ---------------------------------------------------------------- koneksi
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (ev) => {
    try {
      render(JSON.parse(ev.data));
    } catch (e) {
      console.error(e);
    }
  };
  es.onerror = () => setStatus('bad', 'Terputus');
}

async function control(action) {
  const confirmText = {
    'cancel-all': 'Batalkan semua order milik bot?',
    'release-halt': 'Lepas rem darurat dan lanjutkan trading?',
    pause: 'Jeda trading? Semua order bot akan dibatalkan.',
  }[action];
  if (confirmText && !confirm(confirmText)) return;
  try {
    const res = await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'dashboard' },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    render(data.state);
    toast({ pause: 'Trading dijeda', resume: 'Trading dilanjutkan', 'cancel-all': 'Order dibatalkan', 'release-halt': 'Rem darurat dilepas' }[action]);
  } catch (e) {
    toast('Gagal: ' + e.message);
  }
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn) control(btn.dataset.action);
});

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

// ---------------------------------------------------------------- render utama
function setStatus(kind, text) {
  const p = $('#statusPill');
  p.className = 'pill ' + kind;
  p.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${esc(text)}</span>`;
}

function render(s) {
  if (!s) return;
  state = s;
  serverOffset = s.now - Date.now();

  const mode = $('#modePill');
  mode.textContent = s.mode === 'LIVE' ? 'Live' : 'Simulasi';
  mode.className = 'pill ' + (s.mode === 'LIVE' ? 'is-live' : 'is-dry');

  if (s.halted) setStatus('bad', 'Dihentikan');
  else if (s.paused) setStatus('warn', 'Dijeda');
  else setStatus('ok', 'Aktif');

  $('#haltBanner').hidden = !s.halted;
  $('#haltText').textContent = s.halted ? `Rem darurat aktif: ${s.halted}` : '';

  const btn = $('#btnPause');
  btn.dataset.action = s.paused ? 'resume' : 'pause';
  btn.textContent = s.paused ? 'Lanjutkan Trading' : 'Jeda Trading';

  renderKpis(s);
  renderTickers(s);
  renderMarkets(s);
  renderPnl(s);
  renderParams(s);
  renderHistory(s);
  renderLearning(s);
  renderLogs(s);
  $('#uptime').textContent = 'Uptime ' + duration(s.now - s.startedAt);
}

function renderKpis(s) {
  const st = s.stats;
  const live = s.mode === 'LIVE';
  const pnl = live && isNum(s.account.dayPnl) ? s.account.dayPnl : st.pnl;
  $('#pnlLabel').textContent = live ? 'PnL Hari Ini' : 'PnL Simulasi';
  $('#kpiPnl').textContent = money(pnl, { sign: true });
  $('#kpiPnlFoot').innerHTML = deltaHtml(st.pnl, `${st.trades} trade · bot ${money(st.pnl, { sign: true })}`);

  $('#kpiWin').textContent = st.trades ? pct(st.wins / st.trades) : '—';
  $('#kpiWinFoot').textContent = st.trades ? `${st.wins} menang dari ${st.trades}` : 'belum ada trade';

  $('#kpiAcc').textContent = pct(st.accuracy);
  $('#kpiAccFoot').textContent = `Brier ${isNum(st.brier) ? st.brier.toFixed(3) : '—'} · ${st.settled} market`;

  if (live) {
    $('#kpiBal').textContent = money(s.account.available);
    $('#kpiBalFoot').textContent = `Total ${money(s.account.total)}${s.account.username ? ' · ' + s.account.username : ''}`;
  } else {
    $('#kpiBal').textContent = money(s.account.bankroll);
    $('#kpiBalFoot').textContent = 'Modal simulasi';
  }

  const max = s.config.maxOpenExposureUsd;
  $('#kpiExp').textContent = money(s.exposureUsd);
  const ratio = max > 0 ? Math.min(1, s.exposureUsd / max) : 0;
  $('#expFill').style.width = (ratio * 100).toFixed(1) + '%';
  $('#expMeter').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  $('#kpiExpFoot').textContent = `Batas ${money(max)} · ${pct(ratio, 0)}`;
}

// ---------------------------------------------------------------- tickers
function renderTickers(s) {
  const root = $('#tickers');
  for (const asset of s.config.assets) {
    let card = root.querySelector(`[data-asset="${asset}"]`);
    if (!card) {
      card = document.createElement('article');
      card.className = 'ticker';
      card.dataset.asset = asset;
      card.innerHTML = `
        <div class="ticker-top">
          <span class="asset-badge"><span class="coin" aria-hidden="true">${esc(COIN_GLYPH[asset] ?? asset[0])}</span>${esc(asset)}</span>
          <span class="ticker-sub" data-src></span>
        </div>
        <div class="ticker-price" data-price>—</div>
        <div class="ticker-sub" data-change>—</div>
        <div class="spark" data-spark></div>`;
      root.appendChild(card);
    }
    const p = s.prices[asset];
    if (!p) {
      $('[data-price]', card).textContent = '—';
      $('[data-change]', card).textContent = 'Menunggu data harga…';
      continue;
    }
    const series = p.series;
    const first = series[0]?.[1];
    const change = isNum(first) && first > 0 ? p.spot / first - 1 : null;
    $('[data-price]', card).textContent = price(p.spot);
    $('[data-src]', card).textContent = p.source;
    $('[data-change]', card).innerHTML = deltaHtml(change, isNum(change) ? `${(change * 100).toFixed(2)}% · 1 jam` : '—');
    lineChart($('[data-spark]', card), series, { height: 56, spark: true, format: price });
  }
}

// ---------------------------------------------------------------- markets
function phaseOf(m, cfg) {
  if (m.secondsLeft <= 0) return 'Selesai';
  if (m.secondsLeft <= cfg.stopSecondsLeft) return 'Ditutup';
  if (m.secondsLeft <= cfg.tradeWhenSecondsLeft) return 'Trading';
  return 'Menunggu';
}

function renderMarkets(s) {
  const root = $('#markets');
  if (!s.markets.length) {
    root.innerHTML = `<div class="empty">Belum ada market 5 menit yang terdeteksi. Bot memindai feed setiap 30 detik.</div>`;
    return;
  }
  root.innerHTML = s.markets
    .map((m) => {
      const phase = phaseOf(m, s.config);
      const hasP = isNum(m.pUp);
      const ref = m.twapKnown ? m.twapKnown.avg : m.spot;
      const diff = isNum(ref) && isNum(m.strike) ? ref / m.strike - 1 : null;
      const order = m.order
        ? `<span class="chip"><i style="background:var(--${m.order.side === 'up' ? 'up' : 'down'})"></i>BID ${m.order.side.toUpperCase()} ${m.order.quantity} @ ${m.order.price.toFixed(2)}${m.order.dry ? ' · sim' : ''}</span>`
        : m.hasPosition
          ? `<span class="chip">Posisi ditahan</span>`
          : '';
      return `
      <article class="market ${phase === 'Trading' ? 'is-active' : ''}">
        <div class="market-head">
          <div class="ring" data-ring data-start="${m.startMs}" data-end="${m.endMs}">
            <svg viewBox="0 0 36 36" aria-hidden="true">
              <circle class="track" cx="18" cy="18" r="16" fill="none" stroke-width="2.5"></circle>
              <circle class="prog" cx="18" cy="18" r="16" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="100.53" stroke-dashoffset="0"></circle>
            </svg>
            <div class="ring-label" data-ring-label>—</div>
          </div>
          <div class="market-title">
            <div class="a">${esc(m.asset)} <span class="tag ${phase === 'Trading' ? 'gold' : ''}">${phase}</span><span class="tag">${esc(m.type === 'PARIMUTUEL' ? 'Pool' : 'Order Book')}</span></div>
            <div class="q" title="${esc(m.question)}">${esc(m.question)}</div>
          </div>
        </div>
        ${
          hasP
            ? `<div class="prob">
                <div class="prob-bar" role="img" aria-label="Peluang naik ${pct(m.pUp)}, turun ${pct(1 - m.pUp)}">
                  <span class="up" style="flex-basis:${(m.pUp * 100).toFixed(2)}%"></span>
                  <span class="down" style="flex-basis:${((1 - m.pUp) * 100).toFixed(2)}%"></span>
                </div>
                <div class="prob-labels">
                  <span><span class="arrow-up" aria-hidden="true">▲</span> <b>${pct(m.pUp)}</b> <span class="muted">${esc(m.upLabel)}</span></span>
                  <span><span class="muted">${esc(m.downLabel)}</span> <b>${pct(1 - m.pUp)}</b> <span class="arrow-down" aria-hidden="true">▼</span></span>
                </div>
              </div>`
            : `<div class="empty" style="padding:4px 0">Model aktif saat sisa ≤ ${s.config.tradeWhenSecondsLeft} detik.</div>`
        }
        <div class="kv">
          <div><div class="k">${m.twapKnown ? `Rata² ${m.twapKnown.count}s` : 'Spot'}</div><div class="v">${price(m.twapKnown ? m.twapKnown.avg : m.spot)}</div></div>
          <div><div class="k">Acuan</div><div class="v" title="${esc(m.strikeSource ?? '')}">${price(m.strike)}</div></div>
          <div><div class="k">Selisih</div><div class="v">${isNum(diff) ? (diff >= 0 ? '+' : '') + (diff * 100).toFixed(3) + '%' : '—'}</div></div>
        </div>
        ${bookRow(m)}
        <div class="decision"><span>${esc(m.foreign ? 'Dilewati (ada order manual)' : m.decision ?? 'Menunggu window trading')}</span>${order}</div>
      </article>`;
    })
    .join('');
  tickRings();
}

/** Baris harga pasar (ask terbaik) + edge model setelah fee + tanda arbitrase. */
function bookRow(m) {
  const b = m.book;
  if (!b) return '';
  const fee = isNum(m.feeRate) ? m.feeRate : 0;
  const cell = (side, label) => {
    const ask = b[side]?.bestAsk;
    const prob = isNum(m.pUp) ? (side === 'up' ? m.pUp : 1 - m.pUp) : null;
    const edge = isNum(ask) && isNum(prob) ? prob - ask * (1 + fee) : null;
    const edgeTxt = isNum(edge) ? `${edge >= 0 ? '+' : '−'}${Math.abs(edge * 100).toFixed(1)}¢` : '';
    return `<div><div class="k"><i class="sw sw-${side}" style="width:8px;height:8px"></i> Ask ${esc(label)}</div>
      <div class="v">${isNum(ask) ? ask.toFixed(2) : '—'} ${edgeTxt ? `<span class="edge ${edge >= 0 ? 'pos' : 'neg'}">${edgeTxt}</span>` : ''}</div></div>`;
  };
  const arb = m.arb ? `<div class="arb">◆ Arbitrase: UP+DOWN = $${m.arb.costPerSet.toFixed(3)} · untung ~$${m.arb.profitPerSet.toFixed(3)}/set</div>` : '';
  return `<div class="kv kv2">${cell('up', 'UP')}${cell('down', 'DOWN')}<div><div class="k">Fee</div><div class="v">${(fee * 100).toFixed(1)}%</div></div></div>${arb}`;
}

function tickRings() {
  const now = Date.now() + serverOffset;
  const C = 100.53;
  for (const ring of document.querySelectorAll('[data-ring]')) {
    const start = Number(ring.dataset.start);
    const end = Number(ring.dataset.end);
    const left = Math.max(0, (end - now) / 1000);
    const frac = end > start ? Math.min(1, Math.max(0, (end - now) / (end - start))) : 0;
    ring.querySelector('.prog').setAttribute('stroke-dashoffset', String(C * (1 - frac)));
    ring.classList.toggle('stop', state && left <= state.config.stopSecondsLeft);
    const m = Math.floor(left / 60);
    const sec = Math.floor(left % 60);
    ring.querySelector('[data-ring-label]').textContent = `${m}:${String(sec).padStart(2, '0')}`;
  }
}

// ---------------------------------------------------------------- chart garis (PnL & sparkline)
function niceTicks(min, max, count = 4) {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= count) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

/**
 * Chart garis tunggal: garis 2px, area wash 10%, titik akhir r=4 dengan ring permukaan,
 * crosshair + tooltip saat hover/sentuh.
 */
function lineChart(el, points, { height = 240, spark = false, format = (v) => v, zero = false, tooltip } = {}) {
  el._points = points;
  el._opts = { height, spark, format, zero, tooltip };
  drawLine(el);
  if (!el._bound) {
    el._bound = true;
    const move = (ev) => {
      const r = el.getBoundingClientRect();
      el._hoverX = (ev.clientX - r.left) / r.width;
      el._hoverClient = [ev.clientX, ev.clientY];
      drawLine(el);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', move);
    el.addEventListener('pointerleave', () => {
      el._hoverX = null;
      $('#tooltip').hidden = true;
      drawLine(el);
    });
    new ResizeObserver(() => drawLine(el)).observe(el);
  }
}

function drawLine(el) {
  const pts = el._points ?? [];
  const { height, spark, format, zero, tooltip } = el._opts;
  const W = Math.max(120, el.clientWidth || 300);
  const H = height;
  const pad = spark ? { l: 2, r: 8, t: 6, b: 6 } : { l: 56, r: 64, t: 12, b: 26 };
  if (pts.length < 2) {
    el.innerHTML = `<div class="empty">${spark ? 'Mengumpulkan data…' : 'Kurva muncul setelah ada trade yang selesai.'}</div>`;
    return;
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  let yMin = Math.min(...ys, ...(zero ? [0] : []));
  let yMax = Math.max(...ys, ...(zero ? [0] : []));
  const ticks = spark ? null : niceTicks(yMin, yMax, 4);
  if (ticks) {
    yMin = ticks[0];
    yMax = ticks[ticks.length - 1];
  } else if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const x0 = xs[0], x1 = xs[xs.length - 1];
  const sx = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const sy = (y) => pad.t + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
  const base = zero ? sy(0) : H - pad.b;
  const area = `${line}L${sx(x1).toFixed(1)},${base.toFixed(1)}L${sx(x0).toFixed(1)},${base.toFixed(1)}Z`;
  const last = pts[pts.length - 1];

  let svg = `<svg xmlns="${SVGNS}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Grafik garis">`;
  if (ticks) {
    for (const t of ticks) {
      const y = sy(t).toFixed(1);
      svg += `<line class="${t === 0 ? 'zero-line' : 'grid-line'}" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>`;
      svg += `<text class="axis-text" x="${pad.l - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${esc(format(t))}</text>`;
    }
    svg += `<text class="axis-text" x="${pad.l}" y="${H - 6}">${hhmm(x0)}</text>`;
    svg += `<text class="axis-text" x="${W - pad.r}" y="${H - 6}" text-anchor="end">${hhmm(x1)}</text>`;
  }
  svg += `<path d="${area}" fill="var(--series-pnl)" fill-opacity="0.1"/>`;
  svg += `<path d="${line}" fill="none" stroke="var(--series-pnl)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  svg += `<circle cx="${sx(last[0])}" cy="${sy(last[1])}" r="4" fill="var(--series-pnl)" stroke="var(--surface-1)" stroke-width="2"/>`;
  if (!spark) {
    svg += `<text class="axis-text" x="${sx(last[0]) + 10}" y="${sy(last[1])}" dominant-baseline="middle" style="fill:var(--text-primary);font-weight:600">${esc(format(last[1]))}</text>`;
  }

  if (el._hoverX !== null && el._hoverX !== undefined) {
    const targetX = x0 + ((el._hoverX * W - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    let idx = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - targetX) < Math.abs(pts[idx][0] - targetX)) idx = i;
    const p = pts[idx];
    const cx = sx(p[0]);
    svg += `<line class="crosshair" x1="${cx}" x2="${cx}" y1="${pad.t}" y2="${H - pad.b}"/>`;
    svg += `<circle cx="${cx}" cy="${sy(p[1])}" r="5" fill="var(--series-pnl)" stroke="var(--surface-1)" stroke-width="2"/>`;
    const tt = $('#tooltip');
    tt.innerHTML = tooltip ? tooltip(p, idx) : `<div class="tt-k">${hhmmss(p[0])}</div><div><b>${esc(format(p[1]))}</b></div>`;
    tt.hidden = false;
    const [cxp, cyp] = el._hoverClient;
    const w = tt.offsetWidth;
    tt.style.left = Math.min(window.innerWidth - w - 8, cxp + 14) + 'px';
    tt.style.top = Math.max(8, cyp - 44) + 'px';
  }
  svg += '</svg>';
  el.innerHTML = svg;
}

// ---------------------------------------------------------------- PnL, parameter, riwayat, log
function renderPnl(s) {
  const trades = s.history.filter((h) => h.trade);
  let cum = 0;
  const pts = trades.map((h) => [h.ts, (cum += h.trade.pnl)]);
  if (pts.length) pts.unshift([pts[0][0] - 60_000, 0]);
  $('#pnlNote').textContent = trades.length ? `${trades.length} trade · ${s.mode === 'LIVE' ? 'live' : 'simulasi'}` : '—';
  lineChart($('#pnlChart'), pts, {
    height: 260,
    zero: true,
    format: (v) => money(v, { sign: true }),
    tooltip: (p, i) => {
      const h = trades[i - 1];
      if (!h) return `<div class="tt-k">Awal</div><div><b>$0.00</b></div>`;
      return `<div class="tt-k">${hhmm(h.ts)} · ${esc(h.asset)} · ${h.trade.side.toUpperCase()} @ ${h.trade.price.toFixed(2)}</div>
              <div>Trade <b>${money(h.trade.pnl, { sign: true })}</b> · Kumulatif <b>${money(p[1], { sign: true })}</b></div>`;
    },
  });
}

function renderParams(s) {
  const c = s.config;
  const rows = [
    ['Aset', c.assets.join(' · ')],
    ['Maks. per order', money(c.maxOrderUsd)],
    ['Batas exposure', money(c.maxOpenExposureUsd)],
    ['Rem rugi harian', money(c.maxDailyLossUsd)],
    ['Edge minimal', (c.minEdge * 100).toFixed(0) + '¢'],
    ['Fraksi Kelly', c.kellyFraction],
    ['Mulai trading', `sisa ≤ ${c.tradeWhenSecondsLeft}s`],
    ['Tutup order', `sisa ≤ ${c.stopSecondsLeft}s`],
    ['Pengali volatilitas', `×${c.sigmaMultiplier}`],
  ];
  $('#params').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

/** Meter win rate dengan penanda titik impas (bar tunggal + garis penanda). */
function winMeter(g) {
  if (!g.n) return '<span class="muted-txt">belum ada</span>';
  const w = Math.max(0, Math.min(1, g.winrate));
  const b = Math.max(0, Math.min(1, g.breakeven ?? 0));
  const above = g.winrate >= g.breakeven;
  return `<div class="wm" role="img" aria-label="Menang ${pct(g.winrate)}, impas ${pct(g.breakeven)}">
      <div class="wm-track"><span class="wm-fill" style="width:${(w * 100).toFixed(1)}%"></span><i class="wm-mark" style="left:${(b * 100).toFixed(1)}%"></i></div>
      <div class="wm-txt"><b>${pct(g.winrate, 0)}</b> <span class="muted-txt">/ impas ${pct(g.breakeven, 0)}</span> <span class="ic ${above ? 'pos' : 'neg'}" aria-hidden="true">${above ? '▲' : '▼'}</span></div>
    </div>`;
}

function learnRows(groups) {
  return groups
    .map((g) => {
      const status = g.blocked
        ? '<span class="st st-bad"><i aria-hidden="true">■</i> Diblokir</span>'
        : g.n
          ? '<span class="st st-ok"><i aria-hidden="true">●</i> Aktif</span>'
          : '<span class="muted-txt">—</span>';
      const mobileTag = g.blocked ? '<div class="st st-bad only-mobile"><i aria-hidden="true">■</i> Diblokir</div>' : '';
      return `<tr><td class="nowrap">${esc(g.key)}${mobileTag}</td><td class="num">${g.n}</td><td>${winMeter(g)}</td><td class="num">${g.n ? deltaHtml(g.pnl, money(g.pnl, { sign: true })) : '—'}</td><td>${status}</td></tr>`;
    })
    .join('');
}

function renderLearning(s) {
  const L = s.learning;
  if (!L) return;
  $('#learnNote').textContent = L.enabled
    ? `${L.markets} market · ${L.total.n} trade · ROI ${pct(L.total.roi)}`
    : 'Pembelajaran dimatikan (ADAPTIVE=false)';
  $('#learnTime').innerHTML = learnRows(L.byTime);
  $('#learnAsset').innerHTML = L.byAsset.length ? learnRows(L.byAsset) : `<tr><td colspan="5" class="muted-txt">Belum ada trade.</td></tr>`;
  $('#learnCalib').innerHTML = L.calibration
    .map((c) => {
      const state = c.active
        ? c.k < 0.95
          ? 'terlalu yakin → dikoreksi'
          : c.k > 1.05
            ? 'kurang yakin → dipertegas'
            : 'sudah tepat'
        : `mengumpulkan data ${c.n}/${L.minCalibrationSamples}`;
      return `<div class="calib-item ${c.active ? 'on' : ''}">
        <div class="k">Sisa ${c.checkpoint} dtk</div>
        <div class="v">${c.active ? 'k = ' + c.k.toFixed(2) : '—'}</div>
        <div class="d">${esc(state)}</div>
      </div>`;
    })
    .join('');
}

function renderHistory(s) {
  const rows = s.history.slice(-40).reverse();
  $('#histNote').textContent = rows.length ? `${s.history.length} market selesai` : '—';
  if (!rows.length) {
    $('#history').innerHTML = `<tr><td colspan="6" class="empty">Belum ada market yang selesai.</td></tr>`;
    return;
  }
  $('#history').innerHTML = rows
    .map((h) => {
      const res = `<span class="res"><i style="background:var(--${h.outcome})"></i>${h.outcome === 'up' ? 'UP' : 'DOWN'}</span>`;
      const predSide = h.pUp >= 0.5 ? 'UP' : 'DOWN';
      const pred = `${predSide} ${pct(Math.max(h.pUp, 1 - h.pUp), 0)} ${h.correct ? '✓' : '✗'}`;
      const pos = h.trade
        ? `${h.trade.side.toUpperCase()} ${Math.round(h.trade.quantity)} @ ${h.trade.price.toFixed(2)}${isNum(h.trade.secondsLeft) ? ` · sisa ${h.trade.secondsLeft}s` : ''}${h.trade.probe ? ' · probe' : ''}`
        : '—';
      const pnl = h.trade ? deltaHtml(h.trade.pnl, money(h.trade.pnl, { sign: true })) : '—';
      return `<tr><td>${hhmm(h.endMs)}</td><td>${esc(h.asset)}</td><td>${res}</td><td>${esc(pred)}</td><td>${esc(pos)}</td><td class="num">${pnl}</td></tr>`;
    })
    .join('');
}

function renderLogs(s) {
  const el = $('#logs');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = s.logs
    .slice(-120)
    .map(
      (l) =>
        `<div class="log-line ${esc(l.level)}"><span class="t">${hhmmss(l.ts)}</span><span class="l">${esc(l.level.toUpperCase())}</span><span class="m">${esc(l.msg)}</span></div>`,
    )
    .join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------- jam & countdown
setInterval(() => {
  $('#clock').textContent = hhmmss(Date.now() + serverOffset);
  tickRings();
}, 250);

connect();
