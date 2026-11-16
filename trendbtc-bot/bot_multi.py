#!/usr/bin/env python3
"""
bot_multi.py
Platform Otomasi Multi-Akun TrendBTC Terminal Termux HUD:
[1] Market Crypto (12 Aset: BTC, ETH, SOL, DOGE, TRUMP, XRP, BNB, HYPE, AAVE, ENA, ZEC, SUI)
[2] Market Sports Underdog Auto-Sniper ($1 Pool Terendah)
[3] Daily Survivor Monitor (BTC 5M Elimination R1-R8)
[4] Bullseye Flash Event Monitor (BTC Call The Price 3M Window)
[5] Otomasi Login 2Captcha Cloudflare Turnstile (Sitekey Resmi: 0x4AAAAAAD0DDclVFAzTAxsS)
[6] Proteksi Penuh: Auto-Retry HTTP 50x, Anti-429 Throttling, & Jendela Toleransi Anti-409 (Max 15s Lag)
UI: Pure Termux Cyberpunk Neon HUD (Strictly No White Text)

Catatan: kredensial Chainlink dibaca dari file .env (lihat .env.example),
bukan lagi ditulis langsung di kode.
"""

import os
import sys
import json
import time
import uuid
import hmac
import hashlib
import threading
from datetime import datetime, timezone, timedelta
import requests
from requests.adapters import HTTPAdapter


def _load_dotenv(path=None):
    """Loader .env sederhana (tanpa dependensi tambahan)."""
    path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass


_load_dotenv()

# Kredensial Chainlink Data Streams (BTC/USD) - diambil dari .env
CHAINLINK_API_KEY = os.getenv("CHAINLINK_API_KEY", "")
CHAINLINK_USER_SECRET = os.getenv("CHAINLINK_USER_SECRET", "")
BTC_USD_FEED_ID = "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8"

# Palet Warna ANSI Neon (Strictly No White Text)
C_CYAN    = "\033[1;96m"
C_MAGENTA = "\033[1;95m"
C_GREEN   = "\033[1;92m"
C_YELLOW  = "\033[1;93m"
C_BLUE    = "\033[1;94m"
C_RED     = "\033[1;91m"
C_GRAY    = "\033[1;90m"
C_RESET   = "\033[0m"

data_lock = threading.RLock()
config_lock = threading.RLock()
api_request_lock = threading.Lock()
global_bet_lock = threading.Lock()
account_token_locks = {}
last_global_bet_time = 0.0
is_running = True

DURATION_MAP = {
    60: "1m",
    300: "5m",
    900: "15m",
    3600: "1h"
}

ASSET_TIMEFRAME_MAP = {
    "BTC": ["1m", "5m", "15m", "1h"],
    "ETH": ["5m", "15m", "1h"],
    "SOL": ["5m", "15m", "1h"],
    "DOGE": ["5m", "15m", "1h"],
    "TRUMP": ["5m", "15m", "1h"],
    "XRP": ["5m", "15m", "1h"],
    "BNB": ["5m", "15m", "1h"],
    "HYPE": ["5m", "15m", "1h"],
    "AAVE": ["5m", "15m", "1h"],
    "ENA": ["5m", "15m", "1h"],
    "ZEC": ["5m", "15m", "1h"],
    "SUI": ["5m", "15m", "1h"]
}

SUPPORTED_ASSETS = ["BTC", "ETH", "SOL", "DOGE", "TRUMP", "XRP", "BNB", "HYPE", "AAVE", "ENA", "ZEC", "SUI"]

def create_robust_session():
    session = requests.Session()
    adapter = HTTPAdapter(pool_connections=80, pool_maxsize=80)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session

account_sessions = {}
stream_session = create_robust_session()
binance_session = create_robust_session()

global_live_prices = {asset: 0.0 for asset in SUPPORTED_ASSETS}

shared_market_data = {
    asset: {
        tf: {
            "round_id": "",
            "round_start_price": 0.0,
            "band_top": 0.0,
            "band_low": 0.0,
            "band_offset": 0.0,
            "waktu_target_lock": None,
            "status_waktu": "SYNC...",
            "participants": 0,
            "is_synchronized": False
        } for tf in ASSET_TIMEFRAME_MAP[asset]
    } for asset in SUPPORTED_ASSETS
}

shared_sports_fixtures = []
shared_sports_markets_map = {}
shared_sports_my_predictions = []
shared_sports_bet_history = []
sports_already_betted_keys = set()

shared_survivor_global = {
    "status": "idle",
    "is_active": False,
    "doors_open": True,
    "starts_at": None,
    "starts_label": "at 19.00 your time",
    "prize_pool": "25,000 TREND",
    "entered": 151,
    "still_standing": 151,
    "current_round": 0,
    "round_id": "",
    "round_start_price": 0.0,
    "lock_time": None
}
shared_survivor_accounts = {}
shared_survivor_bet_history = []
survivor_already_picked_rounds = set()

shared_bullseye_global = {
    "status": "No event running",
    "is_active": False,
    "round_id": "",
    "starts_at": None,
    "call_deadline": None,
    "ends_at": None,
    "target_price": 0.0,
    "participants": 0,
    "prize_pool": "10,000 TREND"
}
shared_bullseye_accounts = {}
shared_bullseye_history = []
bullseye_already_called_rounds = set()

account_states = {}
account_balances = {}
shared_bet_history = []
shared_api_prediction_history = []
account_btc_martingale_tracker = {}

def get_account_lock(acc_idx):
    if acc_idx not in account_token_locks:
        account_token_locks[acc_idx] = threading.Lock()
    return account_token_locks[acc_idx]

def clear_termux():
    os.system("clear" if os.name == "posix" else "cls")

global_config = {}

def load_config(file_path="config_multi.json"):
    global global_config
    with config_lock:
        if global_config and "ACCOUNTS" in global_config:
            return global_config
        if not os.path.exists(file_path):
            print(f"{C_RED}Error: Berkas {file_path} tidak ditemukan.{C_RESET}")
            sys.exit(1)
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                global_config = json.load(f)
                return global_config
        except Exception:
            return global_config

def save_config(config_data, file_path="config_multi.json"):
    global global_config
    with config_lock:
        global_config = config_data
        try:
            tmp_path = f"{file_path}.tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(config_data, f, indent=4)
            os.replace(tmp_path, file_path)
        except Exception:
            pass

def get_account(account_index):
    with config_lock:
        cfg = load_config()
        accs = cfg.get("ACCOUNTS", [])
        if isinstance(accs, list) and 0 <= account_index < len(accs):
            return dict(accs[account_index])
        return {}

def update_account_token(account_index, access_token=None, refresh_token=None):
    with config_lock:
        cfg = load_config()
        accs = cfg.get("ACCOUNTS", [])
        if isinstance(accs, list) and 0 <= account_index < len(accs):
            if access_token:
                accs[account_index]["ACCESS_TOKEN"] = access_token
            if refresh_token:
                accs[account_index]["REFRESH_TOKEN"] = refresh_token
            save_config(cfg)

def parse_iso_time(iso_val):
    if not iso_val:
        return None
    try:
        if isinstance(iso_val, (int, float)):
            if iso_val > 1e11:
                return datetime.fromtimestamp(iso_val / 1000.0, tz=timezone.utc)
            return datetime.fromtimestamp(iso_val, tz=timezone.utc)
        s_val = str(iso_val).strip().replace("Z", "+00:00")
        if s_val.isdigit():
            num_v = float(s_val)
            if num_v > 1e11:
                return datetime.fromtimestamp(num_v / 1000.0, tz=timezone.utc)
            return datetime.fromtimestamp(num_v, tz=timezone.utc)
        return datetime.fromisoformat(s_val)
    except Exception:
        return None

def get_next_survivor_scheduled_time():
    wib = timezone(timedelta(hours=7))
    now_wib = datetime.now(wib)
    today = now_wib.date()

    t3 = datetime(today.year, today.month, today.day, 3, 0, 0, tzinfo=wib)
    t19 = datetime(today.year, today.month, today.day, 19, 0, 0, tzinfo=wib)

    if now_wib < t3:
        return t3.astimezone(timezone.utc), "at 3.00 your time"
    elif now_wib < t19:
        return t19.astimezone(timezone.utc), "at 19.00 your time"
    else:
        tomorrow = today + timedelta(days=1)
        t_next = datetime(tomorrow.year, tomorrow.month, tomorrow.day, 3, 0, 0, tzinfo=wib)
        return t_next.astimezone(timezone.utc), "at 3.00 your time"

def format_countdown_live(target_dt):
    if not target_dt:
        return "--:--"
    now_utc = datetime.now(timezone.utc)
    diff_sec = int((target_dt - now_utc).total_seconds())
    if diff_sec <= 0:
        return "LOCKED"
    h, rem = divmod(diff_sec, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}h {m:02d}m {s:02d}s"
    return f"{m:02d}m {s:02d}s"

def get_headers(token=None):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://trendbtc.app",
        "Referer": "https://trendbtc.app/",
        "Connection": "keep-alive"
    }
    if token:
        headers["Authorization"] = f"Bearer {str(token).replace('Bearer ', '').strip()}"
    return headers

def extract_token_from_response(data):
    if not isinstance(data, dict):
        return None, None
    new_acc = data.get("accessToken") or data.get("access_token")
    new_ref = data.get("refreshToken") or data.get("refresh_token")
    if not new_acc and isinstance(data.get("token"), dict):
        new_acc = data["token"].get("accessToken") or data["token"].get("access_token")
        new_ref = data["token"].get("refreshToken") or data["token"].get("refresh_token")
    if not new_acc and isinstance(data.get("data"), dict):
        d_obj = data["data"]
        new_acc = d_obj.get("accessToken") or d_obj.get("access_token")
        new_ref = d_obj.get("refreshToken") or d_obj.get("refresh_token")
    if isinstance(new_acc, str) and len(new_acc) > 20:
        return new_acc, new_ref
    return None, None

# ================= INTEGRASI 2CAPTCHA TURNSTILE RESMI =================
def solve_turnstile_with_2captcha(api_key, sitekey="0x4AAAAAAD0DDclVFAzTAxsS", pageurl="https://trendbtc.app"):
    if not api_key:
        return None
    in_url = f"https://2captcha.com/in.php?key={api_key}&method=turnstile&sitekey={sitekey}&pageurl={pageurl}&json=1"
    try:
        r = requests.get(in_url, timeout=12)
        res_json = r.json()
        if res_json.get("status") != 1:
            return None
        req_id = res_json.get("request")
        res_url = f"https://2captcha.com/res.php?key={api_key}&action=get&id={req_id}&json=1"
        for _ in range(25):
            time.sleep(5)
            r_res = requests.get(res_url, timeout=10)
            res_data = r_res.json()
            if res_data.get("status") == 1:
                return res_data.get("request")
            elif res_data.get("request") != "CAPCHA_NOT_READY":
                return None
    except Exception:
        pass
    return None

def execute_force_login(account_index):
    account = get_account(account_index)
    if not account:
        return False, "Akun tidak ditemukan"
    email = str(account.get("EMAIL", "")).strip()
    password = str(account.get("PASSWORD", "")).strip()
    if not email or not password:
        return False, "Email/Password kosong"

    cfg = load_config()
    captcha_key = cfg.get("TWO_CAPTCHA_API_KEY", "")
    sitekey = cfg.get("CF_TURNSTILE_SITEKEY", "0x4AAAAAAD0DDclVFAzTAxsS")

    print(f"[{C_YELLOW}2CAPTCHA...{C_RESET}] {C_CYAN}{account.get('ACCOUNT_NAME')}{C_RESET} -> Memecahkan Cloudflare Turnstile...")
    captcha_token = solve_turnstile_with_2captcha(captcha_key, sitekey=sitekey)

    url = f"{cfg.get('API_BASE_URL', 'https://api.trendbtc.app')}/api/auth/login"
    headers = get_headers()
    headers["Content-Type"] = "application/json"
    proxy = account.get("PROXY")
    proxies = {"http": proxy, "https": proxy} if proxy else {}
    sess = account_sessions.get(account_index) or create_robust_session()

    payload = {
        "email": email,
        "password": password
    }
    if captcha_token:
        payload["turnstileToken"] = captcha_token
        payload["captchaToken"] = captcha_token
        payload["cf-turnstile-response"] = captcha_token

    try:
        res = sess.post(url, json=payload, headers=headers, proxies=proxies, timeout=(8, 16))
        if res.status_code in [200, 201]:
            new_acc, new_ref = extract_token_from_response(res.json())
            if new_acc:
                update_account_token(account_index, new_acc, new_ref)
                print(f"[{C_GREEN}LOGIN SUKSES{C_RESET}] {C_CYAN}{account.get('ACCOUNT_NAME')}{C_RESET} -> Token baru tersimpan otomatis!")
                return True, "Login berhasil"
            return False, "Format token tidak dikenal"
        elif res.status_code == 429:
            time.sleep(2.5)
            return False, "429 Rate Limit"
        else:
            return False, f"HTTP {res.status_code}"
    except Exception as e:
        return False, f"Err: {str(e)[:25]}"

def rotate_tokens_instantly(account_index):
    with get_account_lock(account_index):
        account = get_account(account_index)
        if not account:
            return False
        ref_tok = account.get("REFRESH_TOKEN", "").strip()
        if not ref_tok:
            ok, _ = execute_force_login(account_index)
            return ok

        cfg = load_config()
        url = f"{cfg.get('API_BASE_URL', 'https://api.trendbtc.app')}/api/auth/refresh"
        headers = get_headers()
        headers["Content-Type"] = "application/json"
        proxy = account.get("PROXY")
        proxies = {"http": proxy, "https": proxy} if proxy else {}
        sess = account_sessions.get(account_index) or create_robust_session()

        try:
            res = sess.post(url, json={"refreshToken": ref_tok}, headers=headers, proxies=proxies, timeout=(5, 10))
            if res.status_code in [200, 201]:
                new_acc, new_ref = extract_token_from_response(res.json())
                if new_acc:
                    update_account_token(account_index, new_acc, new_ref)
                    return True
            ok, _ = execute_force_login(account_index)
            return ok
        except Exception:
            ok, _ = execute_force_login(account_index)
            return ok

def get_chainlink_auth_headers(method: str, path: str, body: str = "") -> dict:
    ts = str(int(time.time() * 1000))
    msg = f"{method.upper()} {path} {body} {CHAINLINK_API_KEY} {ts}".encode("utf-8")
    sig = hmac.new(CHAINLINK_USER_SECRET.encode("utf-8"), msg, hashlib.sha256).hexdigest()
    return {
        "X-Authorization-Timestamp": ts,
        "X-Authorization-Client-Id": CHAINLINK_API_KEY,
        "X-Authorization-Signature": sig,
        "Accept": "application/json"
    }

def fetch_chainlink_btc_price() -> float:
    if CHAINLINK_API_KEY and CHAINLINK_USER_SECRET:
        path = f"/api/v1/reports/latest?feedID={BTC_USD_FEED_ID}"
        url = f"https://api.dataengine.chain.link{path}"
        headers = get_chainlink_auth_headers("GET", path)
        try:
            res = stream_session.get(url, headers=headers, timeout=(1.2, 2.5))
            if res.status_code == 200:
                data = res.json()
                report = data.get("report") if isinstance(data.get("report"), dict) else data
                raw_p = report.get("benchmarkPrice") or report.get("price") or report.get("bid")
                if raw_p:
                    p_val = float(raw_p)
                    if p_val > 1e14:
                        p_val /= 1e18
                    elif p_val > 1e6:
                        p_val /= 1e8
                    if p_val > 5000:
                        return p_val
        except Exception:
            pass

    try:
        r = binance_session.get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", timeout=(1.0, 2.0))
        if r.status_code == 200:
            p = float(r.json().get("price", 0.0))
            if p > 0:
                return p
    except Exception:
        pass
    return 0.0

def fetch_hype_live_price() -> float:
    sources = [
        "https://api.binance.com/api/v3/ticker/price?symbol=HYPEUSDT",
        "https://fapi.binance.com/fapi/v1/ticker/price?symbol=HYPEUSDT",
        "https://api.bybit.com/v5/market/tickers?category=spot&symbol=HYPEUSDT"
    ]
    for src in sources:
        try:
            r = binance_session.get(src, timeout=(1.0, 2.0))
            if r.status_code == 200:
                data = r.json()
                if "price" in data:
                    p = float(data["price"])
                    if p > 0:
                        return p
                elif "result" in data and "list" in data["result"]:
                    items = data["result"]["list"]
                    if items and "lastPrice" in items[0]:
                        p = float(items[0]["lastPrice"])
                        if p > 0:
                            return p
        except Exception:
            pass
    return 0.0

def fetch_trump_live_price() -> float:
    try:
        r = binance_session.get("https://api.binance.com/api/v3/ticker/price?symbol=TRUMPUSDT", timeout=(1.0, 2.0))
        if r.status_code == 200:
            p = float(r.json().get("price", 0.0))
            if p > 0:
                return p
    except Exception:
        pass
    try:
        r = binance_session.get("https://api.bybit.com/v5/market/tickers?category=spot&symbol=TRUMPUSDT", timeout=(1.0, 2.0))
        if r.status_code == 200:
            data = r.json()
            if "result" in data and "list" in data["result"]:
                items = data["result"]["list"]
                if items and "lastPrice" in items[0]:
                    p = float(items[0]["lastPrice"])
                    if p > 0:
                        return p
    except Exception:
        pass
    return 0.0

def update_all_live_prices():
    global global_live_prices
    btc_p = fetch_chainlink_btc_price()
    if btc_p > 0:
        with data_lock:
            global_live_prices["BTC"] = btc_p

    hype_p = fetch_hype_live_price()
    if hype_p > 0:
        with data_lock:
            global_live_prices["HYPE"] = hype_p

    trump_p = fetch_trump_live_price()
    if trump_p > 0:
        with data_lock:
            global_live_prices["TRUMP"] = trump_p

    pairs = [
        ("ETH", "ETHUSDT"),
        ("SOL", "SOLUSDT"),
        ("DOGE", "DOGEUSDT"),
        ("XRP", "XRPUSDT"),
        ("BNB", "BNBUSDT"),
        ("AAVE", "AAVEUSDT"),
        ("ENA", "ENAUSDT"),
        ("ZEC", "ZECUSDT"),
        ("SUI", "SUIUSDT")
    ]
    for asset, sym in pairs:
        try:
            r = binance_session.get(f"https://api.binance.com/api/v3/ticker/price?symbol={sym}", timeout=(1.0, 2.0))
            if r.status_code == 200:
                p = float(r.json().get("price", 0.0))
                if p > 0:
                    with data_lock:
                        global_live_prices[asset] = p
        except Exception:
            pass

def fetch_balances_from_server(account_index):
    account = get_account(account_index)
    if not account:
        return None, None
    token = account.get("ACCESS_TOKEN", "").strip()
    if not token or len(token) < 20:
        return None, None

    cfg = load_config()
    sess = account_sessions.get(account_index) or create_robust_session()
    proxy = account.get("PROXY")
    proxies = {"http": proxy, "https": proxy} if proxy else {}
    url = f"{cfg.get('API_BASE_URL', 'https://api.trendbtc.app')}/api/me/balances"
    headers = get_headers(token)

    try:
        res = sess.get(url, headers=headers, proxies=proxies, timeout=(4, 8))
        if res.status_code == 401 and rotate_tokens_instantly(account_index):
            account = get_account(account_index)
            token = account.get("ACCESS_TOKEN", "").strip()
            headers = get_headers(token)
            res = sess.get(url, headers=headers, proxies=proxies, timeout=(4, 8))

        if res.status_code == 200:
            data = res.json()
            usd_val = 0.0
            trend_val = 0.0
            balances_list = data.get("balances", [])
            if isinstance(balances_list, list):
                for b in balances_list:
                    curr = str(b.get("currency", "")).upper()
                    bal = float(b.get("balance", 0.0))
                    if "USD" in curr:
                        usd_val = bal
                    elif "TREND" in curr:
                        trend_val = bal
                return usd_val, trend_val
            elif isinstance(balances_list, dict):
                return float(balances_list.get("USD", 0.0)), float(balances_list.get("TREND", 0.0))
            return float(data.get("usdBalance", 0.0)), float(data.get("trendBalance", 0.0))
    except Exception:
        pass
    return None, None

# ================= WORKER PASAR CRYPTO =================
def background_sync_worker():
    global shared_market_data, global_live_prices, is_running
    sess = create_robust_session()
    while is_running:
        update_all_live_prices()
        cfg = load_config()
        base_url = cfg.get("API_BASE_URL", "https://api.trendbtc.app").rstrip("/")
        url = cfg.get("API_URL", f"{base_url}/api/markets/current-rounds")
        try:
            res = sess.get(url, headers=get_headers(), timeout=(4, 8))
            if res.status_code == 200:
                rounds_list = res.json().get("rounds", [])
                now_utc = datetime.now(timezone.utc)
                with data_lock:
                    for r in rounds_list:
                        duration = r.get("durationSeconds")
                        sym_raw = str(r.get("marketSymbol", "")).upper()
                        matched_asset = next((a for a in SUPPORTED_ASSETS if a in sym_raw), None)
                        if matched_asset and duration in DURATION_MAP:
                            tf = DURATION_MAP[duration]
                            if tf in ASSET_TIMEFRAME_MAP.get(matched_asset, []):
                                lock_dt = parse_iso_time(r.get("lockTime"))
                                end_dt = parse_iso_time(r.get("endTime"))
                                target_dt = lock_dt if (lock_dt and now_utc < lock_dt) else end_dt if (end_dt and now_utc < end_dt) else None
                                status_waktu = "Open" if (lock_dt and now_utc < lock_dt) else "Settle"
                                start_p = float(r.get("startPrice") or 0.0)

                                if matched_asset in ["HYPE", "AAVE", "SOL", "ETH", "DOGE", "TRUMP", "ENA", "ZEC", "SUI"] and global_live_prices.get(matched_asset, 0.0) <= 0:
                                    live_feed = float(r.get("currentPrice") or r.get("price") or start_p)
                                    if live_feed > 0:
                                        global_live_prices[matched_asset] = live_feed

                                raw_corridor = r.get("corridorHalfWidth")
                                if raw_corridor is not None and float(raw_corridor) > 0:
                                    b_offset = float(raw_corridor)
                                    b_top = start_p + b_offset
                                    b_low = start_p - b_offset
                                else:
                                    b_offset = 0.0
                                    b_top = 0.0
                                    b_low = 0.0

                                if matched_asset in shared_market_data and tf in shared_market_data[matched_asset]:
                                    shared_market_data[matched_asset][tf].update({
                                        "round_id": r.get("id", "N/A"),
                                        "round_start_price": start_p,
                                        "band_top": b_top,
                                        "band_low": b_low,
                                        "band_offset": b_offset,
                                        "waktu_target_lock": target_dt,
                                        "status_waktu": status_waktu,
                                        "participants": int(r.get("participants", 0)),
                                        "is_synchronized": True
                                    })
        except Exception:
            pass
        time.sleep(1.2)

def fetch_account_prediction_history(account_index, account_name):
    account = get_account(account_index)
    if not account:
        return []
    token = account.get("ACCESS_TOKEN", "").strip()
    if not token or len(token) < 20:
        return []

    cfg = load_config()
    sess = account_sessions.get(account_index) or create_robust_session()
    proxy = account.get("PROXY")
    proxies = {"http": proxy, "https": proxy} if proxy else {}
    url = f"{cfg.get('API_BASE_URL', 'https://api.trendbtc.app')}/api/predictions/my?limit=10"
    headers = get_headers(token)
    parsed_items = []

    try:
        res = sess.get(url, headers=headers, proxies=proxies, timeout=(4, 8))
        if res.status_code == 401 and rotate_tokens_instantly(account_index):
            account = get_account(account_index)
            token = account.get("ACCESS_TOKEN", "").strip()
            headers = get_headers(token)
            res = sess.get(url, headers=headers, proxies=proxies, timeout=(4, 8))

        if res.status_code == 200:
            predictions = res.json().get("predictions", [])
            btc_1m_settled = []
            for p in predictions:
                rnd = p.get("round", {})
                dur = rnd.get("durationSeconds") if isinstance(rnd, dict) else None
                sym = str(rnd.get("marketSymbol", "") if isinstance(rnd, dict) else "").upper()
                res_val = str(p.get("result", "")).lower() if p.get("result") else ""
                st_val = str(p.get("status", "")).lower()
                if (dur == 60 or "1M" in sym or "BTC" in sym) and (res_val in ["won", "lost", "refund", "draw"] or st_val == "settled"):
                    btc_1m_settled.append(res_val)

            consecutive_losses = 0
            for r_status in btc_1m_settled:
                if r_status == "lost":
                    consecutive_losses += 1
                elif r_status in ["won", "refund", "draw"]:
                    break

            with data_lock:
                account_btc_martingale_tracker[account_name] = {
                    "consecutive_losses": consecutive_losses,
                    "multiplier": 2 ** consecutive_losses,
                    "last_result": btc_1m_settled[0] if btc_1m_settled else "none"
                }

            for p in predictions[:6]:
                r_id = p.get("roundId", "N/A")
                short_r_id = f"..{r_id[-6:]}" if len(r_id) >= 6 else r_id
                direction = str(p.get("direction", "UP")).upper()
                stake = float(p.get("stakeAmount", p.get("amount", 0.0)))
                weight = float(p.get("weight", 0.0))
                payout = float(p.get("payoutAmount", 0.0))
                trend_reward = int(p.get("trendReward", 0))
                result = str(p.get("result", "")).lower() if p.get("result") else ""

                if result == "won":
                    profit = payout - stake
                    hasil_str = f"{C_GREEN}WIN (+${profit:,.2f}){C_RESET}"
                elif result == "lost":
                    hasil_str = f"{C_RED}LOSE (-${stake:,.2f}){C_RESET}"
                else:
                    hasil_str = f"{C_YELLOW}OPEN{C_RESET}"

                dir_colored = f"{C_GREEN}{direction:<8}{C_RESET}" if direction in ["UP", "BREAKOUT"] else f"{C_RED}{direction:<8}{C_RESET}"
                parsed_items.append({
                    "id": p.get("id", str(uuid.uuid4())),
                    "account": account_name,
                    "short_r_id": short_r_id,
                    "direction_str": dir_colored,
                    "stake": stake,
                    "weight": weight,
                    "payout": payout,
                    "trend_reward": trend_reward,
                    "hasil_str": hasil_str,
                    "created_at": p.get("createdAt", "")
                })
    except Exception:
        pass
    return parsed_items

def background_history_worker():
    global shared_api_prediction_history, is_running
    while is_running:
        cfg = load_config()
        accounts = cfg.get("ACCOUNTS", [])
        combined = []
        for idx, acc in enumerate(accounts):
            name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
            items = fetch_account_prediction_history(idx, name)
            combined.extend(items)
            time.sleep(1.0)

        combined.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        with data_lock:
            shared_api_prediction_history = combined[:6]
        time.sleep(15)

def account_maintenance_worker(account_index, account_name):
    global account_balances, is_running
    last_bal_fetch = 0
    time.sleep(account_index * 2.0)
    while is_running:
        curr_time = time.time()
        if curr_time - last_bal_fetch > 15:
            usd, trend = fetch_balances_from_server(account_index)
            with data_lock:
                if usd is not None and trend is not None:
                    account_balances[account_name] = {"pred": usd, "trend": trend}
            last_bal_fetch = curr_time
        time.sleep(2)

def execute_bet_api(account_index, prediction_type, current_bet_amount, round_id, timeframe=None):
    global last_global_bet_time
    acc = get_account(account_index)
    if not acc:
        return False, "Akun Invalid"
    token = acc.get("ACCESS_TOKEN", "").strip()
    if not token or len(token) < 20:
        return False, "Token Expired"

    cfg = load_config()
    if cfg.get("SIMULATION_MODE", False):
        time.sleep(0.3)
        return True, f"SIMULASI ${current_bet_amount}"

    url = cfg.get("PREDICTION_API_URL", "https://api.trendbtc.app/api/predictions")
    headers = get_headers(token)
    headers["Content-Type"] = "application/json"

    stake_val = int(current_bet_amount)

    payload = {
        "roundId": str(round_id),
        "direction": str(prediction_type).upper(),
        "amount": stake_val,
        "stakeAmount": stake_val,
        "idempotencyKey": str(uuid.uuid4())
    }
    proxy = acc.get("PROXY")
    proxies = {"http": proxy, "https": proxy} if proxy else {}
    sess = account_sessions.get(account_index) or create_robust_session()

    last_error = "RTO"
    with api_request_lock:
        with global_bet_lock:
            now_t = time.time()
            gap = now_t - last_global_bet_time
            if gap < 2.5:
                time.sleep(2.5 - gap)
            last_global_bet_time = time.time()

        for attempt in range(4):
            try:
                res = sess.post(url, json=payload, headers=headers, proxies=proxies, timeout=(6, 14))
                if res.status_code in [200, 201]:
                    fetch_balances_from_server(account_index)
                    return True, f"APPROVED ${stake_val:,.0f}"
                elif res.status_code == 401:
                    if rotate_tokens_instantly(account_index):
                        fresh_acc = get_account(account_index)
                        headers["Authorization"] = f"Bearer {fresh_acc.get('ACCESS_TOKEN', '').strip()}"
                        continue
                    return False, "401 (Expired)"
                elif res.status_code == 429:
                    time.sleep(2.5)
                    continue
                elif res.status_code in [500, 502, 503, 504]:
                    # Penanganan lonjakan Cloudflare / 503 Service Unavailable
                    time.sleep(1.0)
                    continue
                elif res.status_code == 409:
                    # Membaca pesan spesifik 409 untuk membedakan Lock Time vs Already Predicted
                    try:
                        err_msg = res.json().get("error", {}).get("message", "Lock Time/Conflict")
                    except Exception:
                        err_msg = "Lock Time"
                    return False, f"409 ({err_msg})"
                else:
                    err_txt = "Cloudflare Error" if "<html" in res.text.lower() else res.text[:20]
                    return False, f"{res.status_code} ({err_txt})"
            except Exception as e:
                last_error = f"Err: {str(e)[:20]}"
                time.sleep(1.0)
        return False, last_error

def account_asset_bet_worker(account_index, account_name, asset, timeframe):
    global account_states, shared_bet_history, is_running
    state_key = f"{account_name}_{asset}_{timeframe}"
    last_round_id = ""
    bet_executed = False

    while is_running:
        time.sleep(0.4)
        with data_lock:
            asset_data = shared_market_data.get(asset, {})
            data = asset_data.get(timeframe, {})
            round_id = data.get("round_id", "")
            round_start = data.get("round_start_price", 0.0)
            band_top = data.get("band_top", 0.0)
            band_low = data.get("band_low", 0.0)
            band_offset = data.get("band_offset", 0.0)
            current_live = global_live_prices.get(asset, 0.0)
            target_lock = data.get("waktu_target_lock")
            is_sync = data.get("is_synchronized", False)

        if not is_sync or target_lock is None or not round_id or round_id == "N/A" or round_start <= 0 or current_live <= 0:
            with data_lock:
                account_states[state_key] = f"{C_CYAN}Sync...{C_RESET}"
            continue

        if round_id != last_round_id:
            last_round_id = round_id
            bet_executed = False

        total_sec = int((target_lock - datetime.now(timezone.utc)).total_seconds())
        live_diff = current_live - round_start
        abs_diff = abs(live_diff)

        acc_config = get_account(account_index)
        min_bet = float(acc_config.get("MIN_BET", 10))
        exec_sec_cfg = acc_config.get("EXECUTE_BEFORE_SECONDS", {}).get(asset, {}).get(timeframe, 10 if timeframe == "1m" else 85)

        if live_diff > 0:
            diff_color = C_GREEN
            diff_sym = "▲"
        elif live_diff < 0:
            diff_color = C_RED
            diff_sym = "▼"
        else:
            diff_color = C_YELLOW
            diff_sym = "―"

        if timeframe == "1m":
            if band_top > 0 and band_low > 0:
                direction = "BREAKOUT" if (current_live > band_top or current_live < band_low) else "INSIDE"
            else:
                direction = "BREAKOUT" if abs_diff > band_offset else "INSIDE"
            dir_display = direction
        else:
            if live_diff > 0:
                direction = "UP"
            elif live_diff < 0:
                direction = "DOWN"
            else:
                direction = "STAGNAN"
            dir_display = direction

        martingale_badge = ""
        bet_amount = min_bet

        if asset == "BTC" and timeframe == "1m":
            matched_breakout_rule = False
            if direction == "BREAKOUT":
                bo_rules = acc_config.get("BTC_1M_BREAKOUT_STAKING", {}).get("RULES", [])
                for rule in sorted(bo_rules, key=lambda x: x.get("gap", 0), reverse=True):
                    if abs_diff >= rule.get("gap", 0):
                        bet_amount = float(rule.get("amount", 50))
                        matched_breakout_rule = True
                        martingale_badge = f" {C_YELLOW}[BO +{abs_diff:,.1f} ➔ ${bet_amount:,.0f}]{C_RESET}"
                        break

            if not matched_breakout_rule:
                m_cfg = acc_config.get("BTC_MARTINGALE", {})
                if m_cfg.get("ENABLED", True):
                    base_bet = float(m_cfg.get("BASE_BET", 1))
                    max_bet = float(m_cfg.get("MAX_BET", 1000))
                    mult_factor = float(m_cfg.get("MULTIPLIER", 2))
                    with data_lock:
                        m_track = account_btc_martingale_tracker.get(account_name, {"consecutive_losses": 0, "multiplier": 1})
                        losses_count = m_track.get("consecutive_losses", 0)
                    calc_amount = base_bet * (mult_factor ** losses_count)
                    bet_amount = min(calc_amount, max_bet)
                    mult_display = mult_factor ** losses_count
                    martingale_badge = f" {C_MAGENTA}[M: x{mult_display:.0f} | L:{losses_count}]{C_RESET}"
        else:
            rules = acc_config.get("ASSET_STAKING_RULES", {}).get(asset, [])
            for rule in sorted(rules, key=lambda x: x.get("gap", 0), reverse=True):
                if abs_diff >= rule.get("gap", 0):
                    bet_amount = float(rule.get("amount", min_bet))
                    break

        if asset in ["DOGE"]:
            diff_str = f"{live_diff:+,.5f}"
        elif asset in ["XRP", "TRUMP", "ENA", "SUI"]:
            diff_str = f"{live_diff:+,.4f}"
        else:
            diff_str = f"{live_diff:+,.2f}"

        with data_lock:
            if not bet_executed:
                account_states[state_key] = f"{C_CYAN}({total_sec}s | Snip: {exec_sec_cfg}s){C_RESET} {C_YELLOW}| ${bet_amount:,.0f} {dir_display}{C_RESET}{martingale_badge} {diff_color}({diff_sym} {diff_str}){C_RESET}"
            else:
                account_states[state_key] = f"{C_MAGENTA}Locked (Selesai){C_RESET}"

        # Sniper dieksekusi dengan jendela toleransi 15 detik untuk mencegah lag menabrak Lock Time 409
        window_bawah = max(2, exec_sec_cfg - 15)
        if window_bawah <= total_sec <= exec_sec_cfg and not bet_executed and direction != "STAGNAN":
            ts_now = datetime.now().strftime("%H:%M:%S")
            success, msg = execute_bet_api(account_index, direction, bet_amount, round_id, timeframe)
            with data_lock:
                if success:
                    account_states[state_key] = f"{C_GREEN}LOCKED: {msg}{C_RESET}"
                    shared_bet_history.append(f"{C_YELLOW}[{ts_now}]{C_RESET} {C_CYAN}{account_name}{C_RESET} {C_MAGENTA}({asset} {timeframe.upper()}){C_RESET} -> {C_GREEN}SUKSES BET ${bet_amount:,.0f} {direction}{martingale_badge}{C_RESET}")
                else:
                    account_states[state_key] = f"{C_RED}GAGAL: {msg}{C_RESET}"
                    shared_bet_history.append(f"{C_YELLOW}[{ts_now}]{C_RESET} {C_CYAN}{account_name}{C_RESET} {C_MAGENTA}({asset} {timeframe.upper()}){C_RESET} -> {C_RED}GAGAL ({msg}){C_RESET}")
                if len(shared_bet_history) > 30:
                    shared_bet_history.pop(0)
            bet_executed = True

# ================= WORKER SPORTS =================
def sports_sync_worker():
    global shared_sports_fixtures, shared_sports_markets_map, is_running
    sess = create_robust_session()
    cfg = load_config()
    base_url = cfg.get("API_BASE_URL", "https://api.trendbtc.app").rstrip("/")
    url = f"{base_url}/api/event-markets?category=sports"

    while is_running:
        try:
            first_acc = get_account(0)
            token = first_acc.get("ACCESS_TOKEN", "").strip() if first_acc else ""
            res = sess.get(url, headers=get_headers(token), timeout=(6, 12))

            if res.status_code == 200:
                data = res.json()
                raw_markets = data.get("markets")
                if not isinstance(raw_markets, list):
                    raw_markets = []

                fixtures_dict = {}
                markets_map = {}
                now_utc = datetime.now(timezone.utc)

                for m in raw_markets:
                    try:
                        if not isinstance(m, dict):
                            continue
                        r_id = str(m.get("roundId") or "")
                        if not r_id:
                            continue
                        markets_map[r_id] = m

                        st = str(m.get("status") or "").lower()
                        winner_idx = m.get("winnerIndex")
                        live_obj = m.get("live")
                        is_ended = bool(live_obj.get("ended", False)) if isinstance(live_obj, dict) else False

                        raw_time = m.get("lockTime") or m.get("startsAt") or m.get("startTime") or m.get("endTime")
                        target_dt = parse_iso_time(raw_time)
                        m["parsed_target_dt"] = target_dt

                        raw_pools = m.get("pools")
                        if isinstance(raw_pools, list) and len(raw_pools) >= 2:
                            p0 = float(raw_pools[0] or 0)
                            p1 = float(raw_pools[1] or 0)
                        else:
                            p0 = 0.0
                            p1 = 0.0

                        tot_p = p0 + p1
                        pct0 = (p0 / tot_p * 100.0) if tot_p > 0 else 50.0
                        pct1 = (p1 / tot_p * 100.0) if tot_p > 0 else 50.0

                        m["p0"] = p0
                        m["p1"] = p1
                        m["pct0"] = pct0
                        m["pct1"] = pct1

                        if pct0 <= pct1:
                            m["best_dir"] = "UP"
                            m["best_name"] = "Yes"
                            m["best_pct"] = pct0
                            m["best_pool"] = p0
                        else:
                            m["best_dir"] = "DOWN"
                            m["best_name"] = "No"
                            m["best_pct"] = pct1
                            m["best_pool"] = p1

                        if st != "settled" and winner_idx is None and not is_ended:
                            if target_dt and (target_dt - now_utc).total_seconds() <= 0:
                                continue

                            fix_key = m.get("fixtureKey") or m.get("eventTitle") or m.get("question") or r_id
                            fix_key = str(fix_key)

                            if fix_key not in fixtures_dict:
                                teams = m.get("teams")
                                t1 = "Team 1"
                                t2 = "Team 2"
                                if isinstance(teams, list) and len(teams) >= 2:
                                    if isinstance(teams[0], dict):
                                        t1 = str(teams[0].get("name") or "Team 1")
                                    if isinstance(teams[1], dict):
                                        t2 = str(teams[1].get("name") or "Team 2")

                                fix_title = str(m.get("eventTitle") or f"{t1} vs {t2}")
                                fixtures_dict[fix_key] = {
                                    "title": fix_title,
                                    "league": str(m.get("league") or "SPORTS").replace("-", " ").upper(),
                                    "target_dt": target_dt,
                                    "t1_name": t1,
                                    "t2_name": t2,
                                    "sub_markets": []
                                }

                            q_text = str(m.get("question") or "")
                            q_lower = q_text.lower()
                            t1_name = fixtures_dict[fix_key]["t1_name"]
                            t2_name = fixtures_dict[fix_key]["t2_name"]

                            if "draw" in q_lower or "seri" in q_lower:
                                m["sub_type"] = "Draw"
                                m["sort_order"] = 2
                            elif t2_name.lower() in q_lower and "vs" not in q_lower:
                                m["sub_type"] = f"{t2_name} to win"
                                m["sort_order"] = 3
                            elif t1_name.lower() in q_lower:
                                m["sub_type"] = f"{t1_name} to win"
                                m["sort_order"] = 1
                            else:
                                m["sub_type"] = q_text
                                m["sort_order"] = 4

                            fixtures_dict[fix_key]["sub_markets"].append(m)

                    except Exception:
                        continue

                active_fixtures_list = list(fixtures_dict.values())
                for fix in active_fixtures_list:
                    fix["sub_markets"].sort(key=lambda x: x.get("sort_order", 9))

                with data_lock:
                    shared_sports_fixtures = active_fixtures_list
                    shared_sports_markets_map = markets_map
        except Exception:
            pass
        time.sleep(2.5)

def sports_history_worker():
    global shared_sports_my_predictions, sports_already_betted_keys, is_running
    cfg = load_config()
    accounts = cfg.get("ACCOUNTS", [])
    base_url = cfg.get("API_BASE_URL", "https://api.trendbtc.app").rstrip("/")

    while is_running:
        combined = []
        for idx, acc in enumerate(accounts):
            name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
            token = acc.get("ACCESS_TOKEN", "").strip()
            if not token:
                continue
            sess = account_sessions.get(idx) or create_robust_session()
            url = f"{base_url}/api/event-markets/my?category=sports"
            try:
                res = sess.get(url, headers=get_headers(token), timeout=(4, 8))
                if res.status_code == 401 and rotate_tokens_instantly(idx):
                    fresh_acc = get_account(idx)
                    res = sess.get(url, headers=get_headers(fresh_acc.get("ACCESS_TOKEN")), timeout=(4, 8))
                if res.status_code == 200:
                    my_preds = res.json().get("predictions", [])
                    for p in my_preds:
                        p["account_name"] = name
                        combined.append(p)
                        r_id = str(p.get("roundId") or "")
                        if r_id:
                            with data_lock:
                                sports_already_betted_keys.add(f"{name}_{r_id}")
            except Exception:
                pass
            time.sleep(1.0)
        with data_lock:
            shared_sports_my_predictions = combined[:8]
        time.sleep(12)

def auto_sports_lowest_percentage_worker():
    global shared_sports_bet_history, sports_already_betted_keys, is_running
    cfg = load_config()
    accounts = cfg.get("ACCOUNTS", [])

    while is_running:
        time.sleep(2)
        with data_lock:
            fixtures_copy = list(shared_sports_fixtures)

        if not fixtures_copy:
            continue

        now_utc = datetime.now(timezone.utc)

        for fix in fixtures_copy:
            fix_target = fix.get("target_dt")
            if fix_target and (fix_target - now_utc).total_seconds() <= 15:
                continue

            for m in fix.get("sub_markets", []):
                round_id = str(m.get("roundId") or "")
                if not round_id:
                    continue

                m_target = m.get("parsed_target_dt")
                if m_target and (m_target - now_utc).total_seconds() <= 15:
                    continue

                chosen_dir = m.get("best_dir", "UP")
                chosen_name = m.get("best_name", "Yes")
                chosen_pct = m.get("best_pct", 50.0)
                chosen_pool = m.get("best_pool", 0)
                sub_label = m.get("sub_type", "Match")

                for idx, acc in enumerate(accounts):
                    acc_name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
                    bet_key = f"{acc_name}_{round_id}"

                    if bet_key in sports_already_betted_keys:
                        continue

                    ts_now = datetime.now().strftime("%H:%M:%S")
                    success, msg = execute_bet_api(idx, chosen_dir, 1, round_id)
                    with data_lock:
                        sports_already_betted_keys.add(bet_key)
                        if success:
                            log_msg = f"{C_YELLOW}[{ts_now}]{C_RESET} {C_CYAN}{acc_name}{C_RESET} -> {C_GREEN}SUKSES $1 {chosen_name} ({chosen_pct:.0f}% | ${chosen_pool:,.0f} pool){C_RESET} | {sub_label}"
                        else:
                            log_msg = f"{C_YELLOW}[{ts_now}]{C_RESET} {C_CYAN}{acc_name}{C_RESET} -> {C_RED}GAGAL ({msg}){C_RESET} | {sub_label}"
                        shared_sports_bet_history.append(log_msg)
                        if len(shared_sports_bet_history) > 25:
                            shared_sports_bet_history.pop(0)

                    time.sleep(3.5)

# ================= WORKER SURVIVOR =================
def survivor_sync_worker():
    global shared_survivor_global, is_running
    sess = create_robust_session()
    cfg = load_config()
    base_url = cfg.get("API_BASE_URL", "https://api.trendbtc.app").rstrip("/")
    url = f"{base_url}/api/survivor"

    while is_running:
        try:
            first_acc = get_account(0)
            token = first_acc.get("ACCESS_TOKEN", "").strip() if first_acc else ""
            res = sess.get(url, headers=get_headers(token), timeout=(5, 10))
            if res.status_code == 401 and rotate_tokens_instantly(0):
                fresh_acc = get_account(0)
                res = sess.get(url, headers=get_headers(fresh_acc.get("ACCESS_TOKEN")), timeout=(5, 10))

            if res.status_code == 200:
                d = res.json()
                raw_obj = d.get("survivor") or d.get("data") or d
                if not isinstance(raw_obj, dict):
                    raw_obj = d

                now_utc = datetime.now(timezone.utc)
                phase = str(raw_obj.get("phase", "idle")).lower()
                doors = bool(raw_obj.get("joinOpen", True))

                start_raw = raw_obj.get("startAt") or raw_obj.get("startsAt")
                end_raw = raw_obj.get("endAt") or raw_obj.get("endsAt")
                starts_dt = parse_iso_time(start_raw)
                ends_dt = parse_iso_time(end_raw)

                if starts_dt:
                    local_dt = starts_dt.astimezone()
                    starts_label = f"at {local_dt.strftime('%H.%M')} your time"
                else:
                    starts_dt, starts_label = get_next_survivor_scheduled_time()

                entrants = int(raw_obj.get("entrantCount") or raw_obj.get("entered") or 151)
                alive = int(raw_obj.get("aliveCount") or raw_obj.get("stillStanding") or entrants)

                rounds_list = raw_obj.get("rounds", [])
                cur_round_num = 0
                cur_r_data = None

                for r in rounds_list:
                    st_t = parse_iso_time(r.get("startTime"))
                    en_t = parse_iso_time(r.get("endTime"))
                    r_st = str(r.get("status", "")).lower()
                    if (st_t and en_t and st_t <= now_utc < en_t) or r_st in ["active", "open", "running"]:
                        cur_round_num = int(r.get("index", 0)) + 1
                        cur_r_data = r
                        break

                if not cur_r_data and (starts_dt and ends_dt and starts_dt <= now_utc < ends_dt):
                    idx = int(raw_obj.get("currentRoundIndex", 0))
                    if 0 <= idx < len(rounds_list):
                        cur_round_num = idx + 1
                        cur_r_data = rounds_list[idx]

                r_id = ""
                r_start = 0.0
                r_lock = None

                if cur_r_data:
                    r_id = str(cur_r_data.get("id") or f"R{cur_round_num}")
                    r_start = float(cur_r_data.get("startPrice") or 0.0)
                    r_lock = parse_iso_time(cur_r_data.get("lockTime"))
                    if not r_lock:
                        en_t = parse_iso_time(cur_r_data.get("endTime"))
                        if en_t:
                            r_lock = en_t - timedelta(seconds=30)
                        else:
                            r_lock = parse_iso_time(raw_obj.get("joinCloseAt"))

                prize_raw = raw_obj.get("prizePool") or "25000"
                prize_str = f"{float(prize_raw):,.0f} TREND" if str(prize_raw).replace(".", "").isdigit() else str(prize_raw)

                with data_lock:
                    shared_survivor_global.update({
                        "status": phase,
                        "is_active": (cur_round_num > 0),
                        "doors_open": doors,
                        "starts_at": starts_dt,
                        "starts_label": starts_label,
                        "prize_pool": prize_str,
                        "entered": entrants,
                        "still_standing": alive,
                        "current_round": cur_round_num,
                        "round_id": r_id,
                        "round_start_price": r_start,
                        "lock_time": r_lock
                    })
        except Exception:
            pass
        time.sleep(2.5)

def execute_survivor_join_api(account_index):
    acc = get_account(account_index)
    if not acc:
        return False, "Akun Invalid"
    token = acc.get("ACCESS_TOKEN", "").strip()
    if not token or len(token) < 20:
        return False, "Token Expired"

    cfg = load_config()
    base_url = cfg.get("API_BASE_URL", "https://api.trendbtc.app").rstrip("/")
    url = f"{base_url}/api/survivor/join"
    headers = get_headers(token)
    headers["Content-Type"] = "application/json"

    sess = account_sessions.get(account_index) or create_robust_session()
    proxy = acc.get("PROXY")
    proxies = {"http": proxy, "https": proxy} if proxy else {}

    try:
        res = sess.post(url, json={}, headers=headers, proxies=proxies, timeout=(5, 10))
        if res.status_code in [200, 201]:
            return True, "SUKSES JOIN"
        elif res.status_code in [400, 409]:
            return True, "SUDAH TERDAFTAR"
        elif res.status_code == 401 and rotate_tokens_instantly(account_index):
            fresh_acc = get_account(account_index)
            headers["Authorization"] = f"Bearer {fresh_acc.get('ACCESS_TOKEN', '').strip()}"
            res2 = sess.post(url, json={}, headers=headers, proxies=proxies, timeout=(5, 10))
            if res2.status_code in [200, 201]:
                return True, "SUKSES JOIN"
            elif res2.status_code in [400, 409]:
                return True, "SUDAH TERDAFTAR"
            return False, f"HTTP {res2.status_code}"
        else:
            return False, f"HTTP {res.status_code}"
    except Exception as e:
        return False, f"Err: {str(e)[:20]}"

def execute_survivor_pick_api(account_index, direction, round_id):
    acc = get_account(account_index)
    if not acc:
        return False, "Akun Invalid"
    token = acc.get("ACCESS_TOKEN", "").strip()
    if not token or len(token) < 20:
        return False, "Token Expired"

    cfg = load_config()
    base_url = cfg.get("API_BASE_URL", "https://api.trendbtc.app").rstrip("/")
    url = f"{base_url}/api/survivor/pick"
    headers = get_headers(token)
    headers["Content-Type"] = "application/json"

    payload = {
        "direction": str(direction).upper(),
        "roundId": str(round_id) if round_id else None,
        "idempotencyKey": str(uuid.uuid4())
    }
    sess = account_sessions.get(account_index) or create_robust_session()
    proxy = acc.get("PROXY")
    proxies = {"http": proxy, "https": proxy} if proxy else {}

    try:
        res = sess.post(url, json=payload, headers=headers, proxies=proxies, timeout=(5, 10))
        if res.status_code in [200, 201]:
            return True, f"PICK {direction.upper()} DITERIMA"
        elif res.status_code == 401 and rotate_tokens_instantly(account_index):
            fresh_acc = get_account(account_index)
            headers["Authorization"] = f"Bearer {fresh_acc.get('ACCESS_TOKEN', '').strip()}"
            res2 = sess.post(url, json=payload, headers=headers, proxies=proxies, timeout=(5, 10))
            if res2.status_code in [200, 201]:
                return True, f"PICK {direction.upper()} DITERIMA"
            return False, f"HTTP {res2.status_code}"
        elif res.status_code == 409:
            return False, "409 (Ronde Terkunci)"
        else:
            return False, f"HTTP {res.status_code}"
    except Exception as e:
        return False, f"Err: {str(e)[:20]}"

def survivor_account_worker(account_index, account_name):
    global shared_survivor_accounts, shared_survivor_bet_history, survivor_already_picked_rounds, is_running
    cfg = load_config()
    base_url = cfg.get("API_BASE_URL", "https://api.trendbtc.app").rstrip("/")
    me_url = f"{base_url}/api/survivor/me"

    while is_running:
        time.sleep(0.5)
        acc = get_account(account_index)
        token = acc.get("ACCESS_TOKEN", "").strip() if acc else ""
        if not token:
            time.sleep(1.5)
            continue

        sess = account_sessions.get(account_index) or create_robust_session()
        proxy = acc.get("PROXY")
        proxies = {"http": proxy, "https": proxy} if proxy else {}

        try:
            res = sess.get(me_url, headers=get_headers(token), proxies=proxies, timeout=(4, 8))
            if res.status_code == 401 and rotate_tokens_instantly(account_index):
                fresh_acc = get_account(account_index)
                res = sess.get(me_url, headers=get_headers(fresh_acc.get("ACCESS_TOKEN")), proxies=proxies, timeout=(4, 8))

            if res.status_code == 200:
                me_data = res.json()
                entry = me_data.get("entry", {}) if isinstance(me_data.get("entry"), dict) else me_data
                has_joined = bool(entry.get("joined", False))
                still_in = bool(entry.get("alive", False))
                ko_round = entry.get("eliminatedRound")
                if ko_round is not None:
                    ko_round = int(ko_round)

                round_results = {}
                picks_list = entry.get("picks", [])
                if isinstance(picks_list, list):
                    for idx_p, p_item in enumerate(picks_list):
                        if isinstance(p_item, dict):
                            r_num = p_item.get("roundIndex", idx_p) + 1
                            r_res = str(p_item.get("result", "")).lower()
                            round_results[r_num] = r_res

                with data_lock:
                    shared_survivor_accounts[account_name] = {
                        "joined": has_joined,
                        "still_in": still_in,
                        "knocked_round": ko_round,
                        "round_results": round_results,
                        "status_str": f"{C_GREEN}Still in{C_RESET}" if still_in else f"{C_RED}Knocked out{C_RESET}" if has_joined else f"{C_YELLOW}Belum Join{C_RESET}"
                    }

                doors_open = shared_survivor_global.get("doors_open", False)
                if doors_open and not has_joined:
                    ok_j, msg_j = execute_survivor_join_api(account_index)
                    ts_now = datetime.now().strftime("%H:%M:%S")
                    if ok_j:
                        with data_lock:
                            shared_survivor_accounts[account_name]["joined"] = True
                            shared_survivor_accounts[account_name]["still_in"] = True
                    with data_lock:
                        shared_survivor_bet_history.append(f"{C_YELLOW}[{ts_now}]{C_RESET} {C_CYAN}{account_name}{C_RESET} -> {C_GREEN if ok_j else C_RED}{msg_j}{C_RESET} (SURVIVOR LOBBY)")
                        if len(shared_survivor_bet_history) > 20:
                            shared_survivor_bet_history.pop(0)

                with data_lock:
                    r_id = shared_survivor_global.get("round_id", "")
                    r_start = shared_survivor_global.get("round_start_price", 0.0)
                    r_lock = shared_survivor_global.get("lock_time")
                    btc_live = global_live_prices.get("BTC", 0.0)
                    is_active = shared_survivor_global.get("is_active", False)

                if has_joined and still_in and r_id and r_lock and is_active:
                    now_utc = datetime.now(timezone.utc)
                    sec_left = int((r_lock - now_utc).total_seconds())
                    pick_key = f"{account_name}_{r_id}"

                    # Sniper Survivor disetel aman di 75 detik (Akun_1) dan 90 detik (Akun_2) sebelum lock
                    target_sniper_sec = 75 if account_index == 0 else 90

                    if 5 <= sec_left <= target_sniper_sec and pick_key not in survivor_already_picked_rounds:
                        diff = btc_live - r_start if (btc_live > 0 and r_start > 0) else 0.0
                        chosen_dir = "UP" if diff >= 0 else "DOWN"
                        arrow_sym = "▲" if diff > 0 else "▼" if diff < 0 else "―"
                        ok_p, msg_p = execute_survivor_pick_api(account_index, chosen_dir, r_id)
                        ts_now = datetime.now().strftime("%H:%M:%S")
                        with data_lock:
                            survivor_already_picked_rounds.add(pick_key)
                            log_col = C_GREEN if ok_p else C_RED
                            shared_survivor_bet_history.append(f"{C_YELLOW}[{ts_now}]{C_RESET} {C_CYAN}{account_name}{C_RESET} -> {log_col}{msg_p}{C_RESET} | Sniped at {sec_left}s | BTC {arrow_sym} {diff:+,.2f}")
                            if len(shared_survivor_bet_history) > 20:
                                shared_survivor_bet_history.pop(0)

                        try:
                            with open("survivor_history.log", "a", encoding="utf-8") as f:
                                f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] [{account_name}] {msg_p} | Ronde: {r_id} | Sisa: {sec_left}s | BTC: {diff:+,.2f}\n")
                        except Exception:
                            pass
        except Exception:
            pass

# ================= WORKER BULLSEYE =================
def bullseye_sync_worker():
    global shared_bullseye_global, is_running
    sess = create_robust_session()
    cfg = load_config()
    base_url = cfg.get("API_BASE_URL", "https://api.trendbtc.app").rstrip("/")
    url = f"{base_url}/api/bullseye"

    while is_running:
        try:
            first_acc = get_account(0)
            token = first_acc.get("ACCESS_TOKEN", "").strip() if first_acc else ""
            res = sess.get(url, headers=get_headers(token), timeout=(4, 8))
            if res.status_code == 401 and rotate_tokens_instantly(0):
                fresh_acc = get_account(0)
                res = sess.get(url, headers=get_headers(fresh_acc.get("ACCESS_TOKEN")), timeout=(4, 8))

            if res.status_code == 200:
                d = res.json()
                raw_b = d.get("bullseye", {}) if isinstance(d.get("bullseye"), dict) else d

                phase = str(raw_b.get("phase", "idle")).lower()
                is_active = (phase == "active" or phase == "running")

                r_id = str(raw_b.get("eventId") or "")
                starts_dt = parse_iso_time(raw_b.get("startedAt"))
                call_dl = parse_iso_time(raw_b.get("submitCloseAt"))
                ends_dt = parse_iso_time(raw_b.get("settleAt"))
                parts = int(raw_b.get("entryCount") or 0)
                prize = f"{raw_b.get('unitPrizeSol', 0.001)} SOL + {raw_b.get('consolationTrend', 200)} TREND"

                with data_lock:
                    shared_bullseye_global.update({
                        "status": "LIVE FLASH EVENT (BERJALAN)" if is_active else "No event running",
                        "is_active": is_active,
                        "round_id": r_id,
                        "starts_at": starts_dt,
                        "call_deadline": call_dl,
                        "ends_at": ends_dt,
                        "participants": parts,
                        "prize_pool": prize
                    })
        except Exception:
            pass
        time.sleep(2.5)

def execute_bullseye_call_api(account_index, predicted_price, round_id):
    acc = get_account(account_index)
    if not acc:
        return False, "Akun Invalid"
    token = acc.get("ACCESS_TOKEN", "").strip()
    if not token or len(token) < 20:
        return False, "Token Expired"

    cfg = load_config()
    base_url = cfg.get("API_BASE_URL", "https://api.trendbtc.app").rstrip("/")
    url = f"{base_url}/api/bullseye/submit"
    headers = get_headers(token)
    headers["Content-Type"] = "application/json"

    payload = {
        "price": float(round(predicted_price, 2)),
        "guess": float(round(predicted_price, 2)),
        "eventId": str(round_id) if round_id else None,
        "idempotencyKey": str(uuid.uuid4())
    }
    sess = account_sessions.get(account_index) or create_robust_session()
    proxy = acc.get("PROXY")
    proxies = {"http": proxy, "https": proxy} if proxy else {}

    endpoints_to_try = [
        f"{base_url}/api/bullseye/submit",
        f"{base_url}/api/bullseye/call"
    ]

    for ep in endpoints_to_try:
        try:
            res = sess.post(ep, json=payload, headers=headers, proxies=proxies, timeout=(5, 10))
            if res.status_code in [200, 201]:
                return True, f"CALLED ${predicted_price:,.2f}"
            elif res.status_code == 401 and rotate_tokens_instantly(account_index):
                fresh_acc = get_account(account_index)
                headers["Authorization"] = f"Bearer {fresh_acc.get('ACCESS_TOKEN', '').strip()}"
                res2 = sess.post(ep, json=payload, headers=headers, proxies=proxies, timeout=(5, 10))
                if res2.status_code in [200, 201]:
                    return True, f"CALLED ${predicted_price:,.2f}"
            elif res.status_code == 409:
                return False, "409 (Calling Window Expired)"
            elif res.status_code == 404:
                continue
        except Exception:
            pass
    return False, "Gagal kirim prediksi harga"

def bullseye_account_worker(account_index, account_name):
    global shared_bullseye_accounts, shared_bullseye_history, bullseye_already_called_rounds, is_running
    cfg = load_config()
    base_url = cfg.get("API_BASE_URL", "https://api.trendbtc.app").rstrip("/")
    me_url = f"{base_url}/api/bullseye/me"

    while is_running:
        time.sleep(0.5)
        acc = get_account(account_index)
        token = acc.get("ACCESS_TOKEN", "").strip() if acc else ""
        if not token:
            time.sleep(1.5)
            continue

        sess = account_sessions.get(account_index) or create_robust_session()
        proxy = acc.get("PROXY")
        proxies = {"http": proxy, "https": proxy} if proxy else {}

        try:
            res = sess.get(me_url, headers=get_headers(token), proxies=proxies, timeout=(4, 8))
            if res.status_code == 401 and rotate_tokens_instantly(account_index):
                fresh_acc = get_account(account_index)
                res = sess.get(me_url, headers=get_headers(fresh_acc.get("ACCESS_TOKEN")), proxies=proxies, timeout=(4, 8))

            if res.status_code == 200:
                me_data = res.json()
                entry = me_data.get("entry", {}) if isinstance(me_data.get("entry"), dict) else me_data
                has_called = bool(entry.get("joined", False) or entry.get("guess") is not None)
                called_price = float(entry.get("guess") or entry.get("price") or 0.0)

                with data_lock:
                    shared_bullseye_accounts[account_name] = {
                        "has_called": has_called,
                        "called_price": called_price,
                        "status_str": f"{C_GREEN}SUBMITTED (${called_price:,.2f}){C_RESET}" if has_called else f"{C_YELLOW}STANDBY (Sniper Ready: 15s){C_RESET}"
                    }

                with data_lock:
                    is_active = shared_bullseye_global.get("is_active", False)
                    r_id = shared_bullseye_global.get("round_id", "")
                    call_dl = shared_bullseye_global.get("call_deadline")
                    btc_live = global_live_prices.get("BTC", 0.0)

                if is_active and not has_called and btc_live > 0:
                    call_key = f"{account_name}_{r_id}"
                    if call_key not in bullseye_already_called_rounds:
                        now_utc = datetime.now(timezone.utc)
                        # Stagger sniper timing bullseye
                        target_sniper_sec = 20 if account_index == 0 else 12

                        should_snipe = False
                        if call_dl:
                            sec_left_call = int((call_dl - now_utc).total_seconds())
                            if 2 <= sec_left_call <= target_sniper_sec:
                                should_snipe = True
                        else:
                            should_snipe = True

                        if should_snipe:
                            ok, msg = execute_bullseye_call_api(account_index, btc_live, r_id)
                            ts_now = datetime.now().strftime("%H:%M:%S")
                            with data_lock:
                                bullseye_already_called_rounds.add(call_key)
                                log_col = C_GREEN if ok else C_RED
                                shared_bullseye_history.append(f"{C_YELLOW}[{ts_now}]{C_RESET} {C_CYAN}{account_name}{C_RESET} -> {log_col}{msg}{C_RESET} (BULLSEYE SNIPER)")
                                if len(shared_bullseye_history) > 20:
                                    shared_bullseye_history.pop(0)
        except Exception:
            pass

# ================= INISIALISASI AKUN =================
def initialize_all_accounts_strictly(accounts):
    clear_termux()
    total = len(accounts)
    print(f"{C_MAGENTA}========================================================================================{C_RESET}")
    print(f"{C_CYAN}OTENTIKASI & SINKRONISASI SALDO ({total} AKUN){C_RESET}")
    print(f"{C_YELLOW}Memverifikasi status token dan saldo akun...{C_RESET}")
    print(f"{C_MAGENTA}========================================================================================{C_RESET}\n")

    has_error = False
    for idx, acc in enumerate(accounts):
        name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
        account_sessions[idx] = create_robust_session()
        usd, trend = fetch_balances_from_server(idx)
        if usd is None:
            print(f"[{C_YELLOW}REFRESH...{C_RESET}] {C_CYAN}{name:<10}{C_RESET} -> Menyegarkan token via 2Captcha / Refresh API...")
            if rotate_tokens_instantly(idx):
                usd, trend = fetch_balances_from_server(idx)

        if usd is not None and trend is not None:
            account_balances[name] = {"pred": usd, "trend": trend}
            print(f"[{C_GREEN}AKTIF{C_RESET}     ] {C_CYAN}{name:<10}{C_RESET} | Saldo: {C_GREEN}${usd:,.2f}{C_RESET} | {C_MAGENTA}{trend:,.0f} TREND{C_RESET}")
        else:
            has_error = True
            account_balances[name] = {"pred": 0.0, "trend": 0.0}
            print(f"[{C_RED}EXPIRED{C_RESET}   ] {C_CYAN}{name:<10}{C_RESET} | Token kedaluwarsa")

    print(f"\n{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")
    if has_error:
        print(f"{C_YELLOW}Periksa token atau jalankan kembali bot setelah login tersegarkan.{C_RESET}")
        time.sleep(2)
    else:
        print(f"{C_GREEN}Seluruh akun terverifikasi aktif.{C_RESET}")
        time.sleep(1)

# ================= RUNNER MODE CRYPTO (12 ASET NEON HUD) =================
def run_crypto_mode(accounts):
    threading.Thread(target=background_sync_worker, daemon=True).start()
    threading.Thread(target=background_history_worker, daemon=True).start()

    for idx, acc in enumerate(accounts):
        name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
        threading.Thread(target=account_maintenance_worker, args=(idx, name), daemon=True).start()
        for asset, tfs in ASSET_TIMEFRAME_MAP.items():
            for tf in tfs:
                threading.Thread(target=account_asset_bet_worker, args=(idx, name, asset, tf), daemon=True).start()

    while is_running:
        clear_termux()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"{C_MAGENTA}========================================================================================{C_RESET}")
        print(f"{C_CYAN}TRENDBTC SNIPER [CRYPTO MODE] // 12 ASET (5M, 15M, 1H SNIPER > 60S STAGGERED){C_RESET}")
        print(f"{C_YELLOW}🕒 Waktu Live: {now_str}{C_RESET}")
        print(f"{C_MAGENTA}========================================================================================{C_RESET}")

        with data_lock:
            print(f"{C_YELLOW}PASAR LIVE & STATUS RONDE:{C_RESET}")
            for asset in SUPPORTED_ASSETS:
                p_live = global_live_prices.get(asset, 0.0)
                if asset in ["DOGE"]:
                    fmt_price = f"${p_live:,.5f}"
                elif asset in ["XRP", "TRUMP", "ENA", "SUI"]:
                    fmt_price = f"${p_live:,.4f}"
                else:
                    fmt_price = f"${p_live:,.2f}"

                for tf in ASSET_TIMEFRAME_MAP.get(asset, []):
                    d = shared_market_data.get(asset, {}).get(tf, {})
                    st_p = d.get("round_start_price", 0.0)
                    diff = (p_live - st_p) if (p_live > 0 and st_p > 0) else 0.0
                    t_lock = d.get("waktu_target_lock")
                    cd_str = format_countdown_live(t_lock)

                    if asset in ["DOGE"]:
                        diff_str = f"{diff:+,.5f}"
                        st_str = f"${st_p:,.5f}"
                    elif asset in ["XRP", "TRUMP", "ENA", "SUI"]:
                        diff_str = f"{diff:+,.4f}"
                        st_str = f"${st_p:,.4f}"
                    else:
                        diff_str = f"{diff:+,.2f}"
                        st_str = f"${st_p:,.2f}"

                    if diff > 0:
                        diff_col = C_GREEN
                        diff_sym = "▲"
                    elif diff < 0:
                        diff_col = C_RED
                        diff_sym = "▼"
                    else:
                        diff_col = C_YELLOW
                        diff_sym = "―"

                    neon_live_label  = f"{C_CYAN}Live:{C_RESET}"
                    neon_start_label = f"{C_MAGENTA}Start:{C_RESET}"
                    neon_diff_label  = f"{C_CYAN}Diff:{C_RESET}"

                    if asset == "BTC" and tf == "1m":
                        b_top = d.get("band_top", 0.0)
                        b_low = d.get("band_low", 0.0)
                        b_top_s = f"${b_top:,.2f}" if b_top > 0 else "CALC..."
                        b_low_s = f"${b_low:,.2f}" if b_low > 0 else "CALC..."
                        stat_badge = f"{C_GREEN}BREAKOUT{C_RESET}" if (b_top > 0 and (p_live > b_top or p_live < b_low)) else f"{C_MAGENTA}INSIDE{C_RESET}"
                        print(f"  {C_BLUE}>{C_RESET} {C_YELLOW}{asset:<5} {tf.upper():<3}{C_RESET} | {neon_live_label} {C_GREEN}{fmt_price:<10}{C_RESET} | {neon_start_label} {C_YELLOW}{st_str:<10}{C_RESET} | {C_MAGENTA}Top:{C_RESET} {C_CYAN}{b_top_s:<10}{C_RESET} | {C_MAGENTA}Low:{C_RESET} {C_CYAN}{b_low_s:<10}{C_RESET} | Status: {stat_badge} | {C_CYAN}⏱️ Sisa:{C_RESET} {C_GREEN}{cd_str}{C_RESET}")
                    else:
                        print(f"  {C_BLUE}>{C_RESET} {C_YELLOW}{asset:<5} {tf.upper():<3}{C_RESET} | {neon_live_label} {C_GREEN}{fmt_price:<10}{C_RESET} | {neon_start_label} {C_YELLOW}{st_str:<10}{C_RESET} | {neon_diff_label} {diff_col}{diff_sym} {diff_str:<10}{C_RESET} | {C_CYAN}⏱️ Sisa:{C_RESET} {C_GREEN}{cd_str:<8}{C_RESET}")

            print(f"{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")
            print(f"{C_YELLOW}STATUS AKUN & LIVE SNIPER:{C_RESET}")
            for idx, acc in enumerate(accounts):
                name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
                b = account_balances.get(name, {})
                print(f"{C_CYAN} * {name:<8}{C_RESET} | Saldo: {C_GREEN}${b.get('pred', 0.0):,.2f}{C_RESET} | {C_MAGENTA}{b.get('trend', 0.0):,.0f} TREND{C_RESET}")
                for asset in SUPPORTED_ASSETS:
                    for tf in ASSET_TIMEFRAME_MAP.get(asset, []):
                        st_k = f"{name}_{asset}_{tf}"
                        if st_k in account_states:
                            print(f"      {C_BLUE}>{C_RESET} {C_YELLOW}{asset:<5} {tf.upper():<3}:{C_RESET} {account_states[st_k]}")

            print(f"{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")
            print(f"{C_YELLOW}RIWAYAT PREDIKSI WEBSITE (TERBARU):{C_RESET}")
            if shared_api_prediction_history:
                for h in shared_api_prediction_history:
                    print(f"   * {C_CYAN}{h['account']:<8}{C_RESET} | Ronde: {C_YELLOW}{h['short_r_id']:<8}{C_RESET} | {h['direction_str']} | Bet: {C_YELLOW}${h['stake']:,.0f}{C_RESET} | Pay: {C_GREEN}${h['payout']:,.1f}{C_RESET} | Hasil: {h['hasil_str']}")
            else:
                print(f"   {C_CYAN}Menyinkronkan riwayat resmi...{C_RESET}")

            print(f"{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")
            print(f"{C_YELLOW}LOG EKSEKUSI PARALEL:{C_RESET}")
            if shared_bet_history:
                for log_item in shared_bet_history[-4:]:
                    print(f" {log_item}")
            else:
                print(f" {C_YELLOW}(Belum ada aktivitas transaksi){C_RESET}")
        time.sleep(1)

# ================= RUNNER MODE SPORTS =================
def run_sports_mode(accounts):
    threading.Thread(target=sports_sync_worker, daemon=True).start()
    threading.Thread(target=sports_history_worker, daemon=True).start()
    threading.Thread(target=auto_sports_lowest_percentage_worker, daemon=True).start()

    for idx, acc in enumerate(accounts):
        name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
        threading.Thread(target=account_maintenance_worker, args=(idx, name), daemon=True).start()

    while is_running:
        clear_termux()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"{C_MAGENTA}========================================================================================{C_RESET}")
        print(f"{C_CYAN}TRENDBTC SPORTS [AUTO-SNIPER UNDERDOG $1] // MATCH CARD MONITOR{C_RESET}")
        print(f"{C_YELLOW}🕒 Waktu Live: {now_str}{C_RESET}")
        print(f"{C_MAGENTA}========================================================================================{C_RESET}")

        with data_lock:
            print(f"{C_YELLOW}SALDO AKUN:{C_RESET}")
            for idx, acc in enumerate(accounts):
                name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
                b = account_balances.get(name, {})
                print(f"  * {C_CYAN}{name:<8}{C_RESET} | Saldo: {C_GREEN}${b.get('pred', 0.0):,.2f}{C_RESET} | {C_MAGENTA}{b.get('trend', 0.0):,.0f} TREND{C_RESET}")

            print(f"\n{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")
            print(f"{C_YELLOW}PERTANDINGAN AKTIF // KARTU SUB-MARKET (TIM 1 · DRAW · TIM 2):{C_RESET}")
            if shared_sports_fixtures:
                for fix in shared_sports_fixtures[:3]:
                    time_left = format_countdown_live(fix.get("target_dt"))
                    print(f"\n{C_MAGENTA}╔═══════════════════════════════════════════════════════════════════════════════════════{C_RESET}")
                    print(f"⚽ {C_YELLOW}[{fix.get('league')}]{C_RESET} {C_CYAN}{fix.get('title')}{C_RESET} | {C_YELLOW}⏱️ Locks in: {C_GREEN}{time_left}{C_RESET}")
                    print(f"{C_MAGENTA}╠═══════════════════════════════════════════════════════════════════════════════════════{C_RESET}")

                    for m in fix.get("sub_markets", []):
                        sub_name = m.get("sub_type", "Option")
                        p0 = m.get("p0", 0)
                        p1 = m.get("p1", 0)
                        pct0 = m.get("pct0", 50.0)
                        pct1 = m.get("pct1", 50.0)

                        b_name = m.get("best_name", "Yes")
                        b_pct = m.get("best_pct", 50.0)
                        b_pool = m.get("best_pool", 0)
                        b_dir = m.get("best_dir", "UP")

                        print(f"  ► {C_YELLOW}{sub_name}{C_RESET}")
                        print(f"    Yes {pct0:.0f}% (${p0:,.0f} pool)  |  No {pct1:.0f}% (${p1:,.0f} pool)")
                        print(f"    🎯 {C_GREEN}AUTO-PICK $1:{C_RESET} {C_MAGENTA}[{b_name} {b_pct:.0f}% (${b_pool:,.0f} pool)]{C_RESET} ➔ Direction: {C_YELLOW}{b_dir}{C_RESET}\n")
                    print(f"{C_MAGENTA}╚═══════════════════════════════════════════════════════════════════════════════════════{C_RESET}")
            else:
                print(f"  {C_CYAN}Menyinkronkan pertandingan olahraga dari TrendBTC API...{C_RESET}")

            print(f"\n{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")
            print(f"{C_YELLOW}LOG OTOMASI TIKET SPORTS ($1 PERSENTASE TERKECIL):{C_RESET}")
            if shared_sports_bet_history:
                for item in shared_sports_bet_history[-4:]:
                    print(f"  {item}")
            else:
                print(f"  {C_YELLOW}(Sedang menganalisis pilihan pool terendah...){C_RESET}")

            print(f"\n{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")
            print(f"{C_YELLOW}RIWAYAT PREDIKSI SPORTS RESMI (EVENT-MARKETS/MY):{C_RESET}")
            if shared_sports_my_predictions:
                for p in shared_sports_my_predictions[:5]:
                    acc_n = p.get("account_name", "Akun")
                    r_id = str(p.get("roundId") or "")
                    m_info = shared_sports_markets_map.get(r_id, {})
                    ev_title = m_info.get("question") or m_info.get("eventTitle") or f"Ronde ..{r_id[-6:]}"

                    outs = m_info.get("outcomes", ["Yes", "No"])
                    direction = str(p.get("direction", "")).upper()
                    if direction == "UP" and len(outs) > 0:
                        choice_display = outs[0]
                    elif direction == "DOWN" and len(outs) > 1:
                        choice_display = outs[1]
                    else:
                        choice_display = direction

                    amount = float(p.get("stakeAmount") or p.get("amount") or 0.0)
                    st = str(p.get("status", "ACCEPTED")).upper()
                    res_val = str(p.get("result", "")).upper() if p.get("result") else ""
                    st_col = C_GREEN if res_val == "WON" else C_RED if res_val == "LOST" else C_YELLOW
                    badge_status = f"{st_col}{res_val if res_val else st}{C_RESET}"

                    print(f"  * {C_CYAN}{acc_n:<8}{C_RESET} | {ev_title[:28]:<28} | Opsi: {C_MAGENTA}{choice_display:<6}{C_RESET} | Bet: ${amount:,.0f} | {badge_status}")
            else:
                print(f"  {C_YELLOW}(Belum ada tiket tersimpan di server){C_RESET}")

            print(f"\n{C_MAGENTA}========================================================================================{C_RESET}")
            print(f"{C_YELLOW}Tekan [CTRL + C] untuk keluar.{C_RESET}")

        time.sleep(1)

# ================= RUNNER MODE SURVIVOR =================
def run_survivor_mode(accounts):
    threading.Thread(target=background_sync_worker, daemon=True).start()
    threading.Thread(target=survivor_sync_worker, daemon=True).start()

    for idx, acc in enumerate(accounts):
        name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
        threading.Thread(target=account_maintenance_worker, args=(idx, name), daemon=True).start()
        threading.Thread(target=survivor_account_worker, args=(idx, name), daemon=True).start()

    while is_running:
        clear_termux()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        with data_lock:
            sg = shared_survivor_global
            cur_rnd = sg.get("current_round", 0)
            is_active = sg.get("is_active", False) or (cur_rnd > 0)
            st_doors = f"{C_GREEN}Doors are open{C_RESET}" if sg["doors_open"] else f"{C_RED}Closed (Tournament Active){C_RESET}"
            starts_cd = format_countdown_live(sg["starts_at"]) if sg["starts_at"] else "N/A"
            starts_lbl = sg.get("starts_label", "at 19.00 your time")

            btc_p = global_live_prices.get("BTC", 0.0)
            diff_btc = btc_p - sg["round_start_price"] if (btc_p > 0 and sg["round_start_price"] > 0) else 0.0

            if diff_btc > 0:
                diff_col = C_GREEN
                diff_sym = "▲"
            elif diff_btc < 0:
                diff_col = C_RED
                diff_sym = "▼"
            else:
                diff_col = C_YELLOW
                diff_sym = "―"

            r_lock = sg.get("lock_time")
            if r_lock and is_active:
                now_utc = datetime.now(timezone.utc)
                diff_sec = int((r_lock - now_utc).total_seconds())
                if diff_sec > 0:
                    m, s = divmod(diff_sec, 60)
                    pick_closes_str = f"{m:02d}:{s:02d}"
                else:
                    pick_closes_str = "00:00 (LOCKED)"
            else:
                pick_closes_str = "--:--"

            still_standing_str = f"{sg['still_standing']:,}" if (sg["still_standing"] is not None and is_active) else "—"

            print(f"{C_MAGENTA}╔═══════════════════════════════════════════════════════════════════════════════════════{C_RESET}")
            if is_active and cur_rnd > 0:
                print(f"💀 {C_RED}SURVIVOR · BTC 5M{C_RESET} | {C_CYAN}Round {cur_rnd} of 8{C_RESET} | {C_YELLOW}🕒 {now_str}{C_RESET}")
                print(f"   {C_YELLOW}Call the next 5-minute BTC candle. Wrong call — or no call — and you are out.{C_RESET}")
                print(f"{C_MAGENTA}╠═══════════════════════════════════════════════════════════════════════════════════════{C_RESET}")
                print(f"  ⏱️  {C_YELLOW}PICK CLOSES IN :{C_RESET} {C_RED}{pick_closes_str}{C_RESET} (Sniping > 60s sebelum lock)")
            else:
                print(f"🏆 {C_CYAN}DAILY ELIMINATION // SURVIVOR · BTC 5M{C_RESET} | {C_YELLOW}🕒 {now_str}{C_RESET}")
                print(f"   {st_doors} — {C_YELLOW}One pick per round. Wrong call — or no call — and you are out.{C_RESET}")
                print(f"{C_MAGENTA}╠═══════════════════════════════════════════════════════════════════════════════════════{C_RESET}")
                print(f"  ⏱️  {C_YELLOW}Starts in      :{C_RESET} {C_GREEN}{starts_cd}{C_RESET} {C_CYAN}{starts_lbl}{C_RESET}")

            print(f"  📈 {C_CYAN}Live:{C_RESET} {C_GREEN}${btc_p:,.2f}{C_RESET} | {C_MAGENTA}Start:{C_RESET} {C_YELLOW}${sg['round_start_price']:,.2f}{C_RESET} | {C_CYAN}Diff:{C_RESET} {diff_col}{diff_sym} {diff_btc:+,.2f} vs start{C_RESET}")
            print(f"  💰 {C_YELLOW}Prize pool     :{C_RESET} {C_MAGENTA}{sg['prize_pool']}{C_RESET}")
            print(f"  👥 {C_YELLOW}Entered        :{C_RESET} {C_CYAN}{sg['entered']:,}{C_RESET} peserta | {C_YELLOW}Still standing :{C_RESET} {C_GREEN}{still_standing_str}{C_RESET}")
            print(f"  🎯 {C_YELLOW}Sniper Timing  :{C_RESET} {C_GREEN}Detik ke-75 (Akun 1) & Detik ke-90 (Akun 2){C_RESET}")
            print(f"{C_MAGENTA}╚═══════════════════════════════════════════════════════════════════════════════════════{C_RESET}")

            print(f"\n{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")
            print(f"{C_YELLOW}YOUR RUN // STATUS AKUN PESERTA (PROGRES LINTASAN 8 RONDE):{C_RESET}")
            for idx, acc in enumerate(accounts):
                name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
                b = account_balances.get(name, {})
                sa = shared_survivor_accounts.get(name, {})

                has_joined = sa.get("joined", True)
                still_in = sa.get("still_in", True)
                ko_round = sa.get("knocked_round")
                round_res = sa.get("round_results", {})

                acc_rounds_ui = []
                for r_num in range(1, 9):
                    r_status = round_res.get(r_num)

                    if ko_round and r_num == ko_round:
                        acc_rounds_ui.append(f"{C_RED}R{r_num}✗{C_RESET}")
                    elif ko_round and r_num > ko_round:
                        acc_rounds_ui.append(f"{C_GRAY}R{r_num}{C_RESET}")
                    elif r_status == "won" or (r_num < cur_rnd and still_in):
                        acc_rounds_ui.append(f"{C_GREEN}R{r_num}✓{C_RESET}")
                    elif r_status == "lost":
                        acc_rounds_ui.append(f"{C_RED}R{r_num}✗{C_RESET}")
                    elif r_num == cur_rnd and is_active and still_in:
                        acc_rounds_ui.append(f"{C_CYAN}▶R{r_num}◀{C_RESET}")
                    else:
                        acc_rounds_ui.append(f"{C_YELLOW}R{r_num}{C_RESET}")

                acc_track_str = " · ".join(acc_rounds_ui)

                if still_in:
                    run_badge = f"{C_GREEN}Still in{C_RESET}"
                    if is_active and cur_rnd > 0:
                        target_sec = 75 if idx == 0 else 90
                        msg_sub = f"Bertanding di Ronde {cur_rnd}. Standby sniper detik ke-{target_sec} sebelum lock."
                    else:
                        msg_sub = "You are in. Picks open the moment round 1 starts."
                elif has_joined:
                    ko_str = f" (Gugur di R{ko_round})" if ko_round else ""
                    run_badge = f"{C_RED}Knocked out{ko_str}{C_RESET}"
                    msg_sub = "Tereliminasi. Tidak dapat memilih ronde berikutnya."
                else:
                    run_badge = f"{C_YELLOW}Belum Terdaftar{C_RESET}"
                    msg_sub = "Menunggu antrean auto-join lobi."

                print(f"  * {C_CYAN}{name:<8}{C_RESET} | Saldo: {C_GREEN}${b.get('pred', 0.0):,.2f}{C_RESET} | {C_MAGENTA}{b.get('trend', 0.0):,.0f} TREND{C_RESET} | Run: {run_badge}")
                print(f"    ↳ {acc_track_str}")
                print(f"    ↳ {C_YELLOW if not still_in else C_GREEN}{msg_sub}{C_RESET}\n")

            print(f"{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")
            print(f"{C_YELLOW}LOG AKTIVITAS SURVIVOR:{C_RESET}")
            if shared_survivor_bet_history:
                for item in shared_survivor_bet_history[-4:]:
                    print(f"  {item}")
            else:
                print(f"  {C_GREEN}✓ Seluruh akun terdaftar resmi di lobi. Standby menunggu R1 ({starts_lbl}).{C_RESET}")

            print(f"\n{C_MAGENTA}========================================================================================{C_RESET}")
            print(f"{C_YELLOW}Tekan [CTRL + C] untuk keluar atau kembali ke menu.{C_RESET}")

        time.sleep(1)

# ================= RUNNER MODE BULLSEYE =================
def run_bullseye_mode(accounts):
    threading.Thread(target=background_sync_worker, daemon=True).start()
    threading.Thread(target=bullseye_sync_worker, daemon=True).start()

    for idx, acc in enumerate(accounts):
        name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
        threading.Thread(target=account_maintenance_worker, args=(idx, name), daemon=True).start()
        threading.Thread(target=bullseye_account_worker, args=(idx, name), daemon=True).start()

    while is_running:
        clear_termux()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        with data_lock:
            bg = shared_bullseye_global
            btc_p = global_live_prices.get("BTC", 0.0)

            is_active = bg["is_active"]
            st_badge = f"{C_GREEN}LIVE FLASH EVENT (BERJALAN){C_RESET}" if is_active else f"{C_YELLOW}No event running{C_RESET}"
            call_cd = format_countdown_live(bg["call_deadline"]) if bg["call_deadline"] else "--:--"
            event_cd = format_countdown_live(bg["ends_at"]) if bg["ends_at"] else "--:--"

            print(f"{C_MAGENTA}╔═══════════════════════════════════════════════════════════════════════════════════════{C_RESET}")
            print(f"🎯 {C_CYAN}CALL THE PRICE // BULLSEYE · BTC FLASH EVENT{C_RESET} | {C_YELLOW}🕒 {now_str}{C_RESET}")
            print(f"   Status: {st_badge}")
            print(f"   {C_YELLOW}Bullseye opens without warning and lasts 10 mins. When active, you have 3 mins to call!{C_RESET}")
            print(f"{C_MAGENTA}╠═══════════════════════════════════════════════════════════════════════════════════════{C_RESET}")
            print(f"  ⏱️  {C_YELLOW}Call Window Sisa  :{C_RESET} {C_GREEN if is_active else C_GRAY}{call_cd}{C_RESET} (Sniping di 20s/12s terakhir)")
            print(f"  ⏳ {C_YELLOW}Event Sisa Selesai:{C_RESET} {C_CYAN if is_active else C_GRAY}{event_cd}{C_RESET} (total durasi 10 menit)")
            print(f"  📈 {C_CYAN}Live:{C_RESET} {C_GREEN}${btc_p:,.2f}{C_RESET} | Target Benchmark")
            print(f"  💰 {C_YELLOW}Hadiah Event      :{C_RESET} {C_MAGENTA}{bg['prize_pool']}{C_RESET} | Peserta: {C_CYAN}{bg['participants']}{C_RESET}")
            print(f"  🎯 {C_YELLOW}Sniper Timing     :{C_RESET} {C_GREEN}Detik ke-20 (Akun 1) & Detik ke-12 (Akun 2){C_RESET}")
            print(f"{C_MAGENTA}╚═══════════════════════════════════════════════════════════════════════════════════════{C_RESET}")

            print(f"\n{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")
            print(f"{C_YELLOW}STATUS AKUN & AUTO-CALL BULLSEYE:{C_RESET}")
            for idx, acc in enumerate(accounts):
                name = acc.get("ACCOUNT_NAME", f"Akun_{idx+1}")
                b = account_balances.get(name, {})
                ba = shared_bullseye_accounts.get(name, {})
                target_sec = 20 if idx == 0 else 12
                st_account = ba.get("status_str", f"{C_YELLOW}STANDBY (Sniper Ready: {target_sec}s){C_RESET}")

                print(f"  * {C_CYAN}{name:<8}{C_RESET} | Saldo: {C_GREEN}${b.get('pred', 0.0):,.2f}{C_RESET} | {C_MAGENTA}{b.get('trend', 0.0):,.0f} TREND{C_RESET} | Status: {st_account}")

            print(f"\n{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")
            print(f"{C_YELLOW}LOG AKTIVITAS BULLSEYE:{C_RESET}")
            if shared_bullseye_history:
                for item in shared_bullseye_history[-4:]:
                    print(f"  {item}")
            else:
                if is_active:
                    print(f"  {C_CYAN}Event Bullseye aktif! Menunggu detik ke-20/12 sebelum jendela call ditutup...{C_RESET}")
                else:
                    print(f"  {C_YELLOW}Standby memantau event Bullseye... Bot akan otomatis menembak saat event muncul.{C_RESET}")

            print(f"\n{C_MAGENTA}========================================================================================{C_RESET}")
            print(f"{C_YELLOW}Tekan [CTRL + C] untuk keluar atau kembali ke menu.{C_RESET}")

        time.sleep(1)

# ================= MENU UTAMA =================
def select_operation_mode():
    clear_termux()
    print(f"{C_MAGENTA}========================================================================================{C_RESET}")
    print(f"{C_CYAN}TRENDBTC AUTOMATION SYSTEM // PILIH MODE OPERASI{C_RESET}")
    print(f"{C_MAGENTA}========================================================================================{C_RESET}\n")
    print(f"  {C_YELLOW}[1]{C_RESET} {C_GREEN}Market Crypto{C_RESET} (Sniper 12 Aset + Staggered Timings > 60s)")
    print(f"  {C_YELLOW}[2]{C_RESET} {C_MAGENTA}Market Sports{C_RESET} (Auto-Bet $1 Underdog + Kartu Tiga Pilihan)")
    print(f"  {C_YELLOW}[3]{C_RESET} {C_CYAN}Daily Survivor{C_RESET} (BTC 5m Elimination R1-R8 // Sniper Anti-Lock)")
    print(f"  {C_YELLOW}[4]{C_RESET} {C_YELLOW}Bullseye{C_RESET} (Call The Price // Sniper Anti-Lock Jendela 3M)\n")
    print(f"{C_MAGENTA}----------------------------------------------------------------------------------------{C_RESET}")

    choice = input(f"{C_CYAN}Pilih Mode [1 / 2 / 3 / 4]: {C_RESET}").strip()
    return choice

def main():
    global is_running
    cfg = load_config()
    accounts = cfg.get("ACCOUNTS", [])
    if not accounts:
        print(f"{C_RED}Konfigurasi config_multi.json kosong atau tidak ada akun.{C_RESET}")
        sys.exit(1)

    choice = select_operation_mode()
    initialize_all_accounts_strictly(accounts)

    if choice == "4":
        run_bullseye_mode(accounts)
    elif choice == "3":
        run_survivor_mode(accounts)
    elif choice == "2":
        run_sports_mode(accounts)
    else:
        run_crypto_mode(accounts)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        is_running = False
        print(f"\n{C_YELLOW}Bot dihentikan.{C_RESET}")
        sys.exit(0)
