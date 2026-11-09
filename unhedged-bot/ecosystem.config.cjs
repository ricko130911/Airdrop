// Konfigurasi PM2. Jalankan dari folder unhedged-bot:
//   pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'unhedged-bot',
      script: 'src/index.js',
      args: 'run',
      cwd: __dirname,
      interpreter: 'node',
      instances: 1, // WAJIB 1: jangan jalankan beberapa bot sekaligus (order bisa dobel)
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      max_memory_restart: '300M',
      kill_timeout: 15000, // beri waktu bot membatalkan order sebelum mati
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
