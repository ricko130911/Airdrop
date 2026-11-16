#!/usr/bin/env bash
# Setup TrendBTC Neon Sniper di VPS (Ubuntu/Debian) + jalankan dengan pm2.
# Pakai:  cd ~/trendbtc-bot && bash setup_vps.sh
set -euo pipefail

cd "$(dirname "$0")"
APP_DIR="$(pwd)"

echo ">>> [1/6] Install paket sistem (python3, venv, curl)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3 python3-venv python3-pip curl ca-certificates

echo ">>> [2/6] Install Node.js + pm2 (kalau belum ada)..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

echo ">>> [3/6] Buat virtualenv Python + install dependensi..."
python3 -m venv venv
./venv/bin/pip install --upgrade pip >/dev/null
./venv/bin/pip install -r requirements.txt

echo ">>> [4/6] Cek file konfigurasi..."
if [ ! -f config_multi.json ]; then
  cp config_multi.example.json config_multi.json
  chmod 600 config_multi.json
  echo "!!! config_multi.json dibuat dari contoh. Isi EMAIL/PASSWORD/2CAPTCHA dulu:"
  echo "    nano $APP_DIR/config_multi.json"
  echo "    lalu jalankan lagi: bash setup_vps.sh"
  exit 1
fi
chmod 600 config_multi.json

if [ ! -f .env ]; then
  cp .env.example .env
  PASS="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
  sed -i "s/^DASHBOARD_PASSWORD=.*/DASHBOARD_PASSWORD=${PASS}/" .env
  chmod 600 .env
  echo ">>> .env dibuat. Password dashboard: ${PASS}"
fi
PORT="$(grep -E '^DASHBOARD_PORT=' .env | cut -d= -f2)"
PORT="${PORT:-8080}"

echo ">>> [5/6] Buka port ${PORT} di firewall (kalau ufw aktif)..."
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp"
fi

echo ">>> [6/6] Start dengan pm2..."
pm2 delete trendbtc-bot >/dev/null 2>&1 || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

IP="$(curl -s https://api.ipify.org || hostname -I | awk '{print $1}')"
echo
echo "=================================================================="
echo " SELESAI! Dashboard: http://${IP}:${PORT}"
echo " User: $(grep -E '^DASHBOARD_USER=' .env | cut -d= -f2)   Password: lihat file .env"
echo " Log  : pm2 logs trendbtc-bot"
echo "=================================================================="
