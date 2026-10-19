const path = require("node:path");
const root = path.resolve(__dirname, "..");
module.exports = {
  apps: [
    { name: "crm-api", script: "server/src/index.js" },
    { name: "crm-jobs", script: "server/src/jobs/runner.js" },
  ].map((app) => ({
    ...app,
    cwd: root,
    interpreter: "node",
    node_args: ["--env-file=/etc/hd-crm/server.env"],
    env: { NODE_ENV: "production" },
    exec_mode: "fork",
    instances: 1,
    watch: false,
    autorestart: true,
    min_uptime: 10000,
    max_restarts: 10,
    exp_backoff_restart_delay: 1000,
    max_memory_restart: "750M",
    kill_timeout: 10000,
    time: true,
  })),
};
