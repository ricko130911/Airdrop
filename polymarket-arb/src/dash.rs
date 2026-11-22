//! Shared dashboard state. The hot path only takes this lock for a few hundred nanoseconds
//! (and book log lines are throttled), the UI thread reads it ~10x per second.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use ratatui::style::Color;

pub const MAX_LOGS: usize = 600;

#[derive(Clone)]
pub struct LogLine {
    pub market: String,
    pub spans: Vec<(String, Color)>,
}

#[derive(Clone, Default)]
pub struct MarketView {
    pub label: String,
    pub slug: String,
    pub up_ask: Option<f64>,
    pub down_ask: Option<f64>,
    pub fee_rate: f64,
    pub fee_exp: u32,
    pub secs_left: i64,
    pub spent: f64,
    pub shares_up: f64,
    pub shares_down: f64,
}

#[derive(Default)]
pub struct State {
    pub logs: VecDeque<LogLine>,
    pub markets: Vec<MarketView>,
    pub selected: usize,
    pub locks: u64,
    pub misses: u64,
    pub leg_risk_events: u64,
    pub locked_pnl: f64,
    pub locked_pnl_closed: f64,
    pub capital_in_use: f64,
    pub sign_lat_us: VecDeque<u64>,
    pub fire_lat_us: VecDeque<u64>,
    pub ws_status: String,
    pub clob_rtt_us: u64,
    pub msgs_per_sec: u64,
    /// Some(reason) once trading has been halted for safety.
    pub halted: Option<String>,
}

pub struct Dash {
    pub state: Mutex<State>,
    pub msgs: AtomicU64,
    pub started: Instant,
    pub dry_run: bool,
    pub max_pair_cost: f64,
    pub markets_arg: String,
}

pub fn percentile(v: &VecDeque<u64>, p: f64) -> Option<u64> {
    if v.is_empty() {
        return None;
    }
    let mut s: Vec<u64> = v.iter().copied().collect();
    s.sort_unstable();
    let i = ((s.len() as f64 - 1.0) * p).round() as usize;
    Some(s[i])
}

fn push_lat(q: &mut VecDeque<u64>, v: u64) {
    if q.len() == 200 {
        q.pop_front();
    }
    q.push_back(v);
}

impl Dash {
    pub fn new(dry_run: bool, max_pair_cost: f64, markets_arg: String) -> Self {
        Self {
            state: Mutex::new(State {
                ws_status: "connecting".into(),
                ..State::default()
            }),
            msgs: AtomicU64::new(0),
            started: Instant::now(),
            dry_run,
            max_pair_cost,
            markets_arg,
        }
    }

    pub fn log(&self, market: &str, spans: Vec<(String, Color)>) {
        let mut s = self.state.lock().unwrap();
        if s.logs.len() == MAX_LOGS {
            s.logs.pop_front();
        }
        s.logs.push_back(LogLine {
            market: market.to_owned(),
            spans,
        });
    }

    pub fn count_msg(&self) {
        self.msgs.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_latency(&self, sign_us: u64, fire_us: u64) {
        let mut s = self.state.lock().unwrap();
        push_lat(&mut s.sign_lat_us, sign_us);
        push_lat(&mut s.fire_lat_us, fire_us);
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.lock().unwrap())
    }
}

/// Small helpers to build colored log lines.
pub fn tag(t: &str, c: Color) -> (String, Color) {
    (format!("[{t}] "), c)
}
pub fn txt(t: impl Into<String>) -> (String, Color) {
    (t.into(), Color::White)
}
pub fn dim(t: impl Into<String>) -> (String, Color) {
    (t.into(), Color::DarkGray)
}
pub fn col(t: impl Into<String>, c: Color) -> (String, Color) {
    (t.into(), c)
}
