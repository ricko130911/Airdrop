//! Runtime configuration, read from environment variables (or a `.env` file).

use std::env;
use std::str::FromStr;

use anyhow::{Context, Result, bail};

#[derive(Clone, Debug)]
pub struct Interval {
    /// Label used in the market slug, e.g. `5m`, `15m`.
    pub label: String,
    /// Window length in seconds.
    pub secs: i64,
}

#[derive(Clone, Debug)]
pub struct Config {
    // --- connectivity ---
    pub clob_host: String,
    pub ws_url: String,
    pub gamma_host: String,

    // --- wallet ---
    pub private_key: String,
    /// 0 = EOA, 1 = Proxy (email/Magic), 2 = Gnosis Safe (browser wallet), 3 = Poly1271 deposit wallet
    pub signature_type: u8,
    pub funder: Option<String>,

    // --- markets ---
    /// Assets for the rolling up/down markets, e.g. `btc,eth,sol,xrp`.
    pub assets: Vec<String>,
    pub intervals: Vec<Interval>,
    /// Extra market slugs to watch (any binary market with two outcomes).
    pub extra_slugs: Vec<String>,

    // --- strategy ---
    /// Fire when (ask_up + ask_down + taker fees) per share is <= this. 0.98 = at least 2c edge.
    pub max_pair_cost: f64,
    /// Max shares (per leg) in one pair trade.
    pub max_shares_per_trade: f64,
    /// Max USDC spent (both legs, incl. fees) in one pair trade.
    pub max_usdc_per_trade: f64,
    /// Max USDC deployed in a single market window.
    pub max_usdc_per_market: f64,
    /// Max USDC deployed across all open windows.
    pub max_usdc_total: f64,
    /// Minimum USDC notional for each leg (exchange rejects tiny marketable orders).
    pub min_leg_usdc: f64,
    /// Do not open new pairs when fewer than this many seconds remain in a window.
    pub stop_before_end_secs: i64,
    /// Milliseconds to wait after a pair trade on a market before firing again on it.
    pub cooldown_ms: u64,

    // --- leg-risk handling ---
    /// When only one leg fills, try to complete the other leg as long as the total pair cost
    /// (incl. fees) stays <= this. 1.00 = break-even.
    pub recovery_max_pair_cost: f64,
    pub recovery_attempts: u32,
    /// How many times to retry selling back a one-sided fill (shares may need to settle).
    pub unwind_attempts: u32,
    /// If the missing leg cannot be completed, sell the filled leg back, accepting at most this
    /// loss per share.
    pub unwind_max_loss_per_share: f64,

    // --- safety ---
    pub dry_run: bool,
}

pub(crate) fn var(key: &str) -> Option<String> {
    env::var(key).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn parse<T: FromStr>(key: &str, default: T) -> Result<T>
where
    T::Err: std::fmt::Display,
{
    match var(key) {
        None => Ok(default),
        Some(v) => v
            .parse::<T>()
            .map_err(|e| anyhow::anyhow!("invalid value for {key}={v}: {e}")),
    }
}

pub(crate) fn list(key: &str, default: &str) -> Vec<String> {
    var(key)
        .unwrap_or_else(|| default.to_owned())
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

pub(crate) fn parse_interval(s: &str) -> Result<Interval> {
    let (num, unit) = s.split_at(s.len() - 1);
    let n: i64 = num.parse().with_context(|| format!("bad interval {s}"))?;
    let secs = match unit {
        "m" => n * 60,
        "h" => n * 3600,
        _ => bail!("bad interval {s}: use e.g. 5m, 15m, 1h"),
    };
    Ok(Interval {
        label: s.to_owned(),
        secs,
    })
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let intervals = list("INTERVALS", "5m")
            .iter()
            .map(|s| parse_interval(s))
            .collect::<Result<Vec<_>>>()?;

        let cfg = Config {
            clob_host: var("CLOB_HOST").unwrap_or_else(|| "https://clob.polymarket.com".into()),
            ws_url: var("WS_URL").unwrap_or_else(|| {
                "wss://ws-subscriptions-clob.polymarket.com/ws/market".into()
            }),
            gamma_host: var("GAMMA_HOST")
                .unwrap_or_else(|| "https://gamma-api.polymarket.com".into()),

            private_key: var("POLYMARKET_PRIVATE_KEY")
                .context("POLYMARKET_PRIVATE_KEY is required")?,
            signature_type: parse("SIGNATURE_TYPE", 0u8)?,
            funder: var("FUNDER_ADDRESS"),

            assets: list("ASSETS", "btc,eth,sol,xrp,doge,bnb,hype"),
            intervals,
            extra_slugs: list("EXTRA_SLUGS", ""),

            max_pair_cost: parse("MAX_PAIR_COST", 0.98)?,
            max_shares_per_trade: parse("MAX_SHARES_PER_TRADE", 200.0)?,
            max_usdc_per_trade: parse("MAX_USDC_PER_TRADE", 100.0)?,
            max_usdc_per_market: parse("MAX_USDC_PER_MARKET", 300.0)?,
            max_usdc_total: parse("MAX_USDC_TOTAL", 1000.0)?,
            min_leg_usdc: parse("MIN_LEG_USDC", 1.0)?,
            stop_before_end_secs: parse("STOP_BEFORE_END_SECS", 5)?,
            cooldown_ms: parse("COOLDOWN_MS", 250)?,

            recovery_max_pair_cost: parse("RECOVERY_MAX_PAIR_COST", 1.0)?,
            recovery_attempts: parse("RECOVERY_ATTEMPTS", 0)?,
            unwind_attempts: parse("UNWIND_ATTEMPTS", 8)?,
            unwind_max_loss_per_share: parse("UNWIND_MAX_LOSS_PER_SHARE", 0.10)?,

            dry_run: parse("DRY_RUN", true)?,
        };

        if !(0.5..1.0).contains(&cfg.max_pair_cost) {
            bail!("MAX_PAIR_COST must be in [0.5, 1.0) (it is {})", cfg.max_pair_cost);
        }
        if cfg.recovery_max_pair_cost < cfg.max_pair_cost {
            bail!("RECOVERY_MAX_PAIR_COST must be >= MAX_PAIR_COST");
        }
        if cfg.signature_type > 3 {
            bail!("SIGNATURE_TYPE must be 0, 1, 2 or 3");
        }
        Ok(cfg)
    }
}
