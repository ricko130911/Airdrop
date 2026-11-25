//! Finds the rolling crypto UP/DOWN markets (e.g. `btc-updown-5m-<window_start_unix>`) and
//! any extra slugs, and pre-warms every cache the order builder needs (tick size, neg-risk,
//! fee parameters, protocol version) so that the hot path never does network I/O.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow};
use polymarket_client_sdk_v2::gamma::Client as GammaClient;
use polymarket_client_sdk_v2::gamma::types::request::MarketBySlugRequest;
use polymarket_client_sdk_v2::types::{Decimal, U256};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::arb::FeeModel;
use crate::config::{Config, Interval};
use crate::exec::Executor;

#[derive(Clone, Debug)]
pub struct MarketInfo {
    pub label: String,
    pub slug: String,
    pub up_token: U256,
    pub down_token: U256,
    pub end_ts: i64,
    pub tick_pips: u32,
    pub min_shares: f64,
    pub fee: FeeModel,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn dec_f64(d: Decimal) -> f64 {
    d.to_string().parse().unwrap_or(0.0)
}

/// Loads one market. Works with an unauthenticated CLOB client too (used by `--record`).
pub async fn load<S: polymarket_client_sdk_v2::auth::state::State>(
    gamma: &GammaClient,
    clob: &polymarket_client_sdk_v2::clob::Client<S>,
    slug: &str,
    label: String,
    fallback_end: Option<i64>,
) -> Result<Option<MarketInfo>> {
    let req = MarketBySlugRequest::builder().slug(slug).build();
    let m = match gamma.market_by_slug(&req).await {
        Ok(m) => m,
        Err(e) => {
            debug!(slug, "not found yet: {e}");
            return Ok(None);
        }
    };
    if m.closed == Some(true) {
        return Ok(None);
    }
    let cond = m.condition_id.ok_or_else(|| anyhow!("{slug}: no conditionId"))?;

    // Authoritative token/outcome mapping + tick size + fees, and warms the SDK's caches.
    let info = clob
        .clob_market_info(&cond.to_string())
        .await
        .with_context(|| format!("clob market info for {slug}"))?;
    let tokens: Vec<_> = info.tokens.iter().flatten().collect();
    if tokens.len() != 2 {
        return Err(anyhow!("{slug}: expected 2 outcomes, got {}", tokens.len()));
    }
    let is_up = |o: &str| {
        let o = o.to_ascii_lowercase();
        o == "up" || o == "yes"
    };
    let (up, down) = if is_up(&tokens[0].outcome) {
        (tokens[0], tokens[1])
    } else if is_up(&tokens[1].outcome) {
        (tokens[1], tokens[0])
    } else {
        // Two arbitrary outcomes: the arb is symmetric, just keep the order.
        (tokens[0], tokens[1])
    };
    // Warm the remaining per-token caches used by OrderBuilder::build / Client::sign.
    for t in [up.token_id, down.token_id] {
        clob.tick_size(t).await?;
        clob.neg_risk(t).await?;
    }

    let tick = dec_f64(Decimal::from(info.min_tick_size));
    let fee = info
        .fee_details
        .as_ref()
        .map(|f| FeeModel {
            rate: dec_f64(f.rate),
            exponent: f.exponent,
        })
        .unwrap_or_default();
    let end_ts = m
        .end_date
        .map(|d| d.timestamp())
        .or(fallback_end)
        .unwrap_or(i64::MAX);

    Ok(Some(MarketInfo {
        label,
        slug: slug.to_owned(),
        up_token: up.token_id,
        down_token: down.token_id,
        end_ts,
        tick_pips: (tick * 10_000.0).round().max(1.0) as u32,
        min_shares: dec_f64(info.min_order_size).max(0.01),
        fee,
    }))
}

/// Slugs of the current and next window for every asset/interval: `(slug, label, end_ts)`.
pub fn wanted(assets: &[String], intervals: &[Interval], now: i64) -> Vec<(String, String, Option<i64>)> {
    let mut out = Vec::new();
    for asset in assets {
        for iv in intervals {
            let start = now - now.rem_euclid(iv.secs);
            // current window + the next one (pre-subscribe so we're ready at the open)
            for s in [start, start + iv.secs] {
                let slug = format!("{asset}-updown-{}-{s}", iv.label);
                // window start time (UTC) keeps the current and next window apart
                let hhmm = polymarket_client_sdk_v2::types::DateTime::<polymarket_client_sdk_v2::types::Utc>::from_timestamp(s, 0)
                    .map(|d| d.format("%H:%M").to_string())
                    .unwrap_or_default();
                out.push((slug, format!("{asset}-{} {hhmm}", iv.label), Some(s + iv.secs)));
            }
        }
    }
    out
}

/// Runs forever, sending newly discovered markets to the engine.
pub async fn run(cfg: Config, exec: Arc<Executor>, tx: mpsc::Sender<MarketInfo>) {
    let gamma = match GammaClient::new(&cfg.gamma_host) {
        Ok(g) => g,
        Err(e) => {
            warn!("gamma client init failed: {e}");
            return;
        }
    };
    let mut seen: HashSet<String> = HashSet::new();
    // slugs that didn't exist yet: don't ask Gamma again for 20s (coins without a market
    // for an interval simply never show up, without spamming the API)
    let mut missing: HashMap<String, Instant> = HashMap::new();
    loop {
        let now = now_secs();
        let mut wanted = wanted(&cfg.assets, &cfg.intervals, now);
        for slug in &cfg.extra_slugs {
            wanted.push((slug.clone(), slug.clone(), None));
        }

        for (slug, label, end) in wanted {
            if seen.contains(&slug)
                || end.is_some_and(|e| e <= now)
                || missing.get(&slug).is_some_and(|t| t.elapsed() < Duration::from_secs(20))
            {
                continue;
            }
            match load(&gamma, &exec.client, &slug, label, end).await {
                Ok(Some(m)) => {
                    info!(slug = %m.slug, tick = m.tick_pips, fee_rate = m.fee.rate, "market ready");
                    seen.insert(slug);
                    if tx.send(m).await.is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    missing.insert(slug, Instant::now());
                }
                Err(e) => warn!("{slug}: {e:#}"),
            }
        }
        // forget old slugs so the set doesn't grow forever
        missing.retain(|_, t| t.elapsed() < Duration::from_secs(60));
        seen.retain(|s| {
            s.rsplit('-')
                .next()
                .and_then(|t| t.parse::<i64>().ok())
                .is_none_or(|t| t > now - 7200)
        });
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}
