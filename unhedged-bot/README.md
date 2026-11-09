# Bot Unhedged: Market Up/Down 5 Menit (BTC, ETH, SOL, CC)

Bot trading otomatis untuk market prediksi **"naik atau turun dalam 5 menit"** di
[Unhedged](https://unhedged.gg), memakai API resmi (`https://api.unhedged.gg`).

> ⚠️ **Peringatan risiko.** Ini adalah trading/taruhan dengan uang sungguhan. Tidak ada
> strategi yang menjamin untung, dan market 5 menit sangat dekat dengan acak. Bot ini
> berjalan dalam **mode simulasi (DRY_RUN) secara default**. Uji dulu berhari-hari,
> pakai nominal kecil, dan jangan pernah memakai uang yang tidak siap hilang.

## Cara kerja ("pintar"-nya di mana?)

1. **Mencari market.** Setiap 30 detik bot membaca `/api/v1/feed` dan memilih market aktif
   untuk BTC/ETH/SOL/CC yang berdurasi 5 menit dengan outcome Up/Down (atau Yes/No).
2. **Mengambil harga aset secara real-time** dari Binance → Coinbase → data harga Unhedged
   sendiri (CTM price-history). Untuk **CC (Canton Coin)** dipakai data harga Unhedged.
3. **Menghitung peluang naik** dengan model probabilitas (random walk / Brownian motion):

   ```
   P(naik) = Φ( (ln(harga_sekarang / harga_acuan) + drift·τ) / (σ·√τ) )
   ```

   - `harga_acuan` = harga saat window 5 menit dibuka (atau strike dari data market)
   - `σ` = volatilitas dari candle 1 menit terakhir (EWMA, data terbaru lebih berbobot)
   - `τ` = sisa detik sampai market tutup
   - `drift` = momentum 5 menit terakhir, diberi bobot kecil (`MOMENTUM_WEIGHT`)

   Intinya: menjelang akhir window, selisih harga yang kecil pun sudah membuat hasil
   cukup pasti, sementara harga di order book sering terlambat menyesuaikan. Di situlah edge-nya.
4. **Hanya trading bila ada edge.** Bot memasang **limit BID** di sisi yang diunggulkan
   pada harga `peluang_model − MIN_EDGE`. Order hanya terisi bila ada yang menjual
   di harga itu atau lebih murah, sehingga setiap fill punya margin minimal `MIN_EDGE`.
5. **Ukuran posisi memakai Kelly fraksional** (default ¼ Kelly), dibatasi `MAX_ORDER_USD`
   dan `MAX_OPEN_EXPOSURE_USD`.
6. **Order dinamis.** Harga order disesuaikan (`/orders/replace`) saat peluang bergeser,
   dibatalkan bila sinyal hilang atau arah berbalik, dan **semua order dibatalkan**
   `STOP_SECONDS_LEFT` detik sebelum market tutup.
7. **Satu posisi per market.** Begitu order terisi, bot menahan posisi sampai selesai dan
   tidak akan membeli sisi lawan.
8. **Rem darurat.** Bila rugi hari ini (dari `/portfolio/me/equity`) mencapai
   `MAX_DAILY_LOSS_USD`, bot berhenti trading dan membatalkan semua ordernya.
9. **Evaluasi diri.** Setelah tiap market selesai, bot mencatat hasil, akurasi, **Brier score**
   (kalibrasi model), dan PnL simulasi ke `logs/decisions.jsonl`.

Market tipe **PARIMUTUEL** (taruhan pool) juga didukung: bot menghitung payout dari ukuran
pool dan hanya bertaruh bila expected value ≥ `MIN_EDGE`.

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

Dashboard dilindungi login. **Wajib isi `DASHBOARD_PASSWORD`** (minimal 8 karakter) di `.env`.
Tanpa password, dashboard tidak akan dijalankan bila dibuka ke publik. Login dengan
username `DASHBOARD_USER` (default `admin`) dan password tersebut. Setelah 10 kali gagal login,
IP tersebut diblokir selama 15 menit.

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
| `MARKET_REGEX` | kosong | Regex manual untuk memilih market bila deteksi otomatis gagal |
| `DASHBOARD_PORT` | `3005` | Port dashboard web |
| `DASHBOARD_HOST` | `0.0.0.0` | `0.0.0.0` = bisa diakses lewat IP VPS, `127.0.0.1` = hanya lokal/SSH tunnel |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | `admin` / kosong | Login dashboard (password wajib) |

## Bila tidak ada market yang terdeteksi

Format persis market 5 menit (judul, nama outcome, field harga acuan) tidak dijelaskan
rinci di dokumentasi, jadi pendeteksiannya dibuat fleksibel. Bila `npm run discover`
tidak menemukan market:

1. Jalankan `node src/index.js discover --raw` dan lihat bagian **DITOLAK** beserta alasannya.
2. Sesuaikan `MARKET_REGEX` (contoh: `MARKET_REGEX=up or down`) atau `FEED_CATEGORY`
   (contoh: `FEED_CATEGORY=Crypto`).
3. Bila nama field harga acuan berbeda, tambahkan namanya ke `STRIKE_FIELDS` di `src/markets.js`.

## Keterbatasan yang perlu diketahui

- **Oracle berbeda.** Unhedged menyelesaikan market dengan sumber harganya sendiri. Bot
  memakai harga Binance/Coinbase, sehingga bisa ada selisih kecil. Ini sebabnya ada
  `MIN_EDGE` dan `SIGMA_MULTIPLIER`.
- **PnL simulasi optimis.** Di mode DRY_RUN, setiap order dianggap terisi. Kenyataannya
  limit order belum tentu terisi, dan yang terisi cenderung yang "kurang bagus" (adverse selection).
- **Fee** order book tidak dimodelkan secara eksplisit. Naikkan `MIN_EDGE` bila fee besar.
- Bot tidak menyentuh market yang sudah punya order manual milik Anda.

## Struktur kode

```
src/
  index.js     CLI: run / discover / status
  bot.js       Loop utama, eksekusi order, manajemen risiko, evaluasi
  model.js     Model probabilitas, volatilitas, drift, Kelly
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
