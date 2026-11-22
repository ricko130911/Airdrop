//! pm2-monit style terminal dashboard. Runs on its own OS thread so rendering can never
//! stall the async hot path.

use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use polymarket_client_sdk_v2::types::Utc;
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Paragraph};

use crate::dash::{Dash, State, percentile};

const ACCENT: Color = Color::Cyan;

struct View {
    scroll: usize,
    all_markets: bool,
}

pub fn spawn(dash: Arc<Dash>) {
    std::thread::Builder::new()
        .name("tui".into())
        .spawn(move || {
            let mut term = ratatui::init();
            let mut view = View {
                scroll: 0,
                all_markets: false,
            };
            loop {
                let _ = term.draw(|f| draw(f, &dash, &view));
                if event::poll(Duration::from_millis(100)).unwrap_or(false)
                    && let Ok(Event::Key(k)) = event::read() {
                        if k.kind != KeyEventKind::Press {
                            continue;
                        }
                        let quit = matches!(k.code, KeyCode::Char('q') | KeyCode::Esc)
                            || (k.code == KeyCode::Char('c')
                                && k.modifiers.contains(KeyModifiers::CONTROL));
                        if quit {
                            ratatui::restore();
                            std::process::exit(0);
                        }
                        dash.with(|s| {
                            let n = s.markets.len().max(1);
                            match k.code {
                                KeyCode::Right | KeyCode::Tab => s.selected = (s.selected + 1) % n,
                                KeyCode::Left | KeyCode::BackTab => {
                                    s.selected = (s.selected + n - 1) % n
                                }
                                _ => {}
                            }
                        });
                        match k.code {
                            KeyCode::Up => view.scroll += 1,
                            KeyCode::Down => view.scroll = view.scroll.saturating_sub(1),
                            KeyCode::PageUp => view.scroll += 20,
                            KeyCode::PageDown => view.scroll = view.scroll.saturating_sub(20),
                            KeyCode::End => view.scroll = 0,
                            KeyCode::Char('a') => view.all_markets = !view.all_markets,
                            _ => {}
                        }
                    }
            }
        })
        .expect("spawn tui thread");
}

fn panel(title: &str) -> Block<'_> {
    Block::bordered()
        .border_type(BorderType::Plain)
        .border_style(Style::default().fg(ACCENT))
        .title(Span::styled(
            format!(" {title} "),
            Style::default().fg(Color::White).add_modifier(Modifier::BOLD),
        ))
}

fn kv<'a>(k: &'a str, v: String, c: Color, w: usize) -> Line<'a> {
    let pad = w.saturating_sub(k.chars().count() + v.chars().count());
    Line::from(vec![
        Span::raw(k),
        Span::raw(" ".repeat(pad)),
        Span::styled(v, Style::default().fg(c)),
    ])
}

fn fmt_dur(secs: u64) -> String {
    let (h, m, s) = (secs / 3600, (secs / 60) % 60, secs % 60);
    if h > 0 { format!("{h}h {m}m") } else { format!("{m}m {s}s") }
}

fn draw(f: &mut Frame, dash: &Dash, view: &View) {
    let s = dash.state.lock().unwrap();
    let [main, footer] = Layout::vertical([Constraint::Min(10), Constraint::Length(1)]).areas(f.area());
    let mlist_h = (s.markets.len() as u16 + 2).clamp(3, 10);
    if main.width < 100 {
        // Narrow screen (e.g. SSH from a phone): stack panels, drop Metadata.
        let [mlist, metrics, logs] = Layout::vertical([
            Constraint::Length(mlist_h),
            Constraint::Length(23),
            Constraint::Min(5),
        ])
        .areas(main);
        draw_markets(f, mlist, &s);
        draw_metrics(f, metrics, dash, &s);
        draw_logs(f, logs, &s, view);
    } else {
        let [left, right] =
            Layout::horizontal([Constraint::Length(42), Constraint::Min(40)]).areas(main);
        let [mlist, metrics] =
            Layout::vertical([Constraint::Length(mlist_h), Constraint::Min(5)]).areas(left);
        let [logs, meta] =
            Layout::vertical([Constraint::Min(5), Constraint::Length(8)]).areas(right);
        draw_markets(f, mlist, &s);
        draw_metrics(f, metrics, dash, &s);
        draw_logs(f, logs, &s, view);
        draw_meta(f, meta, dash, &s);
    }

    let now = Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string();
    let help = "left/right: switch market | up/down/PgUp/PgDn: scroll | a: all markets | q: exit";
    let pad = (footer.width as usize).saturating_sub(help.len() + now.len() + 14);
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(help, Style::default().fg(Color::Gray)),
            Span::raw(" ".repeat(pad)),
            Span::styled(format!("polymarket-arb \u{b7} {now}"), Style::default().fg(Color::Gray)),
        ])),
        footer,
    );
}

fn draw_markets(f: &mut Frame, area: Rect, s: &State) {
    let mut lines = Vec::new();
    if s.markets.is_empty() {
        lines.push(Line::styled(" waiting for markets...", Style::default().fg(Color::DarkGray)));
    }
    for (i, m) in s.markets.iter().enumerate() {
        let sel = i == s.selected;
        let sum = m.up_ask.zip(m.down_ask).map(|(a, b)| a + b);
        let dot = match sum {
            Some(x) if x < 1.0 => Color::Yellow,
            Some(_) => Color::Green,
            None => Color::DarkGray,
        };
        let style = if sel {
            Style::default().bg(Color::Rgb(30, 60, 70)).fg(Color::White)
        } else {
            Style::default()
        };
        lines.push(
            Line::from(vec![
                Span::styled(format!("[{i:>2}] "), Style::default().fg(Color::DarkGray)),
                Span::styled(format!("{:<9}", m.label), Style::default().fg(ACCENT)),
                Span::raw(format!(" T-{:<5}", format!("{}s", m.secs_left.max(0)))),
                Span::raw(format!(
                    "\u{3a3} {:<6}",
                    sum.map(|x| format!("{x:.3}")).unwrap_or_else(|| "-".into())
                )),
                Span::styled(" \u{25cf}", Style::default().fg(dot)),
            ])
            .style(style),
        );
    }
    f.render_widget(Paragraph::new(lines).block(panel("Markets")), area);
}

fn draw_metrics(f: &mut Frame, area: Rect, dash: &Dash, s: &State) {
    let w = area.width.saturating_sub(2) as usize;
    let m = s.markets.get(s.selected);
    let up = m.and_then(|m| m.up_ask);
    let down = m.and_then(|m| m.down_ask);
    let sum = up.zip(down).map(|(a, b)| a + b);
    let edge = sum.map(|x| 1.0 - x);
    let f2 = |x: Option<f64>, d: usize| x.map(|v| format!("{v:.d$}")).unwrap_or_else(|| "-".into());
    let ms = |us: Option<u64>| us.map(|u| format!("{:.2} ms", u as f64 / 1000.0)).unwrap_or_else(|| "-".into());
    let fired = s.locks + s.misses + s.leg_risk_events;
    let hit = if fired > 0 {
        format!("{} %", s.locks * 100 / fired)
    } else {
        "-".into()
    };
    let pnl = s.locked_pnl + s.locked_pnl_closed;
    let pnl_c = if pnl >= 0.0 { Color::Green } else { Color::Red };

    let lines = vec![
        kv("\u{3a3} best asks", f2(sum, 3), if sum.is_some_and(|x| x <= dash.max_pair_cost) { Color::Yellow } else { Color::White }, w),
        kv("UP best ask", f2(up, 2), Color::Green, w),
        kv("DOWN best ask", f2(down, 2), Color::Red, w),
        kv("Edge", edge.map(|e| format!("{e:+.3}")).unwrap_or_else(|| "-".into()),
            if edge.is_some_and(|e| e > 0.0) { Color::Green } else { Color::Yellow }, w),
        kv("Fire threshold \u{3a3} \u{2264}", format!("{:.3}", dash.max_pair_cost), Color::White, w),
        kv("Time left", m.map(|m| fmt_dur(m.secs_left.max(0) as u64)).unwrap_or_else(|| "-".into()), Color::White, w),
        kv("Taker fee rate", m.map(|m| format!("{}", m.fee_rate)).unwrap_or_else(|| "-".into()), Color::White, w),
        kv("Position UP/DOWN", m.map(|m| format!("{:.0} / {:.0}", m.shares_up, m.shares_down)).unwrap_or_else(|| "-".into()), Color::White, w),
        kv("Market cost", m.map(|m| format!("${:.2}", m.spent)).unwrap_or_else(|| "-".into()), Color::White, w),
        kv("Locked PnL", format!("{pnl:+.2}"), pnl_c, w),
        kv("Locks / Miss", format!("{} / {}", s.locks, s.misses), Color::White, w),
        kv("Leg-risk events", s.leg_risk_events.to_string(), if s.leg_risk_events > 0 { Color::Magenta } else { Color::White }, w),
        kv("Hit rate", hit, Color::White, w),
        kv("Tick\u{2192}fill p50", ms(percentile(&s.fire_lat_us, 0.5)), Color::White, w),
        kv("Tick\u{2192}fill p95", ms(percentile(&s.fire_lat_us, 0.95)), Color::White, w),
        kv("Sign latency p50", ms(percentile(&s.sign_lat_us, 0.5)), Color::White, w),
        kv("CLOB RTT", ms((s.clob_rtt_us > 0).then_some(s.clob_rtt_us)), Color::White, w),
        kv("Book msgs/s", s.msgs_per_sec.to_string(), Color::White, w),
        kv("Capital in use", format!("${:.2}", s.capital_in_use), Color::White, w),
        kv("Trading", s.halted.as_ref().map_or("active".to_string(), |_| "HALTED".to_string()),
            if s.halted.is_some() { Color::Red } else { Color::Green }, w),
        kv("WS feed", s.ws_status.clone(), if s.ws_status.starts_with("ok") { Color::Green } else { Color::Red }, w),
    ];
    f.render_widget(Paragraph::new(lines).block(panel("Custom Metrics")), area);
}

fn draw_logs(f: &mut Frame, area: Rect, s: &State, view: &View) {
    let sel = s.markets.get(s.selected).map(|m| m.label.as_str());
    let title = match (view.all_markets, sel) {
        (false, Some(l)) => format!("arb-{l} Logs"),
        _ => "arb Logs (all markets)".into(),
    };
    let h = area.height.saturating_sub(2) as usize;
    let filtered: Vec<_> = s
        .logs
        .iter()
        .filter(|l| {
            view.all_markets
                || sel.is_none()
                || Some(l.market.as_str()) == sel
                || l.market == "net"
                || l.market == "ws"
        })
        .collect();
    let end = filtered.len().saturating_sub(view.scroll.min(filtered.len()));
    let start = end.saturating_sub(h);
    let lines: Vec<Line> = filtered[start..end]
        .iter()
        .map(|l| {
            let mut spans = vec![Span::styled(
                format!("arb-{} > ", l.market),
                Style::default().fg(ACCENT),
            )];
            spans.extend(
                l.spans
                    .iter()
                    .map(|(t, c)| Span::styled(t.clone(), Style::default().fg(*c))),
            );
            Line::from(spans)
        })
        .collect();
    f.render_widget(Paragraph::new(lines).block(panel(&title)), area);
}

fn draw_meta(f: &mut Frame, area: Rect, dash: &Dash, s: &State) {
    let up = dash.started.elapsed().as_secs();
    let mode = if dash.dry_run {
        Span::styled("DRY RUN (no orders)", Style::default().fg(Color::Yellow))
    } else {
        Span::styled("LIVE", Style::default().fg(Color::Green).add_modifier(Modifier::BOLD))
    };
    let slug = s.markets.get(s.selected).map(|m| m.slug.clone()).unwrap_or_default();
    let g = |t: &'static str| Span::styled(format!("{t:<12}"), Style::default().fg(Color::Gray));
    let lines = vec![
        Line::from(vec![g("App name"), Span::raw(format!("{:<22}", "polymarket-arb")), g("Market"), Span::raw(slug)]),
        Line::from(vec![g("Strategy"), Span::raw(format!("{:<22}", "UP+DOWN complete set")), g("Watching"), Span::raw(dash.markets_arg.clone())]),
        Line::from(vec![g("Version"), Span::raw(format!("{:<22}", env!("CARGO_PKG_VERSION"))), g("Order type"), Span::raw("FOK batch (2 legs / 1 request)")]),
        Line::from(vec![g("Mode"), mode, Span::raw("   "), g("Threshold"), Span::raw(format!("\u{3a3} ask + fees \u{2264} {:.3}", dash.max_pair_cost))]),
        Line::from(vec![g("Uptime"), Span::styled(format!("{:<22}", fmt_dur(up)), Style::default().fg(Color::Green)), g("Language"), Span::raw("Rust (tokio, LTO, native CPU)")]),
    ];
    f.render_widget(Paragraph::new(lines).block(panel("Metadata")), area);
}
