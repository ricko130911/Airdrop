import { discoverMarkets, extractStrike, marketType, resolverInfo, bookTop, marketTakerFee, priceSourceOf } from './markets.js';
import { estimateVolatility, estimateDrift, probabilityUp, probabilityUpTwap, brier } from './model.js';
import { decideOrderBook, decideParimutuel, parimutuelPools, completeSetArb, decideSnipe, feeFor } from './strategy.js';
import { Learner, CHECKPOINTS, RECORD_VERSION, loadRecords, settleRecords, tradesFromRecords } from './analytics.js';
import path from 'node:path';

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
    // Pembelajaran dari hasil sendiri: kalibrasi peluang + deteksi zona rugi
    this.learner = new Learner({
      enabled: cfg.adaptive !== false,
      minZoneTrades: cfg.adaptiveMinTrades ?? 25,
      minCalibrationSamples: cfg.calibrationMinSamples ?? 40,
    });
  }

  /** Muat riwayat dari logs/decisions.jsonl agar statistik & pembelajaran tidak hilang saat restart. */
  loadHistory() {
    const file = path.join(this.cfg.logDir ?? 'logs', 'decisions.jsonl');
    try {
      const records = settleRecords(loadRecords(file));
      this.learner.addRecords(records);
      for (const r of records) this.applySettleRecord(r);
      if (records.length) {
        const rep = this.learner.report();
        this.log.info(
          `Riwayat dimuat: ${records.length} market, ${rep.total.n} trade, PnL $${rep.total.pnl.toFixed(2)}` +
            ` | kalibrasi aktif: ${rep.calibration.filter((c) => c.active).map((c) => `${c.checkpoint}s(k=${c.k.toFixed(2)})`).join(', ') || 'belum (data kurang)'}`,
        );
      }
    } catch (e) {
      this.log.warn(`Gagal memuat riwayat: ${e.message}`);
    }
  }

  // ------------------------------------------------------------------ lifecycle

  async start() {
    const c = this.cfg;
    this.loadHistory();
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
      const wait = (this.fastMode ? this.cfg.snipePollMs : this.cfg.pollMs) - (Date.now() - t0);
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

    const { startAt, stopAt } = this.tradeWindow();
    const entries = [...this.markets.values()].sort((a, b) => a.window.endMs - b.window.endMs);
    // Mode cepat (poll ~1 detik) selama ada market di jendela tembak sniper
    this.fastMode =
      this.cfg.strategy === 'sniper' &&
      entries.some((e) => {
        const left = (e.window.endMs - Date.now()) / 1000;
        return left <= startAt + 3 && left > stopAt - 1;
      });
    for (const entry of entries) {
      const secondsLeft = (entry.window.endMs - Date.now()) / 1000;

      if (secondsLeft <= -20) {
        const done = await this.settle(entry);
        if (done) this.markets.delete(entry.market.id);
        continue;
      }
      if (secondsLeft <= stopAt) {
        if (entry.order) await this.cancelOrder(entry, 'mendekati penutupan');
        continue;
      }
      if (secondsLeft > startAt) continue;
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
        this.prices.setAssetSource(a.asset, priceSourceOf(a.market, a.asset));
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
        if (entry.paper && !entry.paper.fill) entry.paper.fill = this.fillInfo(entry, entry.paper.side, entry.paper.price);
        entry.order = null;
        entry.hasPosition = true;
      } else if (Number(o.cum_quantity ?? 0) > 0 && !entry.hasPosition) {
        this.log.info(`[${entry.asset}] order #${entry.order.id} terisi sebagian (${o.cum_quantity}/${o.quantity}).`);
        if (entry.paper && !entry.paper.fill) entry.paper.fill = this.fillInfo(entry, entry.paper.side, entry.paper.price);
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

  /** Ambil data market terbaru (harga acuan resmi + order book teratas). */
  async refreshMarketDetail(entry) {
    try {
      const res = await this.api.market(entry.market.id);
      const mk = res?.market ?? res;
      if (mk && mk.id === entry.market.id) entry.market = { ...entry.market, ...mk };
    } catch (e) {
      this.log.debug(`[${entry.asset}] gagal ambil detail market: ${e.message}`);
    }
    entry.book = bookTop(entry.market, entry.sides);
    entry.feeRate = this.cfg.feeRate ?? marketTakerFee(entry.market);
  }

  async computeProbability(entry, secondsLeft) {
    const data = await this.prices.series(entry.asset);
    if (!data) return { pUp: null, reason: 'harga aset tidak tersedia' };
    const r = resolverInfo(entry.market);
    const avgSec = r.averagingSeconds || 0;

    // Harga acuan: pakai nilai resmi Unhedged (TWAP 60 detik sebelum window dimulai)
    if (!entry.strike?.final) {
      const s = extractStrike(entry.market);
      if (s) entry.strike = s;
      else if (!entry.strike) {
        const from = entry.window.startMs - (avgSec || 1) * 1000;
        const p = await this.prices.twap(entry.asset, from, entry.window.startMs);
        if (p !== null) entry.strike = { value: p, source: `hitung-sendiri:twap-${avgSec || 1}s`, final: false };
      }
    }
    if (!entry.strike) return { pUp: null, reason: 'harga acuan (strike) belum diketahui' };

    const sigma = estimateVolatility(data.series);
    const drift = estimateDrift(data.series, { lookbackSec: 300 });
    const common = {
      spot: data.spot,
      secondsLeft,
      sigma,
      drift,
      momentumWeight: this.cfg.momentumWeight,
      sigmaMultiplier: this.cfg.sigmaMultiplier,
    };

    let pUp;
    let known = null;
    if (avgSec > 0) {
      const endWindowStart = entry.window.endMs - avgSec * 1000;
      if (Date.now() > endWindowStart) known = await this.prices.secondCloses(entry.asset, endWindowStart, entry.window.endMs);
      pUp = probabilityUpTwap({
        ...common,
        threshold: entry.strike.value,
        avgSeconds: avgSec,
        knownSum: known?.sum ?? 0,
        knownCount: known?.count ?? 0,
      });
    } else {
      pUp = probabilityUp({ ...common, strike: entry.strike.value });
    }
    const knownAvg = known?.count ? known.sum / known.count : null;
    // Data per detik harus lengkap: detik yang sudah lewat di jendela rata-rata harus sudah ada datanya
    const elapsed = avgSec > 0 ? Math.max(0, Math.floor(avgSec - secondsLeft)) : 0;
    const dataOk = avgSec === 0 || elapsed === 0 || (known?.count ?? 0) >= elapsed - 3;
    return { pUp, spot: data.spot, sigma, drift, source: data.source, knownAvg, knownCount: known?.count ?? 0, knownSource: known?.source, dataOk, elapsed };
  }

  /** Simulasi fill (DRY-RUN): order terisi hanya bila ada ask di order book <= harga order. */
  simulateFill(entry, tag) {
    const o = entry.order;
    if (!o?.dry) return;
    const ask = entry.book?.[o.side]?.bestAsk ?? null;
    if (ask === null || ask > o.price) return;
    const fill = Math.min(ask, o.price);
    const fee = feeFor(fill, entry.feeRate ?? 0, this.cfg.feeModel) * o.quantity;
    entry.paper = { side: o.side, price: fill, quantity: o.quantity, fee, probe: !!o.probe, strategy: o.strategy ?? 'model', fill: this.fillInfo(entry, o.side, fill) };
    entry.hasPosition = true;
    entry.order = null;
    const f = entry.paper.fill;
    this.log.info(
      `[DRY] ${tag} order TERISI: ${o.side.toUpperCase()} ${o.quantity} @ ${fill.toFixed(2)} (fee ~$${fee.toFixed(2)})` +
        ` | sisa ${f.secondsLeft}s, p=${fmt(f.prob)}, edge ${f.edge !== null ? (f.edge * 100).toFixed(1) + '¢' : '-'}${o.probe ? ' [PROBE]' : ''}`,
    );
  }

  async handleMarket(entry, secondsLeft) {
    const m0 = entry.market;
    await this.refreshMarketDetail(entry);
    const m = entry.market ?? m0;
    const tag = `[${entry.asset} ${Math.round(secondsLeft)}s]`;

    // Arbitrase complete set (UP + DOWN < $1 setelah fee)
    const arb = completeSetArb(entry.book, entry.feeRate);
    if (arb && !entry.arb) {
      this.log.warn(`${tag} PELUANG ARBITRASE: ask UP ${entry.book.up.bestAsk} + ask DOWN ${entry.book.down.bestAsk} = $${arb.costPerSet.toFixed(3)} per set (untung ~$${arb.profitPerSet.toFixed(3)}/set sebelum slippage)`);
      this.log.journal({ kind: 'arb', marketId: m.id, asset: entry.asset, book: entry.book, ...arb });
    }
    entry.arb = arb;

    this.simulateFill(entry, tag);

    const est = await this.computeProbability(entry, secondsLeft);
    if (est.pUp === null) {
      entry.lastDecision = est.reason;
      this.log.debug(`${tag} lewati: ${est.reason}`);
      return;
    }
    // Catat peluang mentah di titik-titik waktu tetap (bahan kalibrasi, untuk SEMUA market)
    entry.checkpoints ??= [];
    for (const c of CHECKPOINTS) {
      if (secondsLeft <= c && secondsLeft > c - 30 && !entry.checkpoints.some((x) => x.s === c)) {
        entry.checkpoints.push({ s: c, pUp: est.pUp, at: Math.round(secondsLeft) });
      }
    }
    const pUpRaw = est.pUp;
    est.pUp = this.learner.calibrate(pUpRaw, secondsLeft);
    entry.lastEval = { pUp: est.pUp, pUpRaw, secondsLeft, spot: est.spot, sigma: est.sigma, knownAvg: est.knownAvg, knownCount: est.knownCount, at: Date.now() };

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
    const twapInfo = est.knownCount ? ` twap60=${fmt(est.knownAvg, 4)}(${est.knownCount}s)` : '';
    const calInfo = Math.abs(est.pUp - pUpRaw) > 0.005 ? ` (mentah ${fmt(pUpRaw)})` : '';
    const info = `spot=${fmt(est.spot, 4)} acuan=${fmt(entry.strike.value, 4)}${twapInfo} pUp=${fmt(est.pUp)}${calInfo}`;

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

    if (this.cfg.strategy === 'sniper') {
      await this.handleSnipe(entry, secondsLeft, est, pUpRaw, tag, info, exposureLeftUsd);
      return;
    }

    const zone = this.learner.zoneVerdict(entry.asset, secondsLeft);
    let d = decideOrderBook({
      pUp: est.pUp,
      cfg: this.cfg,
      bankroll,
      exposureLeftUsd,
      feeRate: entry.feeRate ?? 0,
      currentSide: entry.order?.side ?? null,
      book: entry.book,
    });
    if (d.action === 'buy' && zone.blocked) {
      // Zona terbukti rugi: hanya kirim order "probe" 1 kontrak (atau lewati) agar tetap bisa belajar
      d = this.cfg.probeTrades !== false ? { ...d, quantity: 1, stakeUsd: d.price, probe: true, probeReason: zone.reason } : { action: 'skip', reason: zone.reason };
    }
    entry.lastDecision =
      d.action === 'buy'
        ? `bid ${d.side.toUpperCase()} @ ${d.price.toFixed(2)}${d.ask !== null ? ` · ask ${d.ask.toFixed(2)}` : ' · belum ada penjual'}${d.probe ? ` · probe (${d.probeReason})` : ''}`
        : d.reason;
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
        this.simulateFill(entry, tag);
        return;
      } else {
        return; // order masih sesuai
      }
    }
    await this.placeOrder(entry, d, tag, info);
    this.simulateFill(entry, tag);
  }

  // ------------------------------------------------------------------ eksekusi

  outcomeParam(entry, side) {
    const o = entry.sides[side];
    return o.engineId ?? o.label;
  }

  async placeOrder(entry, d, tag, info) {
    const outcome = this.outcomeParam(entry, d.side);
    const priceStr = d.price.toFixed(2);
    const msg = `${tag} ${info} -> BELI ${d.side.toUpperCase()} (${entry.sides[d.side].label}) ${d.quantity} kontrak @ ${priceStr} (~$${d.stakeUsd.toFixed(2)}, p=${fmt(d.prob)})${d.probe ? ' [PROBE]' : ''}`;
    this.log.journal({ kind: 'order', live: this.live, marketId: entry.market.id, asset: entry.asset, ...d, strike: entry.strike, secondsLeft: entry.lastEval?.secondsLeft });

    if (!this.live) {
      this.log.info(`[DRY] ${msg}`);
      entry.order = { id: `dry-${Date.now()}`, side: d.side, outcome, price: d.price, quantity: d.quantity, dry: true, probe: !!d.probe, strategy: d.strategy ?? 'model' };
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
      entry.order = { id: String(o.id), side: d.side, outcome, price: d.price, quantity: d.quantity, probe: !!d.probe, strategy: d.strategy ?? 'model' };
      const px = d.fillsNow ? d.ask : d.price;
      entry.paper = { side: d.side, price: px, quantity: d.quantity, fee: feeFor(px, entry.feeRate ?? 0, this.cfg.feeModel) * d.quantity, probe: !!d.probe, strategy: d.strategy ?? 'model' };
      if (d.fillsNow) entry.paper.fill = this.fillInfo(entry, d.side, px);
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
      entry.paper = { side: d.side, price: d.price, quantity: d.quantity, fee: (entry.feeRate ?? 0) * d.price * d.quantity };
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
      entry.order = null; // order simulasi yang dibatalkan = tidak pernah terisi
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
      } else if (mk) {
        const r = resolverInfo(mk);
        if (r.endPrice !== null && r.threshold !== null && r.endStatus === 'final') {
          outcomeUp = r.endPrice >= r.threshold ? 1 : 0; // aturan Unhedged: sama dengan = UP
          source = 'unhedged-twap';
        }
      }
    } catch {
      /* belum resolve */
    }
    if (outcomeUp === null) {
      if (entry.settleAttempts < 8) return false; // tunggu hasil resmi sedikit lagi
      const avgSec = resolverInfo(entry.market).averagingSeconds || 60;
      const finalPrice = await this.prices.twap(entry.asset, entry.window.endMs - avgSec * 1000, entry.window.endMs);
      if (finalPrice === null) return true;
      outcomeUp = finalPrice >= entry.strike.value ? 1 : 0;
      source = 'hitung-sendiri';
    }

    // Live: posisi hanya dihitung bila order benar-benar terisi (posisi terdeteksi) atau bet masuk
    const paper = entry.paper && (!this.live || entry.hasPosition || entry.bet) ? entry.paper : null;
    const record = {
      kind: 'settle',
      v: RECORD_VERSION,
      ts: new Date().toISOString(),
      marketId: entry.market.id,
      asset: entry.asset,
      question: entry.market.question ?? entry.market.title ?? '',
      endMs: entry.window.endMs,
      outcomeUp,
      source,
      strike: entry.strike,
      lastEval: entry.lastEval,
      checkpoints: entry.checkpoints ?? [],
      paper,
    };
    this.log.journal(record);
    this.learner.addRecord(record);
    const trade = this.applySettleRecord(record);
    const s = this.stats;
    const tradeNote = trade
      ? ` | posisi ${trade.side.toUpperCase()} ${trade.won ? 'MENANG' : 'KALAH'} ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}${trade.probe ? ' (probe)' : ''}`
      : '';
    this.log.info(
      `[${entry.asset}] selesai: ${outcomeUp ? 'UP' : 'DOWN'} (sumber ${source}), prediksi terakhir pUp=${fmt(entry.lastEval.pUp)}${tradeNote}` +
        ` | akurasi ${s.correct}/${s.scored}, Brier ${fmt(s.brierSum / s.scored)}` +
        ` | PnL ${this.live ? '' : 'simulasi '}$${s.paperPnl.toFixed(2)} (${s.wins}/${s.trades} menang)`,
    );
    return true;
  }

  /** Jendela trading efektif (detik tersisa) sesuai strategi. */
  tradeWindow() {
    return this.cfg.strategy === 'sniper'
      ? { startAt: this.cfg.snipeMaxSec, stopAt: this.cfg.snipeMinSec }
      : { startAt: this.cfg.tradeWhenSecondsLeft, stopAt: this.cfg.stopSecondsLeft };
  }

  /** Statistik hari ini (UTC): PnL, jumlah trade, dan kekalahan sniper. */
  todayStats() {
    const day = new Date().toISOString().slice(0, 10);
    let pnl = 0;
    let trades = 0;
    let wins = 0;
    let snipeLosses = 0;
    for (const h of this.history) {
      if (!h.trade || new Date(h.ts).toISOString().slice(0, 10) !== day) continue;
      trades++;
      pnl += h.trade.pnl;
      if (h.trade.won) wins++;
      else if (h.trade.strategy === 'sniper') snipeLosses++;
    }
    return { day, pnl, trades, wins, snipeLosses };
  }

  /**
   * Strategi SNIPER: tembak di detik-detik terakhir hanya bila hasil hampir pasti,
   * data per detik lengkap, ada penjual, dan masih untung setelah fee.
   */
  async handleSnipe(entry, secondsLeft, est, pUpRaw, tag, info, exposureLeftUsd) {
    // Order sniper yang tidak langsung terisi tidak dikejar: batalkan
    if (entry.order) {
      await this.cancelOrder(entry, 'tembakan tidak terisi, tidak dikejar');
      return;
    }
    const today = this.todayStats();
    if (this.cfg.snipeMaxLossesPerDay > 0 && today.snipeLosses >= this.cfg.snipeMaxLossesPerDay) {
      entry.lastDecision = `rem sniper: ${today.snipeLosses} kalah hari ini, lanjut besok`;
      return;
    }
    if (this.cfg.dailyProfitTargetUsd > 0 && today.pnl >= this.cfg.dailyProfitTargetUsd) {
      entry.lastDecision = `target harian tercapai (+$${today.pnl.toFixed(2)})`;
      return;
    }
    if (!est.dataOk) {
      entry.lastDecision = `data per detik belum lengkap (${est.knownCount}/${est.elapsed} dtk)`;
      return;
    }
    // Pakai peluang yang paling konservatif antara model mentah & terkalibrasi
    const side = est.pUp >= 0.5 ? 'up' : 'down';
    const sideProb = (p) => (side === 'up' ? p : 1 - p);
    const prob = Math.min(sideProb(est.pUp), sideProb(pUpRaw));
    // Taruhan boleh dinaikkan hanya bila sniper sudah terbukti untung & belum kalah hari ini
    const trust = this.learner.sniperTrust(this.cfg.snipeTrustTrades);
    const allowScale = trust.trusted && today.snipeLosses === 0;
    const d = decideSnipe({
      prob,
      side,
      book: entry.book,
      feeRate: entry.feeRate ?? 0,
      cfg: this.cfg,
      exposureLeftUsd,
      bankroll: this.bankroll ?? 0,
      allowScale,
    });
    let sizeNote = '';
    if (d.action === 'buy') {
      if (d.sizing.scaled) sizeNote = ` · taruhan dinaikkan ke $${d.stakeUsd.toFixed(2)} (yakin ${(prob * 100).toFixed(1)}%)`;
      else if (!trust.trusted) sizeNote = ` · taruhan minimum $${d.stakeUsd.toFixed(2)} (belum terbukti: ${trust.reason})`;
      else if (today.snipeLosses) sizeNote = ` · taruhan minimum $${d.stakeUsd.toFixed(2)} (sudah kalah hari ini)`;
      else sizeNote = ` · taruhan $${d.stakeUsd.toFixed(2)}`;
    }
    entry.lastDecision =
      d.action === 'buy' ? `TEMBAK ${side.toUpperCase()} @ ${d.price.toFixed(2)} · untung ~${(d.ev * 100).toFixed(1)}¢/kontrak${sizeNote}` : `sniper: ${d.reason}`;
    if (d.action !== 'buy') {
      this.log.debug(`${tag} ${info} -> sniper skip: ${d.reason}`);
      return;
    }
    await this.placeOrder(entry, d, `${tag} [SNIPER${d.sizing.scaled ? ' +' : ''}]`, info + sizeNote);
    this.simulateFill(entry, tag);
  }

  /** Detail saat order terisi: sisa waktu, peluang model, ask, dan edge setelah fee. */
  fillInfo(entry, side, price) {
    const ev = entry.lastEval;
    const prob = ev ? (side === 'up' ? ev.pUp : 1 - ev.pUp) : null;
    const fee = entry.feeRate ?? 0;
    return {
      secondsLeft: Math.round((entry.window.endMs - Date.now()) / 1000),
      prob,
      pUpRaw: ev?.pUpRaw ?? null,
      ask: entry.book?.[side]?.bestAsk ?? null,
      edge: prob !== null ? prob - price - feeFor(price, fee, this.cfg.feeModel) : null,
      knownCount: ev?.knownCount ?? 0,
      at: Date.now(),
    };
  }

  /** Tambahkan hasil market ke statistik & riwayat dashboard (dipakai juga saat memuat log). */
  applySettleRecord(r) {
    const s = this.stats;
    const pUp = r.lastEval?.pUp;
    s.settled++;
    if (Number.isFinite(pUp)) {
      s.scored++;
      s.brierSum += brier(pUp, r.outcomeUp);
      if ((pUp >= 0.5 ? 1 : 0) === r.outcomeUp) s.correct++;
    }
    const [t] = tradesFromRecords([r]);
    let trade = null;
    if (t) {
      trade = { side: t.side, price: t.price, quantity: t.quantity, won: t.won, pnl: t.pnl, probe: t.probe, strategy: t.strategy, secondsLeft: t.secondsLeft, prob: t.prob, edge: t.edge };
      s.paperPnl += t.pnl;
      s.trades++;
      if (t.won) s.wins++;
    }
    this.history.push({
      ts: Date.parse(r.ts) || Date.now(),
      endMs: r.endMs ?? (Date.parse(r.ts) || Date.now()),
      marketId: r.marketId,
      asset: r.asset,
      question: r.question ?? '',
      outcome: r.outcomeUp ? 'up' : 'down',
      source: r.source,
      pUp,
      correct: Number.isFinite(pUp) ? (pUp >= 0.5 ? 1 : 0) === r.outcomeUp : null,
      trade,
    });
    if (this.history.length > 500) this.history.shift();
    return trade;
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
        twapKnown: e.lastEval?.knownCount ? { avg: e.lastEval.knownAvg, count: e.lastEval.knownCount } : null,
        book: e.book ?? null,
        feeRate: e.feeRate ?? null,
        arb: e.arb ?? null,
        pUp: e.lastEval?.pUp ?? null,
        pUpRaw: e.lastEval?.pUpRaw ?? null,
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

    return {
      now,
      mode: this.live ? 'LIVE' : 'DRY-RUN',
      startedAt: this.startedAt,
      paused: this.paused,
      halted: this.halted,
      account: { ...this.account, dayPnl: this.live ? this.dayPnl : null, bankroll: this.bankroll },
      exposureUsd: this.exposureUsd(),
      config: {
        strategy: c.strategy,
        snipe:
          c.strategy === 'sniper'
            ? {
                minProb: c.snipeMinProb,
                maxPrice: c.snipeMaxPrice,
                minEv: c.snipeMinEv,
                usd: c.snipeUsd,
                maxUsd: c.snipeMaxUsd,
                maxLossesPerDay: c.snipeMaxLossesPerDay,
                dailyTarget: c.dailyProfitTargetUsd,
                feeModel: c.feeModel,
                trust: this.learner.sniperTrust(c.snipeTrustTrades),
              }
            : null,
        assets: c.assets,
        maxOrderUsd: c.maxOrderUsd,
        maxOpenExposureUsd: c.maxOpenExposureUsd,
        maxDailyLossUsd: c.maxDailyLossUsd,
        minEdge: c.minEdge,
        kellyFraction: c.kellyFraction,
        tradeWhenSecondsLeft: this.tradeWindow().startAt,
        stopSecondsLeft: this.tradeWindow().stopAt,
        sigmaMultiplier: c.sigmaMultiplier,
      },
      stats: {
        settled: s.settled,
        accuracy: s.scored ? s.correct / s.scored : null,
        brier: s.scored ? s.brierSum / s.scored : null,
        trades: s.trades,
        wins: s.wins,
        pnl: s.paperPnl,
        today: this.todayStats(),
      },
      markets,
      prices,
      history: this.history.slice(-200),
      logs: this.log.recent ? this.log.recent(150) : [],
      learning: this.learner.report(),
    };
  }
}
