//! Research Lab: the web dashboard served by the read-only recorder (`--record`).
//!
//! Shows live up/down books, recent outcomes and backtest results. It has no wallet and no
//! order endpoints; the only action is re-running the (offline) backtest.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::State as AxState;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use serde::Serialize;
use tracing::{info, warn};

use crate::backtest::{self, Report};
use crate::web::{basic_value, check_auth, unauthorized};

const PAGE: &str = include_str!("web/lab.html");

pub type Shared<T> = Arc<Mutex<T>>;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct LiveMarket {
    pub slug: String,
    pub asset: String,
    pub label: String,
    pub end_ts: i64,
    pub up_bid: Option<f64>,
    pub up_ask: Option<f64>,
    pub down_bid: Option<f64>,
    pub down_ask: Option<f64>,
    pub fee_rate: f64,
    /// one point per second: (unix seconds, up ask, down ask)
    pub history: Vec<(i64, Option<f64>, Option<f64>)>,
}

#[derive(Clone, Debug, Serialize)]
pub struct OutcomeOut {
    pub slug: String,
    pub asset: String,
    pub end_ts: i64,
    pub winner: String,
}

#[derive(Debug, Default, Serialize)]
pub struct LabState {
    pub demo: bool,
    pub started_ms: i64,
    pub ws_ok: bool,
    pub rows: u64,
    pub resolved: u64,
    pub msgs_per_sec: u64,
    pub data_bytes: u64,
    pub assets: Vec<String>,
    pub markets: Vec<LiveMarket>,
    /// newest last
    pub outcomes: VecDeque<OutcomeOut>,
}

impl LabState {
    pub fn push_outcome(&mut self, o: OutcomeOut) {
        if self.outcomes.len() == 120 {
            self.outcomes.pop_front();
        }
        self.outcomes.push_back(o);
    }
}

#[derive(Debug, Default, Serialize)]
pub struct BtState {
    pub running: bool,
    pub last_ms: i64,
    pub report: Option<Report>,
    pub note: Option<String>,
    pub error: Option<String>,
}

/// Starts a backtest over `dir` in the background unless one is already running.
pub fn trigger_backtest(bt: &Shared<BtState>, dir: PathBuf) -> bool {
    {
        let mut b = bt.lock().unwrap();
        if b.running {
            return false;
        }
        b.running = true;
    }
    let bt = Arc::clone(bt);
    tokio::task::spawn_blocking(move || {
        let res = backtest::compute(&dir, backtest::default_cfg());
        let mut b = bt.lock().unwrap();
        b.running = false;
        b.last_ms = now_ms();
        match res {
            Ok(Some(r)) => {
                b.report = Some(r);
                b.note = None;
                b.error = None;
            }
            Ok(None) => {
                b.note = Some("Belum ada round lengkap (orderbook + pemenang). Biarkan perekam berjalan.".into());
                b.error = None;
            }
            Err(e) => b.error = Some(format!("{e:#}")),
        }
    });
    true
}

#[derive(Clone)]
struct App {
    lab: Shared<LabState>,
    bt: Shared<BtState>,
    dir: PathBuf,
    auth: Option<String>,
}

fn json<T: Serialize>(v: &T) -> Response {
    let mut r = axum::Json(v).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

async fn index(AxState(app): AxState<App>, headers: HeaderMap) -> Response {
    if !check_auth(app.auth.as_deref(), &headers) {
        return unauthorized();
    }
    // Prefer the file on disk (cwd = polymarket-arb under pm2), so UI updates only need
    // `git pull`; fall back to the copy compiled into the binary.
    let page = std::fs::read_to_string("src/web/lab.html").unwrap_or_else(|_| PAGE.to_owned());
    let mut r = Html(page).into_response();
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

async fn api_lab(AxState(app): AxState<App>, headers: HeaderMap) -> Response {
    if !check_auth(app.auth.as_deref(), &headers) {
        return unauthorized();
    }
    let s = app.lab.lock().unwrap();
    json(&*s)
}

async fn api_bt(AxState(app): AxState<App>, headers: HeaderMap) -> Response {
    if !check_auth(app.auth.as_deref(), &headers) {
        return unauthorized();
    }
    let s = app.bt.lock().unwrap();
    json(&*s)
}

async fn api_bt_run(AxState(app): AxState<App>, headers: HeaderMap) -> Response {
    if !check_auth(app.auth.as_deref(), &headers) {
        return unauthorized();
    }
    let started = trigger_backtest(&app.bt, app.dir.clone());
    json(&serde_json::json!({ "started": started }))
}

/// Serves the dashboard. With a password it listens on all interfaces, otherwise on
/// localhost only.
pub fn spawn(lab: Shared<LabState>, bt: Shared<BtState>, dir: PathBuf, port: u16, user: String, password: Option<String>) {
    let (ip, auth) = match &password {
        Some(pw) => ([0, 0, 0, 0], Some(basic_value(&user, pw))),
        None => ([127, 0, 0, 1], None),
    };
    let router = Router::new()
        .route("/", get(index))
        .route("/api/lab", get(api_lab))
        .route("/api/backtest", get(api_bt))
        .route("/api/backtest/run", post(api_bt_run))
        .with_state(App { lab, bt, dir, auth });
    let addr = SocketAddr::from((ip, port));
    tokio::spawn(async move {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => {
                if password.is_some() {
                    info!("Research Lab on http://<vps-ip>:{port} (user '{user}')");
                    println!("Research Lab dashboard: http://<vps-ip>:{port}  (login: {user} / WEB_PASSWORD)");
                } else {
                    println!("Research Lab dashboard: http://127.0.0.1:{port} only (set WEB_PASSWORD to open it on the VPS IP)");
                }
                if let Err(e) = axum::serve(l, router).await {
                    warn!("lab dashboard stopped: {e}");
                }
            }
            Err(e) => warn!("lab dashboard could not bind {addr}: {e}"),
        }
    });
}

/// Starts the server from WEB_* env vars, plus an automatic backtest every 30 minutes.
pub fn start(lab: Shared<LabState>, bt: Shared<BtState>, dir: PathBuf) {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let port = env("WEB_PORT").and_then(|p| p.parse().ok()).unwrap_or(8080);
    let user = env("WEB_USER").unwrap_or_else(|| "admin".into());
    spawn(lab, Arc::clone(&bt), dir.clone(), port, user, env("WEB_PASSWORD"));
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            trigger_backtest(&bt, dir.clone());
            tokio::time::sleep(Duration::from_secs(1800)).await;
        }
    });
}

/// `--lab-demo`: a simulated feed so the dashboard can be previewed without network.
/// Backtest results come from RECORD_DIR (real or synthetic recordings).
pub async fn demo(dir: PathBuf) -> anyhow::Result<()> {
    let lab: Shared<LabState> = Arc::new(Mutex::new(LabState {
        demo: true,
        started_ms: now_ms() - 3_725_000,
        ws_ok: true,
        assets: vec!["btc".into(), "eth".into(), "sol".into()],
        ..LabState::default()
    }));
    let bt: Shared<BtState> = Arc::new(Mutex::new(BtState::default()));
    start(Arc::clone(&lab), bt, dir);

    let mut seed = 0x2545_F491_4F6C_DD1Du64;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 11) as f64 / (1u64 << 53) as f64
    };
    let assets = ["btc", "eth", "sol"];
    let mut x = [0.0f64; 6];
    let mut hist: Vec<VecDeque<(i64, Option<f64>, Option<f64>)>> = vec![VecDeque::new(); 6];
    let round = |v: f64| (v * 100.0).round() / 100.0;
    let mut rows = 1_284_311u64;
    {
        let mut l = lab.lock().unwrap();
        let now = now_ms() / 1000;
        let start = now - now % 300;
        for k in (1..=60).rev() {
            for a in assets {
                let up = rnd() < 0.5;
                l.push_outcome(OutcomeOut {
                    slug: format!("{a}-updown-5m-{}", start - k * 300),
                    asset: a.into(),
                    end_ts: start - (k - 1) * 300,
                    winner: if up { "UP" } else { "DOWN" }.into(),
                });
            }
        }
        l.resolved = 2_163;
        l.data_bytes = 187_400_000;
    }
    let mut prefilled = false;
    loop {
        let now = now_ms() / 1000;
        let start = now - now % 300;
        let steps = if prefilled { 1 } else { 300 };
        for step in (0..steps).rev() {
            let t = now - step;
            for (i, h) in hist.iter_mut().enumerate() {
                let w_start = if i < 3 { start } else { start + 300 };
                let left = ((w_start + 300 - t) as f64 / 60.0).clamp(0.05, 10.0);
                x[i] += (rnd() - 0.5) * 0.0004;
                let z = x[i] / (0.0009 * left.sqrt());
                let p = 0.5 * (1.0 + erf(z / std::f64::consts::SQRT_2));
                let spread = if rnd() < 0.02 { -0.02 } else { 0.01 + (rnd() * 2.0).floor() / 100.0 };
                let ua = round((p + spread / 2.0 + 0.005).clamp(0.01, 0.99));
                let da = round((1.0 - p + spread / 2.0 + 0.005).clamp(0.01, 0.99));
                if h.len() == 600 {
                    h.pop_front();
                }
                h.push_back((t, Some(ua), Some(da)));
            }
        }
        prefilled = true;
        rows += 9 + (rnd() * 6.0) as u64;
        let markets = (0..6)
            .map(|i| {
                let a = assets[i % 3];
                let w_start = if i < 3 { start } else { start + 300 };
                let (_, ua, da) = *hist[i].back().unwrap();
                let hhmm = polymarket_client_sdk_v2::types::DateTime::<polymarket_client_sdk_v2::types::Utc>::from_timestamp(w_start, 0)
                    .map(|d| d.format("%H:%M").to_string())
                    .unwrap_or_default();
                LiveMarket {
                    slug: format!("{a}-updown-5m-{w_start}"),
                    asset: a.into(),
                    label: format!("{a}-5m {hhmm}"),
                    end_ts: w_start + 300,
                    up_bid: ua.map(|v| v - 0.01),
                    up_ask: ua,
                    down_bid: da.map(|v| v - 0.01),
                    down_ask: da,
                    fee_rate: if a == "btc" { 0.05 } else { 0.01 },
                    history: hist[i].iter().copied().collect(),
                }
            })
            .collect();
        {
            let mut l = lab.lock().unwrap();
            l.markets = markets;
            l.rows = rows;
            l.msgs_per_sec = 600 + (rnd() * 300.0) as u64;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Abramowitz-Stegun erf approximation (demo only).
fn erf(x: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.327_591_1 * x.abs());
    let y = 1.0
        - (((((1.061_405_429 * t - 1.453_152_027) * t) + 1.421_413_741) * t - 0.284_496_736) * t + 0.254_829_592)
            * t
            * (-x * x).exp();
    if x >= 0.0 { y } else { -y }
}
