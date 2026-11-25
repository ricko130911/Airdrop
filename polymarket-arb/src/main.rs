//! Polymarket UP/DOWN complete-set arbitrage bot.
//!
//! Usage:
//!   polymarket-arb            # TUI dashboard (default), reads config from env / .env
//!   polymarket-arb --no-tui   # plain logs to stdout (for systemd / tmux / docker)
//!   polymarket-arb --demo     # dashboard with a simulated feed, no wallet needed
//!   polymarket-arb --check    # show the balance seen by each SIGNATURE_TYPE, then exit
//!   polymarket-arb --record   # record order books + outcomes for backtesting (no wallet, no orders)
//!   polymarket-arb --backtest [DIR] [--shares 5] [--latency-ms 500]   # simulate strategies on recorded data
//!
//! Web dashboard: http://<vps-ip>:WEB_PORT (needs WEB_PASSWORD, see .env.example)

mod arb;
mod backtest;
mod book;
mod config;
mod dash;
mod demo;
mod discovery;
mod engine;
mod exec;
mod record;
mod ui;
mod web;

use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc;
use tracing::info;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn start_web(dash: &Arc<dash::Dash>) {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    if env("WEB_ENABLED").is_some_and(|v| v == "false") {
        return;
    }
    let port = env("WEB_PORT").and_then(|p| p.parse().ok()).unwrap_or(8080);
    let user = env("WEB_USER").unwrap_or_else(|| "admin".into());
    web::spawn(Arc::clone(dash), port, user, env("WEB_PASSWORD"));
}

fn main() -> Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _ = dotenvy::dotenv();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |f: &str| args.iter().any(|a| a == f);
    let demo = has("--demo");
    let tui = !has("--no-tui") && !has("--check") && !has("--record") && !has("--backtest");

    // With the TUI on, logs go to a file so they don't corrupt the screen.
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info,polymarket_client_sdk_v2=warn".into());
    if tui {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("polymarket-arb.log")?;
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_ansi(false)
            .with_writer(std::sync::Mutex::new(file))
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }

    if has("--backtest") {
        // offline simulation over recorded data: no network, no wallet
        return backtest::run(&args);
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()?;
    rt.block_on(async move {
        if demo {
            let dash = Arc::new(dash::Dash::new(true, 0.98, "btc,eth (simulated) 5m,15m".into()));
            start_web(&dash);
            if tui {
                ui::spawn(Arc::clone(&dash));
            }
            demo::run(dash).await;
            return Ok(());
        }
        if has("--record") {
            // read-only recorder: needs no wallet and cannot trade
            return record::run().await;
        }
        let cfg = config::Config::from_env()?;
        if has("--check") {
            return exec::check_wallets(&cfg).await;
        }
        let watching = format!(
            "{} \u{b7} {}",
            cfg.assets.join(","),
            cfg.intervals.iter().map(|i| i.label.as_str()).collect::<Vec<_>>().join(",")
        );
        let dash = Arc::new(dash::Dash::new(cfg.dry_run, cfg.max_pair_cost, watching));
        info!(dry_run = cfg.dry_run, max_pair_cost = cfg.max_pair_cost, "starting");
        start_web(&dash);

        let exec = exec::Executor::new(&cfg, Arc::clone(&dash)).await?;
        exec.latency_probe().await;
        if tui {
            ui::spawn(Arc::clone(&dash));
        }

        let (tx, rx) = mpsc::channel(64);
        tokio::spawn(discovery::run(cfg.clone(), Arc::clone(&exec), tx));
        tokio::select! {
            () = engine::run(cfg, exec, dash, rx) => {}
            _ = tokio::signal::ctrl_c() => {}
        }
        if tui {
            ratatui::restore();
        }
        Ok::<_, anyhow::Error>(())
    })
}
