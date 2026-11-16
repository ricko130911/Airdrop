#!/usr/bin/env python3
"""
Layanan 24/7 untuk VPS: bot TrendBTC + dashboard web.

- Engine (thread) memindai semua ronde tiap N detik, memasang taruhan (kalau LIVE aktif),
  menyimpan riwayat ke SQLite, mengecek hasil, dan menjaga token tetap hidup (auto refresh).
- Dashboard web di http://127.0.0.1:8787 (default hanya localhost, buka lewat SSH tunnel),
  dilindungi password (env TRENDBTC_DASH_PASSWORD).

Jalankan:  TRENDBTC_DASH_PASSWORD=rahasia python3 service.py --data-dir ./data
Demo (data palsu, tanpa internet, tidak ada taruhan sungguhan):  ... python3 service.py --demo
"""
from __future__ import annotations

import argparse
import base64
import hmac
import json
import os
import sqlite3
import sys
import threading
import time
import traceback
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import bot as B

HERE = os.path.dirname(os.path.abspath(__file__))
VERSION = "1.0"

DEFAULT_CONFIG = {
    "live": False,            # False = DRY RUN (simulasi), True = taruhan sungguhan
    "stake": 1.0,
    "threshold": 0.62,
    "min_edge": 0.05,
    "lock_margin": 3.0,
    "interval": 5.0,
    "durations": [300, 900, 3600],
    "markets": [],            # kosong = semua
    "daily_budget": 50.0,     # total stake LIVE per hari (UTC)
    "daily_max_bets": 100,
    "daily_stop_loss": 20.0,  # berhenti bet LIVE hari itu kalau rugi >= ini
}

CONFIG_LIMITS = {
    "stake": (1.0, 1000.0), "threshold": (0.5, 0.99), "min_edge": (0.0, 5.0), "lock_margin": (0.0, 600.0),
    "interval": (2.0, 300.0), "daily_budget": (0.0, 1e7), "daily_max_bets": (0, 100000),
    "daily_stop_loss": (0.0, 1e7),
}


def utc_day(ms=None):
    t = time.time() if ms is None else ms / 1000
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d")


def validate_config(cur: dict, patch: dict) -> dict:
    out = dict(cur)
    for k, v in patch.items():
        if k not in DEFAULT_CONFIG:
            raise ValueError(f"opsi tidak dikenal: {k}")
        if k == "live":
            out[k] = bool(v)
        elif k == "durations":
            ds = sorted({int(x) for x in v})
            if not ds or any(d not in (60, 300, 900, 3600) for d in ds):
                raise ValueError("durations harus dari 60, 300, 900, 3600")
            out[k] = ds
        elif k == "markets":
            out[k] = sorted({str(x).strip().upper() for x in v if str(x).strip()})
        else:
            lo, hi = CONFIG_LIMITS[k]
            num = int(v) if k == "daily_max_bets" else float(v)
            if not lo <= num <= hi:
                raise ValueError(f"{k} harus antara {lo} dan {hi}")
            out[k] = num
    return out


# --------------------------------------------------------------------------- #
# Penyimpanan
# --------------------------------------------------------------------------- #
class Store:
    def __init__(self, path):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("""CREATE TABLE IF NOT EXISTS bets (
            id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, day TEXT, round_id TEXT, market TEXT,
            duration INTEGER, direction TEXT, prob REAL, stake REAL, payout_if_win REAL, ev REAL, mult REAL,
            mode TEXT, status TEXT, prediction_id TEXT, result TEXT, payout REAL, pnl REAL,
            start_price REAL, corridor REAL, end_ms INTEGER, error TEXT)""")
        self.db.execute("CREATE INDEX IF NOT EXISTS bets_round ON bets(round_id)")
        self.db.commit()

    def q(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return [dict(r) for r in cur.fetchall()]

    def has_round(self, round_id, mode):
        return bool(self.q("SELECT 1 FROM bets WHERE round_id=? AND mode=? AND status!='failed' LIMIT 1",
                           (round_id, mode)))

    def add(self, **kw):
        cols = ",".join(kw)
        self.q(f"INSERT INTO bets ({cols}) VALUES ({','.join('?' * len(kw))})", tuple(kw.values()))

    def day_stats(self, mode, day):
        r = self.q("""SELECT COUNT(*) n, COALESCE(SUM(stake),0) staked, COALESCE(SUM(pnl),0) pnl,
                      SUM(result LIKE 'won%') wins, SUM(result LIKE 'lost%') losses,
                      SUM(result IS NULL) pending
                      FROM bets WHERE mode=? AND day=? AND status IN ('placed','dry')""", (mode, day))[0]
        return {k: (r[k] or 0) for k in r}

    def all_stats(self, mode):
        r = self.q("""SELECT COUNT(*) n, COALESCE(SUM(stake),0) staked, COALESCE(SUM(pnl),0) pnl,
                      SUM(result LIKE 'won%') wins, SUM(result LIKE 'lost%') losses
                      FROM bets WHERE mode=? AND status IN ('placed','dry')""", (mode,))[0]
        return {k: (r[k] or 0) for k in r}

    def pnl_series(self, mode, limit=500):
        rows = self.q("""SELECT ts, pnl FROM bets WHERE mode=? AND pnl IS NOT NULL
                         ORDER BY ts DESC LIMIT ?""", (mode, limit))[::-1]
        cum, out = 0.0, []
        for r in rows:
            cum += r["pnl"]
            out.append({"t": r["ts"], "v": round(cum, 4)})
        return out

    def recent(self, limit=60):
        return self.q("SELECT * FROM bets ORDER BY id DESC LIMIT ?", (limit,))


# --------------------------------------------------------------------------- #
# Engine
# --------------------------------------------------------------------------- #
class Engine:
    def __init__(self, data_dir, client=None, vol=None, now_fn=None, demo=False):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.cfg_path = os.path.join(data_dir, "config.json")
        self.config = dict(DEFAULT_CONFIG)
        if os.path.exists(self.cfg_path):
            with open(self.cfg_path) as f:
                self.config = validate_config(self.config, json.load(f))
        self.tokens = B.TokenStore(os.path.join(data_dir, "tokens.json"))
        self.client = client or B.Client(self.tokens)
        self.vol = vol or B.Vol()
        self.now = now_fn or (lambda: int(time.time() * 1000))
        self.store = Store(os.path.join(data_dir, "bets.db"))
        self.demo = demo
        self.lock = threading.RLock()
        self.events = deque(maxlen=200)
        self.rows = []
        self.rules = dict(B.DEFAULT_RULES)
        self.rules_at = 0
        self.balances = None
        self.token = {"present": self.tokens.available, "ok": None, "checkedAt": None, "error": None}
        self.started = time.time()
        self.last_scan = None
        self.scan_ms = None
        self.last_error = None
        self._next = {"keepalive": 0, "settle": 0, "balances": 0}
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._stoploss_noted = None

    # ---- utilitas
    def log(self, level, msg):
        self.events.appendleft({"t": int(time.time() * 1000), "level": level, "msg": msg})
        print(f"[{level}] {msg}", flush=True)

    def save_config(self):
        tmp = self.cfg_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.config, f, indent=1)
        os.replace(tmp, self.cfg_path)

    def update_config(self, patch):
        with self.lock:
            new = validate_config(self.config, patch)
            if new["live"] and not self.config["live"]:
                if not self.tokens.available and not self.demo:
                    raise ValueError("Masukkan refresh token dulu sebelum menyalakan LIVE")
                self.log("warn", "Mode LIVE dinyalakan: taruhan sungguhan aktif")
            if not new["live"] and self.config["live"]:
                self.log("info", "Mode LIVE dimatikan (kembali ke DRY RUN)")
            self.config = new
            self.save_config()
        self._wake.set()
        return self.config

    def set_refresh_token(self, token):
        token = (token or "").strip().strip('"')
        if len(token) < 16:
            raise ValueError("token terlalu pendek / kosong")
        with self.lock:
            self.tokens.refresh, self.tokens.access = token, None
            self.tokens.save()
            self.token["present"] = True
        self.check_token(force=True)
        return self.token

    def check_token(self, force=False):
        if not self.tokens.available:
            self.token.update(present=False, ok=None)
            return
        try:
            if force:
                self.client._refresh()
            self.client.me()
            self.token.update(ok=True, error=None, checkedAt=int(time.time() * 1000), present=True)
        except B.ApiError as e:
            self.token.update(ok=False, error=str(e), checkedAt=int(time.time() * 1000))
            if self.config["live"]:
                self.log("error", f"Token tidak valid, LIVE dijeda otomatis: {e}")
            else:
                self.log("error", f"Token tidak valid: {e}")

    # ---- loop
    def start(self):
        threading.Thread(target=self._loop, name="engine", daemon=True).start()

    def stop(self):
        self._stop.set()
        self._wake.set()

    def _loop(self):
        self.log("info", f"Engine mulai ({'DEMO' if self.demo else 'API asli'}), mode "
                         f"{'LIVE' if self.config['live'] else 'DRY RUN'}")
        while not self._stop.is_set():
            try:
                self.tick()
                self.last_error = None
            except Exception as e:  # noqa: BLE001 - jangan pernah mati, catat & lanjut
                self.last_error = str(e)
                self.log("error", f"Kesalahan scan: {e}")
                traceback.print_exc()
            self._wake.wait(self.config["interval"])
            self._wake.clear()

    def tick(self):
        t0 = time.time()
        now = self.now()
        if now / 1000 - self.rules_at > 600:
            self.rules = self.client.rules()
            self.rules_at = now / 1000
        if self.tokens.available and time.time() >= self._next["keepalive"]:
            self.check_token()
            self._next["keepalive"] = time.time() + 900  # tiap 15 menit: refresh otomatis bila perlu
        if (self.demo or (self.tokens.available and self.token.get("ok"))) and time.time() >= self._next["balances"]:
            try:
                self.balances = self.client.balances()
            except B.ApiError:
                pass
            self._next["balances"] = time.time() + 60

        cfg = dict(self.config)
        rounds = self.client.current_rounds()
        prices, rows = {}, []
        markets = {m if m.endswith("USD") else m + "USD" for m in cfg["markets"]}
        for r in rounds:
            dur = int(r.get("durationSeconds") or 0)
            if dur not in cfg["durations"] or (markets and str(r.get("marketSymbol", "")).upper() not in markets):
                continue
            row = B.assess(r, self.client, self.vol, self.rules, cfg["stake"], cfg["threshold"],
                           cfg["min_edge"], cfg["lock_margin"], now, prices)
            row["action"] = self._act(r, row, cfg, now)
            rows.append(row)
        rows.sort(key=lambda x: (x["duration"], x["market"]))
        self._settle_dry(now, prices)
        if cfg["live"] and (self.demo or self.tokens.available) and time.time() >= self._next["settle"]:
            self._settle_live()
            self._next["settle"] = time.time() + 30
        with self.lock:
            self.rows = rows
            self.last_scan = int(time.time() * 1000)
            self.scan_ms = int((time.time() - t0) * 1000)

    def _act(self, r, row, cfg, now):
        if not row["eligible"]:
            return None
        live = cfg["live"] and (self.demo or (self.tokens.available and self.token.get("ok") is not False))
        mode = "LIVE" if live else "DRY"
        if self.store.has_round(r["id"], mode):
            return "sudah bet"
        day = utc_day(now)
        base = dict(ts=now, day=day, round_id=r["id"], market=row["market"], duration=row["duration"],
                    direction=row["best"], prob=row["p"], stake=cfg["stake"], payout_if_win=row["payout"],
                    ev=row["ev"], mult=row["mult"], mode=mode, start_price=row["startPrice"],
                    corridor=row["corridor"], end_ms=B.ts_ms(r["endTime"]))
        if not live:
            self.store.add(status="dry", **base)
            return "simulasi"
        st = self.store.day_stats("LIVE", day)
        if st["pnl"] <= -cfg["daily_stop_loss"] and cfg["daily_stop_loss"] > 0:
            if self._stoploss_noted != day:
                self.log("warn", f"Stop-loss harian tercapai (P&L ${st['pnl']:.2f}). Bet LIVE berhenti sampai besok (UTC).")
                self._stoploss_noted = day
            return "stop-loss"
        if st["staked"] + cfg["stake"] > cfg["daily_budget"] or st["n"] >= cfg["daily_max_bets"]:
            return "limit harian"
        try:
            pred = self.client.place(r["id"], row["best"], cfg["stake"])
            self.store.add(status="placed", prediction_id=str((pred or {}).get("id", "")), **base)
            self.log("bet", f"BET {row['best']} ${cfg['stake']:g} {row['market']} {B.fmt_dur(row['duration'])} "
                            f"(peluang {row['p']:.0%}, EV ${row['ev']:+.2f})")
            return "BET"
        except B.ApiError as e:
            self.store.add(status="failed", error=str(e), **base)
            self.log("error", f"Gagal bet {row['market']}: {e}")
            if e.status == 401:
                self.token.update(ok=False, error=str(e))
            return "gagal"

    def _settle_dry(self, now, prices):
        """Hasil simulasi: pakai harga feed situs saat scan pertama setelah ronde berakhir (perkiraan)."""
        pending = self.store.q("SELECT * FROM bets WHERE mode='DRY' AND result IS NULL AND end_ms<=?", (now,))
        for b in pending:
            try:
                if b["market"] not in prices:
                    prices[b["market"]] = self.client.price(b["market"])
            except Exception:  # noqa: BLE001
                continue
            end = prices[b["market"]]
            if b["corridor"]:
                won = (abs(end - b["start_price"]) <= b["corridor"]) == (b["direction"] == "INSIDE")
                push = False
            else:
                push = end == b["start_price"]
                won = (end > b["start_price"]) == (b["direction"] == "UP")
            res = "push" if push else ("won" if won else "lost")
            pnl = 0.0 if push else (b["payout_if_win"] - b["stake"] if won else -b["stake"])
            self.store.q("UPDATE bets SET result=?, pnl=?, payout=? WHERE id=?",
                         (res, round(pnl, 4), b["stake"] + pnl, b["id"]))

    def _settle_live(self):
        pending = self.store.q("SELECT id, prediction_id, stake FROM bets WHERE mode='LIVE' AND status='placed' "
                               "AND result IS NULL")
        if not pending:
            return
        try:
            preds = {str(p.get("id")): p for p in self.client.my_predictions(100)}
        except B.ApiError as e:
            self.log("warn", f"Gagal cek hasil: {e}")
            return
        for b in pending:
            p = preds.get(b["prediction_id"])
            if not p:
                continue
            res = str(p.get("result") or "").lower()
            if res not in ("won", "lost", "push", "cancelled"):
                continue
            payout = float(p.get("payoutAmount") or 0)
            pnl = payout - b["stake"] if res == "won" else (-b["stake"] if res == "lost" else 0.0)
            self.store.q("UPDATE bets SET result=?, payout=?, pnl=? WHERE id=?", (res, payout, round(pnl, 4), b["id"]))
            self.log("win" if res == "won" else "info", f"Hasil {res.upper()} prediksi {b['prediction_id']}: "
                                                          f"P&L ${pnl:+.2f}")

    # ---- snapshot untuk dashboard
    def state(self):
        day = utc_day(self.now())
        mode = "LIVE" if self.config["live"] else "DRY"
        with self.lock:
            return {
                "version": VERSION, "demo": self.demo, "now": int(time.time() * 1000),
                "uptime": int(time.time() - self.started), "lastScan": self.last_scan, "scanMs": self.scan_ms,
                "lastError": self.last_error, "config": self.config, "mode": mode,
                "token": dict(self.token), "balances": self.balances, "rules": self.rules,
                "today": {"LIVE": self.store.day_stats("LIVE", day), "DRY": self.store.day_stats("DRY", day)},
                "total": {"LIVE": self.store.all_stats("LIVE"), "DRY": self.store.all_stats("DRY")},
                "pnl": {"LIVE": self.store.pnl_series("LIVE"), "DRY": self.store.pnl_series("DRY")},
                "rows": self.rows, "bets": self.store.recent(), "events": list(self.events)[:80],
            }


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def make_handler(engine: Engine, password: str):
    page_path = os.path.join(HERE, "dashboard.html")
    expected = base64.b64encode(f"admin:{password}".encode()).decode()

    class H(BaseHTTPRequestHandler):
        server_version = "trendbot"

        def log_message(self, *a):  # jangan spam log
            pass

        def _authed(self):
            got = self.headers.get("Authorization", "")
            return got.startswith("Basic ") and hmac.compare_digest(got[6:].strip(), expected)

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(data)

        def _deny(self):
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="TrendBot", charset="UTF-8"')
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if not self._authed():
                return self._deny()
            if self.path in ("/", "/index.html"):
                with open(page_path, "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            if self.path == "/api/state":
                return self._send(200, engine.state())
            if self.path == "/healthz":
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})

        def do_POST(self):
            if not self._authed():
                return self._deny()
            # header khusus wajib: mencegah situs lain memicu aksi lewat browser Anda (CSRF)
            if self.headers.get("X-Trendbot") != "1":
                return self._send(403, {"error": "missing header"})
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(min(n, 65536)) or b"{}")
                if self.path == "/api/config":
                    return self._send(200, {"config": engine.update_config(body)})
                if self.path == "/api/token":
                    return self._send(200, {"token": engine.set_refresh_token(body.get("refreshToken"))})
                if self.path == "/api/scan":
                    engine._wake.set()
                    return self._send(200, {"ok": True})
                return self._send(404, {"error": "not found"})
            except (ValueError, TypeError) as e:
                return self._send(400, {"error": str(e)})

    return H


def main(argv=None):
    p = argparse.ArgumentParser(description="TrendBot 24/7 + dashboard")
    p.add_argument("--host", default="127.0.0.1", help="default 127.0.0.1 (akses lewat SSH tunnel)")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--data-dir", default=os.path.join(HERE, "data"))
    p.add_argument("--demo", action="store_true", help="data palsu untuk mencoba dashboard")
    a = p.parse_args(argv)
    password = os.environ.get("TRENDBTC_DASH_PASSWORD", "")
    if len(password) < 8:
        sys.exit("Set TRENDBTC_DASH_PASSWORD (minimal 8 karakter) dulu.")
    if a.demo:
        import demo
        client, vol = demo.DemoClient(), demo.DemoVol()
        engine = Engine(a.data_dir, client=client, vol=vol, demo=True)
    else:
        engine = Engine(a.data_dir)
    engine.start()
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(engine, password))
    print(f"Dashboard: http://{a.host}:{a.port}  (user: admin)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()


if __name__ == "__main__":
    main()
