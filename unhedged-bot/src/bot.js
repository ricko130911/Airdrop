import { discoverMarkets, extractStrike, marketType } from './markets.js';
import { estimateVolatility, estimateDrift, probabilityUp, brier } from './model.js';
import { decideOrderBook, decideParimutuel, parimutuelPools } from './strategy.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(d));

export class Bot {
  /**
   * @param {{cfg:any, api: import('./api.js').UnhedgedApi, prices: import('./prices.js').PriceFeed, log:any}} deps
   */
  constructor({ cfg, api, prices, log }) {
    this.cfg = cfg;
    this.api = api;
    this.prices = prices;
    this.log = log;
    this.live = !cfg.dryRun;

    this.markets = new Map(); // marketId -> entry
    this.lastDiscovery = 0;
    this.lastRisk = 0;
    this.halted = null;
    this.bankroll = cfg.bankrollUsd ?? (this.live ? null : 100);
    this.dayPnl = 0;
    this.positionCost = new Map(); // marketId -> USD (posisi live)
    this.foreignMarkets = new Set(); // market yang punya order manual milik user -> tidak disentuh
    this.stats = { settled: 0, scored: 0, correct: 0, brierSum: 0, trades: 0, wins: 0, paperPnl: 0 };
    this.stopping = false;
    this.paused = false; // dijeda manual dari dashboard
    this.startedAt = Date.now();
    this.history = []; // market yang sudah selesai (untuk dashboard)
    this.account = { available: null, total: null, lockedEngine: null, username: null };
    this.lastPriceRefresh = 0;
  }

  // ------------------------------------------------------------------ lifecycle

  async start() {
    const c = this.cfg;
    this.log.info(
      `Bot mulai | mode=${this.live ? 'LIVE' : 'DRY-RUN (simulasi)'} | aset=${c.assets.join(',')} | maxOrder=$${c.maxOrderUsd} | minEdge=${c.minEdge} | trade saat sisa<=${c.tradeWhenSecondsLeft}s`,
    );
    if (this.live) {
      const me = await this.api.me().catch((e) => {
        throw new Error(`API key tidak valid / scope user:read tidak ada: ${e.message}`);
      });
      this.account.username = me?.username ?? me?.id ?? null;
      this.log.info(`Login sebagai ${me?.username ?? me?.id ?? '?'}`);
      await this.refreshRisk(true);
      // Market yang sudah punya order terbuka (dibuat manual) tidak akan disentuh bot
      const open = await this.api.openOrders();
      for (const o of open) this.foreignMarkets.add(o.market_id ?? o.marketId);
      if (open.length) this.log.warn(`${open.length} order terbuka yang sudah ada akan dibiarkan (market tersebut dilewati).`);
    }
    while (!this.stopping) {
      const t0 = Date.now();
      try {
        await this.tick();
      } catch (e) {
        this.log.error(`Error di loop: ${e.message}`);
      }
      const wait = this.cfg.pollMs - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
    }
  }

  async stop() {
    this.stopping = true;
    if (!this.live) return;
    this.log.info('Menghentikan bot: membatalkan semua order milik bot...');
    for (const entry of this.markets.values()) await this.cancelOrder(entry, 'bot berhenti');
  }

  // ------------------------------------------------------------------ loop

  async tick() {
    const now = Date.now();
    if (now - this.lastDiscovery >= this.cfg.discoveryMs) await this.refreshMarkets();
    if (this.live && now - this.lastRisk >= 30_000) await this.refreshRisk();
    if (this.live) await this.syncOrders();
    if (now - this.lastPriceRefresh >= 10_000) {
      // Segarkan harga semua aset (untuk ticker dashboard), error diabaikan
      this.lastPriceRefresh = now;
      await Promise.all(this.cfg.assets.map((a) => this.prices.series(a).catch(() => null)));
    }

    const entries = [...this.markets.values()].sort((a, b) => a.window.endMs - b.window.endMs);
    for (const entry of entries) {
      const secondsLeft = (entry.window.endMs - Date.now()) / 1000;

      if (secondsLeft <= -20) {
        const done = await this.settle(entry);
        if (done) this.markets.delete(entry.market.id);
        continue;
      }
      if (secondsLeft <= this.cfg.stopSecondsLeft) {
        if (entry.order) await this.cancelOrder(entry, 'mendekati penutupan');
        continue;
      }
      if (secondsLeft > this.cfg.tradeWhenSecondsLeft) continue;
      if (Date.now() < entry.window.startMs) continue;
      if (this.foreignMarkets.has(entry.market.id)) continue;

      try {
        await this.handleMarket(entry, secondsLeft);
      } catch (e) {
        this.log.error(`[${entry.asset}] gagal memproses market ${entry.market.id}: ${e.message}`);
      }
    }
  }

  async refreshMarkets() {
    this.lastDiscovery = Date.now();
    try {
      const { accepted, total } = await discoverMarkets(this.api, this.cfg);
      let added = 0;
      for (const a of accepted) {
        if (this.markets.has(a.market.id)) {
          this.markets.get(a.market.id).market = a.market; // perbarui data (pool, dll.)
          continue;
        }
        if (a.window.endMs < Date.now()) continue;
        this.markets.set(a.market.id, {
          market: a.market,
          asset: a.asset,
          sides: a.sides,
          window: a.window,
          type: marketType(a.market),
          strike: null,
          order: null, // {id, side, outcome, price, quantity, dry}
          hasPosition: false,
          bet: null,
          lastEval: null,
          paper: null,
          settleAttempts: 0,
        });
        added++;
      }
      this.log.debug(`Discovery: ${total} market di feed, ${accepted.length} cocok, ${added} baru, dipantau=${this.markets.size}`);
      if (added) this.log.info(`Menemukan ${added} market baru. Dipantau: ${this.markets.size}`);
    } catch (e) {
      this.log.error(`Discovery gagal: ${e.message}`);
    }
  }

  async refreshRisk(initial = false) {
    this.lastRisk = Date.now();
    try {
      const [bal, eq] = await Promise.all([this.api.balance(), this.api.equity().catch(() => null)]);
      const available = Number(bal?.balance?.available);
      if (this.cfg.bankrollUsd === null && Number.isFinite(available)) this.bankroll = available;
      this.account.available = Number.isFinite(available) ? available : null;
      this.account.total = Number(bal?.balance?.total) || null;
      this.account.lockedEngine = Number(bal?.balance?.lockedEngine) || 0;
      const dayPnl = Number(eq?.equity?.dayPnl ?? eq?.equity?.dayChange);
      if (Number.isFinite(dayPnl)) this.dayPnl = dayPnl;
      if (initial) this.log.info(`Saldo available=$${fmt(available, 2)} | PnL hari ini=$${fmt(this.dayPnl, 2)}`);

      if (this.dayPnl <= -this.cfg.maxDailyLossUsd && !this.halted) {
        this.halted = `rugi harian $${fmt(-this.dayPnl, 2)} >= batas $${this.cfg.maxDailyLossUsd}`;
        this.log.warn(`TRADING DIHENTIKAN: ${this.halted}. Membatalkan order...`);
        for (const entry of this.markets.values()) await this.cancelOrder(entry, 'batas rugi harian');
      }

      // Posisi aktif (untuk exposure & deteksi fill)
      const res = await this.api.positions({ marketType: 'ORDER_BOOK', limit: 500 });
      this.positionCost.clear();
      for (const p of res?.positions ?? []) {
        const cost = Number(p.totalBetAmount ?? p.costAmount ?? 0);
        this.positionCost.set(p.marketId, (this.positionCost.get(p.marketId) ?? 0) + (Number.isFinite(cost) ? cost : 0));
        const entry = this.markets.get(p.marketId);
        if (entry && Number(p.quantity ?? 1) > 0) entry.hasPosition = true;
      }
    } catch (e) {
      this.log.warn(`Gagal memperbarui risiko: ${e.message}`);
    }
  }

  /**
   * Deteksi fill: satu panggilan GET /orders per tick untuk semua order milik bot.
   * Order yang hilang dari daftar / sudah terisi sebagian => posisi ada, jangan buka sisi lawan.
   */
  async syncOrders() {
    const tracked = [...this.markets.values()].filter((e) => e.order && !e.order.dry);
    if (!tracked.length) return;
    let open;
    try {
      open = await this.api.openOrders();
    } catch (e) {
      this.log.warn(`Gagal sinkron order: ${e.message}`);
      return;
    }
    const byId = new Map(open.map((o) => [String(o.id), o]));
    for (const entry of tracked) {
      const o = byId.get(entry.order.id);
      if (!o) {
        this.log.info(`[${entry.asset}] order #${entry.order.id} sudah tidak terbuka (terisi). Posisi ditahan sampai market selesai.`);
        entry.order = null;
        entry.hasPosition = true;
      } else if (Number(o.cum_quantity ?? 0) > 0 && !entry.hasPosition) {
        this.log.info(`[${entry.asset}] order #${entry.order.id} terisi sebagian (${o.cum_quantity}/${o.quantity}).`);
        entry.hasPosition = true;
      }
    }
  }

  exposureUsd() {
    let total = 0;
    for (const entry of this.markets.values()) {
      if (entry.order) total += entry.order.price * entry.order.quantity;
      if (entry.bet) total += entry.bet.stake;
      if (!this.live && entry.paper && !entry.order) total += entry.paper.price * entry.paper.quantity;
    }
    for (const [marketId, cost] of this.positionCost) if (this.markets.has(marketId)) total += cost;
    return total;
  }

  // ------------------------------------------------------------------ per market

  async computeProbability(entry, secondsLeft) {
    const data = await this.prices.series(entry.asset);
    if (!data) return { pUp: null, reason: 'harga aset tidak tersedia' };

    if (entry.strike === null) {
      const s = extractStrike(entry.market);
      if (s) entry.strike = { ...s };
      else {
        const p = await this.prices.priceAt(entry.asset, entry.window.startMs);
        if (p !== null) entry.strike = { value: p, source: `harga@open(${data.source})` };
      }
    }
    if (!entry.strike) return { pUp: null, reason: 'harga acuan (strike) belum diketahui' };

    const sigma = estimateVolatility(data.series);
    const drift = estimateDrift(data.series, { lookbackSec: 300 });
    const pUp = probabilityUp({
      spot: data.spot,
      strike: entry.strike.value,
      secondsLeft,
      sigma,
      drift,
      momentumWeight: this.cfg.momentumWeight,
      sigmaMultiplier: this.cfg.sigmaMultiplier,
    });
    return { pUp, spot: data.spot, sigma, drift, source: data.source };
  }

  async handleMarket(entry, secondsLeft) {
    const m = entry.market;
    const est = await this.computeProbability(entry, secondsLeft);
    const tag = `[${entry.asset} ${Math.round(secondsLeft)}s]`;
    if (est.pUp === null) {
      this.log.debug(`${tag} lewati: ${est.reason}`);
      return;
    }
    entry.lastEval = { pUp: est.pUp, secondsLeft, spot: est.spot, sigma: est.sigma, at: Date.now() };

    if (this.halted) {
      entry.lastDecision = `dihentikan: ${this.halted}`;
      return;
    }
    if (this.paused) {
      entry.lastDecision = 'dijeda';
      return;
    }
    if (entry.hasPosition || entry.bet) {
      entry.lastDecision = 'menahan posisi';
      return;
    }

    const exposureLeftUsd = this.cfg.maxOpenExposureUsd - this.exposureUsd() + (entry.order ? entry.order.price * entry.order.quantity : 0);
    const bankroll = this.bankroll ?? 0;
    const info = `spot=${fmt(est.spot, 4)} strike=${fmt(entry.strike.value, 4)} pUp=${fmt(est.pUp)}`;

    if (entry.type === 'PARIMUTUEL') {
      const pools = parimutuelPools(m, entry.sides);
      const d = decideParimutuel({
        pUp: est.pUp,
        pools,
        feeRate: Number(m.platformFeeRate ?? 0) || 0,
        cfg: this.cfg,
        bankroll,
        exposureLeftUsd,
      });
      entry.lastDecision = d.action === 'bet' ? `taruh ${d.side.toUpperCase()} $${d.stake.toFixed(2)}` : d.reason;
      if (d.action !== 'bet') {
        this.log.debug(`${tag} ${info} -> skip: ${d.reason}`);
        return;
      }
      await this.placeBet(entry, d, tag, info);
      return;
    }

    const d = decideOrderBook({ pUp: est.pUp, cfg: this.cfg, bankroll, exposureLeftUsd });
    entry.lastDecision = d.action === 'buy' ? `beli ${d.side.toUpperCase()} @ ${d.price.toFixed(2)}` : d.reason;
    if (d.action !== 'buy') {
      this.log.debug(`${tag} ${info} -> skip: ${d.reason}`);
      if (entry.order) await this.cancelOrder(entry, `sinyal hilang (${d.reason})`);
      return;
    }

    if (entry.order) {
      if (entry.order.side !== d.side) {
        await this.cancelOrder(entry, 'arah model berbalik');
      } else if (Math.abs(entry.order.price - d.price) >= this.cfg.repriceThreshold - 1e-9) {
        await this.replaceOrder(entry, d, tag, info);
        return;
      } else {
        return; // order masih sesuai
      }
    }
    await this.placeOrder(entry, d, tag, info);
  }

  // ------------------------------------------------------------------ eksekusi

  outcomeParam(entry, side) {
    const o = entry.sides[side];
    return o.engineId ?? o.label;
  }

  async placeOrder(entry, d, tag, info) {
    const outcome = this.outcomeParam(entry, d.side);
    const priceStr = d.price.toFixed(2);
    const msg = `${tag} ${info} -> BELI ${d.side.toUpperCase()} (${entry.sides[d.side].label}) ${d.quantity} kontrak @ ${priceStr} (~$${d.stakeUsd.toFixed(2)}, p=${fmt(d.prob)})`;
    this.log.journal({ kind: 'order', live: this.live, marketId: entry.market.id, asset: entry.asset, ...d, strike: entry.strike, secondsLeft: entry.lastEval?.secondsLeft });

    if (!this.live) {
      this.log.info(`[DRY] ${msg}`);
      entry.order = { id: `dry-${Date.now()}`, side: d.side, outcome, price: d.price, quantity: d.quantity, dry: true };
      entry.paper = { side: d.side, price: d.price, quantity: d.quantity, prob: d.prob };
      return;
    }

    this.log.info(msg);
    try {
      const res = await this.api.placeOrder({
        marketId: entry.market.id,
        outcome,
        side: 'bid',
        type: 'Limit',
        price: priceStr,
        quantity: d.quantity,
      });
      const o = res?.order ?? {};
      entry.order = { id: String(o.id), side: d.side, outcome, price: d.price, quantity: d.quantity };
      entry.paper = { side: d.side, price: d.price, quantity: d.quantity, prob: d.prob };
      this.stats.trades++;
      this.log.info(`${tag} order #${o.id} status=${o.status}`);
    } catch (e) {
      this.log.error(`${tag} gagal pasang order: ${e.message}`);
      // POST /orders tidak idempoten. Bila timeout/jaringan, cek apakah order ternyata masuk.
      if (!e.status) await this.recoverUnknownOrder(entry, d, outcome);
    }
  }

  async recoverUnknownOrder(entry, d, outcome) {
    try {
      const open = await this.api.openOrders({ marketId: entry.market.id });
      const mine = open.find((o) => Number(o.price) === d.price && Number(o.quantity) === d.quantity && o.side === 'bid');
      if (mine) {
        entry.order = { id: String(mine.id), side: d.side, outcome, price: d.price, quantity: d.quantity };
        this.log.warn(`Order ternyata masuk (#${mine.id}), dilacak.`);
      }
    } catch (e) {
      this.log.error(`Tidak bisa memverifikasi order: ${e.message}. Market ini dilewati untuk keamanan.`);
      this.foreignMarkets.add(entry.market.id);
    }
  }

  async replaceOrder(entry, d, tag, info) {
    const priceStr = d.price.toFixed(2);
    if (!this.live || entry.order.dry) {
      this.log.info(`[DRY] ${tag} ${info} -> ubah harga ${entry.order.side.toUpperCase()} ${entry.order.price.toFixed(2)} -> ${priceStr}, qty ${d.quantity}`);
      entry.order = { ...entry.order, price: d.price, quantity: d.quantity };
      entry.paper = { side: d.side, price: d.price, quantity: d.quantity, prob: d.prob };
      return;
    }
    try {
      // Kurangi qty dengan yang sudah terisi agar exposure tidak bertambah
      const open = await this.api.openOrders({ marketId: entry.market.id });
      const current = open.find((o) => String(o.id) === entry.order.id);
      if (!current) {
        // Order sudah terisi penuh atau dibatalkan
        entry.order = null;
        entry.hasPosition = true;
        this.log.info(`${tag} order sudah tidak terbuka (kemungkinan terisi). Posisi ditahan.`);
        return;
      }
      if (Number(current.cum_quantity ?? 0) > 0) {
        entry.hasPosition = true; // sebagian terisi: jangan ubah lagi
        return;
      }
      const res = await this.api.replaceOrder({ marketId: entry.market.id, orderId: entry.order.id, price: priceStr, quantity: d.quantity });
      const r = res?.result ?? {};
      if (r.status === 'unchanged') return;
      entry.order = { ...entry.order, id: String(r.replacementOrderId ?? r.replacementOrder?.id ?? entry.order.id), price: d.price, quantity: d.quantity };
      entry.paper = { side: d.side, price: d.price, quantity: d.quantity, prob: d.prob };
      this.log.info(`${tag} ${info} -> harga order diubah ke ${priceStr} (qty ${d.quantity})`);
    } catch (e) {
      this.log.error(`${tag} gagal ubah order: ${e.message}`);
    }
  }

  async cancelOrder(entry, reason) {
    if (!entry.order) return;
    const tag = `[${entry.asset}]`;
    if (!this.live || entry.order.dry) {
      this.log.info(`[DRY] ${tag} batalkan order ${entry.order.side.toUpperCase()} @ ${entry.order.price.toFixed(2)} (${reason})`);
      entry.order = null;
      // Dalam simulasi, order dianggap terisi (asumsi optimis) kecuali dibatalkan karena sinyal berubah
      if (reason !== 'mendekati penutupan' && reason !== 'bot berhenti') entry.paper = null;
      return;
    }
    try {
      await this.api.cancelOrders(entry.market.id, [entry.order.id]);
      this.log.info(`${tag} order #${entry.order.id} dibatalkan (${reason})`);
    } catch (e) {
      // 404/400 biasanya berarti order sudah terisi/ditutup
      this.log.warn(`${tag} batal order #${entry.order.id} gagal: ${e.message}`);
    }
    entry.order = null;
  }

  async placeBet(entry, d, tag, info) {
    const o = entry.sides[d.side];
    const msg = `${tag} ${info} -> TARUH $${d.stake.toFixed(2)} di ${d.side.toUpperCase()} (${o.label}) payout≈${fmt(d.payout, 2)}x EV=${fmt(d.ev)}`;
    this.log.journal({ kind: 'bet', live: this.live, marketId: entry.market.id, asset: entry.asset, ...d, strike: entry.strike });
    if (!this.live) {
      this.log.info(`[DRY] ${msg}`);
      entry.bet = { side: d.side, stake: d.stake };
      entry.paper = { side: d.side, price: 1 / d.payout, quantity: d.stake * d.payout, prob: d.prob };
      return;
    }
    this.log.info(msg);
    try {
      const res = await this.api.placeBet({
        marketId: entry.market.id,
        outcomeIndex: o.index,
        amount: d.stake,
        idempotencyKey: `bot:${entry.market.id}:${d.side}`,
      });
      entry.bet = { side: d.side, stake: d.stake };
      entry.paper = { side: d.side, price: 1 / d.payout, quantity: d.stake * d.payout, prob: d.prob };
      this.stats.trades++;
      this.log.info(`${tag} bet ${res?.bet?.id} status=${res?.bet?.status}`);
    } catch (e) {
      this.log.error(`${tag} gagal taruh bet: ${e.message}`);
    }
  }

  // ------------------------------------------------------------------ evaluasi

  /** Setelah market selesai: catat hasil untuk evaluasi akurasi model. @returns {Promise<boolean>} selesai? */
  async settle(entry) {
    entry.settleAttempts++;
    if (!entry.lastEval || !entry.strike) return true;

    let outcomeUp = null;
    let source = null;
    try {
      const res = await this.api.market(entry.market.id);
      const mk = res?.market ?? res;
      if (mk?.winningOutcome !== undefined && mk?.winningOutcome !== null) {
        outcomeUp = Number(mk.winningOutcome) === entry.sides.up.index ? 1 : 0;
        source = 'unhedged';
      }
    } catch {
      /* belum resolve */
    }
    if (outcomeUp === null) {
      if (entry.settleAttempts < 8) return false; // tunggu hasil resmi sedikit lagi
      const finalPrice = await this.prices.priceAt(entry.asset, entry.window.endMs);
      if (finalPrice === null) return true;
      outcomeUp = finalPrice > entry.strike.value ? 1 : 0;
      source = 'harga-bursa';
    }

    const s = this.stats;
    s.settled++;
    s.scored++;
    s.brierSum += brier(entry.lastEval.pUp, outcomeUp);
    if ((entry.lastEval.pUp >= 0.5 ? 1 : 0) === outcomeUp) s.correct++;
    let tradeNote = '';
    let trade = null;
    // Live: hanya laporkan bila order benar-benar terisi (posisi terdeteksi) atau bet masuk
    if (entry.paper && (!this.live || entry.hasPosition || entry.bet)) {
      const won = (entry.paper.side === 'up' ? 1 : 0) === outcomeUp;
      const pnl = won ? entry.paper.quantity * (1 - entry.paper.price) : -entry.paper.quantity * entry.paper.price;
      if (!this.live) {
        s.paperPnl += pnl;
        if (won) s.wins++;
        s.trades++;
      }
      trade = { side: entry.paper.side, price: entry.paper.price, quantity: entry.paper.quantity, won, pnl };
      tradeNote = ` | posisi ${entry.paper.side.toUpperCase()} ${won ? 'MENANG' : 'KALAH'} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
    }
    this.history.push({
      ts: Date.now(),
      endMs: entry.window.endMs,
      marketId: entry.market.id,
      asset: entry.asset,
      question: entry.market.question ?? entry.market.title ?? '',
      outcome: outcomeUp ? 'up' : 'down',
      source,
      pUp: entry.lastEval.pUp,
      correct: (entry.lastEval.pUp >= 0.5 ? 1 : 0) === outcomeUp,
      trade,
    });
    if (this.history.length > 500) this.history.shift();
    this.log.journal({ kind: 'settle', marketId: entry.market.id, asset: entry.asset, outcomeUp, source, lastEval: entry.lastEval, paper: entry.paper });
    this.log.info(
      `[${entry.asset}] selesai: ${outcomeUp ? 'UP' : 'DOWN'} (sumber ${source}), prediksi terakhir pUp=${fmt(entry.lastEval.pUp)}${tradeNote}` +
        ` | akurasi ${s.correct}/${s.scored}, Brier ${fmt(s.brierSum / s.scored)}` +
        (!this.live ? ` | paper PnL $${s.paperPnl.toFixed(2)} (${s.wins}/${s.trades} menang)` : ''),
    );
    return true;
  }

  // ------------------------------------------------------------------ kontrol & dashboard

  async setPaused(paused) {
    this.paused = paused;
    this.log.warn(paused ? 'Trading DIJEDA dari dashboard.' : 'Trading DILANJUTKAN dari dashboard.');
    if (paused) for (const entry of this.markets.values()) await this.cancelOrder(entry, 'dijeda');
  }

  async cancelAll() {
    this.log.warn('Membatalkan semua order bot (permintaan dashboard).');
    for (const entry of this.markets.values()) await this.cancelOrder(entry, 'dibatalkan dari dashboard');
  }

  resumeAfterHalt() {
    if (!this.halted) return;
    this.log.warn(`Rem darurat dilepas manual (sebelumnya: ${this.halted}).`);
    this.halted = null;
  }

  /** Data ringkas untuk dashboard (tanpa API key/rahasia). */
  snapshot() {
    const now = Date.now();
    const c = this.cfg;
    const s = this.stats;
    const markets = [...this.markets.values()]
      .sort((a, b) => a.window.endMs - b.window.endMs)
      .map((e) => ({
        id: e.market.id,
        asset: e.asset,
        type: e.type,
        question: e.market.question ?? e.market.title ?? '',
        startMs: e.window.startMs,
        endMs: e.window.endMs,
        secondsLeft: (e.window.endMs - now) / 1000,
        upLabel: e.sides.up.label,
        downLabel: e.sides.down.label,
        strike: e.strike?.value ?? null,
        strikeSource: e.strike?.source ?? null,
        pUp: e.lastEval?.pUp ?? null,
        spot: e.lastEval?.spot ?? null,
        evalAgeSec: e.lastEval ? (now - e.lastEval.at) / 1000 : null,
        decision: e.lastDecision ?? null,
        order: e.order ? { side: e.order.side, price: e.order.price, quantity: e.order.quantity, dry: !!e.order.dry } : null,
        hasPosition: e.hasPosition || !!e.bet,
        foreign: this.foreignMarkets.has(e.market.id),
      }));

    const prices = {};
    for (const a of c.assets) {
      const cached = this.prices.cache?.get(a)?.data;
      if (!cached) continue;
      const cutoff = now - 60 * 60_000;
      prices[a] = {
        spot: cached.spot,
        source: cached.source,
        series: cached.series.filter((p) => p.t >= cutoff).map((p) => [p.t, p.p]),
      };
    }

    const tradesDone = this.history.filter((h) => h.trade);
    const realized = tradesDone.reduce((acc, h) => acc + h.trade.pnl, 0);
    return {
      now,
      mode: this.live ? 'LIVE' : 'DRY-RUN',
      startedAt: this.startedAt,
      paused: this.paused,
      halted: this.halted,
      account: { ...this.account, dayPnl: this.live ? this.dayPnl : null, bankroll: this.bankroll },
      exposureUsd: this.exposureUsd(),
      config: {
        assets: c.assets,
        maxOrderUsd: c.maxOrderUsd,
        maxOpenExposureUsd: c.maxOpenExposureUsd,
        maxDailyLossUsd: c.maxDailyLossUsd,
        minEdge: c.minEdge,
        kellyFraction: c.kellyFraction,
        tradeWhenSecondsLeft: c.tradeWhenSecondsLeft,
        stopSecondsLeft: c.stopSecondsLeft,
        sigmaMultiplier: c.sigmaMultiplier,
      },
      stats: {
        settled: s.settled,
        accuracy: s.scored ? s.correct / s.scored : null,
        brier: s.scored ? s.brierSum / s.scored : null,
        trades: tradesDone.length,
        wins: tradesDone.filter((h) => h.trade.won).length,
        pnl: realized,
      },
      markets,
      prices,
      history: this.history.slice(-200),
      logs: this.log.recent ? this.log.recent(150) : [],
    };
  }
}
