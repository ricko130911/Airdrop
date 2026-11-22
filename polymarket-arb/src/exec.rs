//! Order execution: local EIP-712 signing (official SDK) + our own raw, pre-warmed HTTP path.
//!
//! The SDK's `post_order(s)` polls for settlement tx hashes for up to 30s after a match, which
//! is far too slow for reacting to a missing leg. We therefore serialize the SDK's
//! `SignedOrder`s ourselves and POST them to `/orders` in ONE request (both legs in one round
//! trip), with L2 HMAC headers computed locally.

use std::str::FromStr as _;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alloy_signer_local::PrivateKeySigner;
use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE;
use hmac::{Hmac, Mac};
use polymarket_client_sdk_v2::POLYGON;
use polymarket_client_sdk_v2::auth::state::Authenticated;
use polymarket_client_sdk_v2::auth::{ExposeSecret as _, Normal, Signer as _};
use polymarket_client_sdk_v2::clob::types::{
    OrderStatusType, OrderType, Side, SignatureType, SignedOrder,
};
use polymarket_client_sdk_v2::clob::types::response::PostOrderResponse;
use polymarket_client_sdk_v2::clob::{Client, Config as ClobConfig};
use polymarket_client_sdk_v2::types::{Address, Decimal, U256};
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use sha2::Sha256;
use tracing::{error, info, warn};

use crate::book::{SCALE, px_to_f64};
use crate::config::Config;
use crate::dash::{Dash, col, dim, tag, txt};
use ratatui::style::Color;

pub type AuthClient = Client<Authenticated<Normal>>;

pub struct Executor {
    pub client: AuthClient,
    signer: PrivateKeySigner,
    http: reqwest::Client,
    orders_url: String,
    time_url: String,
    // L2 auth material, pre-rendered as header values
    address: HeaderValue,
    api_key: HeaderValue,
    passphrase: HeaderValue,
    secret: Vec<u8>,
    pub dry_run: bool,
    cfg: Config,
    dash: Arc<Dash>,
}

/// Result of one leg.
#[derive(Clone, Debug, Default)]
pub struct LegFill {
    pub shares: f64,
    pub usdc: f64,
}

#[derive(Clone, Debug)]
pub struct PairJob {
    pub market_idx: usize,
    pub label: String,
    pub up_token: U256,
    pub down_token: U256,
    pub tick_pips: u32,
    pub shares: f64,
    pub up_px: u32,
    pub down_px: u32,
    pub fee_up: crate::arb::FeeModel,
    pub fee_down: crate::arb::FeeModel,
    pub expected_cost: f64,
    /// When the triggering WS frame was received.
    pub t_recv: Instant,
}

#[derive(Clone, Debug)]
pub struct PairResult {
    pub market_idx: usize,
    pub up: LegFill,
    pub down: LegFill,
    pub usdc_spent: f64,
    /// true if an order was actually sent (false for dry-run / signing errors)
    pub fired: bool,
}

/// Polymarket L2 auth: base64url(HMAC-SHA256(secret, ts + METHOD + path + body)).
fn l2_signature(secret: &[u8], ts: u64, method: &str, path: &str, body: &str) -> Result<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret)?;
    mac.update(ts.to_string().as_bytes());
    mac.update(method.as_bytes());
    mac.update(path.as_bytes());
    mac.update(body.as_bytes());
    Ok(URL_SAFE.encode(mac.finalize().into_bytes()))
}

fn dec_px(px: u32) -> Decimal {
    // pips (1e-4) -> Decimal with 4dp, then normalize to drop trailing zeros
    Decimal::new(i64::from(px), 4).normalize()
}

fn dec_shares(s: f64) -> Decimal {
    let cents = (s * 100.0 + 1e-6).floor() as i64;
    Decimal::new(cents, 2)
}

fn to_f64(d: Decimal) -> f64 {
    d.to_string().parse().unwrap_or(0.0)
}

fn sig_type(n: u8) -> SignatureType {
    match n {
        1 => SignatureType::Proxy,
        2 => SignatureType::GnosisSafe,
        3 => SignatureType::Poly1271,
        _ => SignatureType::Eoa,
    }
}

impl Executor {
    pub async fn new(cfg: &Config, dash: Arc<Dash>) -> Result<Arc<Self>> {
        let signer = PrivateKeySigner::from_str(&cfg.private_key)
            .context("POLYMARKET_PRIVATE_KEY is not a valid hex private key")?
            .with_chain_id(Some(POLYGON));

        let mut auth = Client::new(&cfg.clob_host, ClobConfig::default())?
            .authentication_builder(&signer)
            .signature_type(sig_type(cfg.signature_type));
        if let Some(f) = &cfg.funder {
            auth = auth.funder(Address::from_str(f).context("bad FUNDER_ADDRESS")?);
        }
        let client = auth.authenticate().await.context("CLOB authentication failed")?;

        let geo = client.check_geoblock().await;
        match geo {
            Ok(g) if g.blocked => bail!(
                "Polymarket reports this IP ({}) as geoblocked. Trading from here is not allowed.",
                g.ip
            ),
            Ok(_) => {}
            Err(e) => warn!("geoblock check failed (continuing): {e}"),
        }

        // Caches the protocol version so order building never touches the network.
        let version = client.version().await.context("GET /version failed")?;
        info!(version, signer = %signer.address(), "authenticated with CLOB");

        let creds = client.credentials();
        let secret = URL_SAFE
            .decode(creds.secret().expose_secret())
            .context("API secret is not base64url")?;

        let http = reqwest::Client::builder()
            .tcp_nodelay(true)
            .pool_idle_timeout(None)
            .pool_max_idle_per_host(8)
            .tcp_keepalive(Duration::from_secs(15))
            .http2_keep_alive_interval(Duration::from_secs(10))
            .http2_keep_alive_while_idle(true)
            .timeout(Duration::from_secs(10))
            .build()?;

        let base = cfg.clob_host.trim_end_matches('/');
        let exec = Arc::new(Self {
            address: HeaderValue::from_str(&client.address().to_checksum(None))?,
            api_key: HeaderValue::from_str(&creds.key().to_string())?,
            passphrase: HeaderValue::from_str(creds.passphrase().expose_secret())?,
            secret,
            client,
            signer,
            http,
            orders_url: format!("{base}/orders"),
            time_url: format!("{base}/time"),
            dry_run: cfg.dry_run,
            cfg: cfg.clone(),
            dash,
        });

        // Keep the TLS connection to the CLOB hot so the first order doesn't pay for a handshake.
        let warm = Arc::clone(&exec);
        tokio::spawn(async move {
            loop {
                let t = Instant::now();
                match warm.http.get(&warm.time_url).send().await {
                    Ok(r) => {
                        let _ = r.bytes().await;
                        let us = t.elapsed().as_micros() as u64;
                        warm.dash.with(|s| s.clob_rtt_us = us);
                        warm.dash.log(
                            "net",
                            vec![tag("net", Color::Blue), dim(format!("heartbeat clob {:.1}ms", us as f64 / 1000.0))],
                        );
                    }
                    Err(e) => {
                        warm.dash.log("net", vec![tag("net", Color::Red), col(format!("clob keepalive failed: {e}"), Color::Red)]);
                        warn!("clob keepalive failed: {e}");
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
        Ok(exec)
    }

    /// Measure a few round trips to the CLOB so the user can judge their server location.
    pub async fn latency_probe(&self) {
        let mut v = Vec::new();
        for _ in 0..5 {
            let t = Instant::now();
            if let Ok(r) = self.http.get(&self.time_url).send().await {
                let _ = r.bytes().await;
                v.push(t.elapsed().as_micros() as u64);
            }
        }
        v.sort_unstable();
        if let Some(med) = v.get(v.len() / 2) {
            info!(
                "CLOB HTTP round trip: median {:.2} ms (samples {:?} us). <5ms = great, >50ms = move your server closer",
                *med as f64 / 1000.0,
                v
            );
        }
    }

    async fn sign_buy(
        &self,
        token: U256,
        px: u32,
        shares: f64,
        ot: OrderType,
    ) -> Result<SignedOrder> {
        self.sign(token, px, shares, Side::Buy, ot).await
    }

    async fn sign(
        &self,
        token: U256,
        px: u32,
        shares: f64,
        side: Side,
        ot: OrderType,
    ) -> Result<SignedOrder> {
        let order = self
            .client
            .limit_order()
            .token_id(token)
            .side(side)
            .price(dec_px(px))
            .size(dec_shares(shares))
            .order_type(ot)
            .build()
            .await?;
        Ok(self.client.sign(&self.signer, order).await?)
    }

    fn l2_headers(&self, path: &str, body: &str) -> Result<HeaderMap> {
        let ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let sig = l2_signature(&self.secret, ts, "POST", path, body)?;

        let mut h = HeaderMap::with_capacity(6);
        h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        h.insert("POLY_ADDRESS", self.address.clone());
        h.insert("POLY_API_KEY", self.api_key.clone());
        h.insert("POLY_PASSPHRASE", self.passphrase.clone());
        h.insert("POLY_SIGNATURE", HeaderValue::from_str(&sig)?);
        h.insert("POLY_TIMESTAMP", HeaderValue::from_str(&ts.to_string())?);
        Ok(h)
    }

    /// POST one or more signed orders in a single request.
    async fn post(&self, orders: &[SignedOrder]) -> Result<Vec<PostOrderResponse>> {
        let body = serde_json::to_string(orders)?;
        let headers = self.l2_headers("/orders", &body)?;
        let resp = self
            .http
            .post(&self.orders_url)
            .headers(headers)
            .body(body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            bail!("POST /orders {status}: {text}");
        }
        serde_json::from_str::<Vec<PostOrderResponse>>(&text)
            .map_err(|e| anyhow!("unexpected /orders response ({e}): {text}"))
    }

    /// Turn an order response into the filled amount, waiting for "delayed" orders.
    async fn leg_fill(&self, r: &PostOrderResponse, side: Side, limit_px: u32) -> LegFill {
        if !r.success {
            return LegFill::default();
        }
        let from_resp = |r: &PostOrderResponse| {
            let (making, taking) = (to_f64(r.making_amount), to_f64(r.taking_amount));
            match side {
                // BUY: we give USDC (making) and receive shares (taking)
                Side::Buy => LegFill {
                    shares: taking,
                    usdc: making,
                },
                _ => LegFill {
                    shares: making,
                    usdc: taking,
                },
            }
        };
        match &r.status {
            OrderStatusType::Matched => from_resp(r),
            OrderStatusType::Delayed | OrderStatusType::Live => {
                // Poll the order until the matching engine settles it (max ~3s).
                for _ in 0..30 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if let Ok(o) = self.client.order(&r.order_id).await {
                        match o.status {
                            OrderStatusType::Matched | OrderStatusType::Canceled
                            | OrderStatusType::Unmatched => {
                                let shares = to_f64(o.size_matched);
                                return LegFill {
                                    shares,
                                    usdc: shares * px_to_f64(limit_px),
                                };
                            }
                            _ => {}
                        }
                    }
                }
                warn!(order = %r.order_id, "order still pending after 3s; assuming unfilled");
                LegFill::default()
            }
            _ => LegFill::default(),
        }
    }

    /// Fire both legs at once. Returns what actually filled (after leg-risk handling).
    pub async fn execute_pair(&self, job: PairJob) -> PairResult {
        let mut out = PairResult {
            market_idx: job.market_idx,
            up: LegFill::default(),
            down: LegFill::default(),
            usdc_spent: 0.0,
            fired: false,
        };

        if self.dry_run {
            self.dash.log(
                &job.label,
                vec![
                    tag("exec", Color::Cyan),
                    col("DRY RUN ", Color::Yellow),
                    txt(format!(
                        "would buy {:.2} sh UP @{:.4} + DOWN @{:.4} \u{2192} profit {:+.4}",
                        job.shares,
                        px_to_f64(job.up_px),
                        px_to_f64(job.down_px),
                        job.shares - job.expected_cost
                    )),
                ],
            );
            info!(
                market = %job.label, shares = job.shares,
                up_px = px_to_f64(job.up_px), down_px = px_to_f64(job.down_px),
                cost = format!("{:.4}", job.expected_cost),
                profit = format!("{:.4}", job.shares - job.expected_cost),
                detect_us = job.t_recv.elapsed().as_micros() as u64,
                "[DRY RUN] would buy UP + DOWN"
            );
            return out;
        }

        // Sign both legs in parallel (pure CPU, ~100us each).
        let (a, b) = tokio::join!(
            self.sign_buy(job.up_token, job.up_px, job.shares, OrderType::FOK),
            self.sign_buy(job.down_token, job.down_px, job.shares, OrderType::FOK),
        );
        let (up_o, down_o) = match (a, b) {
            (Ok(a), Ok(b)) => (a, b),
            (a, b) => {
                error!(market = %job.label, "signing failed: {:?} / {:?}", a.err(), b.err());
                return out;
            }
        };
        let t_signed = job.t_recv.elapsed();
        out.fired = true;

        let resp = self.post(&[up_o, down_o]).await;
        let t_resp = job.t_recv.elapsed();
        let resp = match resp {
            Ok(r) if r.len() == 2 => r,
            Ok(r) => {
                error!(market = %job.label, "expected 2 responses, got {}: {r:?}", r.len());
                return out;
            }
            Err(e) => {
                error!(market = %job.label, "pair order failed: {e:#}");
                return out;
            }
        };

        let (up, down) = tokio::join!(
            self.leg_fill(&resp[0], Side::Buy, job.up_px),
            self.leg_fill(&resp[1], Side::Buy, job.down_px),
        );
        info!(
            market = %job.label,
            up_shares = up.shares, down_shares = down.shares,
            up_status = ?resp[0].status, down_status = ?resp[1].status,
            up_err = resp[0].error_msg.as_deref().unwrap_or(""),
            down_err = resp[1].error_msg.as_deref().unwrap_or(""),
            sign_us = t_signed.as_micros() as u64,
            tick_to_resp_us = t_resp.as_micros() as u64,
            "pair result"
        );
        self.dash
            .record_latency(t_signed.as_micros() as u64, t_resp.as_micros() as u64);
        self.dash.log(
            &job.label,
            vec![
                tag("exec", Color::Cyan),
                txt(format!(
                    "sign EIP-712 x2 \u{b7} post FOK {:.2} sh \u{b7} {:.2}ms tick\u{2192}resp",
                    job.shares,
                    t_resp.as_secs_f64() * 1000.0
                )),
            ],
        );
        for (name, f, r, px) in [("UP", &up, &resp[0], job.up_px), ("DOWN", &down, &resp[1], job.down_px)] {
            let ok = f.shares > 0.0;
            self.dash.log(
                &job.label,
                vec![
                    tag("fill", if ok { Color::Green } else { Color::Red }),
                    col(format!("{name} "), if name == "UP" { Color::Green } else { Color::Red }),
                    txt(format!("{:.2}/{:.2} @{:.4} ", f.shares, job.shares, px_to_f64(px))),
                    dim(r.error_msg.clone().unwrap_or_default()),
                ],
            );
        }
        out.up = up;
        out.down = down;
        self.fix_imbalance(&job, &mut out).await;
        out.usdc_spent = out.up.usdc + out.down.usdc;
        out
    }

    /// If one leg filled more than the other, complete the short leg (if still profitable /
    /// break-even) or sell the excess back.
    async fn fix_imbalance(&self, job: &PairJob, out: &mut PairResult) {
        let diff = out.up.shares - out.down.shares;
        if diff.abs() < 0.01 {
            return;
        }
        let (long_is_up, excess) = (diff > 0.0, diff.abs());
        let (long_fill, long_fee, short_token, short_fee, long_token) = if long_is_up {
            (&out.up, job.fee_up, job.down_token, job.fee_down, job.up_token)
        } else {
            (&out.down, job.fee_down, job.up_token, job.fee_up, job.down_token)
        };
        let long_avg = if long_fill.shares > 0.0 {
            long_fill.usdc / long_fill.shares
        } else {
            0.0
        };
        let long_cost = long_avg + long_fee.per_share(long_avg);
        self.dash.log(
            &job.label,
            vec![
                tag("risk", Color::Magenta),
                col(format!("LEG RISK {excess:.2} sh unhedged, recovering"), Color::Magenta),
            ],
        );
        warn!(
            market = %job.label, excess, long_leg = if long_is_up { "UP" } else { "DOWN" },
            "LEG RISK: one leg filled without the other, recovering"
        );

        // 1) Try to complete the missing leg up to RECOVERY_MAX_PAIR_COST.
        let tick = job.tick_pips.max(1);
        let mut cap = self.cfg.recovery_max_pair_cost - long_cost;
        cap -= short_fee.per_share(cap.clamp(0.0, 1.0));
        let cap_px = ((cap * f64::from(SCALE)) as u32 / tick) * tick;
        let mut remaining = excess;
        if cap_px >= tick && cap_px < SCALE {
            for attempt in 1..=self.cfg.recovery_attempts {
                if remaining < 0.01 {
                    break;
                }
                let res = async {
                    let o = self
                        .sign_buy(short_token, cap_px, remaining, OrderType::FAK)
                        .await?;
                    let r = self.post(&[o]).await?;
                    let r = r.into_iter().next().ok_or_else(|| anyhow!("empty response"))?;
                    Ok::<_, anyhow::Error>(self.leg_fill(&r, Side::Buy, cap_px).await)
                }
                .await;
                match res {
                    Ok(f) => {
                        remaining -= f.shares;
                        let tgt = if long_is_up { &mut out.down } else { &mut out.up };
                        tgt.shares += f.shares;
                        tgt.usdc += f.usdc;
                        info!(attempt, filled = f.shares, remaining, "recovery buy");
                    }
                    Err(e) => warn!(attempt, "recovery buy failed: {e:#}"),
                }
                if remaining >= 0.01 {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            }
        }
        if remaining < 0.01 {
            info!(market = %job.label, "leg risk resolved: pair completed");
            return;
        }

        // 2) Still unbalanced: sell the excess of the long leg back.
        let floor = (long_avg - self.cfg.unwind_max_loss_per_share).max(px_to_f64(tick));
        let floor_px = ((floor * f64::from(SCALE)).ceil() as u32).div_ceil(tick) * tick;
        let res = async {
            let o = self
                .sign(long_token, floor_px, remaining, Side::Sell, OrderType::FAK)
                .await?;
            let r = self.post(&[o]).await?;
            let r = r.into_iter().next().ok_or_else(|| anyhow!("empty response"))?;
            Ok::<_, anyhow::Error>(self.leg_fill(&r, Side::Sell, floor_px).await)
        }
        .await;
        match res {
            Ok(f) if f.shares > 0.0 => {
                let tgt = if long_is_up { &mut out.up } else { &mut out.down };
                tgt.shares -= f.shares;
                tgt.usdc -= f.usdc;
                let left = remaining - f.shares;
                if left >= 0.01 {
                    error!(market = %job.label, left, "ALERT: unhedged shares remain (directional exposure)");
                } else {
                    info!(market = %job.label, sold = f.shares, "excess leg unwound");
                }
            }
            Ok(_) => {
                error!(market = %job.label, remaining, "ALERT: could not unwind; unhedged shares remain")
            }
            Err(e) => {
                error!(market = %job.label, remaining, "ALERT: unwind failed: {e:#}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn l2_hmac_matches_official_sdk_vector() {
        // Same vector as polymarket_client_sdk_v2's auth::tests::hmac_succeeds
        let secret = URL_SAFE
            .decode("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
            .unwrap();
        let sig = l2_signature(&secret, 1_000_000, "test-sign", "/orders", r#"{"hash":"0x123"}"#)
            .unwrap();
        assert_eq!(sig, "4gJVbox-R6XlDK4nlaicig0_ANVL1qdcahiL8CXfXLM=");
    }

    #[test]
    fn decimal_conversions() {
        assert_eq!(dec_px(4800).to_string(), "0.48");
        assert_eq!(dec_px(4850).to_string(), "0.485");
        assert_eq!(dec_shares(60.009).to_string(), "60.00");
        assert_eq!(dec_shares(12.5).to_string(), "12.50");
    }
}
