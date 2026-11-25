// pm2 config for the read-only recorder + POLY//LAB dashboard.
//
//   pm2 start ecosystem.config.js     # start
//   pm2 logs poly-lab                 # live logs
//   pm2 monit                         # terminal monitor (CPU, memory, logs)
//   pm2 restart poly-lab              # after `git pull && cargo build --release`
//   pm2 save && pm2 startup           # start again automatically after a VPS reboot
//
// The dashboard password is read from .env (WEB_PASSWORD), so it is not stored here.
// This process has no wallet and cannot place orders.
module.exports = {
  apps: [
    {
      name: "poly-lab",
      cwd: __dirname,
      script: "./target/release/polymarket-arb",
      args: "--record",
      interpreter: "none", // native binary, not a Node script
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 1000,
      kill_timeout: 5000,
      max_memory_restart: "800M", // the in-process backtest can use RAM on small VPSes
      time: true, // timestamp each log line
      env: {
        ASSETS: "btc,eth,sol",
        INTERVALS: "5m",
        RECORD_DIR: "data",
        WEB_PORT: "8080",
        WEB_USER: "admin",
        RUST_LOG: "info,polymarket_client_sdk_v2=warn",
      },
    },
  ],
};
