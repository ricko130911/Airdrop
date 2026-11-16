// pm2 process file:  pm2 start ecosystem.config.js
const path = require("path");

module.exports = {
  apps: [
    {
      name: "trendbtc-bot",
      cwd: __dirname,
      script: "web_server.py",
      interpreter: path.join(__dirname, "venv", "bin", "python"),
      interpreter_args: "-u",
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      max_memory_restart: "600M",
      time: true,
      env: {
        PYTHONUNBUFFERED: "1",
      },
    },
  ],
};
