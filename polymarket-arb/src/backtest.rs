//! `--backtest [DIR]`: replays recorded order books (see `--record`) and simulates
//! "buy both sides" strategies against the real outcomes.
//!
//! The simulation is deliberately pessimistic, because optimistic backtests lose real money:
//! - every order executes `latency_ms` AFTER the decision (default 500 ms, the delay observed
//!   live), against the book as it was at that later moment;
//! - a buy fills only if the ask is still <= our limit with enough size, and we pay our limit
//!   (no price improvement) plus the market's taker fee;
//! - parameters are chosen on the first 60% of windows (train) and judged ONLY on the last
//!   40% (test), which the selection never saw.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::arb::FeeModel;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Lvl {
    pub px: f64,
    pub sz: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Quote {
    pub t: i64,
    pub up_bid: Option<Lvl>,
    pub up_ask: Option<Lvl>,
    pub dn_bid: Option<Lvl>,
    pub dn_ask: Option<Lvl>,
}

impl Quote {
    fn ask(&self, up: bool) -> Option<Lvl> {
        if up { self.up_ask } else { self.dn_ask }
    }
    fn bid(&self, up: bool) -> Option<Lvl> {
        if up { self.up_bid } else { self.dn_bid }
    }
}

#[derive(Clone, Debug)]
pub struct Window {
    pub asset: String,
    pub end_ms: i64,
    pub fee: FeeModel,
    pub up_won: bool,
    pub quotes: Vec<Quote>,
}

impl Window {
    /// The book in force at time `t` (last update at or before `t`).
    fn at(&self, t: i64) -> Option<&Quote> {
        let i = self.quotes.partition_point(|q| q.t <= t);
        (i > 0).then(|| &self.quotes[i - 1])
    }
    fn pays(&self, up: bool) -> f64 {
        if up == self.up_won { 1.0 } else { 0.0 }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SimCfg {
    pub latency_ms: i64,
    pub shares: f64,
    /// Wait before selling freshly bought shares (they must settle first).
    pub unwind_delay_ms: i64,
    pub unwind_max_loss: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Deadline {
    /// keep the single leg until resolution
    Hold,
    /// sell the single leg at the bid
    Sell,
    /// buy the other leg anyway if total pair cost <= cap
    Hedge(f64),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Strategy {
    /// What the live bot did: buy UP and DOWN at the same moment when asks + fees <= max_pair.
    TakerPair { max_pair: f64 },
    /// Buy the cheap side first (ask <= entry_max), then the other side later when the total
    /// cost per pair <= pair_target. If not hedged `deadline_s` before the end: on_deadline.
    LegIn { entry_max: f64, pair_target: f64, deadline_s: i64, on_deadline: Deadline },
    /// In the last `last_s` seconds, buy the side priced in [min_px, max_px] (the near-certain one).
    LastCent { min_px: f64, max_px: f64, last_s: i64 },
}

impl Strategy {
    pub fn family(&self) -> &'static str {
        match self {
            Strategy::TakerPair { .. } => "A. Beli UP+DOWN bersamaan (bot lama)",
            Strategy::LegIn { .. } => "B. Dua arah bertahap (leg-in)",
            Strategy::LastCent { .. } => "C. Last cent (sisi hampir pasti)",
        }
    }
    pub fn describe(&self) -> String {
        match *self {
            Strategy::TakerPair { max_pair } => format!("pair<={max_pair:.2}"),
            Strategy::LegIn { entry_max, pair_target, deadline_s, on_deadline } => {
                let d = match on_deadline {
                    Deadline::Hold => "hold".to_string(),
                    Deadline::Sell => "sell".to_string(),
                    Deadline::Hedge(c) => format!("hedge<={c:.2}"),
                };
                format!("entry<={entry_max:.2} target<={pair_target:.2} T-{deadline_s}s {d}")
            }
            Strategy::LastCent { min_px, max_px, last_s } => {
                format!("{min_px:.2}-{max_px:.2} last {last_s}s")
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Locked,
    HedgedLate,
    OneSidedSold,
    OneSidedHeld,
    Directional,
}

#[derive(Clone, Copy, Debug)]
pub struct Trade {
    /// profit/loss in dollars for `shares` shares
    pub pnl: f64,
    /// dollars spent on buys
    pub cost: f64,
    pub kind: Kind,
}

/// Buy decided at `t`; returns (fill time, cost per share incl. fee) if it would have filled.
fn buy(w: &Window, c: &SimCfg, t: i64, up: bool, limit: f64) -> Option<(i64, f64)> {
    let te = t + c.latency_ms;
    if te >= w.end_ms {
        return None;
    }
    let a = w.at(te)?.ask(up)?;
    (a.px <= limit + 1e-9 && a.sz >= c.shares).then(|| (te, limit + w.fee.per_share(limit)))
}

/// Sell decided at `t`; returns proceeds per share net of fee if it would have filled.
fn sell(w: &Window, c: &SimCfg, t: i64, up: bool, min_px: f64) -> Option<f64> {
    let te = t + c.latency_ms;
    if te >= w.end_ms {
        return None;
    }
    let b = w.at(te)?.bid(up)?;
    (b.px >= min_px - 1e-9 && b.sz >= c.shares).then(|| b.px - w.fee.per_share(b.px))
}

/// One leg filled, the other did not: sell it back after it settles, else hold it.
fn exit_single(w: &Window, c: &SimCfg, up: bool, filled_at: i64, cost: f64, px: f64) -> Trade {
    let n = c.shares;
    match sell(w, c, filled_at + c.unwind_delay_ms, up, px - c.unwind_max_loss) {
        Some(p) => Trade { pnl: (p - cost) * n, cost: cost * n, kind: Kind::OneSidedSold },
        None => Trade { pnl: (w.pays(up) - cost) * n, cost: cost * n, kind: Kind::OneSidedHeld },
    }
}

/// Simulates one strategy on one window. At most one trade per window.
pub fn simulate(w: &Window, s: &Strategy, c: &SimCfg) -> Option<Trade> {
    let n = c.shares;
    let fee = |p: f64| w.fee.per_share(p);
    match *s {
        Strategy::TakerPair { max_pair } => {
            let mut next = i64::MIN;
            for q in &w.quotes {
                if q.t < next || q.t > w.end_ms - 5_000 {
                    continue;
                }
                let (Some(ua), Some(da)) = (q.up_ask, q.dn_ask) else { continue };
                if ua.sz < n || da.sz < n || ua.px + da.px + fee(ua.px) + fee(da.px) > max_pair {
                    continue;
                }
                match (buy(w, c, q.t, true, ua.px), buy(w, c, q.t, false, da.px)) {
                    (Some((_, cu)), Some((_, cd))) => {
                        return Some(Trade { pnl: (1.0 - cu - cd) * n, cost: (cu + cd) * n, kind: Kind::Locked });
                    }
                    (Some((tf, cu)), None) => return Some(exit_single(w, c, true, tf, cu, ua.px)),
                    (None, Some((tf, cd))) => return Some(exit_single(w, c, false, tf, cd, da.px)),
                    (None, None) => next = q.t + c.latency_ms,
                }
            }
            None
        }
        Strategy::LegIn { entry_max, pair_target, deadline_s, on_deadline } => {
            let dl = w.end_ms - deadline_s * 1000;
            // 1) first leg: the cheap side
            let mut leg = None;
            let mut next = i64::MIN;
            for q in &w.quotes {
                if q.t >= dl {
                    break;
                }
                if q.t < next {
                    continue;
                }
                let pick = [true, false]
                    .into_iter()
                    .filter_map(|up| q.ask(up).map(|a| (up, a)))
                    .filter(|(_, a)| a.px <= entry_max && a.sz >= n)
                    .min_by(|x, y| x.1.px.total_cmp(&y.1.px));
                let Some((up, a)) = pick else { continue };
                match buy(w, c, q.t, up, a.px) {
                    Some((tf, cost)) => {
                        leg = Some((up, tf, cost));
                        break;
                    }
                    None => next = q.t + c.latency_ms,
                }
            }
            let (up, tf, c1) = leg?;
            // 2) second leg when the pair locks a profit
            let mut next = i64::MIN;
            for q in w.quotes.iter().filter(|q| q.t >= tf) {
                if q.t >= dl {
                    break;
                }
                if q.t < next {
                    continue;
                }
                let Some(a) = q.ask(!up) else { continue };
                if a.sz < n || c1 + a.px + fee(a.px) > pair_target {
                    continue;
                }
                match buy(w, c, q.t, !up, a.px) {
                    Some((_, c2)) => {
                        return Some(Trade { pnl: (1.0 - c1 - c2) * n, cost: (c1 + c2) * n, kind: Kind::Locked });
                    }
                    None => next = q.t + c.latency_ms,
                }
            }
            // 3) deadline
            let td = dl.max(tf);
            let hold = Trade { pnl: (w.pays(up) - c1) * n, cost: c1 * n, kind: Kind::Directional };
            match on_deadline {
                Deadline::Hold => Some(hold),
                Deadline::Sell => Some(match sell(w, c, td, up, 0.0) {
                    Some(p) => Trade { pnl: (p - c1) * n, cost: c1 * n, kind: Kind::OneSidedSold },
                    None => hold,
                }),
                Deadline::Hedge(cap) => {
                    let mut next = i64::MIN;
                    for q in w.quotes.iter().filter(|q| q.t >= td) {
                        if q.t > w.end_ms - 2_000 {
                            break;
                        }
                        if q.t < next {
                            continue;
                        }
                        let Some(a) = q.ask(!up) else { continue };
                        if a.sz < n || c1 + a.px + fee(a.px) > cap {
                            continue;
                        }
                        match buy(w, c, q.t, !up, a.px) {
                            Some((_, c2)) => {
                                return Some(Trade { pnl: (1.0 - c1 - c2) * n, cost: (c1 + c2) * n, kind: Kind::HedgedLate });
                            }
                            None => next = q.t + c.latency_ms,
                        }
                    }
                    Some(hold)
                }
            }
        }
        Strategy::LastCent { min_px, max_px, last_s } => {
            let mut next = i64::MIN;
            for q in &w.quotes {
                if w.end_ms - q.t > last_s * 1000 || q.t < next {
                    continue;
                }
                if q.t > w.end_ms - 1_000 {
                    break;
                }
                let pick = [true, false]
                    .into_iter()
                    .filter_map(|up| q.ask(up).map(|a| (up, a)))
                    .filter(|(_, a)| a.px >= min_px && a.px <= max_px && a.sz >= n)
                    .max_by(|x, y| x.1.px.total_cmp(&y.1.px));
                let Some((up, a)) = pick else { continue };
                match buy(w, c, q.t, up, a.px) {
                    Some((_, cost)) => {
                        return Some(Trade { pnl: (w.pays(up) - cost) * n, cost: cost * n, kind: Kind::Directional });
                    }
                    None => next = q.t + c.latency_ms,
                }
            }
            None
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub trades: usize,
    pub wins: usize,
    pub locked: usize,
    pub one_sided: usize,
    pub pnl: f64,
    pub worst: f64,
    pub max_dd: f64,
    pub max_cost: f64,
}

pub fn evaluate(ws: &[Window], s: &Strategy, c: &SimCfg) -> Stats {
    let mut st = Stats::default();
    let (mut peak, mut cum) = (0.0_f64, 0.0_f64);
    for w in ws {
        let Some(t) = simulate(w, s, c) else { continue };
        st.trades += 1;
        if t.pnl > 0.0 {
            st.wins += 1;
        }
        match t.kind {
            Kind::Locked => st.locked += 1,
            Kind::OneSidedSold | Kind::OneSidedHeld => st.one_sided += 1,
            _ => {}
        }
        st.pnl += t.pnl;
        st.worst = st.worst.min(t.pnl);
        st.max_cost = st.max_cost.max(t.cost);
        cum += t.pnl;
        peak = peak.max(cum);
        st.max_dd = st.max_dd.max(peak - cum);
    }
    st
}

pub fn grid() -> Vec<Strategy> {
    let mut g = Vec::new();
    for max_pair in [0.95, 0.96, 0.97, 0.98, 0.99] {
        g.push(Strategy::TakerPair { max_pair });
    }
    for entry_max in [0.20, 0.25, 0.30, 0.35, 0.40, 0.45] {
        for pair_target in [0.85, 0.90, 0.93, 0.95, 0.97] {
            for deadline_s in [30, 60, 120] {
                for on_deadline in [Deadline::Hold, Deadline::Sell, Deadline::Hedge(1.02), Deadline::Hedge(1.10)] {
                    g.push(Strategy::LegIn { entry_max, pair_target, deadline_s, on_deadline });
                }
            }
        }
    }
    for min_px in [0.90, 0.94, 0.97] {
        for max_px in [0.95, 0.97, 0.98, 0.99] {
            if min_px > max_px {
                continue;
            }
            for last_s in [10, 20, 30, 60] {
                g.push(Strategy::LastCent { min_px, max_px, last_s });
            }
        }
    }
    g
}

// ---------- loading ----------

fn lvl(px: &str, sz: &str) -> Option<Lvl> {
    let px: f64 = px.trim().parse().ok()?;
    let sz: f64 = sz.trim().parse().ok()?;
    Some(Lvl { px, sz })
}

/// Streams a CSV (skipping its header) line by line, so big recordings don't sit in RAM twice.
fn each_line(path: &Path, mut f: impl FnMut(&str)) -> Result<()> {
    let file = fs::File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    for line in BufReader::new(file).lines().skip(1).map_while(Result::ok) {
        f(&line);
    }
    Ok(())
}

pub fn load(dir: &Path) -> Result<Vec<Window>> {
    let mut meta: HashMap<String, FeeModel> = HashMap::new();
    each_line(&dir.join("markets.csv"), |l| {
        let f: Vec<&str> = l.split(',').collect();
        if f.len() >= 4 {
            let fee = FeeModel { rate: f[2].parse().unwrap_or(0.0), exponent: f[3].parse().unwrap_or(1) };
            meta.insert(f[0].to_owned(), fee);
        }
    })?;
    let mut outcome: HashMap<String, (i64, bool)> = HashMap::new();
    each_line(&dir.join("outcomes.csv"), |l| {
        let f: Vec<&str> = l.split(',').collect();
        if f.len() >= 3 {
            let up = match f[2].trim() {
                "UP" | "YES" => true,
                "DOWN" | "NO" => false,
                _ => return,
            };
            outcome.insert(f[0].to_owned(), (f[1].parse().unwrap_or(0), up));
        }
    })?;
    let mut quotes: HashMap<String, Vec<Quote>> = HashMap::new();
    let mut names: Vec<_> = fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .filter(|n| n.starts_with("quotes-") && n.ends_with(".csv"))
        .collect();
    names.sort();
    for name in names {
        each_line(&dir.join(&name), |l| {
            let f: Vec<&str> = l.split(',').collect();
            if f.len() < 11 || !outcome.contains_key(f[1]) {
                return;
            }
            let Ok(t) = f[0].parse() else { return };
            let q = Quote {
                t,
                up_bid: lvl(f[3], f[4]),
                up_ask: lvl(f[5], f[6]),
                dn_bid: lvl(f[7], f[8]),
                dn_ask: lvl(f[9], f[10]),
            };
            match quotes.get_mut(f[1]) {
                Some(v) => v.push(q),
                None => {
                    quotes.insert(f[1].to_owned(), vec![q]);
                }
            }
        })?;
    }
    let mut ws: Vec<Window> = quotes
        .into_iter()
        .filter_map(|(slug, mut qs)| {
            let &(end, up_won) = outcome.get(&slug)?;
            let fee = *meta.get(&slug)?;
            if qs.len() < 10 {
                return None;
            }
            qs.sort_by_key(|q| q.t);
            Some(Window {
                asset: slug.split('-').next().unwrap_or("").to_owned(),
                end_ms: end * 1000,
                fee,
                up_won,
                quotes: qs,
            })
        })
        .collect();
    // deterministic order: windows of different assets share end times
    ws.sort_by(|a, b| a.end_ms.cmp(&b.end_ms).then_with(|| a.asset.cmp(&b.asset)));
    Ok(ws)
}

// ---------- report ----------

#[derive(Clone, Debug, Default, Serialize)]
pub struct StatsOut {
    pub trades: usize,
    pub win_rate: f64,
    pub pnl: f64,
    pub worst: f64,
    pub max_dd: f64,
    pub locked: usize,
    pub one_sided: usize,
}

impl From<&Stats> for StatsOut {
    fn from(s: &Stats) -> Self {
        Self {
            trades: s.trades,
            win_rate: if s.trades > 0 { s.wins as f64 / s.trades as f64 } else { 0.0 },
            pnl: s.pnl,
            worst: s.worst,
            max_dd: s.max_dd,
            locked: s.locked,
            one_sided: s.one_sided,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct RowOut {
    pub params: String,
    pub train: StatsOut,
    pub test: StatsOut,
}

#[derive(Clone, Debug, Serialize)]
pub struct FamilyOut {
    pub name: String,
    /// best 5 by TRAIN pnl (the selection never looks at TEST)
    pub top: Vec<RowOut>,
    /// the TRAIN-best setting made money on TEST with >= 20 trades
    pub ok: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub generated_ms: i64,
    pub windows: usize,
    pub per_asset: std::collections::BTreeMap<String, usize>,
    pub up_win_rate: f64,
    pub train_windows: usize,
    pub test_windows: usize,
    pub shares: f64,
    pub latency_ms: i64,
    pub combos: usize,
    pub families: Vec<FamilyOut>,
    pub any_profitable: bool,
}

pub const FAMILIES: [&str; 3] = [
    "A. Beli UP+DOWN bersamaan (bot lama)",
    "B. Dua arah bertahap (leg-in)",
    "C. Last cent (sisi hampir pasti)",
];

pub fn default_cfg() -> SimCfg {
    SimCfg { latency_ms: 500, shares: 5.0, unwind_delay_ms: 2000, unwind_max_loss: 0.10 }
}

/// Loads `dir`, runs the whole grid (all cores), writes `backtest-results.csv`.
/// `Ok(None)` = not enough complete windows yet.
pub fn compute(dir: &Path, c: SimCfg) -> Result<Option<Report>> {
    let ws = load(dir)?;
    if ws.len() < 2 {
        return Ok(None);
    }
    let mut per_asset = std::collections::BTreeMap::new();
    for w in &ws {
        *per_asset.entry(w.asset.clone()).or_insert(0usize) += 1;
    }
    let up_wins = ws.iter().filter(|w| w.up_won).count();
    let (train, test) = ws.split_at((ws.len() * 6 / 10).clamp(1, ws.len() - 1));

    let grid = grid();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    let chunk = grid.len().div_ceil(threads);
    let mut results: Vec<(Strategy, Stats, Stats)> = std::thread::scope(|sc| {
        let hs: Vec<_> = grid
            .chunks(chunk)
            .map(|part| {
                sc.spawn(move || {
                    part.iter().map(|s| (*s, evaluate(train, s, &c), evaluate(test, s, &c))).collect::<Vec<_>>()
                })
            })
            .collect();
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });

    let mut f = fs::File::create(dir.join("backtest-results.csv"))?;
    writeln!(f, "family,params,train_trades,train_wins,train_pnl,train_worst,test_trades,test_wins,test_pnl,test_worst,test_max_dd")?;
    for (s, a, b) in &results {
        writeln!(f, "{},{},{},{},{:.4},{:.4},{},{},{:.4},{:.4},{:.4}", s.family(), s.describe(), a.trades, a.wins, a.pnl, a.worst, b.trades, b.wins, b.pnl, b.worst, b.max_dd)?;
    }

    results.sort_by(|x, y| y.1.pnl.total_cmp(&x.1.pnl));
    let families: Vec<FamilyOut> = FAMILIES
        .iter()
        .map(|fam| {
            let top: Vec<RowOut> = results
                .iter()
                .filter(|r| r.0.family() == *fam)
                .take(5)
                .map(|(s, a, b)| RowOut { params: s.describe(), train: a.into(), test: b.into() })
                .collect();
            let ok = top.first().is_some_and(|r| r.test.pnl > 0.0 && r.test.trades >= 20);
            FamilyOut { name: (*fam).to_owned(), top, ok }
        })
        .collect();
    Ok(Some(Report {
        generated_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        windows: ws.len(),
        per_asset,
        up_win_rate: up_wins as f64 / ws.len() as f64,
        train_windows: train.len(),
        test_windows: test.len(),
        shares: c.shares,
        latency_ms: c.latency_ms,
        combos: results.len(),
        any_profitable: families.iter().any(|f| f.ok),
        families,
    }))
}

fn flag<T: std::str::FromStr>(args: &[String], name: &str, default: T) -> T {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn row(s: &StatsOut) -> String {
    format!(
        "{:>5} {:>4.0}% {:>+8.2} {:>+7.2} {:>6.2}",
        s.trades, s.win_rate * 100.0, s.pnl, s.worst, s.max_dd
    )
}

pub fn run(args: &[String]) -> Result<()> {
    let dir = args
        .iter()
        .position(|a| a == "--backtest")
        .and_then(|i| args.get(i + 1))
        .filter(|a| !a.starts_with("--"))
        .cloned()
        .unwrap_or_else(|| "data".into());
    let d = default_cfg();
    let c = SimCfg {
        latency_ms: flag(args, "--latency-ms", d.latency_ms),
        shares: flag(args, "--shares", d.shares),
        unwind_delay_ms: flag(args, "--unwind-delay-ms", d.unwind_delay_ms),
        unwind_max_loss: flag(args, "--unwind-max-loss", d.unwind_max_loss),
    };
    let Some(r) = compute(Path::new(&dir), c)? else {
        println!("Belum ada cukup window lengkap (orderbook + hasil) di {dir}. Jalankan --record lebih lama.");
        return Ok(());
    };
    println!("== Data: {} window ({:?}), UP menang {:.0}% ==", r.windows, r.per_asset, r.up_win_rate * 100.0);
    println!(
        "   simulasi: {} share/trade, jeda order {} ms, jual-balik setelah {} ms, fee taker asli per market",
        c.shares, c.latency_ms, c.unwind_delay_ms
    );
    println!(
        "   TRAIN = {} window pertama (untuk memilih pengaturan), TEST = {} window terakhir (penilaian jujur)\n",
        r.train_windows, r.test_windows
    );
    if r.windows < 200 {
        println!("!! Data masih sedikit (<200 window). Hasil di bawah belum bisa dipercaya.\n");
    }
    for fam in &r.families {
        println!("== {} ==", fam.name);
        println!("{:<44} | {:^35} | {:^35}", "pengaturan (5 terbaik di TRAIN)", "TRAIN", "TEST (data belum pernah dilihat)");
        println!("{:<44} | trade   win      PnL   worst  maxDD | trade   win      PnL   worst  maxDD", "");
        for t in &fam.top {
            println!("{:<44} | {} | {}", t.params, row(&t.train), row(&t.test));
        }
        println!();
    }
    println!("== Kesimpulan (pengaturan terbaik TRAIN, dinilai di TEST) ==");
    for fam in &r.families {
        if let Some(b) = fam.top.first() {
            println!(
                "{} {}: {}\n     TEST: {} trade, PnL {:+.2} $, rugi terbesar/trade {:+.2} $, drawdown {:.2} $",
                if fam.ok { "[+]" } else { "[-]" },
                fam.name, b.params, b.test.trades, b.test.pnl, b.test.worst, b.test.max_dd
            );
        }
    }
    println!();
    if r.any_profitable {
        println!("Ada strategi yang untung di data TEST. Kumpulkan data lebih lama (>= 1000 window) dan pastikan");
        println!("hasilnya tetap positif sebelum mempertimbangkan uang asli, mulai dengan ukuran minimum.");
    } else {
        println!("TIDAK ada strategi yang untung (dengan >= 20 trade) di data TEST. Jangan trading dengan uang asli.");
    }
    println!("\nSemua {} kombinasi tersimpan di {}/backtest-results.csv", r.combos, dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: SimCfg = SimCfg { latency_ms: 500, shares: 5.0, unwind_delay_ms: 2000, unwind_max_loss: 0.10 };
    const NOFEE: FeeModel = FeeModel { rate: 0.0, exponent: 1 };

    fn l(px: f64) -> Option<Lvl> {
        Some(Lvl { px, sz: 100.0 })
    }
    /// quote at t seconds: (up_bid, up_ask, dn_bid, dn_ask)
    fn q(t: f64, ub: f64, ua: f64, db: f64, da: f64) -> Quote {
        Quote { t: (t * 1000.0) as i64, up_bid: l(ub), up_ask: l(ua), dn_bid: l(db), dn_ask: l(da) }
    }
    fn win(up_won: bool, quotes: Vec<Quote>) -> Window {
        Window { asset: "btc".into(), end_ms: 300_000, fee: NOFEE, up_won, quotes }
    }

    #[test]
    fn taker_pair_locks_when_book_stays() {
        let w = win(true, vec![q(10.0, 0.47, 0.48, 0.47, 0.48), q(200.0, 0.5, 0.51, 0.48, 0.5)]);
        let t = simulate(&w, &Strategy::TakerPair { max_pair: 0.98 }, &C).unwrap();
        assert_eq!(t.kind, Kind::Locked);
        assert!((t.pnl - 5.0 * 0.04).abs() < 1e-9);
    }

    #[test]
    fn taker_pair_gets_one_leg_when_price_moves_within_latency() {
        // at 10.0 the pair costs 0.96, but 0.3s later DOWN ask jumped (the live failure mode)
        let w = win(false, vec![
            q(10.0, 0.47, 0.48, 0.47, 0.48),
            q(10.3, 0.47, 0.48, 0.55, 0.56),
            q(12.6, 0.40, 0.41, 0.58, 0.60),
        ]);
        let t = simulate(&w, &Strategy::TakerPair { max_pair: 0.98 }, &C).unwrap();
        // UP filled at 0.48, sold back at 0.40 bid 2.5s later => -0.08/share
        assert_eq!(t.kind, Kind::OneSidedSold);
        assert!((t.pnl - 5.0 * (0.40 - 0.48)).abs() < 1e-9);
    }

    #[test]
    fn leg_in_locks_after_swing() {
        let w = win(true, vec![
            q(10.0, 0.34, 0.35, 0.64, 0.66), // UP cheap -> buy UP @0.35
            q(60.0, 0.55, 0.56, 0.44, 0.45), // later DOWN @0.45 -> pair 0.80 <= 0.90
        ]);
        let s = Strategy::LegIn { entry_max: 0.35, pair_target: 0.90, deadline_s: 60, on_deadline: Deadline::Hold };
        let t = simulate(&w, &s, &C).unwrap();
        assert_eq!(t.kind, Kind::Locked);
        assert!((t.pnl - 5.0 * 0.20).abs() < 1e-9);
    }

    #[test]
    fn leg_in_trend_loses_on_hold_and_less_on_sell() {
        let quotes = vec![
            q(10.0, 0.34, 0.35, 0.64, 0.66),
            q(100.0, 0.20, 0.21, 0.78, 0.80),
            q(250.0, 0.10, 0.11, 0.88, 0.90),
        ];
        let w = win(false, quotes);
        let hold = Strategy::LegIn { entry_max: 0.35, pair_target: 0.90, deadline_s: 60, on_deadline: Deadline::Hold };
        let t = simulate(&w, &hold, &C).unwrap();
        assert_eq!(t.kind, Kind::Directional);
        assert!((t.pnl + 5.0 * 0.35).abs() < 1e-9); // lost the whole leg
        let sell = Strategy::LegIn { entry_max: 0.35, pair_target: 0.90, deadline_s: 60, on_deadline: Deadline::Sell };
        let t = simulate(&w, &sell, &C).unwrap();
        assert_eq!(t.kind, Kind::OneSidedSold);
        assert!((t.pnl - 5.0 * (0.20 - 0.35)).abs() < 1e-9); // sold at 0.20 bid at T-60s
    }

    #[test]
    fn last_cent_wins_one_cent_or_loses_almost_all() {
        let qs = vec![q(285.0, 0.97, 0.98, 0.01, 0.03)];
        let s = Strategy::LastCent { min_px: 0.97, max_px: 0.99, last_s: 20 };
        let won = simulate(&win(true, qs.clone()), &s, &C).unwrap();
        assert!((won.pnl - 5.0 * 0.02).abs() < 1e-9);
        let lost = simulate(&win(false, qs), &s, &C).unwrap();
        assert!((lost.pnl + 5.0 * 0.98).abs() < 1e-9);
    }

    #[test]
    fn fees_are_charged_per_share() {
        let mut w = win(true, vec![q(10.0, 0.47, 0.48, 0.47, 0.48)]);
        w.fee = FeeModel { rate: 0.05, exponent: 1 };
        let t = simulate(&w, &Strategy::TakerPair { max_pair: 0.99 }, &C).unwrap();
        let fee = 0.05 * 0.48 * 0.52;
        assert!((t.pnl - 5.0 * (0.04 - 2.0 * fee)).abs() < 1e-9);
    }
}
