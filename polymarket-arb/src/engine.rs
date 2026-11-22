//! Hot path: WebSocket frames -> flat order books -> arb check -> fire.
//!
//! Everything here runs on a single task with no locks on the decision path (the dashboard
//! is updated with throttled, sub-microsecond lock sections). A frame is parsed with
//! zero-copy borrowed strings, prices are parsed straight into integer pips, and an
//! opportunity is turned into a spawned signing+POST task immediately.

use std::collections::HashMap;
use std::str::FromStr as _;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt as _, StreamExt as _};
use polymarket_client_sdk_v2::clob::types::TickSize;
use polymarket_client_sdk_v2::types::Decimal;
use ratatui::style::Color;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};

use crate::arb::{self, Limits};
use crate::book::{AskBook, parse_px, px_to_f64};
use crate::config::Config;
use crate::dash::{Dash, MarketView, col, dim, tag, txt};
use crate::discovery::MarketInfo;
use crate::exec::{Executor, PairJob, PairResult};

const LOG_THROTTLE: Duration = Duration::from_millis(400);

// ---------- wire format (borrowed, zero-copy) ----------

#[derive(Deserialize)]
struct Lvl<'a> {
    #[serde(borrow)]
    price: &'a str,
    #[serde(borrow)]
    size: &'a str,
}

#[derive(Deserialize)]
struct Pc<'a> {
    #[serde(borrow)]
    asset_id: &'a str,
    #[serde(borrow)]
    price: &'a str,
    #[serde(borrow, default)]
    size: Option<&'a str>,
    #[serde(borrow)]
    side: &'a str,
}

#[derive(Deserialize)]
struct Msg<'a> {
    #[serde(borrow, default)]
    event_type: Option<&'a str>,
    #[serde(borrow, default)]
    asset_id: Option<&'a str>,
    #[serde(borrow, default)]
    timestamp: Option<&'a str>,
    #[serde(borrow, default)]
    asks: Vec<Lvl<'a>>,
    #[serde(borrow, default)]
    price_changes: Vec<Pc<'a>>,
    #[serde(borrow, default)]
    new_tick_size: Option<&'a str>,
}

// ---------- engine state ----------

struct Mkt {
    info: MarketInfo,
    up: AskBook,
    down: AskBook,
    up_id: String,
    down_id: String,
    in_flight: bool,
    reserved: f64,
    cooldown_until: Instant,
    spent: f64,
    fees: f64,
    shares_up: f64,
    shares_down: f64,
    last_book_log: Instant,
    last_ws_log: Instant,
    lag_ms: i64,
}

pub struct Engine {
    cfg: Config,
    exec: Arc<Executor>,
    dash: Arc<Dash>,
    markets: Vec<Option<Mkt>>,
    by_token: HashMap<String, (usize, bool)>,
    capital: f64,
    res_tx: mpsc::UnboundedSender<PairResult>,
    touched: Vec<usize>,
    /// Set after any trade whose real outcome is unknown/unhedged: no new trades until restart.
    halted: bool,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sub_msg(ids: &[String]) -> String {
    serde_json::json!({
        "type": "market",
        "operation": "subscribe",
        "markets": [],
        "assets_ids": ids,
        "initial_dump": true,
    })
    .to_string()
}

impl Engine {
    fn add(&mut self, info: MarketInfo) -> Vec<String> {
        let up_id = info.up_token.to_string();
        let down_id = info.down_token.to_string();
        if self.by_token.contains_key(&up_id) {
            return vec![];
        }
        let idx = self.markets.len();
        self.by_token.insert(up_id.clone(), (idx, true));
        self.by_token.insert(down_id.clone(), (idx, false));
        self.dash.log(
            &info.label,
            vec![
                tag("mkt", Color::Cyan),
                txt(format!("subscribed {} ", info.slug)),
                dim(format!(
                    "tick {:.4} min {} fee r={} e={}",
                    px_to_f64(info.tick_pips),
                    info.min_shares,
                    info.fee.rate,
                    info.fee.exponent
                )),
            ],
        );
        let past = Instant::now() - LOG_THROTTLE;
        self.markets.push(Some(Mkt {
            info,
            up: AskBook::default(),
            down: AskBook::default(),
            up_id: up_id.clone(),
            down_id: down_id.clone(),
            in_flight: false,
            reserved: 0.0,
            cooldown_until: Instant::now(),
            spent: 0.0,
            fees: 0.0,
            shares_up: 0.0,
            shares_down: 0.0,
            last_book_log: past,
            last_ws_log: past,
            lag_ms: 0,
        }));
        vec![up_id, down_id]
    }

    fn all_ids(&self) -> Vec<String> {
        self.markets
            .iter()
            .flatten()
            .flat_map(|m| [m.up_id.clone(), m.down_id.clone()])
            .collect()
    }

    fn on_frame(&mut self, text: &str, t_recv: Instant) {
        self.dash.count_msg();
        let t = text.trim_start();
        if t.starts_with('[') {
            match serde_json::from_str::<Vec<Msg>>(t) {
                Ok(v) => v.iter().for_each(|m| self.apply(m)),
                Err(e) => warn!("bad ws frame: {e}"),
            }
        } else if t.starts_with('{') {
            match serde_json::from_str::<Msg>(t) {
                Ok(m) => self.apply(&m),
                Err(e) => warn!("bad ws frame: {e}"),
            }
        } else {
            return; // "PONG" etc.
        }
        let touched = std::mem::take(&mut self.touched);
        for &idx in &touched {
            self.evaluate(idx, t_recv);
        }
        self.touched = touched;
        self.touched.clear();
    }

    fn touch(&mut self, idx: usize) {
        if !self.touched.contains(&idx) {
            self.touched.push(idx);
        }
    }

    fn apply(&mut self, m: &Msg) {
        let lag = m
            .timestamp
            .and_then(|s| s.parse::<i64>().ok())
            .map(|ts| now_ms() - ts);
        match m.event_type {
            Some("book") => {
                let Some(&(idx, is_up)) = m.asset_id.and_then(|a| self.by_token.get(a)) else {
                    return;
                };
                let Some(mk) = self.markets[idx].as_mut() else { return };
                let book = if is_up { &mut mk.up } else { &mut mk.down };
                book.clear();
                for l in &m.asks {
                    if let (Some(px), Ok(sz)) = (parse_px(l.price), l.size.parse::<f64>()) {
                        book.set(px, sz);
                    }
                }
                if let Some(l) = lag {
                    mk.lag_ms = l;
                }
                self.touch(idx);
            }
            Some("price_change") => {
                for pc in &m.price_changes {
                    let Some(&(idx, is_up)) = self.by_token.get(pc.asset_id) else {
                        continue;
                    };
                    // price_change "size" is the new total size at that level; SELL = asks.
                    if !pc.side.eq_ignore_ascii_case("SELL") {
                        continue;
                    }
                    let Some(mk) = self.markets[idx].as_mut() else { continue };
                    let (Some(px), Some(sz)) =
                        (parse_px(pc.price), pc.size.and_then(|s| s.parse::<f64>().ok()))
                    else {
                        continue;
                    };
                    if is_up { &mut mk.up } else { &mut mk.down }.set(px, sz);
                    if let Some(l) = lag {
                        mk.lag_ms = l;
                    }
                    if mk.last_ws_log.elapsed() >= LOG_THROTTLE {
                        mk.last_ws_log = Instant::now();
                        let label = mk.info.label.clone();
                        self.dash.log(
                            &label,
                            vec![
                                tag("ws", Color::Blue),
                                dim(format!(
                                    "price_change {:<4} {:<4} {:>8} @{:.4}",
                                    if is_up { "UP" } else { "DOWN" },
                                    pc.side,
                                    pc.size.unwrap_or("-"),
                                    px_to_f64(px)
                                )),
                            ],
                        );
                    }
                    self.touch(idx);
                }
            }
            Some("tick_size_change") => {
                let Some(&(idx, _)) = m.asset_id.and_then(|a| self.by_token.get(a)) else {
                    return;
                };
                let Some(new) = m.new_tick_size else { return };
                if let (Some(mk), Some(px)) = (self.markets[idx].as_mut(), parse_px(new)) {
                    mk.info.tick_pips = px.max(1);
                    if let Some(ts) = Decimal::from_str(new).ok().and_then(|d| TickSize::try_from(d).ok()) {
                        for t in [mk.info.up_token, mk.info.down_token] {
                            self.exec.client.set_tick_size(t, ts);
                        }
                    }
                    info!(market = %mk.info.label, new, "tick size changed");
                }
            }
            _ => {}
        }
    }

    fn evaluate(&mut self, idx: usize, t_recv: Instant) {
        let cfg = &self.cfg;
        let capital = self.capital;
        let Some(mk) = self.markets[idx].as_mut() else { return };
        let now_s = now_ms() / 1000;
        let secs_left = mk.info.end_ts.saturating_sub(now_s);
        let blocked = self.halted
            || mk.in_flight
            || Instant::now() < mk.cooldown_until
            || secs_left < cfg.stop_before_end_secs;

        let budget = cfg
            .max_usdc_per_trade
            .min(cfg.max_usdc_per_market - mk.spent)
            .min(cfg.max_usdc_total - capital);
        let lim = Limits {
            max_pair_cost: cfg.max_pair_cost,
            max_shares: cfg.max_shares_per_trade,
            max_usdc: budget,
            min_shares: mk.info.min_shares,
            min_leg_usdc: cfg.min_leg_usdc,
        };
        let opp = if blocked || budget < 2.0 * cfg.min_leg_usdc {
            None
        } else {
            arb::find(&mk.up, &mk.down, &mk.info.fee, &mk.info.fee, &lim)
        };

        // throttled [book] line (always printed when we fire)
        let (bu, bd) = (mk.up.best(), mk.down.best());
        if opp.is_some() || mk.last_book_log.elapsed() >= LOG_THROTTLE {
            mk.last_book_log = Instant::now();
            if let (Some(u), Some(d)) = (bu, bd) {
                let (pu, pd) = (px_to_f64(u), px_to_f64(d));
                let sum = pu + pd;
                let label = mk.info.label.clone();
                let (su, sd) = (mk.up.size(u), mk.down.size(d));
                let state = if opp.is_some() {
                    col("FIRE", Color::Yellow)
                } else if mk.in_flight {
                    col("busy", Color::Magenta)
                } else {
                    dim("skip")
                };
                self.dash.log(
                    &label,
                    vec![
                        tag("book", Color::DarkGray),
                        col(
                            format!("\u{3a3} {sum:.3}  "),
                            if sum <= cfg.max_pair_cost { Color::Yellow } else { Color::White },
                        ),
                        col("UP ", Color::Green),
                        txt(format!("{pu:.2} x {su:<7.0}")),
                        col("DOWN ", Color::Red),
                        txt(format!("{pd:.2} x {sd:<7.0}")),
                        dim(format!("{}ms  ", mk.lag_ms)),
                        state,
                    ],
                );
            }
        }

        let Some(o) = opp else { return };

        // ---- FIRE ----
        let Some(mk) = self.markets[idx].as_mut() else { return };
        let cost = o.total_cost();
        self.dash.log(
            &mk.info.label,
            vec![
                tag("gap", Color::Yellow),
                col(format!("\u{3a3} {:.3}  ", o.avg_pair_cost()), Color::Yellow),
                col("UP ", Color::Green),
                txt(format!("\u{2264}{:.2}  ", px_to_f64(o.up_px))),
                col("DOWN ", Color::Red),
                txt(format!("\u{2264}{:.2}  ", px_to_f64(o.down_px))),
                col(
                    format!("edge {:+.3} x {:.2} sh = {:+.2}", 1.0 - o.avg_pair_cost(), o.shares, o.expected_profit()),
                    Color::Green,
                ),
            ],
        );
        mk.in_flight = true;
        mk.reserved = cost;
        mk.spent += cost;
        self.capital += cost;
        // Remove the liquidity we're about to take so we don't double-fire on stale levels.
        for (book, _) in [(&mut mk.up, ()), (&mut mk.down, ())] {
            let mut left = o.shares;
            let lv: Vec<(u32, f64)> = book.levels().take(32).collect();
            for (px, sz) in lv {
                let t = sz.min(left);
                book.consume(px, t);
                left -= t;
                if left <= 1e-9 {
                    break;
                }
            }
        }
        let job = PairJob {
            market_idx: idx,
            label: mk.info.label.clone(),
            up_token: mk.info.up_token,
            down_token: mk.info.down_token,
            tick_pips: mk.info.tick_pips,
            min_shares: mk.info.min_shares,
            shares: o.shares,
            up_px: o.up_px,
            down_px: o.down_px,
            fee_up: mk.info.fee,
            fee_down: mk.info.fee,
            expected_cost: cost,
            t_recv,
        };
        let exec = Arc::clone(&self.exec);
        let tx = self.res_tx.clone();
        tokio::spawn(async move {
            let r = exec.execute_pair(job).await;
            let _ = tx.send(r);
        });
    }

    fn on_result(&mut self, r: PairResult) {
        let Some(mk) = self.markets.get_mut(r.market_idx).and_then(Option::as_mut) else {
            return;
        };
        let fee = |f: &crate::exec::LegFill| {
            if f.shares > 0.0 {
                f.shares * mk.info.fee.per_share(f.usdc / f.shares)
            } else {
                0.0
            }
        };
        let fees = fee(&r.up) + fee(&r.down);
        let mut actual = r.usdc_spent + fees;
        if r.uncertain.is_some() {
            // unknown fills: keep the full reservation counted against the budget
            actual = actual.max(mk.reserved);
        }
        mk.in_flight = false;
        mk.cooldown_until = Instant::now() + Duration::from_millis(self.cfg.cooldown_ms);
        mk.spent += actual - mk.reserved;
        self.capital += actual - mk.reserved;
        mk.reserved = 0.0;
        mk.fees += fees;
        mk.shares_up += r.up.shares;
        mk.shares_down += r.down.shares;

        if let Some(why) = &r.uncertain {
            self.halted = true;
            let label = mk.info.label.clone();
            let msg = why.clone();
            error!(market = %label, "TRADING HALTED: {msg}");
            self.dash.log(&label, vec![
                tag("ALERT", Color::Red),
                col(format!("TRADING HALTED: {msg}. Check positions on polymarket.com, then restart the bot."), Color::Red),
            ]);
            self.dash.with(|s| s.halted = Some(msg));
        }
        if r.fired {
            let both = r.up.shares > 0.0 && r.down.shares > 0.0;
            let none = r.up.shares <= 0.0 && r.down.shares <= 0.0;
            self.dash.with(|s| {
                if both {
                    s.locks += 1;
                } else if none {
                    s.misses += 1;
                } else {
                    s.leg_risk_events += 1;
                }
            });
        }
        self.refresh_totals();
    }

    fn refresh_totals(&self) {
        let pnl: f64 = self
            .markets
            .iter()
            .flatten()
            .map(|m| m.shares_up.min(m.shares_down) - m.spent)
            .sum();
        let capital = self.capital;
        self.dash.with(|s| {
            s.locked_pnl = pnl;
            s.capital_in_use = capital;
        });
    }

    /// Once a second: drop finished windows and publish per-market views to the dashboard.
    fn housekeeping(&mut self, last_count: &mut u64) {
        let now_s = now_ms() / 1000;
        for slot in &mut self.markets {
            let expired = slot.as_ref().is_some_and(|m| now_s > m.info.end_ts + 30 && !m.in_flight);
            if expired {
                let m = slot.take().unwrap();
                self.by_token.remove(&m.up_id);
                self.by_token.remove(&m.down_id);
                // The USDC only comes back after the user redeems on polymarket.com, so the
                // capital stays counted against MAX_USDC_TOTAL until the bot is restarted.
                if m.shares_up > 0.0 || m.shares_down > 0.0 {
                    let pnl = m.shares_up.min(m.shares_down) - m.spent;
                    self.dash.log(
                        &m.info.label,
                        vec![
                            tag("done", Color::Cyan),
                            txt(format!(
                                "{} closed: UP {:.2} / DOWN {:.2} sh, cost {:.2}, locked pnl ",
                                m.info.slug, m.shares_up, m.shares_down, m.spent
                            )),
                            col(format!("{pnl:+.2}"), if pnl >= 0.0 { Color::Green } else { Color::Red }),
                            dim("  (redeem on polymarket.com)"),
                        ],
                    );
                    self.dash.with(|s| s.locked_pnl_closed += pnl);
                }
            }
        }
        let views: Vec<MarketView> = self
            .markets
            .iter()
            .flatten()
            .map(|m| MarketView {
                label: m.info.label.clone(),
                slug: m.info.slug.clone(),
                up_ask: m.up.best().map(px_to_f64),
                down_ask: m.down.best().map(px_to_f64),
                fee_rate: m.info.fee.rate,
                fee_exp: m.info.fee.exponent,
                secs_left: m.info.end_ts - now_s,
                spent: m.spent,
                shares_up: m.shares_up,
                shares_down: m.shares_down,
            })
            .collect();
        let total = self.dash.msgs.load(std::sync::atomic::Ordering::Relaxed);
        let rate = total - *last_count;
        *last_count = total;
        self.dash.with(|s| {
            s.markets = views;
            s.msgs_per_sec = rate;
        });
        self.refresh_totals();
    }
}

pub async fn run(
    cfg: Config,
    exec: Arc<Executor>,
    dash: Arc<Dash>,
    mut markets_rx: mpsc::Receiver<MarketInfo>,
) {
    let (res_tx, mut res_rx) = mpsc::unbounded_channel();
    let mut eng = Engine {
        cfg: cfg.clone(),
        exec,
        dash: Arc::clone(&dash),
        markets: Vec::new(),
        by_token: HashMap::new(),
        capital: 0.0,
        res_tx,
        touched: Vec::with_capacity(8),
        halted: false,
    };
    let mut last_count = 0u64;

    loop {
        dash.with(|s| s.ws_status = "connecting".into());
        let ws = match tokio_tungstenite::connect_async(cfg.ws_url.as_str()).await {
            Ok((ws, _)) => ws,
            Err(e) => {
                dash.log("ws", vec![tag("ws", Color::Red), col(format!("connect failed: {e}"), Color::Red)]);
                warn!("ws connect failed: {e}");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        // Disable Nagle on the market-data socket.
        if let tokio_tungstenite::MaybeTlsStream::Rustls(s) = ws.get_ref() {
            let _ = s.get_ref().0.set_nodelay(true);
        }
        let (mut wr, mut rd) = ws.split();
        dash.with(|s| s.ws_status = "ok".into());
        dash.log("ws", vec![tag("ws", Color::Blue), txt("connected to market channel")]);

        let ids = eng.all_ids();
        if !ids.is_empty() && wr.send(Message::text(sub_msg(&ids))).await.is_err() {
            continue;
        }

        let mut ping = tokio::time::interval(Duration::from_secs(5));
        let mut sec = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                biased;
                frame = rd.next() => match frame {
                    Some(Ok(Message::Text(t))) => eng.on_frame(t.as_str(), Instant::now()),
                    Some(Ok(Message::Binary(b))) => {
                        if let Ok(t) = std::str::from_utf8(&b) { eng.on_frame(t, Instant::now()) }
                    }
                    Some(Ok(Message::Ping(p))) => { let _ = wr.send(Message::Pong(p)).await; }
                    Some(Ok(Message::Close(_))) | None => { warn!("ws closed"); break; }
                    Some(Err(e)) => { warn!("ws error: {e}"); break; }
                    _ => {}
                },
                Some(r) = res_rx.recv() => eng.on_result(r),
                Some(m) = markets_rx.recv() => {
                    let ids = eng.add(m);
                    if !ids.is_empty() && wr.send(Message::text(sub_msg(&ids))).await.is_err() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    if wr.send(Message::text("PING")).await.is_err() { break; }
                }
                _ = sec.tick() => eng.housekeeping(&mut last_count),
            }
        }
        dash.with(|s| s.ws_status = "reconnecting".into());
        dash.log("ws", vec![tag("ws", Color::Red), col("disconnected, reconnecting", Color::Red)]);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_official_ws_frames() {
        let book = r#"{"event_type":"book","asset_id":"123","market":"0x01","timestamp":"1234567890",
            "bids":[{"price":"0.5","size":"100"}],"asks":[{"price":"0.51","size":"50"}]}"#;
        let m: Msg = serde_json::from_str(book).unwrap();
        assert_eq!(m.event_type, Some("book"));
        assert_eq!(parse_px(m.asks[0].price), Some(5100));

        let pc = r#"[{"event_type":"price_change","market":"0x02","timestamp":"1",
            "price_changes":[{"asset_id":"123","price":"0.52","size":"10","side":"SELL",
            "hash":"abc","best_bid":"0.5","best_ask":"0.52"}]}]"#;
        let v: Vec<Msg> = serde_json::from_str(pc).unwrap();
        assert_eq!(v[0].price_changes[0].side, "SELL");
        assert_eq!(v[0].price_changes[0].size, Some("10"));
    }
}
