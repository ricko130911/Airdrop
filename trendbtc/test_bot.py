"""Tes offline untuk bot.py: python -m unittest test_bot.py (dari folder trendbtc)."""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

import bot as B

T0 = 1_763_300_000_000  # waktu "sekarang" palsu (ms)


def iso(ms):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def make_round(rid, sym="BTCUSD", dur=300, elapsed=60, lock_before_end=60, start=64000.0, hw=None,
               up=100.0, down=100.0, upw=100.0, downw=100.0, status="open"):
    start_ms = T0 - elapsed * 1000
    end_ms = start_ms + dur * 1000
    return {"id": rid, "marketSymbol": sym, "durationSeconds": dur, "status": status,
            "startTime": iso(start_ms), "lockTime": iso(end_ms - lock_before_end * 1000), "endTime": iso(end_ms),
            "startPrice": start, "corridorHalfWidth": hw, "upPool": up, "downPool": down,
            "upWeight": upw, "downWeight": downw}


class PayoutTest(unittest.TestCase):
    rules = dict(B.DEFAULT_RULES)

    def test_time_multiplier_linear(self):
        r = make_round("r", dur=300, elapsed=0, lock_before_end=60)
        self.assertAlmostEqual(B.time_multiplier(r, self.rules, T0), 1.5)
        self.assertAlmostEqual(B.time_multiplier(r, self.rules, T0 + 120_000), 0.9)  # tengah jalan ke lock
        self.assertAlmostEqual(B.time_multiplier(r, self.rules, T0 + 999_000), 0.3)

    def test_payout_matches_site_formula(self):
        # stake 10 di awal (x1.5 -> weight 15), sisi UP weight 100, pool DOWN 200, rake 5%
        r = make_round("r", elapsed=0, down=200, upw=100)
        pay, mult = B.payout_if_win(10, "UP", r, self.rules, T0)
        self.assertEqual(mult, 1.5)
        self.assertAlmostEqual(pay, round(10 + 200 * 0.95 * 15 / 115, 2))
        # INSIDE memakai sisi "up" seperti di situs
        self.assertEqual(B.payout_if_win(10, "INSIDE", r, self.rules, T0), (pay, mult))

    def test_evaluate_corridor(self):
        r = make_round("r", hw=50.0)
        res = B.evaluate(r, 64000.0, 0.0001, 0.0, self.rules, 1, T0)
        self.assertEqual({x[0] for x in res}, {"INSIDE", "BREAKOUT"})
        self.assertAlmostEqual(sum(x[1] for x in res), 1.0)


class FakeClient:
    def __init__(self, rounds, price=64100.0):
        self.rounds, self._price, self.placed = rounds, price, []

    def rules(self):
        return dict(B.DEFAULT_RULES)

    def current_rounds(self):
        return self.rounds

    def price(self, sym):
        return self._price

    def my_active_round_ids(self):
        return {"already"}

    def place(self, rid, d, stake):
        self.placed.append((rid, d, stake))
        return {"id": "p1"}


class FakeVol:
    def get(self, sym, horizon):
        return 0.00005, 0.0


class RunTest(unittest.TestCase):
    def run_bot(self, args, client):
        tmp = tempfile.mkdtemp()
        tok = os.path.join(tmp, "t.json")
        with open(tok, "w") as f:
            json.dump({"refreshToken": "x"}, f)
        a = B.build_parser().parse_args(args + ["--once", "--log", os.path.join(tmp, "log.csv"),
                                                "--token-file", tok])
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = B.run(a, client=client, vol=FakeVol(), now_fn=lambda: T0)
        return code, buf.getvalue()

    def rounds(self):
        return [make_round("r5", dur=300),            # harga +100 di atas start -> UP kuat
                make_round("r15", dur=900, start=64100.0),  # harga = start -> 50/50 -> tidak bet
                make_round("r1h", dur=3600, status="locked"),
                make_round("r1m", dur=60),           # tidak termasuk durasi default
                make_round("already", dur=3600, elapsed=600)]

    def test_dry_run_does_not_place(self):
        c = FakeClient(self.rounds())
        code, out = self.run_bot([], c)
        self.assertEqual(code, 0)
        self.assertEqual(c.placed, [])
        self.assertIn("BET UP $1.0 (dry-run)", out)
        self.assertNotIn("r1m", out)

    def test_live_places_only_good_rounds(self):
        c = FakeClient(self.rounds())
        code, out = self.run_bot(["--live"], c)
        self.assertEqual(c.placed, [("r5", "UP", 1.0)])
        self.assertIn("sudah bet", out)

    def test_budget_limit(self):
        c = FakeClient([make_round(f"r{i}", dur=300) for i in range(5)])
        self.run_bot(["--live", "--budget", "2"], c)
        self.assertEqual(len(c.placed), 2)


class ClientRefreshTest(unittest.TestCase):
    def test_401_refreshes_and_saves_rotated_token(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "t.json")
        with open(path, "w") as f:
            json.dump({"accessToken": "old", "refreshToken": "r1"}, f)
        calls = []

        def fake_http(method, url, body=None, headers=None):
            calls.append((method, url, body, (headers or {}).get("Authorization")))
            if url.endswith("/api/auth/refresh"):
                return 200, {"accessToken": "new", "refreshToken": "r2"}
            if (headers or {}).get("Authorization") == "Bearer old":
                return 401, {"error": {"message": "expired"}}
            return 201, {"prediction": {"id": "p9"}}

        with mock.patch.object(B, "http", fake_http):
            c = B.Client(B.TokenStore(path), base="https://x")
            self.assertEqual(c.place("rid", "UP", 2), {"id": "p9"})
        body = calls[-1][2]
        self.assertEqual((body["roundId"], body["direction"], body["stakeAmount"]), ("rid", "UP", 2))
        self.assertTrue(body["idempotencyKey"])
        with open(path) as f:
            self.assertEqual(json.load(f), {"accessToken": "new", "refreshToken": "r2"})
        self.assertEqual(oct(os.stat(path).st_mode & 0o777), "0o600")


if __name__ == "__main__":
    unittest.main()
