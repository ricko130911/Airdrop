"""Tes offline untuk service.py: python -m unittest test_service.py (dari folder trendbtc)."""
import json
import os
import tempfile
import unittest

import bot as B
import service as S
from test_bot import T0, FakeClient, FakeVol, make_round


class Client2(FakeClient):
    def __init__(self, rounds, **kw):
        super().__init__(rounds, **kw)
        self.me_ok = True
        self.preds = []

    def me(self):
        if not self.me_ok:
            raise B.ApiError(401, "expired")
        return {"id": "u"}

    def balances(self):
        return {"usdt": 10}

    def my_predictions(self, limit=50):
        return self.preds

    def _refresh(self):
        if not self.me_ok:
            raise B.ApiError(401, "refresh gagal")


def engine(rounds, live=False, token=True, **cfg):
    d = tempfile.mkdtemp()
    c = dict(cfg, live=live)
    with open(os.path.join(d, "config.json"), "w") as f:
        json.dump(c, f)
    if token:
        with open(os.path.join(d, "tokens.json"), "w") as f:
            json.dump({"refreshToken": "r" * 20}, f)
    client = Client2(rounds)
    e = S.Engine(d, client=client, vol=FakeVol(), now_fn=lambda: T0)
    return e, client


class ConfigTest(unittest.TestCase):
    def test_validation(self):
        base = dict(S.DEFAULT_CONFIG)
        self.assertEqual(S.validate_config(base, {"durations": [900, 300]})["durations"], [300, 900])
        self.assertEqual(S.validate_config(base, {"markets": ["btc", " eth "]})["markets"], ["BTC", "ETH"])
        for bad in ({"stake": 0}, {"durations": [42]}, {"nope": 1}, {"threshold": 2}):
            with self.assertRaises(ValueError):
                S.validate_config(base, bad)


class EngineTest(unittest.TestCase):
    def test_dry_run_records_once(self):
        e, c = engine([make_round("r5", dur=300)])
        e.tick()
        e.tick()
        self.assertEqual(c.placed, [])
        bets = e.store.recent()
        self.assertEqual(len(bets), 1)
        self.assertEqual((bets[0]["mode"], bets[0]["direction"]), ("DRY", "UP"))

    def test_live_places_and_settles(self):
        e, c = engine([make_round("r5", dur=300)], live=True)
        e.tick()
        self.assertEqual(c.placed, [("r5", "UP", 1.0)])
        c.preds = [{"id": "p1", "result": "WON", "payoutAmount": 1.8}]
        e._next["settle"] = 0
        e.tick()
        b = e.store.recent()[0]
        self.assertEqual((b["result"], b["pnl"]), ("won", 0.8))
        st = e.state()
        self.assertEqual(st["today"]["LIVE"]["wins"], 1)
        self.assertEqual(st["pnl"]["LIVE"][-1]["v"], 0.8)

    def test_stop_loss_and_budget(self):
        e, c = engine([make_round(f"r{i}", dur=300) for i in range(3)], live=True, daily_stop_loss=0.5)
        e.store.add(ts=T0, day=S.utc_day(T0), round_id="old", market="BTCUSD", duration=300, direction="UP",
                    stake=1, mode="LIVE", status="placed", result="lost", pnl=-1.0)
        e.tick()
        self.assertEqual(c.placed, [])
        self.assertTrue(any("Stop-loss" in ev["msg"] for ev in e.events))

        e2, c2 = engine([make_round(f"r{i}", dur=300) for i in range(5)], live=True, daily_budget=2)
        e2.tick()
        self.assertEqual(len(c2.placed), 2)

    def test_invalid_token_falls_back_to_dry(self):
        e, c = engine([make_round("r5", dur=300)], live=True)
        c.me_ok = False
        e.tick()
        self.assertEqual(c.placed, [])
        self.assertIs(e.token["ok"], False)
        self.assertEqual(e.store.recent()[0]["mode"], "DRY")

    def test_live_requires_token(self):
        e, _ = engine([], token=False)
        with self.assertRaises(ValueError):
            e.update_config({"live": True})

    def test_dry_settlement(self):
        e, c = engine([make_round("r5", dur=300, elapsed=200)])
        e.tick()
        e.now = lambda: T0 + 200_000  # ronde sudah selesai
        c.rounds = []
        e.tick()
        b = e.store.recent()[0]
        self.assertEqual(b["result"], "won")  # harga 64100 > start 64000, arah UP
        self.assertGreater(b["pnl"], 0)


if __name__ == "__main__":
    unittest.main()
