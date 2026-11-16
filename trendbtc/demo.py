"""Data palsu untuk mencoba dashboard (python3 service.py --demo). Tidak menghubungi internet."""
import math
import random
import threading
import time
from datetime import datetime, timezone

MARKETS = {"BTCUSD": 64300.0, "ETHUSD": 3120.0, "SOLUSD": 142.0, "XRPUSD": 0.62,
           "DOGEUSD": 0.161, "SUIUSD": 1.84, "TRUMPUSD": 8.9}
VOL = 0.00012  # per detik


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


class DemoClient:
    def __init__(self, seed=7):
        self.rng = random.Random(seed)
        self.lock = threading.Lock()
        t0 = int(time.time()) - 4000
        self.paths = {m: {t0: p} for m, p in MARKETS.items()}
        self.last = {m: t0 for m in MARKETS}
        self.preds = {}

    def _px(self, m, sec):
        with self.lock:
            while self.last[m] < sec:
                prev = self.paths[m][self.last[m]]
                self.last[m] += 1
                self.paths[m][self.last[m]] = prev * math.exp(self.rng.gauss(0, VOL))
            return self.paths[m].get(sec) or self.paths[m][min(self.paths[m], key=lambda k: abs(k - sec))]

    def rules(self):
        return {"rakeRate": 0.05, "earlyMultiplierMin": 0.3, "earlyMultiplierMax": 1.5}

    def current_rounds(self):
        now = int(time.time())
        out = []
        for m in MARKETS:
            for dur in (60, 300, 900, 3600):
                start = now - now % dur
                end = start + dur
                rr = random.Random(hash((m, dur, start)) & 0xFFFFFFFF)
                corridor = None
                if dur in (60, 900) and m in ("BTCUSD", "ETHUSD"):
                    corridor = round(self._px(m, start) * 0.0008 * math.sqrt(dur / 60), 4)
                out.append({"id": f"{m}-{dur}-{start}", "marketSymbol": m, "durationSeconds": dur, "status": "open",
                            "startTime": iso(start * 1000), "lockTime": iso((end - dur // 4) * 1000),
                            "endTime": iso(end * 1000), "startPrice": round(self._px(m, start), 6),
                            "corridorHalfWidth": corridor,
                            "upPool": rr.uniform(20, 900), "downPool": rr.uniform(20, 900),
                            "upWeight": rr.uniform(20, 900), "downWeight": rr.uniform(20, 900),
                            "participants": rr.randint(2, 80)})
        return out

    def price(self, m):
        return round(self._px(m, int(time.time())), 6)

    def place(self, round_id, direction, stake):
        pid = f"demo-{len(self.preds) + 1}"
        m, dur, start = round_id.rsplit("-", 2)
        self.preds[pid] = {"id": pid, "m": m, "dur": int(dur), "start": int(start), "dir": direction,
                           "stake": stake, "rid": round_id}
        return {"id": pid}

    def my_predictions(self, limit=50):
        now = int(time.time())
        out = []
        for p in self.preds.values():
            end = p["start"] + p["dur"]
            if now < end:
                out.append({"id": p["id"], "result": "pending"})
                continue
            s0, s1 = self._px(p["m"], p["start"]), self._px(p["m"], end)
            won = (s1 > s0) == (p["dir"] in ("UP", "INSIDE"))
            out.append({"id": p["id"], "result": "won" if won else "lost",
                        "payoutAmount": round(p["stake"] * 1.85, 2) if won else 0})
        return out

    def balances(self):
        return {"usdt": 1926.69, "trend": 12450}


class DemoVol:
    def get(self, sym, horizon):
        return VOL, 0.0
