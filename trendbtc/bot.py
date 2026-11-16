#!/usr/bin/env python3
"""
Bot prediksi TrendBTC untuk SEMUA market (BTC, ETH, SOL, XRP, DOGE, SUI, TRUMP, ...)
dan semua durasi ronde (default 5m, 15m, 1h).

Alur:
  1. Ambil daftar ronde aktif dari API publik situs  (GET /api/markets/current-rounds)
  2. Ambil harga feed situs                           (GET /api/prices/<koin>)
  3. Hitung volatilitas dari Binance, lalu peluang tiap sisi (UP/DOWN atau INSIDE/BREAKOUT)
  4. Hitung payout dengan rumus situs sendiri (pool + bonus waktu + rake), lalu EV dalam dolar
  5. Kalau peluang >= ambang dan EV >= batas, pasang taruhan (HANYA dengan --live)

Default-nya DRY RUN: tidak ada taruhan sungguhan. Taruhan sungguhan butuh --live + token login.

Token: TIDAK PERNAH ditempel ke chat / di-commit. Simpan di file .tokens.json (sudah di .gitignore)
atau environment variable TRENDBTC_REFRESH_TOKEN. Lihat README.md.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

import predict as M

API = os.environ.get("TRENDBTC_API", "https://api.trendbtc.app")
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TOKEN_FILE = os.path.join(HERE, ".tokens.json")
DEFAULT_RULES = {"rakeRate": 0.05, "earlyMultiplierMin": 0.3, "earlyMultiplierMax": 1.5}
UPSIDE = {"UP", "INSIDE"}  # sisi yang memakai upPool/upWeight (sama seperti di frontend situs)


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


# --------------------------------------------------------------------------- #
# HTTP + token
# --------------------------------------------------------------------------- #
def http(method: str, url: str, body=None, headers=None):
    """Return (status, json_or_None). Dipisah supaya gampang di-mock waktu tes."""
    data = None if body is None else json.dumps(body).encode()
    h = {"Accept": "application/json", "User-Agent": "trendbtc-helper/1.0"}
    if body is not None:
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else None
        except ValueError:
            return e.code, {"message": raw[:200].decode(errors="replace")}


def _err_msg(payload):
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict) and err.get("message"):
            return err["message"]
        if isinstance(err, str):
            return err
        if payload.get("message"):
            return payload["message"]
    return str(payload)[:200]


class TokenStore:
    def __init__(self, path):
        self.path = path
        self.access = os.environ.get("TRENDBTC_ACCESS_TOKEN")
        self.refresh = os.environ.get("TRENDBTC_REFRESH_TOKEN")
        if os.path.exists(path):
            with open(path) as f:
                d = json.load(f)
            self.access = self.access or d.get("accessToken")
            self.refresh = self.refresh or d.get("refreshToken")

    def save(self):
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"accessToken": self.access, "refreshToken": self.refresh}, f)
        os.chmod(self.path, 0o600)  # hanya pemilik yang bisa baca token

    @property
    def available(self):
        return bool(self.access or self.refresh)


class Client:
    def __init__(self, tokens: TokenStore | None = None, base: str = API):
        self.base = base
        self.tokens = tokens

    def _refresh(self):
        if not (self.tokens and self.tokens.refresh):
            raise ApiError(401, "access token kedaluwarsa dan tidak ada refresh token")
        st, d = http("POST", self.base + "/api/auth/refresh", {"refreshToken": self.tokens.refresh})
        if st != 200 or not d or not d.get("accessToken"):
            raise ApiError(st, "refresh token gagal: " + _err_msg(d) + " (login ulang di browser, ambil token baru)")
        self.tokens.access = d["accessToken"]
        # situs merotasi refresh token: token lama tidak berlaku lagi, jadi simpan yang baru
        self.tokens.refresh = d.get("refreshToken") or self.tokens.refresh
        self.tokens.save()

    def request(self, method, path, body=None, auth=False):
        headers = {}
        if auth:
            if not (self.tokens and self.tokens.available):
                raise ApiError(401, "butuh token login (lihat README)")
            if not self.tokens.access:
                self._refresh()
            headers["Authorization"] = "Bearer " + self.tokens.access
        st, d = http(method, self.base + path, body, headers)
        if st == 401 and auth:
            self._refresh()
            headers["Authorization"] = "Bearer " + self.tokens.access
            st, d = http(method, self.base + path, body, headers)
        if st == 403 and not auth:
            raise ApiError(st, "ditolak server (proteksi bot / IP diblokir). Coba dari koneksi rumah, tanpa VPN.")
        if not 200 <= st < 300:
            raise ApiError(st, _err_msg(d))
        return d

    # ---- endpoint publik
    def current_rounds(self):
        return (self.request("GET", "/api/markets/current-rounds") or {}).get("rounds") or []

    def price(self, market_symbol: str) -> float:
        coin = market_symbol.upper().removesuffix("USD").lower() or "btc"
        return float(self.request("GET", f"/api/prices/{coin}")["price"])

    def rules(self):
        try:
            r = (self.request("GET", "/api/markets/btc/prediction-rules") or {}).get("rules") or {}
        except ApiError:
            r = {}
        out = dict(DEFAULT_RULES)
        out.update({k: v for k, v in r.items() if isinstance(v, (int, float))})
        return out

    # ---- endpoint butuh login
    def my_active_round_ids(self):
        d = self.request("GET", "/api/markets/my-active-predictions", auth=True) or {}
        return {p.get("roundId") or (p.get("round") or {}).get("id") for p in d.get("predictions") or []}

    def me(self):
        return self.request("GET", "/api/me", auth=True)

    def balances(self):
        return self.request("GET", "/api/me/balances", auth=True)

    def my_predictions(self, limit=50):
        d = self.request("GET", f"/api/predictions/my?limit={int(limit)}", auth=True) or {}
        return d.get("predictions") or d.get("items") or []

    def place(self, round_id, direction, stake):
        body = {"roundId": round_id, "direction": direction, "stakeAmount": stake,
                "idempotencyKey": str(uuid.uuid4())}
        return (self.request("POST", "/api/predictions", body, auth=True) or {}).get("prediction")


# --------------------------------------------------------------------------- #
# Rumus payout (disalin dari frontend situs) + EV
# --------------------------------------------------------------------------- #
def ts_ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def time_multiplier(rnd, rules, now_ms):
    """Bonus waktu: turun linear dari earlyMultiplierMax (saat start) ke earlyMultiplierMin (saat lock)."""
    lo = min(rules["earlyMultiplierMin"], rules["earlyMultiplierMax"])
    hi = max(rules["earlyMultiplierMin"], rules["earlyMultiplierMax"])
    start, lock = ts_ms(rnd["startTime"]), ts_ms(rnd["lockTime"])
    span = lock - start
    if span <= 0:
        return lo
    frac = min(max(now_ms - start, 0), span) / span
    return round(hi - (hi - lo) * frac, 6)


def payout_if_win(stake, direction, rnd, rules, now_ms):
    """Total uang kembali kalau menang = stake + bagian dari pool lawan (setelah rake)."""
    mult = time_multiplier(rnd, rules, now_ms)
    weight = stake * mult
    up = direction in UPSIDE
    side_w = ((rnd.get("upWeight") or 0) if up else (rnd.get("downWeight") or 0)) + weight
    opp = max((rnd.get("downPool") or 0) if up else (rnd.get("upPool") or 0), 0) * (1 - rules["rakeRate"])
    win = opp * weight / side_w if side_w > 0 and stake > 0 else 0.0
    return round(stake + win, 2), mult


def side_probs(rnd, price, sigma, mu, seconds_left):
    start = float(rnd["startPrice"])
    hw = rnd.get("corridorHalfWidth")
    if hw:
        p_in = M.prob_inside_close(price, start - hw, start + hw, sigma, mu, seconds_left)
        return {"INSIDE": p_in, "BREAKOUT": 1 - p_in}
    p_up = M.prob_up(price, start, sigma, mu, seconds_left)
    return {"UP": p_up, "DOWN": 1 - p_up}


def evaluate(rnd, price, sigma, mu, rules, stake, now_ms):
    """List (direction, peluang, payout_total, EV_dolar, multiplier) diurutkan EV terbesar."""
    left = max(0.0, (ts_ms(rnd["endTime"]) - now_ms) / 1000)
    out = []
    for d, p in side_probs(rnd, price, sigma, mu, left).items():
        pay, mult = payout_if_win(stake, d, rnd, rules, now_ms)
        ev = p * (pay - stake) - (1 - p) * stake
        out.append((d, p, pay, ev, mult))
    return sorted(out, key=lambda x: x[3], reverse=True)


# --------------------------------------------------------------------------- #
# Volatilitas (Binance, di-cache)
# --------------------------------------------------------------------------- #
class Vol:
    def __init__(self, ttl=20):
        self.ttl, self.cache = ttl, {}

    def get(self, market_symbol, horizon_s):
        coin = market_symbol.upper().removesuffix("USD")
        kind = "1s" if horizon_s <= 120 else "1m"
        key = (coin, kind)
        hit = self.cache.get(key)
        if hit and time.time() - hit[0] < self.ttl:
            return hit[1]
        if kind == "1s":
            closes = [k[4] for k in M.klines(coin, "1s", limit=600)]
            val = M.estimate_vol_drift(closes)
        else:
            closes = [k[4] for k in M.klines(coin, "1m", limit=240)]
            secs = [k[4] for k in M.klines(coin, "1s", limit=300)]
            _, mu = M.estimate_vol_drift(secs)
            val = (M.estimate_vol_1m(closes), mu)
        self.cache[key] = (time.time(), val)
        return val


# --------------------------------------------------------------------------- #
# Loop utama
# --------------------------------------------------------------------------- #
def fmt_dur(s):
    return f"{s // 3600}h" if s % 3600 == 0 else f"{s // 60}m"


def log_row(path, row):
    new = not os.path.exists(path)
    with open(path, "a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["time", "round_id", "market", "duration", "direction", "prob", "stake",
                        "payout_if_win", "ev", "time_mult", "mode", "result"])
        w.writerow(row)


def assess(r, client, vol, rules, stake, threshold, min_edge, lock_margin, now, prices):
    """Nilai satu ronde. Return dict (dipakai CLI dan dashboard). `prices` = cache harga per market."""
    sym, dur = r.get("marketSymbol", "?"), int(r.get("durationSeconds") or 0)
    row = {"id": r.get("id"), "market": sym, "duration": dur, "status": r.get("status"),
           "corridor": r.get("corridorHalfWidth"), "startPrice": None, "price": None, "lockIn": None,
           "endIn": None, "probs": {}, "best": None, "p": None, "ev": None, "payout": None, "mult": None,
           "upPool": r.get("upPool") or 0, "downPool": r.get("downPool") or 0, "eligible": False, "note": ""}
    if r.get("status") != "open" or r.get("startPrice") in (None, ""):
        row["note"] = f"status={r.get('status')} (lewati)"
        return row
    row["startPrice"] = float(r["startPrice"])
    row["lockIn"] = (ts_ms(r["lockTime"]) - now) / 1000
    row["endIn"] = (ts_ms(r["endTime"]) - now) / 1000
    if row["lockIn"] <= lock_margin:
        row["note"] = "terkunci/hampir terkunci"
        return row
    try:
        if sym not in prices:
            prices[sym] = client.price(sym)
        sigma, mu = vol.get(sym, row["endIn"])
    except Exception as e:  # noqa: BLE001
        row["note"] = f"data harga gagal: {e}"
        return row
    row["price"] = prices[sym]
    res = evaluate(r, row["price"], sigma, mu, rules, stake, now)
    d, p, pay, ev, mult = res[0]
    row.update(probs={x[0]: x[1] for x in res}, best=d, p=p, ev=ev, payout=pay, mult=mult,
               eligible=p >= threshold and ev >= min_edge * stake)
    return row


def run(a, client=None, vol=None, now_fn=None, sleep_fn=time.sleep):
    tokens = TokenStore(a.token_file) if a.live else None
    if a.live and not tokens.available:
        print("Mode --live butuh token. Lihat README bagian 'Token login'.", file=sys.stderr)
        return 2
    client = client or Client(tokens)
    vol = vol or Vol()
    now_fn = now_fn or (lambda: int(time.time() * 1000))
    rules = client.rules()
    durations = {int(d) for d in a.durations}
    markets = {m.upper() + ("" if m.upper().endswith("USD") else "USD") for m in a.markets} if a.markets else None

    done = set()
    spent = 0.0
    bets = 0
    if a.live:
        try:
            done |= client.my_active_round_ids()
        except ApiError as e:
            print("Peringatan: gagal cek taruhan aktif:", e, file=sys.stderr)

    print(f"Mode: {'LIVE (taruhan sungguhan)' if a.live else 'DRY RUN (tidak memasang taruhan)'} | "
          f"durasi {sorted(fmt_dur(d) for d in durations)} | stake ${a.stake} | budget ${a.budget} | "
          f"ambang {a.threshold:.0%} | EV min {a.min_edge:.0%} dari stake | rake {rules['rakeRate']:.0%}")

    while True:
        now = now_fn()
        try:
            rounds = client.current_rounds()
        except ApiError as e:
            print(time.strftime("%H:%M:%S"), "gagal ambil ronde:", e)
            if a.once:
                return 1
            sleep_fn(a.interval)
            continue

        prices = {}
        lines = []
        for r in sorted(rounds, key=lambda x: (x.get("durationSeconds", 0), x.get("marketSymbol", ""))):
            sym, dur = r.get("marketSymbol", "?"), int(r.get("durationSeconds") or 0)
            if dur not in durations or (markets and sym.upper() not in markets):
                continue
            row = assess(r, client, vol, rules, a.stake, a.threshold, a.min_edge, a.lock_margin, now, prices)
            tag = f"{sym:9} {fmt_dur(dur):>3}"
            if row["best"] is None:
                lines.append(f"{tag} {row['note']}")
                continue
            d, p = row["best"], row["p"]
            action = "-"
            if r["id"] in done:
                action = "sudah bet"
            elif row["eligible"] and (spent + a.stake > a.budget or bets >= a.max_bets):
                action = "limit budget/jumlah"
            elif row["eligible"]:
                mode = "LIVE" if a.live else "DRY"
                result = "dry-run"
                if a.live:
                    try:
                        pred = client.place(r["id"], d, a.stake)
                        result = "ok " + str((pred or {}).get("id", ""))
                    except ApiError as e:
                        result = "gagal: " + str(e)
                if not result.startswith("gagal"):
                    done.add(r["id"])
                    spent += a.stake
                    bets += 1
                action = f"BET {d} ${a.stake} ({result})"
                log_row(a.log, [datetime.now(timezone.utc).isoformat(timespec="seconds"), r["id"], sym,
                                fmt_dur(dur), d, f"{p:.4f}", a.stake, row["payout"], f"{row['ev']:.4f}",
                                row["mult"], mode, result])
            probs = "  ".join(f"{k} {v:5.1%}" for k, v in sorted(row["probs"].items()))
            lines.append(f"{tag} harga {row['price']:<12g} start {row['startPrice']:<12g} lock {row['lockIn']:5.0f}s "
                         f"akhir {row['endIn']:5.0f}s | {probs} | terbaik {d} EV ${row['ev']:+.3f} "
                         f"x{row['mult']:.2f} | {action}")

        if not a.once and not a.no_clear:
            print("\033[2J\033[H", end="")
        print(time.strftime("%H:%M:%S"), f"| ronde terpantau: {len(lines)} | bet sesi ini: {bets} (${spent:g})")
        for ln in lines:
            print(ln)
        if a.once:
            return 0
        sleep_fn(a.interval)


def build_parser():
    p = argparse.ArgumentParser(description="Bot prediksi TrendBTC untuk semua market (default dry-run)")
    p.add_argument("--durations", nargs="+", default=["300", "900", "3600"],
                   help="durasi ronde dalam detik (default: 300 900 3600 = 5m 15m 1h; tambah 60 untuk 1m)")
    p.add_argument("--markets", nargs="*", help="filter market, mis. BTC ETH SOL (default: semua)")
    p.add_argument("--stake", type=float, default=1.0, help="stake per taruhan dalam $ (default 1)")
    p.add_argument("--budget", type=float, default=20.0, help="total stake maksimal per sesi (default $20)")
    p.add_argument("--max-bets", type=int, default=20, help="jumlah taruhan maksimal per sesi")
    p.add_argument("--threshold", type=float, default=0.62, help="peluang minimum sisi yang dipilih")
    p.add_argument("--min-edge", type=float, default=0.05,
                   help="EV minimum sebagai fraksi stake (0.05 = +5%%) supaya bet dipasang")
    p.add_argument("--lock-margin", type=float, default=3.0, help="jangan bet kalau lock < N detik lagi")
    p.add_argument("--interval", type=float, default=5.0, help="cek tiap N detik")
    p.add_argument("--live", action="store_true", help="PASANG TARUHAN SUNGGUHAN (butuh token)")
    p.add_argument("--token-file", default=DEFAULT_TOKEN_FILE)
    p.add_argument("--log", default=os.path.join(HERE, "bot_log.csv"))
    p.add_argument("--once", action="store_true", help="satu putaran lalu keluar")
    p.add_argument("--no-clear", action="store_true", help="jangan bersihkan layar tiap putaran")
    return p


def main(argv=None):
    a = build_parser().parse_args(argv)
    if not 1 <= a.stake <= 1000:
        sys.exit("stake harus $1–$1000 (batas situs)")
    try:
        sys.exit(run(a) or 0)
    except KeyboardInterrupt:
        print("\nBerhenti.")


if __name__ == "__main__":
    main()
