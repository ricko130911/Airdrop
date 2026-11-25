//! `--record`: market-data recorder for backtesting.
//!
//! It uses an UNAUTHENTICATED client and has no private key, so it cannot place orders.
//! For every rolling up/down window it writes, into `RECORD_DIR` (default `./data`):
//!
//! - `quotes-YYYY-MM-DD.csv`: top of book (best bid/ask + size) of UP and DOWN on every change
//!   (at most one row per market per `RECORD_INTERVAL_MS`, default 250 ms)
//! - `markets.csv`: per-window meta data (fee, tick, min size)
//! - `outcomes.csv`: which side won, once the market resolves

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use futures_util::{SinkExt as _, StreamExt as _};
use polymarket_client_sdk_v2::clob::{Client as ClobClient, Config as ClobConfig};
use polymarket_client_sdk_v2::gamma::Client as GammaClient;
use polymarket_client_sdk_v2::gamma::types::request::MarketBySlugRequest;
use polymarket_client_sdk_v2::types::{DateTime, Utc};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::book::{parse_px, px_to_f64};
use crate::config::{Interval, list, parse_interval, var};
use crate::discovery::{MarketInfo, load, wanted};
use crate::lab::{self, BtState, LabState, LiveMarket, OutcomeOut, Shared};

struct RecConfig {
    clob_host: String,
    gamma_host: String,
    ws_url: String,
    assets: Vec<String>,
    intervals: Vec<Interval>,
    dir: PathBuf,
    interval_ms: u64,
}

impl RecConfig {
    fn from_env() -> Result<Self> {
        Ok(Self {
            clob_host: var("CLOB_HOST").unwrap_or_else(|| "https://clob.polymarket.com".into()),
            gamma_host: var("GAMMA_HOST").unwrap_or_else(|| "https://gamma-api.polymarket.com".into()),
            ws_url: var("WS_URL")
                .unwrap_or_else(|| "wss://ws-subscriptions-clob.polymarket.com/ws/market".into()),
            assets: list("ASSETS", "btc,eth,sol"),
            intervals: list("INTERVALS", "5m")
                .iter()
                .map(|s| parse_interval(s))
                .collect::<Result<_>>()?,
            dir: PathBuf::from(var("RECORD_DIR").unwrap_or_else(|| "data".into())),
            interval_ms: var("RECORD_INTERVAL_MS").and_then(|v| v.parse().ok()).unwrap_or(250),
        })
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- two-sided book ----------

/// One outcome token's book. Recording is not latency critical, so a BTreeMap is fine.
#[derive(Default)]
pub(crate) struct TwoSided {
    bids: BTreeMap<u32, f64>,
    asks: BTreeMap<u32, f64>,
}

impl TwoSided {
    pub(crate) fn set(&mut self, is_bid: bool, px: u32, size: f64) {
        let side = if is_bid { &mut self.bids } else { &mut self.asks };
        if size > 0.0 {
            side.insert(px, size);
        } else {
            side.remove(&px);
        }
    }
    pub(crate) fn clear(&mut self) {
        self.bids.clear();
        self.asks.clear();
    }
    pub(crate) fn best_bid(&self) -> Option<(u32, f64)> {
        self.bids.iter().next_back().map(|(p, s)| (*p, *s))
    }
    pub(crate) fn best_ask(&self) -> Option<(u32, f64)> {
        self.asks.iter().next().map(|(p, s)| (*p, *s))
    }
}

/// (up bid, up ask, down bid, down ask)
type Top = [Option<(u32, f64)>; 4];

struct RecMarket {
    info: MarketInfo,
    up: TwoSided,
    down: TwoSided,
    written: Top,
    dirty: bool,
    changed_ms: i64,
    /// one point per second for the dashboard: (unix s, up ask, down ask)
    history: VecDeque<(i64, Option<f64>, Option<f64>)>,
}

impl RecMarket {
    fn top(&self) -> Top {
        [self.up.best_bid(), self.up.best_ask(), self.down.best_bid(), self.down.best_ask()]
    }
}

// ---------- wire format ----------

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
    bids: Vec<Lvl<'a>>,
    #[serde(borrow, default)]
    asks: Vec<Lvl<'a>>,
    #[serde(borrow, default)]
    price_changes: Vec<Pc<'a>>,
}

/// Book state for all recorded markets.
#[derive(Default)]
pub(crate) struct Books {
    markets: Vec<Option<RecMarket>>,
    by_token: HashMap<String, (usize, bool)>,
}

impl Books {
    fn add(&mut self, info: MarketInfo) -> Vec<String> {
        let (u, d) = (info.up_token.to_string(), info.down_token.to_string());
        if self.by_token.contains_key(&u) {
            return vec![];
        }
        let idx = self.markets.len();
        self.by_token.insert(u.clone(), (idx, true));
        self.by_token.insert(d.clone(), (idx, false));
        self.markets.push(Some(RecMarket {
            info,
            up: TwoSided::default(),
            down: TwoSided::default(),
            written: [None; 4],
            dirty: false,
            changed_ms: 0,
            history: VecDeque::new(),
        }));
        vec![u, d]
    }

    fn book(&mut self, asset: &str) -> Option<&mut RecMarket> {
        let &(idx, _) = self.by_token.get(asset)?;
        self.markets[idx].as_mut()
    }

    /// Applies one WS frame (object or array). Returns how many messages were applied.
    pub(crate) fn apply_frame(&mut self, text: &str, at_ms: i64) -> usize {
        let t = text.trim_start();
        let msgs: Vec<Msg> = if t.starts_with('[') {
            serde_json::from_str(t).unwrap_or_default()
        } else if t.starts_with('{') {
            serde_json::from_str::<Msg>(t).map(|m| vec![m]).unwrap_or_default()
        } else {
            return 0;
        };
        for m in &msgs {
            self.apply(m, at_ms);
        }
        msgs.len()
    }

    fn apply(&mut self, m: &Msg, at_ms: i64) {
        match m.event_type {
            Some("book") => {
                let Some(asset) = m.asset_id else { return };
                let Some(&(_, is_up)) = self.by_token.get(asset) else { return };
                let Some(mk) = self.book(asset) else { return };
                let b = if is_up { &mut mk.up } else { &mut mk.down };
                b.clear();
                for (is_bid, lv) in [(true, &m.bids), (false, &m.asks)] {
                    for l in lv {
                        if let (Some(px), Ok(sz)) = (parse_px(l.price), l.size.parse::<f64>()) {
                            b.set(is_bid, px, sz);
                        }
                    }
                }
                mk.dirty = true;
                mk.changed_ms = at_ms;
            }
            Some("price_change") => {
                for pc in &m.price_changes {
                    let Some(&(_, is_up)) = self.by_token.get(pc.asset_id) else { continue };
                    let (Some(px), Some(sz)) =
                        (parse_px(pc.price), pc.size.and_then(|s| s.parse::<f64>().ok()))
                    else {
                        continue;
                    };
                    let is_bid = pc.side.eq_ignore_ascii_case("BUY");
                    let Some(mk) = self.book(pc.asset_id) else { continue };
                    if is_up { &mut mk.up } else { &mut mk.down }.set(is_bid, px, sz);
                    mk.dirty = true;
                    mk.changed_ms = at_ms;
                }
            }
            _ => {}
        }
    }

    /// CSV rows for markets whose top of book changed since the last flush.
    pub(crate) fn flush_rows(&mut self) -> Vec<String> {
        let mut rows = Vec::new();
        for mk in self.markets.iter_mut().flatten() {
            if !mk.dirty {
                continue;
            }
            mk.dirty = false;
            let top = mk.top();
            if top == mk.written {
                continue;
            }
            mk.written = top;
            let mut row = format!("{},{},{}", mk.changed_ms, mk.info.slug, mk.info.end_ts);
            for lvl in top {
                match lvl {
                    Some((px, sz)) => row.push_str(&format!(",{:.4},{:.2}", px_to_f64(px), sz)),
                    None => row.push_str(",,"),
                }
            }
            row.push('\n');
            rows.push(row);
        }
        rows
    }

    fn prune(&mut self, now_s: i64) {
        for slot in &mut self.markets {
            if slot.as_ref().is_some_and(|m| now_s > m.info.end_ts + 60) {
                let m = slot.take().unwrap();
                self.by_token.remove(&m.info.up_token.to_string());
                self.by_token.remove(&m.info.down_token.to_string());
            }
        }
    }

    /// Records one history point per market and returns the dashboard view.
    fn sample(&mut self, now_s: i64) -> Vec<LiveMarket> {
        let px = |l: Option<(u32, f64)>| l.map(|(p, _)| px_to_f64(p));
        self.markets
            .iter_mut()
            .flatten()
            .map(|m| {
                let top = m.top();
                if m.history.len() == 600 {
                    m.history.pop_front();
                }
                m.history.push_back((now_s, px(top[1]), px(top[3])));
                LiveMarket {
                    slug: m.info.slug.clone(),
                    asset: m.info.slug.split('-').next().unwrap_or("").to_owned(),
                    label: m.info.label.clone(),
                    end_ts: m.info.end_ts,
                    up_bid: px(top[0]),
                    up_ask: px(top[1]),
                    down_bid: px(top[2]),
                    down_ask: px(top[3]),
                    fee_rate: m.info.fee.rate,
                    history: m.history.iter().copied().collect(),
                }
            })
            .collect()
    }

    fn ids(&self) -> Vec<String> {
        self.markets
            .iter()
            .flatten()
            .flat_map(|m| [m.info.up_token.to_string(), m.info.down_token.to_string()])
            .collect()
    }

    fn live(&self) -> usize {
        self.markets.iter().flatten().count()
    }
}

// ---------- output files ----------

pub(crate) const QUOTES_HEADER: &str =
    "ts_ms,slug,end_ts,up_bid,up_bid_sz,up_ask,up_ask_sz,down_bid,down_bid_sz,down_ask,down_ask_sz\n";
pub(crate) const MARKETS_HEADER: &str = "slug,end_ts,fee_rate,fee_exp,tick,min_size\n";
pub(crate) const OUTCOMES_HEADER: &str = "slug,end_ts,winner,detected_ms\n";

fn open_append(path: &PathBuf, header: &str) -> Result<BufWriter<File>> {
    let fresh = fs::metadata(path).map(|m| m.len() == 0).unwrap_or(true);
    let f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open {}", path.display()))?;
    let mut w = BufWriter::new(f);
    if fresh {
        w.write_all(header.as_bytes())?;
        w.flush()?;
    }
    Ok(w)
}

struct Files {
    dir: PathBuf,
    day: String,
    quotes: Option<BufWriter<File>>,
    markets: BufWriter<File>,
    outcomes: BufWriter<File>,
}

impl Files {
    fn new(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir)?;
        Ok(Self {
            markets: open_append(&dir.join("markets.csv"), MARKETS_HEADER)?,
            outcomes: open_append(&dir.join("outcomes.csv"), OUTCOMES_HEADER)?,
            dir,
            day: String::new(),
            quotes: None,
        })
    }

    fn quotes(&mut self) -> Result<&mut BufWriter<File>> {
        let day = Utc::now().format("%Y-%m-%d").to_string();
        if self.quotes.is_none() || day != self.day {
            if let Some(mut q) = self.quotes.take() {
                q.flush()?;
            }
            self.quotes = Some(open_append(
                &self.dir.join(format!("quotes-{day}.csv")),
                QUOTES_HEADER,
            )?);
            self.day = day;
        }
        Ok(self.quotes.as_mut().unwrap())
    }

    fn flush(&mut self) -> Result<()> {
        if let Some(q) = self.quotes.as_mut() {
            q.flush()?;
        }
        self.markets.flush()?;
        self.outcomes.flush()?;
        Ok(())
    }
}

fn sub_msg(ids: &[String]) -> String {
    serde_json::json!({
        "type": "market", "operation": "subscribe", "markets": [],
        "assets_ids": ids, "initial_dump": true,
    })
    .to_string()
}

// ---------- tasks ----------

/// Polls Gamma until each finished window shows a winner.
async fn resolver(
    gamma: GammaClient,
    mut rx: mpsc::Receiver<(String, i64)>,
    tx: mpsc::Sender<(String, i64, String)>,
) {
    let mut pending: Vec<(String, i64)> = Vec::new();
    let mut tick = tokio::time::interval(Duration::from_secs(15));
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Some(m) => pending.push(m),
                None => return,
            },
            _ = tick.tick() => {
                let now = now_ms() / 1000;
                let mut done = Vec::new();
                for (i, (slug, end)) in pending.iter().enumerate() {
                    if now < end + 15 {
                        continue;
                    }
                    if now > end + 3600 {
                        warn!(slug, "no resolution after 1h, giving up");
                        done.push(i);
                        continue;
                    }
                    let req = MarketBySlugRequest::builder().slug(slug.as_str()).build();
                    let Ok(m) = gamma.market_by_slug(&req).await else { continue };
                    let (Some(outcomes), Some(prices)) = (m.outcomes, m.outcome_prices) else { continue };
                    let winner = outcomes.iter().zip(prices.iter()).find_map(|(o, p)| {
                        let p: f64 = p.to_string().parse().unwrap_or(0.0);
                        (p >= 0.99).then(|| o.to_ascii_uppercase())
                    });
                    if let Some(w) = winner {
                        if tx.send((slug.clone(), *end, w)).await.is_err() {
                            return;
                        }
                        done.push(i);
                    }
                }
                for i in done.into_iter().rev() {
                    pending.remove(i);
                }
            }
        }
    }
}

pub async fn run() -> Result<()> {
    let cfg = RecConfig::from_env()?;
    let mut files = Files::new(cfg.dir.clone())?;
    // Unauthenticated: this process has no key and cannot trade.
    let clob = ClobClient::new(&cfg.clob_host, ClobConfig::default())?;
    let gamma = GammaClient::new(&cfg.gamma_host)?;
    info!(dir = %cfg.dir.display(), assets = ?cfg.assets, "recorder started (read-only, no wallet)");
    println!(
        "Recording {} ({}) into {} - read-only, no orders. Ctrl+C to stop.",
        cfg.assets.join(","),
        cfg.intervals.iter().map(|i| i.label.as_str()).collect::<Vec<_>>().join(","),
        cfg.dir.display()
    );

    // discovery
    let (mtx, mut mrx) = mpsc::channel::<MarketInfo>(64);
    {
        let (assets, intervals) = (cfg.assets.clone(), cfg.intervals.clone());
        let gamma = GammaClient::new(&cfg.gamma_host)?;
        tokio::spawn(async move {
            let mut seen: HashSet<String> = HashSet::new();
            let mut missing: HashMap<String, Instant> = HashMap::new();
            loop {
                let now = now_ms() / 1000;
                for (slug, label, end) in wanted(&assets, &intervals, now) {
                    if seen.contains(&slug)
                        || end.is_some_and(|e| e <= now)
                        || missing.get(&slug).is_some_and(|t| t.elapsed() < Duration::from_secs(20))
                    {
                        continue;
                    }
                    match load(&gamma, &clob, &slug, label, end).await {
                        Ok(Some(m)) => {
                            seen.insert(slug);
                            if mtx.send(m).await.is_err() {
                                return;
                            }
                        }
                        Ok(None) => {
                            missing.insert(slug, Instant::now());
                        }
                        Err(e) => warn!("{slug}: {e:#}"),
                    }
                }
                missing.retain(|_, t| t.elapsed() < Duration::from_secs(60));
                seen.retain(|s| {
                    s.rsplit('-').next().and_then(|t| t.parse::<i64>().ok()).is_none_or(|t| t > now - 7200)
                });
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        });
    }

    // resolution
    let (rtx, rrx) = mpsc::channel::<(String, i64)>(256);
    let (otx, mut orx) = mpsc::channel::<(String, i64, String)>(256);
    tokio::spawn(resolver(gamma, rrx, otx));

    // dashboard state (+ outcomes recorded before this start)
    let lab_state: Shared<LabState> = Arc::new(Mutex::new(LabState {
        started_ms: now_ms(),
        assets: cfg.assets.clone(),
        ..LabState::default()
    }));
    let mut outcomes_total = load_past_outcomes(&cfg.dir.join("outcomes.csv"), &lab_state);
    let bt: Shared<BtState> = Arc::new(Mutex::new(BtState::default()));
    lab::start(Arc::clone(&lab_state), bt, cfg.dir.clone());
    lab::spawn_ping(Arc::clone(&lab_state), cfg.clob_host.clone());

    let mut books = Books::default();
    let mut rows_total = 0u64;
    let mut msgs = 0u64;
    let mut backoff = Duration::from_secs(1);
    loop {
        let ws = match tokio_tungstenite::connect_async(cfg.ws_url.as_str()).await {
            Ok((ws, _)) => {
                backoff = Duration::from_secs(1);
                ws
            }
            Err(e) => {
                warn!("ws connect failed (retry in {}s): {e}", backoff.as_secs());
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
                continue;
            }
        };
        let (mut wr, mut rd) = ws.split();
        lab_state.lock().unwrap().ws_ok = true;
        let ids = books.ids();
        if !ids.is_empty() && wr.send(Message::text(sub_msg(&ids))).await.is_err() {
            continue;
        }
        let mut flush = tokio::time::interval(Duration::from_millis(cfg.interval_ms.max(50)));
        let mut ping = tokio::time::interval(Duration::from_secs(5));
        let mut stats = tokio::time::interval(Duration::from_secs(60));
        let mut second = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                frame = rd.next() => match frame {
                    Some(Ok(Message::Text(t))) => { msgs += books.apply_frame(t.as_str(), now_ms()) as u64; }
                    Some(Ok(Message::Ping(p))) => { let _ = wr.send(Message::Pong(p)).await; }
                    Some(Ok(Message::Close(_))) | None => { warn!("ws closed"); break; }
                    Some(Err(e)) => { warn!("ws error: {e}"); break; }
                    _ => {}
                },
                Some(m) = mrx.recv() => {
                    files.markets.write_all(format!(
                        "{},{},{},{},{:.4},{}\n",
                        m.slug, m.end_ts, m.fee.rate, m.fee.exponent,
                        px_to_f64(m.tick_pips), m.min_shares
                    ).as_bytes())?;
                    let _ = rtx.send((m.slug.clone(), m.end_ts)).await;
                    info!(slug = %m.slug, "recording");
                    let ids = books.add(m);
                    if !ids.is_empty() && wr.send(Message::text(sub_msg(&ids))).await.is_err() {
                        break;
                    }
                }
                Some((slug, end, winner)) = orx.recv() => {
                    files.outcomes.write_all(format!("{slug},{end},{winner},{}\n", now_ms()).as_bytes())?;
                    outcomes_total += 1;
                    {
                        let mut l = lab_state.lock().unwrap();
                        l.resolved = outcomes_total;
                        l.push_outcome(OutcomeOut {
                            asset: slug.split('-').next().unwrap_or("").to_owned(),
                            slug: slug.clone(),
                            end_ts: end,
                            winner: winner.clone(),
                        });
                    }
                    info!(slug, winner, "resolved");
                }
                _ = flush.tick() => {
                    let rows = books.flush_rows();
                    if !rows.is_empty() {
                        let q = files.quotes()?;
                        for r in &rows {
                            q.write_all(r.as_bytes())?;
                        }
                        rows_total += rows.len() as u64;
                    }
                }
                _ = ping.tick() => {
                    files.flush()?;
                    books.prune(now_ms() / 1000);
                    if wr.send(Message::text("PING")).await.is_err() { break; }
                }
                _ = second.tick() => {
                    let view = books.sample(now_ms() / 1000);
                    let mut l = lab_state.lock().unwrap();
                    l.markets = view;
                    l.rows = rows_total;
                    l.msgs_per_sec = std::mem::take(&mut msgs);
                }
                _ = stats.tick() => {
                    let bytes = dir_bytes(&cfg.dir);
                    lab_state.lock().unwrap().data_bytes = bytes;
                    let msg = format!(
                        "{} recording {} markets | quote rows {} | resolved windows {}",
                        DateTime::<Utc>::from_timestamp_millis(now_ms()).map(|d| d.format("%H:%M:%S").to_string()).unwrap_or_default(),
                        books.live(), rows_total, outcomes_total
                    );
                    println!("{msg}");
                }
            }
        }
        files.flush()?;
        lab_state.lock().unwrap().ws_ok = false;
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn dir_bytes(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|it| it.filter_map(|e| e.ok()?.metadata().ok()).map(|m| m.len()).sum())
        .unwrap_or(0)
}

/// Shows outcomes recorded by earlier runs on the dashboard; returns how many exist.
fn load_past_outcomes(path: &Path, lab: &Shared<LabState>) -> u64 {
    let Ok(text) = fs::read_to_string(path) else { return 0 };
    let rows: Vec<&str> = text.lines().skip(1).filter(|l| !l.trim().is_empty()).collect();
    let mut l = lab.lock().unwrap();
    for row in rows.iter().skip(rows.len().saturating_sub(120)) {
        let f: Vec<&str> = row.split(',').collect();
        if f.len() >= 3 {
            l.push_outcome(OutcomeOut {
                slug: f[0].to_owned(),
                asset: f[0].split('-').next().unwrap_or("").to_owned(),
                end_ts: f[1].parse().unwrap_or(0),
                winner: f[2].to_owned(),
            });
        }
    }
    l.resolved = rows.len() as u64;
    rows.len() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arb::FeeModel;
    use polymarket_client_sdk_v2::types::U256;

    fn info() -> MarketInfo {
        MarketInfo {
            label: "btc-5m".into(),
            slug: "btc-updown-5m-100".into(),
            up_token: U256::from(1u8),
            down_token: U256::from(2u8),
            end_ts: 400,
            tick_pips: 100,
            min_shares: 5.0,
            fee: FeeModel { rate: 0.05, exponent: 1 },
        }
    }

    #[test]
    fn records_top_of_book_from_live_frame_shapes() {
        let mut b = Books::default();
        b.add(info());
        b.apply_frame(
            r#"{"event_type":"book","asset_id":"1","market":"0x1","timestamp":"1",
               "bids":[{"price":"0.49","size":"100"},{"price":"0.48","size":"5"}],
               "asks":[{"price":"0.51","size":"80"},{"price":"0.52","size":"9"}]}"#,
            1000,
        );
        b.apply_frame(
            r#"[{"event_type":"price_change","market":"0x1","timestamp":"2","price_changes":[
               {"asset_id":"2","price":"0.47","size":"20","side":"BUY"},
               {"asset_id":"2","price":"0.53","size":"30","side":"SELL"},
               {"asset_id":"1","price":"0.51","size":"0","side":"SELL"}]}]"#,
            2000,
        );
        let rows = b.flush_rows();
        assert_eq!(
            rows,
            vec!["2000,btc-updown-5m-100,400,0.4900,100.00,0.5200,9.00,0.4700,20.00,0.5300,30.00\n"]
        );
        // unchanged top of book -> no duplicate row
        b.apply_frame(
            r#"{"event_type":"price_change","market":"0x1","timestamp":"3","price_changes":[
               {"asset_id":"1","price":"0.40","size":"7","side":"BUY"}]}"#,
            3000,
        );
        assert!(b.flush_rows().is_empty());
    }
}
