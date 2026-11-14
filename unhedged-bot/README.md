# Bot Unhedged: Market Up/Down 5 Menit (BTC, ETH, SOL, CC)

Bot trading otomatis untuk market prediksi **"naik atau turun dalam 5 menit"** di
[Unhedged](https://unhedged.gg), memakai API resmi (`https://api.unhedged.gg`).

> ⚠️ **Peringatan risiko.** Ini adalah trading/taruhan dengan uang sungguhan. Tidak ada
> strategi yang menjamin untung, dan market 5 menit sangat dekat dengan acak. Bot ini
> berjalan dalam **mode simulasi (DRY_RUN) secara default**. Uji dulu berhari-hari,
> pakai nominal kecil, dan jangan pernah memakai uang yang tidak siap hilang.

## Strategi default: SNIPER akhir round

Simulasi 610 trade dengan strategi lama (menebak arah 1–3 menit sebelum tutup) **rugi 13.7%**:
order yang terisi justru yang salah, karena trader lain lebih cepat (*adverse selection*), ditambah fee 5%.
Karena itu strategi default sekarang adalah **sniper**:

1. **Hanya menembak di detik-detik terakhir** (default sisa 45 sampai 4 detik). Pada saat itu sebagian
   besar rata-rata 60 detik sudah pasti dari data per detik Binance/Bybit.
2. **Hanya bila hampir pasti:** peluang menang ≥ `SNIPE_MIN_PROB` (97%). Bot memakai peluang yang
   paling konservatif antara model mentah dan model terkalibrasi.
3. **Data harus lengkap:** setiap detik yang sudah lewat di jendela rata-rata harus sudah ada datanya.
   Kalau data tertinggal, bot tidak menembak.
4. **Hanya membeli dari penjual yang sudah ada (taker):** tidak memasang order yang menunggu, dan
   order yang tidak langsung terisi dibatalkan, tidak dikejar.
5. **Hanya bila masih untung setelah fee:** `peluang − harga − fee ≥ SNIPE_MIN_EV` (1.5 sen/kontrak),
   dengan harga beli maksimum `SNIPE_MAX_PRICE` (0.95).
6. **Modal kecil dan tetap per tembakan** (`SNIPE_USD`, default $3), dengan pemeriksaan setiap 1 detik
   selama jendela tembak.
7. **Rem harian:** setelah kalah `SNIPE_MAX_LOSSES_PER_DAY` kali (default 2), sniper berhenti sampai
   besok (UTC). Opsional: berhenti setelah untung harian mencapai `DAILY_PROFIT_TARGET_USD`.

> **Risiko yang harus dipahami:** sniper membeli di harga tinggi (misalnya 0.90). Satu kemenangan
> hanya untung sekitar $0.15–0.30, sedangkan satu kekalahan bisa rugi sekitar $2.80. Sniper hanya
> menguntungkan bila akurasinya sangat tinggi (di atas sekitar 95%). Uji di simulasi dulu, lalu lihat
> baris **sniper** di `node src/index.js analyze`.

Strategi lama tetap tersedia dengan `STRATEGY=model`.

## Cara kerja ("pintar"-nya di mana?)

### Aturan resolusi Unhedged (dari data market asli)

> UP menang bila **rata-rata 60 harga penutupan per detik** sebelum market tutup
> **≥ rata-rata 60 detik sebelum window dimulai** (harga acuan). Sumber: candle 1 detik
> Binance (`BTCUSDT`, `ETHUSDT`, `SOLUSDT`); sumber CC dibaca dari data market-nya.
> Harga sama persis dihitung **UP**.

1. **Mencari market.** Setiap 30 detik bot membaca `/api/v1/feed` dan memilih market aktif
   `... Up or Down - 5 Min` untuk BTC/ETH/SOL/CC. Market 15 menit dan 1 jam diabaikan.
2. **Membaca data resmi market:** sumber harga resolusi (`autoResolution.resolverConfig`),
   **harga acuan resmi** (`priceReferences.start`), fee (`feeSchedule`), dan harga teratas
   order book (`orderBookStats`). Data ini diperbarui setiap tick selama window trading.
3. **Mengambil harga dari sumber yang sama dengan Unhedged** (Binance candle 1 detik untuk
   BTC/ETH/SOL). Venue lain yang didukung: MEXC, Bybit, OKX, Gate, KuCoin.
4. **Menghitung peluang UP dengan model rata-rata (TWAP):**

   ```
   rata²_akhir = (jumlah harga yang sudah terjadi + jumlah harga yang akan datang) / 60
   P(UP) = Φ( (E[rata²_akhir] − harga_acuan) / SD[rata²_akhir] )
   ```

   - Dalam 60 detik terakhir, sebagian harga sudah **pasti** (diambil dari candle 1 detik),
     jadi ketidakpastian menyusut cepat. Ini sumber utama edge.
   - Harga mendatang dimodelkan sebagai random walk: varians rata-rata m detik yang dimulai
     τ detik lagi ≈ σ²·(τ + (m+1)(2m+1)/(6m)).
   - `σ` = volatilitas dari candle 1 menit (EWMA), dikali `SIGMA_MULTIPLIER` agar hati-hati.
5. **Hanya trading bila ada edge setelah fee.** Harga BID maksimum dipilih agar
   `peluang − harga − fee ≥ MIN_EDGE`. Fee dihitung konservatif: tarif taker × harga
   (tier 0 = 5%). Bila ada penjual di harga itu atau lebih murah, order langsung terisi.
6. **Ukuran posisi memakai Kelly fraksional** (default ¼ Kelly), dibatasi `MAX_ORDER_USD`
   dan `MAX_OPEN_EXPOSURE_USD`.
7. **Order dinamis dengan histeresis.** Harga order disesuaikan saat peluang bergeser.
   Untuk pindah ke sisi lawan, model harus lebih yakin sebesar `HYSTERESIS`, supaya bot
   tidak bolak-balik karena noise. Semua order dibatalkan `STOP_SECONDS_LEFT` detik sebelum tutup.
8. **Satu posisi per market.** Begitu order terisi, bot menahan posisi sampai selesai dan
   tidak akan membeli sisi lawan.
9. **Deteksi arbitrase complete set.** Bila ask UP + ask DOWN (setelah fee) < $1, bot
   mencatat **PELUANG ARBITRASE** di log dan dashboard (karena 1 UP + 1 DOWN ditukar $1
   lewat autoBurn). Saat ini hanya dideteksi, tidak dieksekusi otomatis.
10. **Rem darurat.** Bila rugi hari ini mencapai `MAX_DAILY_LOSS_USD`, bot berhenti trading.
11. **Simulasi realistis & evaluasi diri.** Di mode DRY_RUN, order baru dianggap terisi bila
    order book Unhedged benar-benar punya ask ≤ harga order. PnL simulasi sudah dikurangi fee.
    Hasil resmi dari Unhedged dipakai untuk menghitung akurasi dan **Brier score**
    (`logs/decisions.jsonl`).

Market tipe **PARIMUTUEL** (taruhan pool) juga didukung: bot menghitung payout dari ukuran
pool dan hanya bertaruh bila expected value ≥ `MIN_EDGE`.

## Bot belajar dari hasilnya sendiri

Setiap market yang selesai dicatat ke `logs/decisions.jsonl`, termasuk **detail saat order terisi**
(sisa detik, peluang model, harga ask, edge setelah fee). Dari data itu bot belajar dua hal:

1. **Kalibrasi peluang.** Di sisa 150, 90, 45, dan 20 detik, bot mencatat peluang mentah model
   untuk *setiap* market, baik yang ditradingkan maupun tidak. Setelah ada ≥ `CALIBRATION_MIN_SAMPLES`
   market, bot menghitung faktor koreksi **k** per titik waktu:
   - **k < 1**: model terlalu yakin, jadi peluang ditarik ke arah 50%.
   - **k > 1**: model kurang yakin, jadi peluang dipertegas.

   Keputusan trading memakai peluang yang sudah dikoreksi.
2. **Zona rugi.** Trade dikelompokkan menurut sisa waktu saat terisi (0-30s, 30-60s, ...) dan menurut
   aset. Zona yang 60 trade terakhirnya **rugi secara konsisten** (minimal `ADAPTIVE_MIN_TRADES` trade)
   otomatis diblokir. Di zona itu bot hanya mengirim order **probe 1 kontrak**, dan zona dibuka lagi
   bila hasilnya membaik.

Riwayat dimuat ulang saat bot dijalankan, jadi statistik dan pembelajaran **tidak hilang saat restart**.

Lihat hasilnya di panel **Pembelajaran Bot** pada dashboard, atau di terminal:

```bash
node src/index.js analyze
```

Contoh keluaran:

```
== Menurut sisa waktu saat order terisi ==
zona      trade   menang    impas        PnL      ROI
0-30s        12    91.7%    57.4%    +$28.34    59.5%
60-90s       39    56.4%    59.2%    -$10.95    -7.3%  DIBLOKIR
```

Kolom **menang** harus di atas **impas** (harga beli rata-rata + fee) agar untung.

> Catatan: pembelajaran butuh data. Dengan sedikit trade, hasil per zona masih sangat dipengaruhi
> keberuntungan; karena itu ada batas minimal sampel sebelum kalibrasi aktif atau zona diblokir.
> Set `ADAPTIVE=false` untuk mematikan semua penyesuaian otomatis.

## Kebutuhan

- **Node.js 20+** (tidak butuh `npm install`, tanpa dependensi eksternal)
- Akun Unhedged + API key (hanya untuk mode live / perintah `status`)

## Instalasi & penggunaan

```bash
cd unhedged-bot
cp .env.example .env        # lalu edit .env

# 1) Cek market apa saja yang terdeteksi (tidak butuh API key)
npm run discover
node src/index.js discover --raw   # tampilkan JSON mentah market untuk diperiksa

# 2) Jalankan simulasi (DRY_RUN=true): tidak ada order sungguhan
npm start

# Cek koneksi ke sumber harga resmi (Binance & Bybit) dari server ini
node src/index.js check

# Analisis hasil: untung/rugi per zona waktu & aset, kalibrasi model
node src/index.js analyze

# 3) Cek saldo, order, dan posisi (butuh API key)
npm run status

# 4) Tes unit
npm test
```

Untuk **live trading**, isi `UNHEDGED_API_KEY` di `.env` lalu ubah `DRY_RUN=false`.
Hentikan bot dengan `Ctrl+C`: bot akan membatalkan semua order miliknya sebelum keluar.

### Scope API key

Buat di **Account → API Keys**. Yang dibutuhkan:
`market:read`, `balance:read`, `portfolio:read`, `user:read`, `order:place`, `order:cancel`,
`order:read` (ditambah `bet:place`, `bet:read` untuk market PARIMUTUEL).
**Jangan aktifkan `balance:withdraw`.** Bot tidak pernah membutuhkannya.

## Dashboard web

Saat bot berjalan, dashboard otomatis aktif di **port 3005**. Isinya:

- **Ringkasan:** PnL (hari ini / simulasi), win rate, akurasi model + Brier score, saldo, dan meter exposure
- **Harga pasar** BTC/ETH/SOL/CC dengan grafik 1 jam (arahkan kursor/sentuh untuk melihat harga)
- **Market dipantau:** hitung mundur, bar peluang UP vs DOWN, spot vs harga acuan, keputusan bot, dan order aktif
- **Kurva PnL kumulatif** dengan tooltip per trade
- **Riwayat market** dan **jurnal aktivitas** real-time
- **Tombol kontrol:** Jeda/Lanjutkan trading, Batalkan semua order, Lepas rem darurat

Ada dua halaman:

| Alamat | Login | Isi |
|---|---|---|
| `http://IP_VPS:3005` | **tanpa login** | Tampilan lengkap, **hanya melihat**. Cocok untuk Smart TV. Tombol kontrol disembunyikan dan nama akun tidak ditampilkan. |
| `http://IP_VPS:3005/admin` | `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | Sama, plus tombol Jeda/Lanjutkan, Batalkan Semua Order, dan Lepas Rem Darurat. |

- Halaman `/admin` hanya aktif bila `DASHBOARD_PASSWORD` diisi (minimal 8 karakter). Setelah 10 kali
  gagal login, IP tersebut diblokir selama 15 menit.
- Ingin semua halaman wajib login? Set `DASHBOARD_PUBLIC_VIEW=false`.
- Tampilan tanpa login tetap menampilkan saldo dan hasil trading kepada siapa pun yang tahu IP dan port-nya.

## Deploy di VPS dengan PM2 (dikendalikan dari Termux)

### 1. Masuk ke VPS dari Termux

```bash
pkg update && pkg install openssh
ssh root@IP_VPS_ANDA
```

### 2. Pasang Node.js, Git, dan PM2 di VPS (Ubuntu/Debian)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git
npm install -g pm2
node -v   # pastikan v20 atau lebih baru
```

### 3. Ambil kode dan atur konfigurasi

```bash
git clone https://github.com/ricko130911/Airdrop.git
cd Airdrop
git checkout ccr-11623a72-xsp3o6   # lewati bila sudah di-merge ke main
cd unhedged-bot
cp .env.example .env
nano .env    # isi DASHBOARD_PASSWORD (dan UNHEDGED_API_KEY untuk live)
```

Repo privat? Saat `git clone` diminta login, pakai username GitHub dan
**Personal Access Token** sebagai password.

### 4. Jalankan dengan PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save                 # simpan daftar proses
pm2 startup              # jalankan perintah yang ditampilkan agar bot hidup lagi setelah VPS reboot
```

### 5. Buka port 3005

```bash
ufw allow 3005/tcp       # bila memakai UFW
```

Bila VPS di cloud (AWS, GCP, Vultr, DigitalOcean, dan lain-lain), buka juga port **3005/TCP**
di firewall / security group panel penyedia VPS.

### 6. Buka dashboard

Di browser HP atau laptop: **`http://IP_VPS_ANDA:3005`**, lalu login.

### Perintah PM2 yang berguna

```bash
pm2 status                    # status bot
pm2 logs unhedged-bot         # lihat log real-time (Ctrl+C untuk keluar)
pm2 restart unhedged-bot      # restart setelah mengubah .env
pm2 stop unhedged-bot         # hentikan bot (order bot dibatalkan dulu)
git pull && pm2 restart unhedged-bot   # update ke versi terbaru
```

> `ecosystem.config.cjs` sengaja memakai `instances: 1`. Jangan jalankan lebih dari satu
> bot dengan API key yang sama, karena order bisa dobel.

### Keamanan (disarankan)

`http://` tidak terenkripsi, jadi password dikirim tanpa enkripsi. Pilihan yang lebih aman:

- **SSH tunnel dari Termux:** set `DASHBOARD_HOST=127.0.0.1` di `.env`, lalu di Termux jalankan
  `ssh -L 3005:127.0.0.1:3005 root@IP_VPS_ANDA` dan buka `http://localhost:3005` di HP. Port 3005
  tidak perlu dibuka di firewall.
- Atau pasang HTTPS lewat reverse proxy (Caddy/Nginx) dengan domain sendiri.

### Alternatif: jalankan langsung di Termux (tanpa VPS)

```bash
pkg install nodejs git
npm install -g pm2
# lalu langkah 3, 4, dan 6 di atas; buka http://localhost:3005
```

Android bisa mematikan Termux di background. Aktifkan `termux-wake-lock` dan matikan
optimasi baterai untuk Termux. VPS tetap lebih stabil untuk bot 24 jam.

## Pengaturan penting (`.env`)

| Variabel | Default | Arti |
|---|---|---|
| `DRY_RUN` | `true` | `true` = simulasi, `false` = order sungguhan |
| `ASSETS` | `BTC,ETH,SOL,CC` | Aset yang diperdagangkan |
| `MAX_ORDER_USD` | `5` | Maksimum USD per order |
| `MAX_OPEN_EXPOSURE_USD` | `20` | Total maksimum dana yang terbuka bersamaan |
| `MAX_DAILY_LOSS_USD` | `25` | Rem darurat rugi harian |
| `KELLY_FRACTION` | `0.25` | Agresivitas ukuran posisi |
| `MIN_EDGE` | `0.05` | Margin minimal (5 sen per kontrak $1) |
| `MAX_PRICE` / `MIN_PRICE` | `0.92` / `0.05` | Batas harga beli |
| `TRADE_WHEN_SECONDS_LEFT` | `180` | Mulai trading saat sisa waktu ≤ ini |
| `STOP_SECONDS_LEFT` | `15` | Batalkan order saat sisa waktu ≤ ini |
| `SIGMA_MULTIPLIER` | `1.3` | >1 = model lebih hati-hati (antisipasi lonjakan) |
| `MOMENTUM_WEIGHT` | `0.2` | Bobot momentum (0 = abaikan) |
| `HYSTERESIS` | `0.05` | Keyakinan tambahan untuk berpindah sisi (anti bolak-balik) |
| `FEE_RATE` | kosong | Fee per kontrak (fraksi harga). Kosong = tarif taker dari data market |
| `STRATEGY` | `sniper` | `sniper` = tembak di akhir round, `model` = strategi lama |
| `SNIPE_MAX_SEC` / `SNIPE_MIN_SEC` | `45` / `4` | Jendela tembak (detik tersisa) |
| `SNIPE_MIN_PROB` | `0.97` | Peluang menang minimal |
| `SNIPE_MAX_PRICE` | `0.95` | Harga beli maksimum |
| `SNIPE_MIN_EV` | `0.015` | Untung minimal per kontrak setelah fee |
| `SNIPE_USD` | `3` | Modal per tembakan |
| `SNIPE_MAX_LOSSES_PER_DAY` | `2` | Rem: berhenti sampai besok setelah kalah sebanyak ini |
| `DAILY_PROFIT_TARGET_USD` | `0` | Berhenti setelah untung harian mencapai angka ini (0 = tanpa target) |
| `FEE_MODEL` | `flat` | `flat` = tarif × harga (konservatif), `risk` = tarif × min(harga, 1−harga) |
| `ADAPTIVE` | `true` | Kalibrasi peluang otomatis + blokir zona yang terbukti rugi |
| `ADAPTIVE_MIN_TRADES` | `25` | Minimal trade per zona sebelum zona boleh diblokir |
| `CALIBRATION_MIN_SAMPLES` | `40` | Minimal market per titik waktu sebelum kalibrasi aktif |
| `PROBE_TRADES` | `true` | Di zona yang diblokir tetap kirim order 1 kontrak untuk belajar |
| `MARKET_REGEX` | kosong | Regex manual untuk memilih market bila deteksi otomatis gagal |
| `DASHBOARD_PORT` | `3005` | Port dashboard web |
| `DASHBOARD_HOST` | `0.0.0.0` | `0.0.0.0` = bisa diakses lewat IP VPS, `127.0.0.1` = hanya lokal/SSH tunnel |
| `DASHBOARD_PUBLIC_VIEW` | `true` | Halaman utama bisa dilihat tanpa login (Smart TV), hanya melihat |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | `admin` / kosong | Login halaman kontrol `/admin`. Kosong = `/admin` mati |

## Bila tidak ada market yang terdeteksi

Format persis market 5 menit (judul, nama outcome, field harga acuan) tidak dijelaskan
rinci di dokumentasi, jadi pendeteksiannya dibuat fleksibel. Bila `npm run discover`
tidak menemukan market:

1. Jalankan `node src/index.js discover --raw` dan lihat bagian **DITOLAK** beserta alasannya.
2. Sesuaikan `MARKET_REGEX` (contoh: `MARKET_REGEX=up or down`) atau `FEED_CATEGORY`
   (contoh: `FEED_CATEGORY=Crypto`).
3. Bila nama field harga acuan berbeda, tambahkan namanya ke `STRIKE_FIELDS` di `src/markets.js`.

## Keterbatasan yang perlu diketahui

- **Rumus fee belum pasti.** Dokumentasi menyebut fee order book memakai "risk-shaped curve".
  Bot memakai perkiraan konservatif (tarif taker × harga). Setelah live, cek kolom `fee`
  di riwayat trade dan sesuaikan `FEE_RATE` bila perlu.
- **Simulasi tetap perkiraan.** Fill disimulasikan dari harga teratas order book yang dibaca
  tiap ~4 detik. Kedalaman order book (jumlah kontrak di tiap harga) tidak diketahui, dan
  order resting bisa terisi di antara dua pembacaan tanpa terdeteksi.
- **Pasar bisa sangat efisien.** Contoh data asli: 97 detik sebelum tutup, UP sudah dihargai
  0.97. Bila pemain lain sudah secepat ini, edge bisa sangat tipis atau tidak ada.
- **Sumber harga CC = Bybit CCUSDT.** Penutupan per detik CC dibentuk dari trade Bybit
  terbaru (seperti Unhedged, sumber `bybit-trades`). Bybit memblokir beberapa negara/data center;
  jalankan `node src/index.js check` di VPS untuk memastikan semua sumber harga bisa diakses.
- Bot tidak menyentuh market yang sudah punya order manual milik Anda.

## Struktur kode

```
src/
  index.js     CLI: run / discover / status
  bot.js       Loop utama, eksekusi order, manajemen risiko, evaluasi
  model.js     Model probabilitas (TWAP 60 detik), volatilitas, drift, Kelly
  analytics.js Pembelajaran: kalibrasi peluang, zona rugi, ringkasan hasil
  strategy.js  Keputusan beli/lewati (fungsi murni)
  markets.js   Pencarian & parsing market dari feed
  prices.js    Sumber harga (Binance, Coinbase, Unhedged)
  api.js       Klien REST Unhedged (rate limit, retry aman)
  config.js    Pembacaan .env
  logger.js    Log ke konsol + logs/bot.log + logs/decisions.jsonl
  dashboard/   Server dashboard (server.js) + tampilan web (public/)
ecosystem.config.cjs  Konfigurasi PM2
test/          Tes unit (node --test)
```
