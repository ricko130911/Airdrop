#!/usr/bin/env python3
"""
Estimator probabilitas untuk ronde prediksi crypto ala TrendBTC (UP/DOWN dan INSIDE/BREAKOUT).

Ini BUKAN alat yang bisa menebak pasar dengan pasti. Script menghitung PELUANG
berdasarkan harga live + volatilitas terbaru dari Binance (data publik, tanpa API key),
lalu memberi saran: pilih sisi, atau SKIP kalau peluangnya tidak cukup jelas.

Hanya pakai library standar Python 3.8+. Tidak memasang taruhan otomatis.

Contoh:
  python predict.py watch --symbols BTC ETH SOL XRP DOGE SUI --round 1m
  python predict.py watch --symbols BTC --round 1m --band 60          # mode INSIDE/BREAKOUT, band ±$60
  python predict.py updown --symbol BTC --start 64332.85 --seconds-left 40 --mult 1.9
  python predict.py band --symbol BTC --lower 64280 --upper 64390 --seconds-left 40
  python predict.py backtest --symbol BTC --round 1m --decide-at 20 --minutes 120
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.request

# Beberapa host Binance; yang kedua (data-api.binance.vision) khusus data pasar publik
# dan biasanya bisa diakses dari lebih banyak negara.
BINANCE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"]

ROUND_TO_SECONDS = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600}


# --------------------------------------------------------------------------- #
# Data
# --------------------------------------------------------------------------- #
def _get(path: str, params: dict):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    last_err = None
    for host in BINANCE_HOSTS:
        url = f"{host}{path}?{query}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "trend-predictor/1.0"})
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read().decode())
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            last_err = e
    raise RuntimeError(f"Gagal ambil data Binance ({path}): {last_err}")


def pair(symbol: str) -> str:
    s = symbol.upper()
    return s if s.endswith("USDT") else s + "USDT"


def klines(symbol: str, interval: str, limit: int = 500, start_ms: int | None = None,
           end_ms: int | None = None):
    """Return list of (open_time_ms, open, high, low, close)."""
    params = {"symbol": pair(symbol), "interval": interval, "limit": limit}
    if start_ms is not None:
        params["startTime"] = start_ms
    if end_ms is not None:
        params["endTime"] = end_ms
    raw = _get("/api/v3/klines", params)
    return [(int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4])) for k in raw]


def price_now(symbol: str) -> float:
    return float(_get("/api/v3/ticker/price", {"symbol": pair(symbol)})["price"])


def server_time_ms() -> int:
    try:
        return int(_get("/api/v3/time", {})["serverTime"])
    except RuntimeError:
        return int(time.time() * 1000)


# --------------------------------------------------------------------------- #
# Model (fungsi murni, bisa dites tanpa internet)
# --------------------------------------------------------------------------- #
def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def log_returns(closes):
    return [math.log(b / a) for a, b in zip(closes, closes[1:]) if a > 0 and b > 0]


def estimate_vol_drift(closes_1s, momentum_weight: float = 0.25, momentum_window: int = 60):
    """
    sigma : std log-return per detik (dari data 1 detik terakhir)
    mu    : drift per detik = rata-rata return `momentum_window` detik terakhir x bobot kecil.
            Momentum jangka sangat pendek itu lemah, jadi sengaja dikecilkan (shrink).
    """
    r = log_returns(closes_1s)
    if len(r) < 30:
        raise ValueError("Data 1 detik terlalu sedikit untuk estimasi volatilitas")
    mean = sum(r) / len(r)
    var = sum((x - mean) ** 2 for x in r) / (len(r) - 1)
    sigma = math.sqrt(var)
    # batas bawah supaya tidak terlalu yakin saat pasar sedang sepi
    sigma = max(sigma, 1e-6)
    recent = r[-momentum_window:]
    mu = momentum_weight * (sum(recent) / len(recent))
    # drift tidak boleh lebih dari 0.5 sigma per detik
    mu = max(-0.5 * sigma, min(0.5 * sigma, mu))
    return sigma, mu


def prob_up(price: float, start: float, sigma: float, mu: float, seconds_left: float) -> float:
    """P(harga penutupan ronde > harga start)."""
    if seconds_left <= 0:
        return 1.0 if price > start else 0.0
    s = sigma * math.sqrt(seconds_left)
    z = (math.log(price / start) + mu * seconds_left) / s
    return norm_cdf(z)


def prob_inside_close(price, lower, upper, sigma, mu, seconds_left) -> float:
    """P(harga PENUTUPAN ada di dalam [lower, upper])."""
    if seconds_left <= 0:
        return 1.0 if lower <= price <= upper else 0.0
    s = sigma * math.sqrt(seconds_left)
    hi = (math.log(upper / price) - mu * seconds_left) / s
    lo = (math.log(lower / price) - mu * seconds_left) / s
    return max(0.0, norm_cdf(hi) - norm_cdf(lo))


def prob_inside_touch(price, lower, upper, sigma, seconds_left, tick_seconds: float = 1.0,
                      terms: int = 12) -> float:
    """
    P(harga TIDAK PERNAH menyentuh lower/upper sampai ronde selesai).
    Rumus method-of-images untuk gerak Brown di koridor (tanpa drift), dengan koreksi
    Broadie-Glasserman karena harga feed hanya dicek tiap `tick_seconds` (bukan kontinu).
    """
    if not (lower < price < upper):
        return 0.0
    if seconds_left <= 0:
        return 1.0
    if tick_seconds > 0:
        shift = math.exp(0.5826 * sigma * math.sqrt(tick_seconds))
        lower, upper = lower / shift, upper * shift
    w = math.log(upper / lower)
    x = math.log(price / lower)
    s = sigma * math.sqrt(seconds_left)
    total = 0.0
    for k in range(-terms, terms + 1):
        o = 2 * k * w
        total += (norm_cdf((w - x + o) / s) - norm_cdf((-x + o) / s)
                  - norm_cdf((w + x + o) / s) + norm_cdf((x + o) / s))
    return min(1.0, max(0.0, total))


def decide(p_a: float, label_a: str, label_b: str, threshold: float, mult: float | None):
    """Pilih sisi yang lebih mungkin; SKIP kalau peluang < threshold atau EV negatif."""
    side, p = (label_a, p_a) if p_a >= 0.5 else (label_b, 1 - p_a)
    ev = None if mult is None else p * mult - 1.0
    if p < threshold or (ev is not None and ev <= 0):
        return "SKIP", p, ev
    return side, p, ev


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def round_bounds(now_ms: int, round_s: int):
    start = now_ms - (now_ms % (round_s * 1000))
    return start, start + round_s * 1000


def market_state(symbol: str, round_name: str, now_ms: int | None = None):
    round_s = ROUND_TO_SECONDS[round_name]
    now_ms = now_ms or server_time_ms()
    r_start, r_end = round_bounds(now_ms, round_s)
    start_price = klines(symbol, round_name, limit=1, start_ms=r_start)[0][1]
    secs = klines(symbol, "1s", limit=600)
    closes = [k[4] for k in secs]
    sigma, mu = estimate_vol_drift(closes)
    price = closes[-1]
    left = max(0.0, (r_end - now_ms) / 1000.0)
    return price, start_price, sigma, mu, left


def fmt_pct(p):
    return f"{p * 100:5.1f}%"


def fmt_ev(ev):
    return "   -  " if ev is None else f"{ev * 100:+5.1f}%"


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def cmd_watch(a):
    mode = "band" if (a.band or a.band_pct) else "updown"
    while True:
        now = server_time_ms()
        rows = []
        for sym in a.symbols:
            try:
                price, start, sigma, mu, left = market_state(sym, a.round, now)
            except Exception as e:  # noqa: BLE001
                rows.append(f"{sym.upper():6} error: {e}")
                continue
            if mode == "updown":
                p = prob_up(price, start, sigma, mu, left)
                side, conf, ev = decide(p, "UP", "DOWN", a.threshold, a.mult)
                rows.append(f"{sym.upper():6} {price:>12.4f} {start:>12.4f} {price - start:>+10.4f} "
                            f"{left:5.0f}s  UP {fmt_pct(p)}  DOWN {fmt_pct(1 - p)}  EV {fmt_ev(ev)}  -> {side}")
            else:
                half = a.band if a.band else start * a.band_pct / 100
                lo, hi = start - half, start + half
                p_in = (prob_inside_touch(price, lo, hi, sigma, left) if a.rule == "touch"
                        else prob_inside_close(price, lo, hi, sigma, mu, left))
                side, conf, ev = decide(p_in, "INSIDE", "BREAKOUT", a.threshold, a.mult)
                rows.append(f"{sym.upper():6} {price:>12.4f} band [{lo:.4f} .. {hi:.4f}] {left:5.0f}s  "
                            f"INSIDE {fmt_pct(p_in)}  BREAKOUT {fmt_pct(1 - p_in)}  EV {fmt_ev(ev)}  -> {side}")
        if not a.once:
            print("\033[2J\033[H", end="")
        print(time.strftime("%H:%M:%S"), f"| ronde {a.round} | mode {mode}"
              + (f" ({a.rule})" if mode == "band" else "") + f" | ambang {a.threshold:.0%}")
        if mode == "updown":
            print(f"{'KOIN':6} {'HARGA':>12} {'START':>12} {'SELISIH':>10} {'SISA':>6}")
        for r in rows:
            print(r)
        print("\nCatatan: peluang, bukan kepastian. Harga Binance bisa sedikit beda dari feed situs.")
        if a.once:
            return
        time.sleep(a.interval)


def _state_for_manual(a):
    secs = klines(a.symbol, "1s", limit=600)
    closes = [k[4] for k in secs]
    sigma, mu = estimate_vol_drift(closes)
    price = a.price if a.price else closes[-1]
    return price, sigma, mu


def cmd_updown(a):
    price, sigma, mu = _state_for_manual(a)
    p = prob_up(price, a.start, sigma, mu, a.seconds_left)
    side, conf, ev = decide(p, "UP", "DOWN", a.threshold, a.mult)
    print(f"{a.symbol.upper()} harga {price} | start {a.start} | sisa {a.seconds_left}s "
          f"| vol/detik {sigma * 100:.4f}%")
    print(f"UP {fmt_pct(p)}   DOWN {fmt_pct(1 - p)}   EV {fmt_ev(ev)}")
    if a.mult:
        print(f"Break-even butuh peluang >= {1 / a.mult:.1%} pada multiplier x{a.mult}")
    print(f"Saran: {side}")


def cmd_band(a):
    price, sigma, mu = _state_for_manual(a)
    if a.rule == "touch":
        p_in = prob_inside_touch(price, a.lower, a.upper, sigma, a.seconds_left)
    else:
        p_in = prob_inside_close(price, a.lower, a.upper, sigma, mu, a.seconds_left)
    side, conf, ev = decide(p_in, "INSIDE", "BREAKOUT", a.threshold, a.mult)
    print(f"{a.symbol.upper()} harga {price} | band [{a.lower} .. {a.upper}] | sisa {a.seconds_left}s "
          f"| aturan {a.rule}")
    print(f"INSIDE {fmt_pct(p_in)}   BREAKOUT {fmt_pct(1 - p_in)}   EV {fmt_ev(ev)}")
    print(f"Saran: {side}")


def cmd_backtest(a):
    """
    Uji model UP/DOWN pada data 1 detik historis: di setiap ronde, ambil keputusan
    `decide_at` detik setelah ronde dibuka, lalu cek hasilnya di penutupan.
    """
    round_s = ROUND_TO_SECONDS[a.round]
    end_ms = server_time_ms()
    end_ms -= end_ms % (round_s * 1000)
    need = a.minutes * 60 + 600  # + 10 menit pemanasan untuk volatilitas
    start_ms = end_ms - need * 1000
    data = []
    cur = start_ms
    while cur < end_ms:
        chunk = klines(a.symbol, "1s", limit=1000, start_ms=cur, end_ms=end_ms - 1)
        if not chunk:
            break
        data.extend(chunk)
        cur = chunk[-1][0] + 1000
    by_t = {k[0]: k for k in data}
    t0 = sorted(by_t)
    closes_all = [by_t[t][4] for t in t0]
    idx = {t: i for i, t in enumerate(t0)}

    n = hits = taken = taken_hits = 0
    brier = 0.0
    r = start_ms + 600_000
    while r + round_s * 1000 <= end_ms:
        t_dec = r + a.decide_at * 1000
        t_end = r + round_s * 1000 - 1000
        if r in idx and t_dec in idx and t_end in idx:
            i_dec = idx[t_dec]
            hist = closes_all[max(0, i_dec - 600):i_dec + 1]
            start_p = by_t[r][1]
            final_p = by_t[t_end][4]
            if final_p != start_p and len(hist) > 60:
                sigma, mu = estimate_vol_drift(hist)
                p = prob_up(hist[-1], start_p, sigma, mu, (round_s - a.decide_at))
                up = final_p > start_p
                n += 1
                hits += (p >= 0.5) == up
                brier += (p - (1.0 if up else 0.0)) ** 2
                side, conf, _ = decide(p, "UP", "DOWN", a.threshold, None)
                if side != "SKIP":
                    taken += 1
                    taken_hits += (side == "UP") == up
        r += round_s * 1000

    if n == 0:
        print("Tidak ada ronde yang bisa dites (data kurang).")
        return
    print(f"{a.symbol.upper()} ronde {a.round}, keputusan di detik ke-{a.decide_at}, {n} ronde")
    print(f"Akurasi semua ronde      : {hits / n:.1%}")
    print(f"Brier score              : {brier / n:.4f}  (tebak 50/50 = 0.2500, makin kecil makin baik)")
    if taken:
        print(f"Hanya saat yakin >= {a.threshold:.0%} : {taken_hits / taken:.1%} dari {taken} ronde "
              f"({taken / n:.0%} ronde diambil)")
    else:
        print(f"Tidak ada ronde dengan peluang >= {a.threshold:.0%}")


# --------------------------------------------------------------------------- #
def build_parser():
    p = argparse.ArgumentParser(description="Estimator peluang ronde prediksi crypto (UP/DOWN, INSIDE/BREAKOUT)")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--threshold", type=float, default=0.62,
                        help="peluang minimum untuk memberi saran, selain itu SKIP (default 0.62)")
        sp.add_argument("--mult", type=float, default=None,
                        help="multiplier payout total per $1 (mis. 1.9). Dipakai untuk hitung EV")

    w = sub.add_parser("watch", help="pantau beberapa koin secara live")
    w.add_argument("--symbols", nargs="+", default=["BTC", "ETH", "SOL"])
    w.add_argument("--round", choices=ROUND_TO_SECONDS, default="1m")
    w.add_argument("--interval", type=float, default=3.0, help="refresh tiap N detik")
    w.add_argument("--band", type=float, help="mode INSIDE/BREAKOUT: lebar band ± dalam dolar dari harga start")
    w.add_argument("--band-pct", type=float, help="mode INSIDE/BREAKOUT: lebar band ± dalam persen")
    w.add_argument("--rule", choices=["close", "touch"], default="close",
                   help="close = dinilai dari harga penutupan; touch = BREAKOUT kalau band tersentuh kapan saja")
    w.add_argument("--once", action="store_true", help="cetak sekali lalu keluar")
    common(w)

    u = sub.add_parser("updown", help="hitung peluang UP/DOWN untuk satu ronde (angka dari situs)")
    u.add_argument("--symbol", default="BTC")
    u.add_argument("--start", type=float, required=True, help="harga start ronde (lihat di situs)")
    u.add_argument("--seconds-left", type=float, required=True)
    u.add_argument("--price", type=float, help="harga sekarang (default: dari Binance)")
    common(u)

    b = sub.add_parser("band", help="hitung peluang INSIDE/BREAKOUT")
    b.add_argument("--symbol", default="BTC")
    b.add_argument("--lower", type=float, required=True)
    b.add_argument("--upper", type=float, required=True)
    b.add_argument("--seconds-left", type=float, required=True)
    b.add_argument("--price", type=float)
    b.add_argument("--rule", choices=["close", "touch"], default="close")
    common(b)

    t = sub.add_parser("backtest", help="uji akurasi model UP/DOWN pada data historis")
    t.add_argument("--symbol", default="BTC")
    t.add_argument("--round", choices=ROUND_TO_SECONDS, default="1m")
    t.add_argument("--decide-at", type=int, default=20, help="detik setelah ronde dibuka saat memutuskan")
    t.add_argument("--minutes", type=int, default=120)
    common(t)
    return p


def main(argv=None):
    a = build_parser().parse_args(argv)
    try:
        {"watch": cmd_watch, "updown": cmd_updown, "band": cmd_band, "backtest": cmd_backtest}[a.cmd](a)
    except KeyboardInterrupt:
        pass
    except RuntimeError as e:
        print(e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
