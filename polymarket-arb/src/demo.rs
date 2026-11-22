//! `--demo`: drives the dashboard with a simulated order-book feed so the UI can be tried
//! without a wallet or network. Uses the real arb math on synthetic books. NO real orders.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ratatui::style::Color;

use crate::arb::{self, FeeModel, Limits};
use crate::book::{AskBook, px_to_f64};
use crate::dash::{Dash, MarketView, col, dim, tag, txt};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

struct Sim {
    label: &'static str,
    period: i64,
    mid: f64,
    up: AskBook,
    down: AskBook,
    sh_up: f64,
    sh_down: f64,
    spent: f64,
}

pub async fn run(dash: Arc<Dash>) {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let fee = FeeModel { rate: 0.0, exponent: 1 };
    let mut sims = [Sim { label: "btc-5m", period: 300, mid: 0.52, up: AskBook::default(), down: AskBook::default(), sh_up: 0.0, sh_down: 0.0, spent: 0.0 },
        Sim { label: "eth-15m", period: 900, mid: 0.47, up: AskBook::default(), down: AskBook::default(), sh_up: 0.0, sh_down: 0.0, spent: 0.0 }];
    let (mut last_sec, mut last_net) = (Instant::now(), Instant::now());
    let mut last_log = [Instant::now(), Instant::now()];
    loop {
        tokio::time::sleep(Duration::from_millis(35)).await;
        let i = (rng.next() * sims.len() as f64) as usize % sims.len();
        let s = &mut sims[i];
        dash.count_msg();
        s.mid = (s.mid + (rng.next() - 0.5) * 0.02).clamp(0.08, 0.92);
        // the spread between asks is normally 1-4c over $1, occasionally it inverts
        let over = if rng.next() < 0.012 { -0.02 - rng.next() * 0.03 } else { 0.01 + (rng.next() * 3.0).floor() / 100.0 };
        let pu = ((s.mid + over / 2.0) * 100.0).round() / 100.0;
        let pd = ((1.0 - s.mid + over / 2.0) * 100.0).round() / 100.0;
        s.up.clear();
        s.down.clear();
        for k in 0..4u32 {
            s.up.set((pu * 10_000.0) as u32 + k * 100, 100.0 + rng.next() * 3_000.0);
            s.down.set((pd * 10_000.0) as u32 + k * 100, 100.0 + rng.next() * 3_000.0);
        }
        let lim = Limits { max_pair_cost: 0.98, max_shares: 2_000.0, max_usdc: 1_500.0, min_shares: 5.0, min_leg_usdc: 1.0 };
        let opp = arb::find(&s.up, &s.down, &fee, &fee, &lim);
        let lag = 2 + (rng.next() * 12.0) as u64;

        if opp.is_some() || last_log[i].elapsed() > Duration::from_millis(250) {
            last_log[i] = Instant::now();
            let sum = pu + pd;
            if rng.next() < 0.35 {
                dash.log(s.label, vec![tag("ws", Color::Blue), dim(format!(
                    "price_change {:<4} {:<4} {:>6.0} @{:.2}",
                    if rng.next() < 0.5 { "UP" } else { "DOWN" },
                    if rng.next() < 0.5 { "BUY" } else { "SELL" },
                    rng.next() * 1500.0, pu))]);
            }
            dash.log(s.label, vec![
                tag("book", Color::DarkGray),
                col(format!("\u{3a3} {sum:.3}  "), if sum <= 0.98 { Color::Yellow } else { Color::White }),
                col("UP ", Color::Green), txt(format!("{pu:.2} x {:<7.0}", s.up.size((pu * 10_000.0) as u32))),
                col("DOWN ", Color::Red), txt(format!("{pd:.2} x {:<7.0}", s.down.size((pd * 10_000.0) as u32))),
                dim(format!("{lag}ms  ")),
                if opp.is_some() { col("FIRE", Color::Yellow) } else { dim("skip") },
            ]);
        }

        if let Some(o) = opp {
            let fire_us = 900 + (rng.next() * 2_500.0) as u64;
            let sign_us = 90 + (rng.next() * 60.0) as u64;
            dash.log(s.label, vec![
                tag("gap", Color::Yellow),
                col(format!("\u{3a3} {:.3}  ", o.avg_pair_cost()), Color::Yellow),
                col("UP ", Color::Green), txt(format!("\u{2264}{:.2}  ", px_to_f64(o.up_px))),
                col("DOWN ", Color::Red), txt(format!("\u{2264}{:.2}  ", px_to_f64(o.down_px))),
                col(format!("edge {:+.3} x {:.0} sh = {:+.2}", 1.0 - o.avg_pair_cost(), o.shares, o.expected_profit()), Color::Green),
            ]);
            dash.log(s.label, vec![tag("exec", Color::Cyan), txt(format!(
                "sign EIP-712 x2 \u{b7} post FOK {:.0} sh \u{b7} {:.2}ms tick\u{2192}resp", o.shares, fire_us as f64 / 1000.0))]);
            dash.record_latency(sign_us, fire_us);
            if rng.next() < 0.7 {
                for (n, px, c) in [("UP", o.up_px, Color::Green), ("DOWN", o.down_px, Color::Red)] {
                    dash.log(s.label, vec![tag("fill", Color::Green), col(format!("{n} "), c),
                        txt(format!("{:.0}/{:.0} @{:.2}", o.shares, o.shares, px_to_f64(px)))]);
                }
                s.sh_up += o.shares;
                s.sh_down += o.shares;
                s.spent += o.total_cost();
                dash.with(|st| { st.locks += 1; });
            } else {
                dash.log(s.label, vec![tag("fill", Color::Red), col("FOK killed \u{2014} liquidity taken by a faster bot", Color::Red)]);
                dash.with(|st| st.misses += 1);
            }
        }

        if last_net.elapsed() > Duration::from_secs(4) {
            last_net = Instant::now();
            dash.log("net", vec![tag("net", Color::Blue), dim(format!("heartbeat clob {:.1}ms", 1.0 + rng.next() * 3.0))]);
            dash.with(|st| st.clob_rtt_us = 1_000 + (rng.next() * 3_000.0) as u64);
        }

        if last_sec.elapsed() >= Duration::from_secs(1) {
            last_sec = Instant::now();
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
            let views: Vec<MarketView> = sims.iter().map(|s| MarketView {
                label: s.label.into(),
                slug: format!("{}-updown-{}-{}", &s.label[..3], &s.label[4..], now - now % s.period),
                up_ask: s.up.best().map(px_to_f64),
                down_ask: s.down.best().map(px_to_f64),
                fee_rate: 0.0,
                secs_left: s.period - now % s.period,
                spent: s.spent,
                shares_up: s.sh_up,
                shares_down: s.sh_down,
            }).collect();
            let pnl: f64 = sims.iter().map(|s| s.sh_up.min(s.sh_down) - s.spent).sum();
            let cap: f64 = sims.iter().map(|s| s.spent).sum();
            let total = dash.msgs.swap(0, std::sync::atomic::Ordering::Relaxed);
            dash.with(|st| {
                st.markets = views;
                st.locked_pnl = pnl;
                st.capital_in_use = cap;
                st.msgs_per_sec = total;
                st.ws_status = "ok (simulated)".into();
            });
        }
    }
}
