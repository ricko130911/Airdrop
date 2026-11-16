#!/usr/bin/env python3
"""
web_server.py
Menjalankan bot TrendBTC secara headless (tanpa menu Termux) + dashboard web 3D.
Dirancang untuk dijalankan oleh pm2 di VPS.

Pengaturan lewat .env (lihat .env.example):
  BOT_MODES           crypto,survivor,bullseye,sports  (pisahkan dengan koma)
  DASHBOARD_HOST      default 0.0.0.0
  DASHBOARD_PORT      default 8080
  DASHBOARD_USER      default admin
  DASHBOARD_PASSWORD  WAJIB diisi (kalau kosong, dibuat acak & dicetak di log)
  START_PAUSED        true/false  - kalau true, bot tidak memasang taruhan sampai di-resume dari dashboard
"""

import os
import sys
import json
import time
import base64
import hmac
import signal
import secrets
import threading
from collections import deque
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE_DIR)  # bot membaca config_multi.json dengan path relatif
sys.path.insert(0, BASE_DIR)

import bot_multi as bot  # noqa: E402  (memuat .env juga)

WEB_DIR = os.path.join(BASE_DIR, "web")
HOST = os.getenv("DASHBOARD_HOST", "0.0.0.0")
PORT = int(os.getenv("DASHBOARD_PORT", "8080"))
DASH_USER = os.getenv("DASHBOARD_USER", "admin")
DASH_PASSWORD = os.getenv("DASHBOARD_PASSWORD", "")
VALID_MODES = ["crypto", "survivor", "bullseye", "sports"]
MODES = [m.strip().lower() for m in os.getenv("BOT_MODES", "crypto").split(",") if m.strip().lower() in VALID_MODES] or ["crypto"]

control = {
    "paused": os.getenv("START_PAUSED", "false").lower() in ("1", "true", "yes"),
    "phase": "booting",
    "started_at": time.time(),
}

# ---------------------------------------------------------------------------
# Patch bot: tanpa clear layar, dan semua aksi taruhan lewat saklar pause.
# Worker bot memanggil fungsi ini lewat nama global modul, jadi patch berlaku.
# ---------------------------------------------------------------------------
bot.clear_termux = lambda: None


def _guard(fn, label):
    def wrapper(*args, **kwargs):
        if control["paused"]:
            return False, "PAUSED (dashboard)"
        ok, msg = fn(*args, **kwargs)
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        acc_idx = args[0] if args else "?"
        print(f"[{ts}] [{label}] akun#{acc_idx} args={args[1:]} -> {'OK' if ok else 'GAGAL'}: {msg}", flush=True)
        return ok, msg
    return wrapper


bot.execute_bet_api = _guard(bot.execute_bet_api, "BET")
bot.execute_survivor_pick_api = _guard(bot.execute_survivor_pick_api, "SURVIVOR")
bot.execute_bullseye_call_api = _guard(bot.execute_bullseye_call_api, "BULLSEYE")

# ---------------------------------------------------------------------------
# Riwayat harga untuk sparkline (sampel tiap 2 detik, simpan 10 menit)
# ---------------------------------------------------------------------------
price_history = {a: deque(maxlen=300) for a in bot.SUPPORTED_ASSETS}


def price_sampler():
    while bot.is_running:
        now_ms = int(time.time() * 1000)
        with bot.data_lock:
            snap = dict(bot.global_live_prices)
        for a, p in snap.items():
            if p and p > 0:
                price_history[a].append((now_ms, p))
        time.sleep(2)


# ---------------------------------------------------------------------------
# Snapshot state -> JSON (TANPA email / password / token)
# ---------------------------------------------------------------------------
def _iso(dt):
    return dt.isoformat() if dt else None


def _left(dt, now):
    return int((dt - now).total_seconds()) if dt else None


def build_state():
    now = datetime.now(timezone.utc)
    cfg = bot.load_config()
    accounts_cfg = cfg.get("ACCOUNTS", [])

    with bot.data_lock:
        prices = dict(bot.global_live_prices)

        markets = {}
        for asset in bot.SUPPORTED_ASSETS:
            markets[asset] = {}
            for tf in bot.ASSET_TIMEFRAME_MAP.get(asset, []):
                d = bot.shared_market_data.get(asset, {}).get(tf, {})
                lock_dt = d.get("waktu_target_lock")
                markets[asset][tf] = {
                    "round_id": d.get("round_id", ""),
                    "start": d.get("round_start_price", 0.0),
                    "band_top": d.get("band_top", 0.0),
                    "band_low": d.get("band_low", 0.0),
                    "band_offset": d.get("band_offset", 0.0),
                    "lock_at": _iso(lock_dt),
                    "secs_left": _left(lock_dt, now),
                    "status": d.get("status_waktu", ""),
                    "participants": d.get("participants", 0),
                    "synced": d.get("is_synchronized", False),
                }

        accounts = []
        for idx, acc in enumerate(accounts_cfg):
            name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
            bal = bot.account_balances.get(name, {})
            states = {}
            for asset in bot.SUPPORTED_ASSETS:
                for tf in bot.ASSET_TIMEFRAME_MAP.get(asset, []):
                    st = bot.account_states.get(f"{name}_{asset}_{tf}")
                    if st:
                        states[f"{asset}_{tf}"] = st
            sv = dict(bot.shared_survivor_accounts.get(name, {}))
            if "round_results" in sv:
                sv["round_results"] = {str(k): v for k, v in sv["round_results"].items()}
            accounts.append({
                "name": name,
                "usd": bal.get("pred"),
                "trend": bal.get("trend"),
                "martingale": dict(bot.account_btc_martingale_tracker.get(name, {})),
                "states": states,
                "survivor": sv,
                "bullseye": dict(bot.shared_bullseye_accounts.get(name, {})),
            })

        sg = bot.shared_survivor_global
        survivor = {
            "status": sg.get("status"),
            "is_active": sg.get("is_active"),
            "doors_open": sg.get("doors_open"),
            "starts_at": _iso(sg.get("starts_at")),
            "starts_in": _left(sg.get("starts_at"), now),
            "starts_label": sg.get("starts_label"),
            "prize_pool": sg.get("prize_pool"),
            "entered": sg.get("entered"),
            "still_standing": sg.get("still_standing"),
            "current_round": sg.get("current_round"),
            "round_start_price": sg.get("round_start_price"),
            "lock_in": _left(sg.get("lock_time"), now),
            "log": list(bot.shared_survivor_bet_history)[-12:],
        }

        bg = bot.shared_bullseye_global
        bullseye = {
            "status": bg.get("status"),
            "is_active": bg.get("is_active"),
            "call_in": _left(bg.get("call_deadline"), now),
            "ends_in": _left(bg.get("ends_at"), now),
            "participants": bg.get("participants"),
            "prize_pool": bg.get("prize_pool"),
            "log": list(bot.shared_bullseye_history)[-12:],
        }

        fixtures = []
        for fix in list(bot.shared_sports_fixtures)[:12]:
            subs = []
            for m in fix.get("sub_markets", []):
                subs.append({
                    "label": m.get("sub_type", "Option"),
                    "p0": m.get("p0", 0), "p1": m.get("p1", 0),
                    "pct0": m.get("pct0", 50.0), "pct1": m.get("pct1", 50.0),
                    "best_name": m.get("best_name"), "best_pct": m.get("best_pct"),
                    "best_dir": m.get("best_dir"),
                })
            fixtures.append({
                "title": fix.get("title"),
                "league": fix.get("league"),
                "secs_left": _left(fix.get("target_dt"), now),
                "sub_markets": subs,
            })

        sports_preds = []
        for p in list(bot.shared_sports_my_predictions)[:8]:
            r_id = str(p.get("roundId") or "")
            m_info = bot.shared_sports_markets_map.get(r_id, {})
            outs = m_info.get("outcomes", ["Yes", "No"]) or ["Yes", "No"]
            direction = str(p.get("direction", "")).upper()
            choice = outs[0] if direction == "UP" and outs else outs[1] if direction == "DOWN" and len(outs) > 1 else direction
            sports_preds.append({
                "account": p.get("account_name", "Akun"),
                "title": m_info.get("question") or m_info.get("eventTitle") or f"Ronde ..{r_id[-6:]}",
                "choice": choice,
                "amount": float(p.get("stakeAmount") or p.get("amount") or 0.0),
                "status": (str(p.get("result") or "") or str(p.get("status", "ACCEPTED"))).upper(),
            })

        predictions = []
        for h in list(bot.shared_api_prediction_history):
            predictions.append({k: h.get(k) for k in ("account", "short_r_id", "direction_str", "stake", "payout", "hasil_str", "created_at")})

        crypto_log = list(bot.shared_bet_history)[-30:]
        sports_log = list(bot.shared_sports_bet_history)[-20:]

    history = {a: list(price_history[a]) for a in bot.SUPPORTED_ASSETS}

    return {
        "server_time": now.isoformat(),
        "modes": MODES,
        "phase": control["phase"],
        "paused": control["paused"],
        "uptime": int(time.time() - control["started_at"]),
        "simulation": bool(cfg.get("SIMULATION_MODE", False)),
        "assets": bot.SUPPORTED_ASSETS,
        "timeframes": bot.ASSET_TIMEFRAME_MAP,
        "prices": prices,
        "history": history,
        "markets": markets,
        "accounts": accounts,
        "predictions": predictions,
        "crypto_log": crypto_log,
        "survivor": survivor,
        "bullseye": bullseye,
        "sports": {"fixtures": fixtures, "predictions": sports_preds, "log": sports_log},
    }


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "NeonSniper/1.0"

    def log_message(self, fmt, *args):
        pass  # jangan banjiri log pm2

    def _authorized(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            user, _, pwd = base64.b64decode(header[6:]).decode("utf-8").partition(":")
        except Exception:
            return False
        return hmac.compare_digest(user, DASH_USER) and hmac.compare_digest(pwd, DASH_PASSWORD)

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None, cache="no-store"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", cache)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _deny(self):
        self._send(401, '{"error":"unauthorized"}', extra={"WWW-Authenticate": 'Basic realm="TrendBTC Neon Sniper"'})

    def do_GET(self):
        if not self._authorized():
            return self._deny()
        path = self.path.split("?", 1)[0]
        if path == "/api/state":
            try:
                return self._send(200, json.dumps(build_state(), default=str))
            except Exception as e:
                return self._send(500, json.dumps({"error": str(e)[:200]}))
        if path in ("/", "/index.html"):
            path = "/index.html"
        file_path = os.path.realpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not file_path.startswith(os.path.realpath(WEB_DIR) + os.sep) or not os.path.isfile(file_path):
            return self._send(404, '{"error":"not found"}')
        ext = os.path.splitext(file_path)[1].lower()
        with open(file_path, "rb") as f:
            cache = "private, max-age=86400" if "/vendor/" in file_path else "no-store"
            return self._send(200, f.read(), CONTENT_TYPES.get(ext, "application/octet-stream"), cache=cache)

    def do_POST(self):
        if not self._authorized():
            return self._deny()
        # Header khusus + JSON = perlindungan CSRF sederhana
        if self.path != "/api/control" or self.headers.get("X-Requested-With") != "neon-dashboard":
            return self._send(400, '{"error":"bad request"}')
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._send(400, '{"error":"invalid json"}')
        if "paused" in data:
            control["paused"] = bool(data["paused"])
            print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] [CONTROL] paused={control['paused']}", flush=True)
        return self._send(200, json.dumps({"paused": control["paused"]}))


# ---------------------------------------------------------------------------
# Start workers (versi headless dari run_*_mode di bot_multi.py)
# ---------------------------------------------------------------------------
def start_workers(accounts):
    def spawn(fn, *args):
        threading.Thread(target=fn, args=args, daemon=True).start()

    # Harga live + ronde crypto selalu jalan (dipakai dashboard & semua mode)
    spawn(bot.background_sync_worker)
    for idx, acc in enumerate(accounts):
        spawn(bot.account_maintenance_worker, idx, acc.get("ACCOUNT_NAME", f"Akun_{idx+1}"))

    if "crypto" in MODES:
        spawn(bot.background_history_worker)
        for idx, acc in enumerate(accounts):
            name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
            for asset, tfs in bot.ASSET_TIMEFRAME_MAP.items():
                for tf in tfs:
                    spawn(bot.account_asset_bet_worker, idx, name, asset, tf)

    if "sports" in MODES:
        spawn(bot.sports_sync_worker)
        spawn(bot.sports_history_worker)
        spawn(bot.auto_sports_lowest_percentage_worker)

    if "survivor" in MODES:
        spawn(bot.survivor_sync_worker)
        for idx, acc in enumerate(accounts):
            spawn(bot.survivor_account_worker, idx, acc.get("ACCOUNT_NAME", f"Akun_{idx+1}"))

    if "bullseye" in MODES:
        spawn(bot.bullseye_sync_worker)
        for idx, acc in enumerate(accounts):
            spawn(bot.bullseye_account_worker, idx, acc.get("ACCOUNT_NAME", f"Akun_{idx+1}"))


def main():
    global DASH_PASSWORD
    cfg = bot.load_config()
    accounts = cfg.get("ACCOUNTS", [])
    if not accounts:
        print("config_multi.json kosong atau tidak ada akun.", flush=True)
        sys.exit(1)

    if not DASH_PASSWORD:
        DASH_PASSWORD = secrets.token_urlsafe(12)
        print("=" * 70, flush=True)
        print("DASHBOARD_PASSWORD belum di-set di .env!", flush=True)
        print(f"Password sementara (berubah tiap restart): {DASH_PASSWORD}", flush=True)
        print("=" * 70, flush=True)

    server = ThreadingHTTPServer((HOST, PORT), DashboardHandler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"Dashboard aktif di http://{HOST}:{PORT}  (user: {DASH_USER})", flush=True)
    print(f"Mode bot: {', '.join(MODES)} | paused={control['paused']}", flush=True)

    def shutdown(*_):
        bot.is_running = False
        print("Menghentikan bot...", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    threading.Thread(target=price_sampler, daemon=True).start()

    control["phase"] = "login"
    bot.initialize_all_accounts_strictly(accounts)
    start_workers(accounts)
    control["phase"] = "running"

    while bot.is_running:
        time.sleep(1)


if __name__ == "__main__":
    main()
