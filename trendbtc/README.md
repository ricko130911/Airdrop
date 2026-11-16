# TrendBTC — estimator peluang ronde prediksi

Ada 2 script:
- **`bot.py`** — membaca SEMUA market & ronde langsung dari API situs (5m, 15m, 1h, opsional 1m),
  menghitung peluang + EV dengan rumus payout situs, dan (opsional, `--live`) memasang taruhan.
- **`predict.py`** — kalkulator peluang manual + backtest dengan data Binance.

## bot.py — semua market, 5m / 15m / 1h

```bash
cd trendbtc

# 1) DRY RUN (aman, tidak pasang taruhan, tidak butuh login)
python bot.py                                  # semua market, ronde 5m 15m 1h
python bot.py --durations 60 300 900 3600      # + ronde 1 menit
python bot.py --markets BTC ETH SOL            # hanya market tertentu

# 2) LIVE (taruhan sungguhan) — butuh token login, lihat di bawah
python bot.py --live --stake 1 --budget 20 --max-bets 20
```

Setiap ronde ditampilkan: harga, harga start, sisa detik ke lock & akhir, peluang tiap sisi,
sisi terbaik + **EV dalam dolar** + bonus waktu saat ini, dan aksi (BET / - / sudah bet).
Semua keputusan BET dicatat ke `bot_log.csv`.

Bot memasang taruhan hanya kalau **semua** ini terpenuhi:
- peluang sisi itu ≥ `--threshold` (default 62%)
- EV ≥ `--min-edge` × stake (default +5%), dihitung dari pool lawan × (1 − rake 5%) × porsi bobot Anda
- ronde masih `open`, lock masih > `--lock-margin` detik lagi, belum pernah bet di ronde itu
- belum melewati `--budget` (total $ per sesi) dan `--max-bets`

### Token login (hanya untuk `--live`)
Situs menyimpan token di localStorage browser. Di trendbtc.app (sudah login) buka DevTools (F12) → Console:

```js
localStorage.getItem('trendbtc_refresh_token')
```

Simpan hasilnya di file `trendbtc/.tokens.json` (file ini di-.gitignore, jangan di-commit):

```json
{"refreshToken": "TEMPEL_DI_SINI"}
```

atau pakai environment variable `TRENDBTC_REFRESH_TOKEN`. Bot otomatis minta access token baru
lewat `/api/auth/refresh` dan menyimpan refresh token baru ke file (situs merotasi token).

⚠️ **Token = akses penuh ke akun Anda** (termasuk withdraw). Jangan pernah kirim ke chat, orang lain, atau GitHub.
⚠️ Karena token dirotasi, sesi di browser bisa ter-logout saat bot jalan — login ulang saja.
⚠️ Bot otomatis kemungkinan melanggar Terms situs dan bisa membuat akun diblokir. Risiko ditanggung sendiri.
⚠️ Kalau dapat error 403, server menolak koneksi (proteksi bot). Coba dari koneksi rumah tanpa VPN.

### Hasil backtest data asli (Binance, 16 Nov 2026)
| Market | Ronde | Keputusan di | Akurasi semua | Akurasi saat yakin ≥62% |
|---|---|---|---|---|
| BTC | 5m | detik 120 | 77.5% (120 ronde) | 79.6% |
| BTC | 15m | detik 450 | 78.3% (60 ronde) | 79.6% |
| ETH | 5m | detik 120 | 76.7% (120 ronde) | 82.4% |

Akurasi tinggi ini karena keputusan diambil **setelah** sebagian ronde berjalan (harga sudah bergerak).
Di situs, bet yang telat dapat bonus waktu lebih kecil dan pemain lain juga melihat harga yang sama,
jadi untung bersih bergantung pada pool. Karena itu bot memakai **EV**, bukan sekadar akurasi.

---

## predict.py — kalkulator manual

Script ini menghitung **peluang** hasil ronde (UP/DOWN dan INSIDE/BREAKOUT) untuk BTC, ETH, SOL, XRP, DOGE, SUI, TRUMP, dll.
Datanya adalah harga live + volatilitas 10 menit terakhir dari Binance (data publik, tanpa API key).
Kalau peluangnya tidak cukup jelas, script menyarankan **SKIP**.

> ⚠️ Tidak ada script yang bisa menebak pasar dengan pasti. Gerak harga 1 menit hampir acak.
> Keunggulan script ini cuma satu: setelah ronde berjalan, harga yang sudah jauh dari harga start
> lebih mungkin selesai di sisi itu, dan script mengukur "seberapa mungkin" dengan angka.
> Script tidak memasang taruhan otomatis. Kategori SPORTS tidak didukung.

## Cara pakai

Butuh Python 3.9+ saja (tanpa `pip install`).

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
