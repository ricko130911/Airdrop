#!/usr/bin/env bash
# Pasang / update TrendBot di VPS (Ubuntu/Debian) sebagai layanan systemd 24/7.
# Pakai:  sudo bash deploy/install.sh        (jalankan dari folder trendbtc)
# Aman dijalankan ulang untuk update: password & data tidak ditimpa.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/trendbtc
DATA=/var/lib/trendbtc
ENVF=/etc/trendbtc.env
SVC=/etc/systemd/system/trendbtc.service
PORT="${TRENDBTC_PORT:-8787}"

[ "$(id -u)" -eq 0 ] || { echo "Jalankan sebagai root (sudo)."; exit 1; }
command -v python3 >/dev/null || { apt-get update -y && apt-get install -y python3; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "Butuh Python 3.9+"; exit 1; }

id -u trendbot >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin trendbot
install -d -o root -g root -m 755 "$APP"
install -d -o trendbot -g trendbot -m 700 "$DATA"
for f in bot.py predict.py service.py demo.py dashboard.html; do
  install -o root -g root -m 644 "$SRC/$f" "$APP/$f"
done

if [ ! -f "$ENVF" ]; then
  PW="$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"
  umask 077
  printf 'TRENDBTC_DASH_PASSWORD=%s\n' "$PW" > "$ENVF"
  NEWPW=1
fi
chmod 600 "$ENVF"

cat > "$SVC" <<UNIT
[Unit]
Description=TrendBot (TrendBTC predictor + dashboard)
After=network-online.target
Wants=network-online.target

[Service]
User=trendbot
Group=trendbot
EnvironmentFile=$ENVF
ExecStart=/usr/bin/python3 $APP/service.py --data-dir $DATA --host 127.0.0.1 --port $PORT
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable trendbtc >/dev/null 2>&1
systemctl restart trendbtc
sleep 2
systemctl --no-pager --lines=5 status trendbtc || true

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "================ TrendBot terpasang ================"
echo "Dashboard hanya bisa dibuka lewat SSH tunnel (aman). Dari komputer/HP Anda jalankan:"
echo "    ssh -L $PORT:127.0.0.1:$PORT root@${IP:-IP_VPS}"
echo "lalu buka  http://localhost:$PORT   (user: admin)"
if [ "${NEWPW:-0}" = 1 ]; then
  echo "Password dashboard: $PW"
  echo "(tersimpan di $ENVF — lihat lagi dengan: sudo cat $ENVF)"
else
  echo "Password dashboard: sudo cat $ENVF"
fi
echo "Log langsung:  journalctl -u trendbtc -f"
echo "Mode awal: DRY RUN. Isi token & nyalakan LIVE dari dashboard."
