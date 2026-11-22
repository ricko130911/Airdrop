// Konfigurasi PM2. Jalankan dari folder unhedged-bot:
//   pm2 start ecosystem.config.cjs
//
// Satu proses bot per akun:
//   .env          -> proses "unhedged-bot"        (akun utama, log di logs/)
//   .env.akun2    -> proses "unhedged-bot-akun2"  (log di logs-akun2/)
//   .env.<nama>   -> proses "unhedged-bot-<nama>"
// Setiap file akun wajib punya UNHEDGED_API_KEY sendiri dan DASHBOARD_PORT berbeda.
const fs = require('node:fs');
const path = require('node:path');

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f === '.env' || (f.startsWith('.env.') && f !== '.env.example' && !f.endsWith('.bak')))
  .sort((a, b) => (a === '.env' ? -1 : b === '.env' ? 1 : a.localeCompare(b)));

// Batas request publik Unhedged 600/menit berlaku PER IP: bagi jatahnya antar akun di VPS ini
const publicRps = String(Math.max(2, Math.floor(9 / Math.max(1, files.length))));

module.exports = {
  apps: (files.length ? files : ['.env']).map((f) => ({
    name: f === '.env' ? 'unhedged-bot' : `unhedged-bot-${f.slice(5)}`,
    script: 'src/index.js',
    args: 'run',
    cwd: __dirname,
    interpreter: 'node',
    instances: 1, // WAJIB 1 per akun: jangan jalankan dua bot untuk akun yang sama (order bisa dobel)
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 50,
    max_memory_restart: '300M',
    kill_timeout: 15000, // beri waktu bot membatalkan order sebelum mati
    time: true,
    env: {
      NODE_ENV: 'production',
      ENV_FILE: path.join(__dirname, f),
      PUBLIC_RPS: publicRps,
    },
  })),
};
