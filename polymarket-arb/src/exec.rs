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
    pub min_shares: f64,
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
    /// The real position is unknown or unhedged: stop opening new trades.
    pub uncertain: Option<String>,
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

/// Collateral balance in dollars. The CLOB reports 6-decimal base units ("25000000" = $25);
/// an integer is read as base units, which can only under-estimate (safe direction).
fn balance_usdc(b: Decimal) -> f64 {
    if b.scale() == 0 { to_f64(b) / 1_000_000.0 } else { to_f64(b) }
}

async fn fetch_balance(client: &AuthClient) -> Result<f64> {
    use polymarket_client_sdk_v2::clob::types::request::BalanceAllowanceRequest;
    let b = client
        .balance_allowance(BalanceAllowanceRequest::builder().asset_type(Default::default()).build())
        .await?;
    Ok(balance_usdc(b.balance))
}

/// Live mode only: refuse to start without enough collateral or without token allowances,
/// otherwise one leg of a pair could be rejected for lack of funds while the other fills.
async fn check_funds(client: &AuthClient, cfg: &Config) -> Result<()> {
    use polymarket_client_sdk_v2::clob::types::request::BalanceAllowanceRequest;
    let b = match client
        .balance_allowance(BalanceAllowanceRequest::builder().asset_type(Default::default()).build())
        .await
    {
        Ok(b) => b,
        Err(e) => {
            warn!("could not read balance/allowance (continuing): {e}");
            return Ok(());
        }
    };
    let usdc = balance_usdc(b.balance);
    info!(raw = %b.balance, usdc, allowances = ?b.allowances, "collateral balance");
    if usdc + 1e-9 < cfg.max_usdc_total {
        bail!(
            "USDC balance is ${usdc:.2} (raw {}) but MAX_USDC_TOTAL is ${:.2}. \
             Deposit more or lower MAX_USDC_TOTAL (keep a buffer for leg recovery).",
            b.balance,
            cfg.max_usdc_total
        );
    }
    if !b.allowances.is_empty()
        && b.allowances.values().all(|v| v.trim().trim_start_matches('0').is_empty())
    {
        bail!(
            "token allowance is 0: make one small manual trade on polymarket.com first \
             (that approves the exchange contracts), then restart the bot"
        );
    }
    Ok(())
}

/// `--check`: log in once per signature type and print the balance each one sees, so the
/// user can tell which SIGNATURE_TYPE holds their funds. Places no orders.
pub async fn check_wallets(cfg: &Config) -> Result<()> {
    use polymarket_client_sdk_v2::clob::types::request::BalanceAllowanceRequest;
    let signer = PrivateKeySigner::from_str(&cfg.private_key)
        .context("POLYMARKET_PRIVATE_KEY is not a valid hex private key")?
        .with_chain_id(Some(POLYGON));
    println!("signer (EOA) address: {}", signer.address());
    println!("FUNDER_ADDRESS in .env: {}", cfg.funder.as_deref().unwrap_or("(not set)"));
    println!("current SIGNATURE_TYPE in .env: {}\n", cfg.signature_type);
    let mut best: Option<(u8, f64)> = None;
    for t in 0u8..=3 {
        let name = ["EOA", "Proxy (email/Magic)", "Gnosis Safe (browser wallet)", "Deposit wallet (Poly1271)"][t as usize];
        let mut auth = Client::new(&cfg.clob_host, ClobConfig::default())?
            .authentication_builder(&signer)
            .signature_type(sig_type(t));
        if t == 3 {
            match &cfg.funder {
                Some(f) => auth = auth.funder(Address::from_str(f).context("bad FUNDER_ADDRESS")?),
                None => {
                    println!("SIGNATURE_TYPE={t} {name:<30} skipped (needs FUNDER_ADDRESS)");
                    continue;
                }
            }
        }
        let res = async {
            let client = auth.authenticate().await?;
            let b = client
                .balance_allowance(BalanceAllowanceRequest::builder().asset_type(Default::default()).build())
                .await?;
            Ok::<_, anyhow::Error>(b)
        }
        .await;
        match res {
            Ok(b) => {
                let usdc = if b.balance.scale() == 0 { to_f64(b.balance) / 1_000_000.0 } else { to_f64(b.balance) };
                let approved = b.allowances.values().any(|v| !v.trim().trim_start_matches('0').is_empty());
                println!(
                    "SIGNATURE_TYPE={t} {name:<30} balance ${usdc:>10.2}   allowance {}",
                    if approved { "OK" } else { "not set" }
                );
                if usdc > best.map_or(0.0, |b| b.1) {
                    best = Some((t, usdc));
                }
            }
            Err(e) => println!("SIGNATURE_TYPE={t} {name:<30} error: {e:#}"),
        }
    }
    match best {
        Some((t, usdc)) => println!("\n=> Your funds (${usdc:.2}) are under SIGNATURE_TYPE={t}. Put that in .env."),
        None => println!(
            "\n=> No balance found under any type. Check that this private key belongs to the \
             Polymarket account that holds the money, and that the deposit has arrived."
        ),
    }
    Ok(())
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

        if !cfg.dry_run {
            check_funds(&client, cfg).await?;
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

        // Show the Polymarket cash balance on the dashboards (refreshed every 15s).
        let bal = Arc::clone(&exec);
        tokio::spawn(async move {
            loop {
                match fetch_balance(&bal.client).await {
                    Ok(usdc) => bal.dash.with(|s| s.balance = Some(usdc)),
                    Err(e) => warn!("balance refresh failed: {e}"),
                }
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
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
        info!(http = %status, body = %text, "POST /orders response");
        if !status.is_success() {
            bail!("POST /orders {status}: {text}");
        }
        serde_json::from_str::<Vec<PostOrderResponse>>(&text)
            .map_err(|e| anyhow!("unexpected /orders response ({e}): {text}"))
    }

    /// Turn an order response into the filled amount, waiting for "delayed" orders.
    /// `None` means the outcome is unknown (order still pending after polling).
    async fn leg_fill(
        &self,
        r: &PostOrderResponse,
        side: Side,
        limit_px: u32,
        size: f64,
    ) -> Option<LegFill> {
        let f = self.leg_fill_raw(r, side, limit_px, size).await?;
        let ok = |x: f64| x <= size * 1.001 + 0.01;
        if ok(f.shares) {
            return Some(f);
        }
        // Amounts may come back in 6-decimal base units.
        let scaled = LegFill { shares: f.shares / 1e6, usdc: f.usdc / 1e6 };
        if ok(scaled.shares) {
            return Some(scaled);
        }
        error!(reported = f.shares, size, "fill larger than the order size: state unknown");
        None
    }

    /// Pessimistic: anything that might have traded but can't be measured returns `None`.
    async fn leg_fill_raw(
        &self,
        r: &PostOrderResponse,
        side: Side,
        limit_px: u32,
        size: f64,
    ) -> Option<LegFill> {
        if !r.success {
            if !r.trade_ids.is_empty() || !r.transaction_hashes.is_empty() {
                error!(order = %r.order_id, "order reported failed but has trades: state unknown");
                return None;
            }
            return Some(LegFill::default());
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
            OrderStatusType::Matched => {
                let f = from_resp(r);
                if f.shares > 0.0 {
                    Some(f)
                } else if matches!(side, Side::Buy) && size > 0.0 {
                    // "matched" without amounts. Our pair legs are FOK (all-or-nothing), so a
                    // match means the full size filled; for FAK callers this is re-checked by
                    // the size sanity check / balance cross-check.
                    warn!(order = %r.order_id, "matched without amounts: assuming full fill of {size}");
                    Some(LegFill { shares: size, usdc: size * px_to_f64(limit_px) })
                } else {
                    error!(order = %r.order_id, "matched without amounts: state unknown");
                    None
                }
            }
            OrderStatusType::Delayed | OrderStatusType::Live => {
                // Poll the order until the matching engine settles it (max ~3s).
                for _ in 0..30 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if let Ok(o) = self.client.order(&r.order_id).await {
                        match o.status {
                            OrderStatusType::Matched | OrderStatusType::Canceled
                            | OrderStatusType::Unmatched => {
                                let shares = to_f64(o.size_matched);
                                return Some(LegFill {
                                    shares,
                                    usdc: shares * px_to_f64(limit_px),
                                });
                            }
                            _ => {}
                        }
                    }
                }
                error!(order = %r.order_id, "order still pending after 3s: fill state unknown");
                None
            }
            OrderStatusType::Unmatched | OrderStatusType::Canceled => {
                if !r.trade_ids.is_empty() {
                    error!(order = %r.order_id, "unmatched but has trades: state unknown");
                    return None;
                }
                Some(LegFill::default())
            }
            other => {
                error!(order = %r.order_id, status = ?other, "unknown order status: state unknown");
                None
            }
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
            uncertain: None,
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

        let balance_before = self.dash.with(|s| s.balance);

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
                out.uncertain = Some(format!("unexpected /orders response ({} entries)", r.len()));
                return out;
            }
            Err(e) => {
                // The request may have reached the exchange: we can't know what filled.
                error!(market = %job.label, "pair order failed: {e:#}");
                out.uncertain = Some(format!("pair order failed: {e}"));
                return out;
            }
        };

        let (up, down) = tokio::join!(
            self.leg_fill(&resp[0], Side::Buy, job.up_px, job.shares),
            self.leg_fill(&resp[1], Side::Buy, job.down_px, job.shares),
        );
        let (Some(up), Some(down)) = (up, down) else {
            out.uncertain = Some("an order stayed pending; fill state unknown".into());
            return out;
        };
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
        self.cross_check_balance(&job, &mut out, balance_before).await;
        out
    }

    /// Independent safety net: compare the real balance change with what we recorded.
    async fn cross_check_balance(&self, job: &PairJob, out: &mut PairResult, before: Option<f64>) {
        let Some(before) = before else { return };
        tokio::time::sleep(Duration::from_secs(3)).await;
        let after = match fetch_balance(&self.client).await {
            Ok(b) => b,
            Err(e) => {
                warn!("post-trade balance check failed: {e}");
                return;
            }
        };
        self.dash.with(|s| s.balance = Some(after));
        let fee = |f: &LegFill, m: &crate::arb::FeeModel| {
            if f.shares > 0.0 { f.shares * m.per_share(f.usdc / f.shares) } else { 0.0 }
        };
        let recorded = out.up.usdc + out.down.usdc + fee(&out.up, &job.fee_up) + fee(&out.down, &job.fee_down);
        let actual = before - after;
        info!(market = %job.label, before, after, actual, recorded, "post-trade balance check");
        if actual - recorded > 0.5 {
            let msg = format!(
                "balance dropped ${actual:.2} but the bot recorded ${recorded:.2}: an order may have filled unseen"
            );
            error!(market = %job.label, "{msg}");
            if out.uncertain.is_none() {
                out.uncertain = Some(msg);
            }
        }
    }

    /// If one leg filled more than the other, complete the short leg (if still profitable /
    /// break-even) or sell the excess back.
    async fn fix_imbalance(&self, job: &PairJob, out: &mut PairResult) {
        let diff = out.up.shares - out.down.shares;
        if diff.abs() < 1.0 {
            // < 1 share (e.g. fee/rounding dust): worth < $1 and below any tradable size.
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
                let size = crate::arb::tradable_shares(remaining, &[cap_px]);
                if remaining < 1.0 || size < job.min_shares.max(1.0) {
                    break;
                }
                let res = async {
                    let o = self
                        .sign_buy(short_token, cap_px, size, OrderType::FAK)
                        .await?;
                    let r = self.post(&[o]).await?;
                    let r = r.into_iter().next().ok_or_else(|| anyhow!("empty response"))?;
                    self.leg_fill(&r, Side::Buy, cap_px, size)
                        .await
                        .ok_or_else(|| anyhow!("recovery order pending, state unknown"))
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
                if remaining >= 1.0 {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            }
        }
        if remaining < 1.0 {
            info!(market = %job.label, "leg risk resolved: pair completed");
            self.dash.log(&job.label, vec![tag("risk", Color::Green), col("leg risk resolved: pair completed", Color::Green)]);
            return;
        }

        // 2) Still unbalanced: sell the excess of the long leg back.
        let floor = (long_avg - self.cfg.unwind_max_loss_per_share).max(px_to_f64(tick));
        let floor_px = ((floor * f64::from(SCALE)).ceil() as u32).div_ceil(tick) * tick;
        self.dash.log(
            &job.label,
            vec![
                tag("risk", Color::Magenta),
                col(format!("selling back {remaining:.2} sh (min price {:.3})", px_to_f64(floor_px)), Color::Magenta),
            ],
        );
        let mut sold_total = 0.0;
        let mut last_err = String::new();
        let mut shrink = 1.0_f64;
        // Freshly bought shares can take a few seconds to settle before they can be sold,
        // so retry the sell for a while instead of giving up after one attempt.
        for attempt in 1..=self.cfg.unwind_attempts.max(1) {
            let left = remaining - sold_total;
            let sell_size = (left * shrink * 100.0 + 1e-9).floor() / 100.0;
            if left < 1.0 || sell_size < job.min_shares.max(1.0) {
                break;
            }
            let res = async {
                let o = self
                    .sign(long_token, floor_px, sell_size, Side::Sell, OrderType::FAK)
                    .await?;
                let r = self.post(&[o]).await?;
                let r = r.into_iter().next().ok_or_else(|| anyhow!("empty response"))?;
                if !r.success {
                    if let Some(m) = &r.error_msg {
                        return Err(anyhow!("rejected: {m}"));
                    }
                }
                self.leg_fill(&r, Side::Sell, floor_px, sell_size)
                    .await
                    .ok_or_else(|| anyhow!("unwind order pending, state unknown"))
            }
            .await;
            match res {
                Ok(f) => {
                    if f.shares > 0.0 {
                        sold_total += f.shares;
                        let tgt = if long_is_up { &mut out.up } else { &mut out.down };
                        tgt.shares -= f.shares;
                        tgt.usdc -= f.usdc;
                        info!(market = %job.label, attempt, sold = f.shares, "unwind sell filled");
                    }
                }
                Err(e) => {
                    last_err = format!("{e:#}");
                    warn!(market = %job.label, attempt, "unwind sell failed: {last_err}");
                    if last_err.contains("state unknown") {
                        out.uncertain = Some(format!("unwind state unknown: {last_err}"));
                        return;
                    }
                    if last_err.to_ascii_lowercase().contains("balance") && attempt >= 3 {
                        // Still not enough shares after settling time: fees may have been
                        // taken in shares, so try slightly less.
                        shrink = (shrink - 0.01).max(0.95);
                    }
                }
            }
            if remaining - sold_total >= 1.0 {
                tokio::time::sleep(Duration::from_millis(750)).await;
            }
        }

        let left = remaining - sold_total;
        if left < 1.0 {
            info!(market = %job.label, sold = sold_total, "one-sided position closed");
            self.dash.log(
                &job.label,
                vec![
                    tag("risk", Color::Green),
                    col(format!("one-sided position closed: sold {sold_total:.2} sh back"), Color::Green),
                ],
            );
        } else {
            let msg = format!("could not sell back {left:.2} unhedged shares {last_err}");
            error!(market = %job.label, "ALERT: {msg}");
            out.uncertain = Some(msg);
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
