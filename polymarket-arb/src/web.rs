//! Read-only web dashboard (same panels as the TUI), protected by HTTP Basic auth.
//!
//! - `WEB_PASSWORD` set   -> listens on 0.0.0.0:WEB_PORT (open in a browser: http://<vps-ip>:<port>)
//! - `WEB_PASSWORD` unset -> listens on 127.0.0.1 only (reach it through an SSH tunnel)
//!
//! The page has no controls: it cannot place, cancel or change anything.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::extract::State as AxState;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ratatui::style::Color;
use serde_json::{Value, json};
use tracing::{info, warn};

use crate::dash::{Dash, percentile};

const PAGE: &str = include_str!("web/index.html");

#[derive(Clone)]
struct App {
    dash: Arc<Dash>,
    /// Expected `Authorization` header value, None = no auth (localhost only)
    auth: Option<String>,
}

fn css(c: Color) -> &'static str {
    match c {
        Color::Green | Color::LightGreen => "g",
        Color::Red | Color::LightRed => "r",
        Color::Yellow | Color::LightYellow => "y",
        Color::Blue | Color::LightBlue => "b",
        Color::Cyan | Color::LightCyan => "c",
        Color::Magenta | Color::LightMagenta => "m",
        Color::DarkGray | Color::Gray => "d",
        _ => "w",
    }
}

fn authorized(app: &App, headers: &HeaderMap) -> bool {
    check_auth(app.auth.as_deref(), headers)
}

/// `Authorization` header value expected for user/password.
pub(crate) fn basic_value(user: &str, pw: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{user}:{pw}")))
}

/// true if no auth is configured (localhost-only) or the header matches.
pub(crate) fn check_auth(expected: Option<&str>, headers: &HeaderMap) -> bool {
    let Some(expected) = expected else { return true };
    let got = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // constant-time-ish comparison
    got.len() == expected.len()
        && got
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

pub(crate) fn unauthorized() -> Response {
    let mut r = (StatusCode::UNAUTHORIZED, "login required").into_response();
    r.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Basic realm=\"polymarket-arb\""),
    );
    r
}

async fn index(AxState(app): AxState<App>, headers: HeaderMap) -> Response {
    if !authorized(&app, &headers) {
        return unauthorized();
    }
    let mut r = Html(PAGE).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

async fn state(AxState(app): AxState<App>, headers: HeaderMap) -> Response {
    if !authorized(&app, &headers) {
        return unauthorized();
    }
    let d = &app.dash;
    let s = d.state.lock().unwrap();
    let markets: Vec<Value> = s
        .markets
        .iter()
        .map(|m| {
            json!({
                "label": m.label, "slug": m.slug, "up": m.up_ask, "down": m.down_ask,
                "fee": m.fee_rate, "feeExp": m.fee_exp, "left": m.secs_left, "spent": m.spent,
                "shUp": m.shares_up, "shDown": m.shares_down,
            })
        })
        .collect();
    let skip = s.logs.len().saturating_sub(300);
    let logs: Vec<Value> = s
        .logs
        .iter()
        .skip(skip)
        .map(|l| {
            json!({
                "m": l.market,
                "s": l.spans.iter().map(|(t, c)| [t.as_str(), css(*c)]).collect::<Vec<_>>(),
            })
        })
        .collect();
    let body = json!({
        "dryRun": d.dry_run,
        "maxPairCost": d.max_pair_cost,
        "watching": d.markets_arg,
        "version": env!("CARGO_PKG_VERSION"),
        "uptime": d.started.elapsed().as_secs(),
        "markets": markets,
        "locks": s.locks, "misses": s.misses, "legRisk": s.leg_risk_events,
        "pnl": s.locked_pnl + s.locked_pnl_closed,
        "capital": s.capital_in_use,
        "fireP50": percentile(&s.fire_lat_us, 0.5),
        "fireP95": percentile(&s.fire_lat_us, 0.95),
        "signP50": percentile(&s.sign_lat_us, 0.5),
        "rtt": s.clob_rtt_us,
        "msgs": s.msgs_per_sec,
        "ws": s.ws_status,
        "halted": s.halted,
        "balance": s.balance,
        "procP50": s.proc_p50_ns, "procP99": s.proc_p99_ns,
        "logs": logs,
    });
    drop(s);
    let mut r = axum::Json(body).into_response();
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

pub fn spawn(dash: Arc<Dash>, port: u16, user: String, password: Option<String>) {
    let (ip, auth) = match &password {
        Some(pw) => (
            [0, 0, 0, 0],
            Some(basic_value(&user, pw)),
        ),
        None => ([127, 0, 0, 1], None),
    };
    let app = App { dash, auth };
    let router = Router::new()
        .route("/", get(index))
        .route("/api/state", get(state))
        .with_state(app);
    let addr = SocketAddr::from((ip, port));
    tokio::spawn(async move {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => {
                if password.is_some() {
                    info!("web dashboard on http://<vps-ip>:{port} (user '{user}')");
                } else {
                    info!(
                        "web dashboard on http://127.0.0.1:{port} only (set WEB_PASSWORD to open it on the VPS IP)"
                    );
                }
                if let Err(e) = axum::serve(l, router).await {
                    warn!("web dashboard stopped: {e}");
                }
            }
            Err(e) => warn!("web dashboard could not bind {addr}: {e}"),
        }
    });
}
