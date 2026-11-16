# TrendBTC — estimator peluang ronde prediksi

Script ini menghitung **peluang** hasil ronde (UP/DOWN dan INSIDE/BREAKOUT) untuk BTC, ETH, SOL, XRP, DOGE, SUI, TRUMP, dll.
Datanya adalah harga live + volatilitas 10 menit terakhir dari Binance (data publik, tanpa API key).
Kalau peluangnya tidak cukup jelas, script menyarankan **SKIP**.

> ⚠️ Tidak ada script yang bisa menebak pasar dengan pasti. Gerak harga 1 menit hampir acak.
> Keunggulan script ini cuma satu: setelah ronde berjalan, harga yang sudah jauh dari harga start
> lebih mungkin selesai di sisi itu, dan script mengukur "seberapa mungkin" dengan angka.
> Script tidak memasang taruhan otomatis. Kategori SPORTS tidak didukung.

## Cara pakai

Butuh Python 3.8+ saja (tanpa `pip install`).

```bash
cd trendbtc

# Pantau banyak koin secara live (ronde 1 menit, mode UP/DOWN)
python predict.py watch --symbols BTC ETH SOL XRP DOGE SUI TRUMP --round 1m

# Mode INSIDE/BREAKOUT: band ±$60 dari harga start
python predict.py watch --symbols BTC --round 1m --band 60
#   --band-pct 0.05     → band ±0.05%
#   --rule touch        → BREAKOUT kalau band tersentuh kapan saja (default: close = dinilai di penutupan)

# Hitung manual dari angka di situs (paling akurat, karena feed situs bisa beda tipis dari Binance)
python predict.py updown --symbol BTC --start 64332.85 --seconds-left 19 --mult 1.9
python predict.py band   --symbol BTC --lower 64280 --upper 64390 --seconds-left 19

# Uji akurasi model di data historis
python predict.py backtest --symbol BTC --round 1m --decide-at 20 --minutes 180
```

### Opsi penting
| Opsi | Arti |
|---|---|
| `--threshold 0.62` | Peluang minimum untuk memberi saran. Di bawah ini → SKIP |
| `--mult 1.9` | Multiplier payout total per $1 (lihat di situs, "estimated from live pools"). Script lalu menghitung EV dan SKIP kalau EV ≤ 0. Break-even = 1 / mult |
| `--price` | Pakai harga dari situs, bukan dari Binance |

## Cara kerjanya
- **UP/DOWN:** `P(UP) = Φ( (ln(harga/start) + μ·t) / (σ·√t) )`. σ = volatilitas per detik dari data 1 detik, μ = momentum 60 detik yang dikecilkan, t = sisa detik.
- **INSIDE (close):** peluang harga penutupan ada di dalam band.
- **INSIDE (touch):** peluang harga tidak pernah menyentuh batas band (rumus koridor gerak Brown + koreksi karena feed dicek per detik).

## Hal yang perlu diingat
- Makin lama menunggu, makin akurat peluangnya. Tapi bonus waktu di situs makin kecil dan multiplier pool bisa turun. Bandingkan peluang dengan multiplier (`--mult`).
- Harga start di situs bisa beda beberapa dolar dari Binance. Pakai `updown --start ...` dengan angka situs kalau selisihnya kecil.
- Jalankan `backtest` dulu untuk melihat akurasi di data asli sebelum memakai uang.
- Tes offline: `python -m unittest test_predict.py`
