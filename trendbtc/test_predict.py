"""Tes offline: python -m unittest test_predict.py (dijalankan dari folder trendbtc)."""
import io
import math
import random
import unittest
from contextlib import redirect_stdout
from unittest import mock

import predict as P


def simulate(price, sigma, steps, rng):
    path = [price]
    for _ in range(steps):
        path.append(path[-1] * math.exp(rng.gauss(0, sigma)))
    return path


class ModelTest(unittest.TestCase):
    def test_prob_up_matches_simulation(self):
        rng = random.Random(1)
        sigma, start, price, t = 0.0002, 100.0, 100.01, 40
        p = P.prob_up(price, start, sigma, 0.0, t)
        sims = sum(simulate(price, sigma, t, rng)[-1] > start for _ in range(20000)) / 20000
        self.assertAlmostEqual(p, sims, delta=0.015)
        self.assertGreater(p, 0.5)

    def test_inside_close_and_touch_match_simulation(self):
        rng = random.Random(2)
        sigma, price, lo, hi, t = 0.0002, 100.0, 99.85, 100.15, 60
        p_close = P.prob_inside_close(price, lo, hi, sigma, 0.0, t)
        p_touch = P.prob_inside_touch(price, lo, hi, sigma, t)
        c = s = 0
        for _ in range(20000):
            path = simulate(price, sigma, t, rng)
            c += lo <= path[-1] <= hi
            s += all(lo < x < hi for x in path)
        self.assertAlmostEqual(p_close, c / 20000, delta=0.015)
        # simulasi dicek per detik, sama seperti asumsi tick_seconds=1
        self.assertAlmostEqual(p_touch, s / 20000, delta=0.015)
        self.assertLess(p_touch, p_close)

    def test_edges(self):
        self.assertEqual(P.prob_up(101, 100, 0.001, 0, 0), 1.0)
        self.assertEqual(P.prob_inside_touch(105, 99, 101, 0.001, 30), 0.0)
        self.assertEqual(P.decide(0.55, "UP", "DOWN", 0.62, None)[0], "SKIP")
        self.assertEqual(P.decide(0.30, "UP", "DOWN", 0.62, None)[0], "DOWN")
        self.assertEqual(P.decide(0.70, "UP", "DOWN", 0.62, 1.3)[0], "SKIP")  # EV negatif
        self.assertEqual(P.decide(0.70, "UP", "DOWN", 0.62, 1.9)[0], "UP")


def fake_klines_factory(seed=3, n=20000, base_ms=1_700_000_000_000):
    rng = random.Random(seed)
    closes = simulate(64000.0, 0.00015, n, rng)
    rows = [(base_ms + i * 1000, closes[i], closes[i], closes[i], closes[i + 1]) for i in range(n)]
    end_ms = rows[-1][0] + 1000

    def fake(symbol, interval, limit=500, start_ms=None, end_ms_=None, **kw):
        end = kw.get("end_ms", end_ms_)
        sel = [r for r in rows if (start_ms is None or r[0] >= start_ms) and (end is None or r[0] <= end)]
        if interval != "1s":  # kline ronde: open = open detik pertama
            return sel[:1]
        return sel[:limit] if start_ms is not None else sel[-limit:]

    return fake, end_ms


class CommandsTest(unittest.TestCase):
    def run_cmd(self, argv):
        fake, end_ms = fake_klines_factory()
        buf = io.StringIO()
        with mock.patch.object(P, "klines", fake), \
             mock.patch.object(P, "server_time_ms", lambda: end_ms - 20_000), redirect_stdout(buf):
            P.main(argv)
        return buf.getvalue()

    def test_watch_updown(self):
        out = self.run_cmd(["watch", "--symbols", "BTC", "ETH", "--once"])
        self.assertIn("UP", out)
        self.assertIn("->", out)

    def test_watch_band(self):
        out = self.run_cmd(["watch", "--symbols", "BTC", "--band", "60", "--rule", "touch", "--once"])
        self.assertIn("INSIDE", out)

    def test_manual(self):
        self.assertIn("Saran", self.run_cmd(["updown", "--start", "64000", "--seconds-left", "30", "--mult", "1.9"]))
        self.assertIn("Saran", self.run_cmd(["band", "--lower", "63900", "--upper", "64100", "--seconds-left", "30"]))

    def test_backtest(self):
        out = self.run_cmd(["backtest", "--minutes", "200"])
        self.assertIn("Akurasi", out)
        print("\n" + out)


if __name__ == "__main__":
    unittest.main()
