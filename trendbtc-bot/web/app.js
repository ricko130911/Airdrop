// Dashboard logic: polls /api/state every second and renders all panels.

const $ = (sel) => document.querySelector(sel);
const DEC = { DOGE: 5, XRP: 4, TRUMP: 4, ENA: 4, SUI: 4 };
const dec = (a) => DEC[a] ?? 2;

const fmtNum = (v, d = 2) =>
  Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPrice = (a, v) => (v > 0 ? "$" + fmtNum(v, dec(a)) : "—");
const fmtSigned = (v, d) => (v > 0 ? "+" : v < 0 ? "−" : "±") + fmtNum(Math.abs(v), d);
const dirClass = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
const dirSym = (v) => (v > 0 ? "▲" : v < 0 ? "▼" : "―");

function fmtCd(sec) {
  if (sec === null || sec === undefined) return "--:--";
  if (sec <= 0) return "LOCKED";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Convert the bot's ANSI color codes into styled spans.
const ANSI = { 90: "a-gray", 91: "a-red", 92: "a-green", 93: "a-yellow", 94: "a-blue", 95: "a-magenta", 96: "a-cyan" };
function ansi(str) {
  const parts = String(str ?? "").split(/\x1b\[([\d;]*)m/);
  let out = "", open = false;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) { out += esc(parts[i]); continue; }
    if (open) { out += "</span>"; open = false; }
    const codes = parts[i].split(";").map(Number);
    const cls = codes.map((c) => ANSI[c]).find(Boolean);
    if (cls) { out += `<span class="${cls}">`; open = true; }
  }
  return open ? out + "</span>" : out;
}

// ---------- 3D tilt on cards ----------
function bindTilt(el) {
  if (el.dataset.tilt || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.dataset.tilt = "1";
  el.addEventListener("pointermove", (e) => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(900px) rotateX(${(-y * 10).toFixed(2)}deg) rotateY(${(x * 12).toFixed(2)}deg) translateZ(6px)`;
  });
  el.addEventListener("pointerleave", () => { el.style.transform = ""; });
}

// ---------- sparklines ----------
const sparkData = new Map();
const tip = $("#spark-tip");

function drawSpark(canvas, asset, points) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  sparkData.set(canvas, { asset, points });
  if (!points || points.length < 2) {
    g.fillStyle = "#4f6b85"; g.font = "11px JetBrains Mono"; g.fillText("collecting ticks…", 4, h / 2 + 4);
    return;
  }
  const vals = points.map((p) => p[1]);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) { max += 1e-9; min -= 1e-9; }
  const pad = 4;
  const X = (i) => (i / (points.length - 1)) * (w - 2) + 1;
  const Y = (v) => h - pad - ((v - min) / (max - min)) * (h - pad * 2);
  const rising = vals[vals.length - 1] >= vals[0];
  const stroke = rising ? "#39ff88" : "#ff4d6d";

  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, rising ? "rgba(57,255,136,0.28)" : "rgba(255,77,109,0.28)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.beginPath();
  points.forEach((p, i) => (i ? g.lineTo(X(i), Y(p[1])) : g.moveTo(X(i), Y(p[1]))));
  g.lineTo(X(points.length - 1), h); g.lineTo(X(0), h); g.closePath();
  g.fillStyle = grad; g.fill();

  g.beginPath();
  points.forEach((p, i) => (i ? g.lineTo(X(i), Y(p[1])) : g.moveTo(X(i), Y(p[1]))));
  g.strokeStyle = stroke; g.lineWidth = 2; g.lineJoin = "round"; g.lineCap = "round";
  g.shadowColor = stroke; g.shadowBlur = 8; g.stroke(); g.shadowBlur = 0;

  const hover = canvas._hoverX;
  if (hover !== undefined) {
    const i = Math.round(((hover - 1) / (w - 2)) * (points.length - 1));
    const idx = Math.max(0, Math.min(points.length - 1, i));
    g.strokeStyle = "rgba(201,243,255,0.35)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(X(idx), 0); g.lineTo(X(idx), h); g.stroke();
    g.fillStyle = stroke; g.beginPath(); g.arc(X(idx), Y(points[idx][1]), 4, 0, Math.PI * 2); g.fill();
  }
}

function bindSpark(canvas) {
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    canvas._hoverX = e.clientX - r.left;
    const d = sparkData.get(canvas);
    if (!d || !d.points || d.points.length < 2) return;
    const idx = Math.max(0, Math.min(d.points.length - 1, Math.round((canvas._hoverX / r.width) * (d.points.length - 1))));
    const [ts, v] = d.points[idx];
    tip.innerHTML = `${d.asset} <b>${fmtPrice(d.asset, v)}</b><br>${new Date(ts).toLocaleTimeString()}`;
    tip.style.left = e.clientX + 14 + "px";
    tip.style.top = e.clientY - 10 + "px";
    tip.classList.remove("hidden");
    drawSpark(canvas, d.asset, d.points);
  });
  canvas.addEventListener("pointerleave", () => {
    canvas._hoverX = undefined;
    tip.classList.add("hidden");
    const d = sparkData.get(canvas);
    if (d) drawSpark(canvas, d.asset, d.points);
  });
}

// ---------- renderers ----------
function renderHeader(s) {
  const phase = $("#pill-phase");
  phase.textContent = s.phase.toUpperCase();
  phase.className = "pill " + (s.phase === "running" ? "pill-ok" : "pill-warn");
  $("#pill-sim").classList.toggle("hidden", !s.simulation);
  const btn = $("#btn-pause");
  btn.textContent = s.paused ? "▶ RESUME BETS" : "❚❚ PAUSE BETS";
  btn.classList.toggle("is-paused", s.paused);
  $("#hero-modes").textContent = s.modes.map((m) => m.toUpperCase()).join(" + ");
  $("#hero-uptime").textContent = fmtUptime(s.uptime);
  $("#hero-clock").textContent = new Date(s.server_time).toLocaleTimeString();
  $("#foot-time").textContent = new Date(s.server_time).toLocaleString();

  document.querySelectorAll("[data-mode]").forEach((el) => {
    const on = s.modes.includes(el.dataset.mode);
    if (el.tagName === "A") el.classList.toggle("hidden", !on);
    else el.classList.toggle("mode-off", !on);
  });
}

function renderHero(s) {
  const btc = s.prices.BTC || 0;
  const m1 = s.markets.BTC?.["1m"] || {};
  $("#hero-price").textContent = btc > 0 ? "$" + fmtNum(btc, 2) : "$—";
  const diff = btc > 0 && m1.start > 0 ? btc - m1.start : 0;
  const hd = $("#hero-diff");
  hd.className = "hero-diff " + dirClass(diff);
  hd.textContent = m1.start > 0 ? `${dirSym(diff)} ${fmtSigned(diff, 2)} vs 1M start · lock ${fmtCd(m1.secs_left)}` : "vs 1M start — syncing";

  const top = m1.band_top, low = m1.band_low;
  if (top > 0 && low > 0 && btc > 0) {
    const span = (top - low) * 2; // track shows 2× the corridor
    const left = low - (top - low) / 2;
    const pct = Math.max(0, Math.min(100, ((btc - left) / span) * 100));
    $("#band-marker").style.left = `calc(${pct}% - 2px)`;
    const breakout = btc > top || btc < low;
    const bs = $("#band-status");
    bs.textContent = breakout ? "BREAKOUT" : "INSIDE";
    bs.className = breakout ? "up" : "a-magenta";
    $("#band-low").textContent = "LOW $" + fmtNum(low, 2);
    $("#band-top").textContent = "TOP $" + fmtNum(top, 2);
    $("#band-start").textContent = "START $" + fmtNum(m1.start, 2);
  } else {
    $("#band-status").textContent = "CALC…";
  }
}

function renderAccounts(s) {
  const wrap = $("#accounts");
  s.accounts.forEach((a, i) => {
    let card = wrap.children[i];
    if (!card) {
      card = document.createElement("div");
      card.className = "acc-card glass tilt";
      wrap.appendChild(card);
      bindTilt(card);
    }
    const m = a.martingale || {};
    const sv = a.survivor || {};
    card.innerHTML = `
      <div class="pop">
        <div class="acc-name">${esc(a.name)}</div>
        <div class="acc-usd">${a.usd == null ? "—" : "$" + fmtNum(a.usd, 2)}</div>
        <div class="acc-trend">${a.trend == null ? "—" : fmtNum(a.trend, 0) + " TREND"}</div>
        <div class="acc-row">
          <span class="chip">Martingale L: <b>${m.consecutive_losses ?? 0}</b></span>
          <span class="chip">x<b>${m.multiplier ?? 1}</b></span>
          <span class="chip">Last: <b>${esc(m.last_result || "none")}</b></span>
          ${s.modes.includes("survivor") ? `<span class="chip">Survivor: ${ansi(sv.status_str || "—")}</span>` : ""}
        </div>
      </div>`;
  });
  while (wrap.children.length > s.accounts.length) wrap.lastChild.remove();
}

function renderAssets(s) {
  const grid = $("#asset-grid");
  s.assets.forEach((a) => {
    let card = grid.querySelector(`[data-asset="${a}"]`);
    if (!card) {
      card = document.createElement("div");
      card.className = "asset-card glass tilt";
      card.dataset.asset = a;
      card.innerHTML = `
        <div class="asset-top"><span class="asset-sym">${a}</span><span class="asset-price"></span></div>
        <canvas class="spark" role="img" aria-label="${a} price, last 10 minutes"></canvas>
        <div class="tf-row"></div>`;
      grid.appendChild(card);
      bindTilt(card);
      bindSpark(card.querySelector("canvas"));
    }
    const p = s.prices[a] || 0;
    card.querySelector(".asset-price").textContent = fmtPrice(a, p);
    const canvas = card.querySelector("canvas");
    if (canvas._hoverX === undefined) drawSpark(canvas, a, s.history[a]);
    else sparkData.set(canvas, { asset: a, points: s.history[a] });

    card.querySelector(".tf-row").innerHTML = (s.timeframes[a] || [])
      .map((tf) => {
        const m = s.markets[a]?.[tf] || {};
        const diff = p > 0 && m.start > 0 ? p - m.start : 0;
        return `<div class="tf" title="${a} ${tf} start ${fmtPrice(a, m.start)}">
          <div class="tf-name">${tf.toUpperCase()}</div>
          <div class="tf-diff ${dirClass(diff)}">${m.start > 0 ? dirSym(diff) + " " + fmtSigned(diff, dec(a)) : "sync"}</div>
          <div class="tf-cd">${fmtCd(m.secs_left)}</div>
        </div>`;
      })
      .join("");
  });
}

function renderSniper(s) {
  if (!s.modes.includes("crypto")) return;
  const t = $("#sniper-table");
  t.querySelector("thead").innerHTML =
    `<tr><th>Asset</th><th>TF</th><th>Start</th><th>Live</th><th>Diff</th><th>Lock</th>` +
    s.accounts.map((a) => `<th>${esc(a.name)}</th>`).join("") + `</tr>`;
  const rows = [];
  s.assets.forEach((a) => {
    const p = s.prices[a] || 0;
    (s.timeframes[a] || []).forEach((tf) => {
      const m = s.markets[a]?.[tf] || {};
      const diff = p > 0 && m.start > 0 ? p - m.start : 0;
      rows.push(`<tr>
        <td class="sym">${a}</td><td>${tf.toUpperCase()}</td>
        <td>${fmtPrice(a, m.start)}</td><td>${fmtPrice(a, p)}</td>
        <td class="${dirClass(diff)}">${dirSym(diff)} ${fmtSigned(diff, dec(a))}</td>
        <td class="a-cyan">${fmtCd(m.secs_left)}</td>
        ${s.accounts.map((acc) => `<td>${ansi(acc.states[`${a}_${tf}`] || "—")}</td>`).join("")}
      </tr>`);
    });
  });
  t.querySelector("tbody").innerHTML = rows.join("");
}

function renderSurvivor(s) {
  if (!s.modes.includes("survivor")) return;
  const g = s.survivor;
  const active = g.is_active && g.current_round > 0;
  const btc = s.prices.BTC || 0;
  const diff = btc > 0 && g.round_start_price > 0 ? btc - g.round_start_price : 0;
  $("#survivor-global").innerHTML = `
    <h3>${active ? `💀 ROUND ${g.current_round} OF 8` : "🏆 DAILY ELIMINATION"}</h3>
    <div class="eyebrow">${active ? "PICK CLOSES IN" : "STARTS IN"}</div>
    <div class="big-cd ${active ? "" : "ok"}">${fmtCd(active ? g.lock_in : g.starts_in)}</div>
    <div class="kv">
      <span>Doors</span><b class="${g.doors_open ? "up" : "down"}">${g.doors_open ? "OPEN" : "CLOSED"}</b>
      <span>Schedule</span><b>${esc(g.starts_label || "—")}</b>
      <span>Prize pool</span><b class="a-magenta">${esc(g.prize_pool)}</b>
      <span>Entered</span><b>${fmtNum(g.entered, 0)}</b>
      <span>Still standing</span><b class="up">${active ? fmtNum(g.still_standing, 0) : "—"}</b>
      <span>BTC vs start</span><b class="${dirClass(diff)}">${g.round_start_price > 0 ? dirSym(diff) + " " + fmtSigned(diff, 2) : "—"}</b>
      <span>Sniper timing</span><b>Akun 1 @75s · Akun 2+ @90s</b>
    </div>`;

  $("#survivor-accounts").innerHTML = s.accounts
    .map((a, idx) => {
      const sv = a.survivor || {};
      const res = sv.round_results || {};
      const ko = sv.knocked_round;
      const still = sv.still_in !== false;
      const cells = [];
      for (let r = 1; r <= 8; r++) {
        const st = res[r];
        let cls = "", txt = `R${r}`;
        if (ko && r === ko) { cls = "lost"; txt += "✗"; }
        else if (ko && r > ko) cls = "dead";
        else if (st === "won" || (r < g.current_round && still)) { cls = "won"; txt += "✓"; }
        else if (st === "lost") { cls = "lost"; txt += "✗"; }
        else if (r === g.current_round && active && still) cls = "now";
        cells.push(`<div class="round ${cls}">${txt}</div>`);
      }
      return `<h3>${esc(a.name)} · ${ansi(sv.status_str || "—")}</h3><div class="track">${cells.join("")}</div>`;
    })
    .join("");
}

function renderBullseye(s) {
  if (!s.modes.includes("bullseye")) return;
  const b = s.bullseye;
  $("#bullseye-global").innerHTML = `
    <h3>🎯 ${b.is_active ? "LIVE FLASH EVENT" : "NO EVENT RUNNING"}</h3>
    <div class="eyebrow">CALL WINDOW</div>
    <div class="big-cd ${b.is_active ? "ok" : "idle"}">${fmtCd(b.call_in)}</div>
    <div class="kv">
      <span>Event ends in</span><b>${fmtCd(b.ends_in)}</b>
      <span>BTC live</span><b class="up">$${fmtNum(s.prices.BTC, 2)}</b>
      <span>Prize</span><b class="a-magenta">${esc(b.prize_pool)}</b>
      <span>Participants</span><b>${fmtNum(b.participants, 0)}</b>
      <span>Sniper timing</span><b>Akun 1 @20s · Akun 2+ @12s</b>
    </div>`;
  $("#bullseye-accounts").innerHTML =
    "<h3>AUTO-CALL STATUS</h3>" +
    s.accounts.map((a) => `<div class="kv"><span>${esc(a.name)}</span><b>${ansi(a.bullseye?.status_str || "STANDBY")}</b></div>`).join("");
}

function renderSports(s) {
  if (!s.modes.includes("sports")) return;
  const fx = s.sports.fixtures;
  $("#sports-fixtures").innerHTML = fx.length
    ? fx.map((f) => `
      <div class="fixture glass">
        <span class="fixture-cd">⏱ ${fmtCd(f.secs_left)}</span>
        <div class="fixture-league">${esc(f.league)}</div>
        <div class="fixture-title">${esc(f.title)}</div>
        ${f.sub_markets.map((m) => `
          <div class="sub">
            <div class="sub-label">${esc(m.label)}</div>
            <div class="pool-bar"><div class="yes" style="width:${m.pct0}%"></div><div class="no" style="width:${m.pct1}%"></div></div>
            <div class="pool-meta">
              <span>Yes ${m.pct0.toFixed(0)}% · $${fmtNum(m.p0, 0)}</span>
              <span class="pick">🎯 ${esc(m.best_name)} ${Number(m.best_pct).toFixed(0)}%</span>
              <span>No ${m.pct1.toFixed(0)}% · $${fmtNum(m.p1, 0)}</span>
            </div>
          </div>`).join("")}
      </div>`).join("")
    : `<div class="glass empty">Menyinkronkan pertandingan dari TrendBTC API…</div>`;

  $("#sports-preds tbody").innerHTML = s.sports.predictions.length
    ? s.sports.predictions.map((p) => {
        const cls = p.status === "WON" ? "up" : p.status === "LOST" ? "down" : "flat";
        return `<tr><td class="a-cyan">${esc(p.account)}</td><td>${esc(String(p.title).slice(0, 40))}</td><td class="a-magenta">${esc(p.choice)}</td><td>$${fmtNum(p.amount, 0)}</td><td class="${cls}">${esc(p.status)}</td></tr>`;
      }).join("")
    : `<tr><td colspan="5" class="empty">Belum ada tiket.</td></tr>`;
}

function renderLogs(s) {
  $("#pred-table tbody").innerHTML = s.predictions.length
    ? s.predictions.map((h) => `<tr>
        <td class="a-cyan">${esc(h.account)}</td><td class="a-yellow">${esc(h.short_r_id)}</td>
        <td>${ansi(h.direction_str)}</td><td>$${fmtNum(h.stake, 0)}</td>
        <td class="up">$${fmtNum(h.payout, 1)}</td><td>${ansi(h.hasil_str)}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty">Menyinkronkan riwayat resmi…</td></tr>`;

  const fill = (id, lines, empty) => {
    const el = $(id);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    el.innerHTML = lines.length ? lines.map(ansi).join("\n") : `<span class="a-gray">${empty}</span>`;
    if (atBottom) el.scrollTop = el.scrollHeight;
  };
  fill("#log-crypto", s.crypto_log, "(Belum ada aktivitas transaksi)");
  fill("#log-survivor", s.survivor.log, "(Standby menunggu ronde survivor)");
  fill("#log-bullseye", s.bullseye.log, "(Standby memantau event Bullseye)");
  fill("#log-sports", s.sports.log, "(Menganalisis pool terendah…)");
}

// ---------- polling ----------
let lastState = null;
let failures = 0;

async function poll() {
  try {
    const res = await fetch("/api/state", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const s = await res.json();
    lastState = s;
    failures = 0;
    const pc = $("#pill-conn");
    pc.textContent = "LIVE";
    pc.className = "pill pill-ok";
    renderHeader(s);
    renderHero(s);
    renderAccounts(s);
    renderAssets(s);
    renderSniper(s);
    renderSurvivor(s);
    renderBullseye(s);
    renderSports(s);
    renderLogs(s);
    window.dispatchEvent(new CustomEvent("neon:state", { detail: s }));
  } catch (e) {
    failures++;
    const pc = $("#pill-conn");
    pc.textContent = failures > 2 ? "OFFLINE" : "RETRY";
    pc.className = "pill " + (failures > 2 ? "pill-bad" : "pill-warn");
  } finally {
    setTimeout(poll, 1000);
  }
}

$("#btn-pause").addEventListener("click", async () => {
  if (!lastState) return;
  const next = !lastState.paused;
  const msg = next
    ? "Pause semua taruhan? Bot tetap memantau, tapi tidak memasang bet/pick/call."
    : "Resume taruhan otomatis sekarang?";
  if (!confirm(msg)) return;
  try {
    await fetch("/api/control", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Requested-With": "neon-dashboard" },
      body: JSON.stringify({ paused: next }),
    });
  } catch (_) { /* next poll will reflect state */ }
});

window.addEventListener("resize", () => {
  document.querySelectorAll(".spark").forEach((c) => {
    const d = sparkData.get(c);
    if (d) drawSpark(c, d.asset, d.points);
  });
});

poll();
