# TrendBTC Neon Sniper — Bot + Dashboard Web 3D

Bot multi-akun TrendBTC (Crypto 12 aset, Survivor, Bullseye, Sports) dengan dashboard web
bergaya cyberpunk: koin Bitcoin 3D (Three.js + bloom), kristal aset yang mengorbit dan berubah
warna sesuai arah harga, kartu 3D tilt, sparkline 10 menit, matrix sniper per akun, dan log live.

| File | Fungsi |
|---|---|
| `bot_multi.py` | Bot asli (masih bisa dijalankan manual dengan menu Termux) |
| `web_server.py` | Menjalankan bot **tanpa menu** + server dashboard (dipakai pm2) |
| `web/` | Tampilan dashboard (HTML/CSS/JS + scene 3D) |
| `ecosystem.config.js` | Konfigurasi pm2 |
| `setup_vps.sh` | Installer otomatis di VPS |
| `config_multi.example.json` | Contoh config (salin jadi `config_multi.json`) |
| `.env.example` | Contoh pengaturan dashboard (salin jadi `.env`) |

> `config_multi.json` dan `.env` berisi password/API key, jadi **tidak** ikut di-commit ke git (`.gitignore`).

## Deploy ke VPS (root@66.42.43.122)

### 1. Kirim folder ke VPS
Dari komputer / Termux kamu (folder ini sudah ada di branch `ccr-61cbc931-u0q8q1`):

```bash
# Opsi A: clone langsung di VPS
ssh root@66.42.43.122
git clone -b ccr-61cbc931-u0q8q1 https://github.com/ricko130911/Airdrop.git
cd Airdrop/trendbtc-bot

# Opsi B: upload dari HP/PC
scp -r trendbtc-bot root@66.42.43.122:/root/
ssh root@66.42.43.122
cd /root/trendbtc-bot
```

### 2. Isi config akun
```bash
cp config_multi.example.json config_multi.json
nano config_multi.json      # isi EMAIL, PASSWORD, TWO_CAPTCHA_API_KEY
```

### 3. Install & jalankan dengan pm2
```bash
bash setup_vps.sh
```
Script ini menginstall Python venv, Node.js, pm2, membuat `.env` dengan password dashboard acak,
membuka port di firewall, lalu `pm2 start` + `pm2 save` + `pm2 startup` (otomatis jalan lagi setelah VPS reboot).

### 4. Buka dashboard
`http://66.42.43.122:8080` → login dengan `DASHBOARD_USER` / `DASHBOARD_PASSWORD` dari file `.env`.

> Kalau VPS kamu pakai firewall di panel provider (Vultr, dll.), buka juga port **8080/TCP** di sana.

## Pengaturan (`.env`)

```ini
BOT_MODES=crypto                 # crypto,survivor,bullseye,sports (bisa digabung)
DASHBOARD_PORT=8080
DASHBOARD_USER=admin
DASHBOARD_PASSWORD=...           # wajib, dibuat otomatis oleh setup_vps.sh
START_PAUSED=false               # true = bot menyala dalam keadaan pause
CHAINLINK_API_KEY=               # opsional; kosong = harga BTC dari Binance
CHAINLINK_USER_SECRET=
```
Setelah mengubah `.env` atau `config_multi.json`: `pm2 restart trendbtc-bot`.

## Perintah pm2

```bash
pm2 status                   # lihat status
pm2 logs trendbtc-bot        # log live (login, setiap bet OK/GAGAL)
pm2 restart trendbtc-bot     # restart
pm2 stop trendbtc-bot        # hentikan
```

## Tombol PAUSE di dashboard
Tombol **PAUSE BETS** menghentikan semua bet/pick/call tanpa mematikan bot (pemantauan tetap jalan).
Ronde yang lewat saat pause dilewati. Catatan mode Sports: market yang dilewati saat pause baru dicoba lagi setelah `pm2 restart`.

## Menjalankan versi terminal (Termux) seperti biasa
```bash
python3 bot_multi.py
```
