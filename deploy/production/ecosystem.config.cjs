const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const environment = process.env.DEPLOY_ENV;
const slot = process.env.DEPLOY_SLOT;
if (
  !["production", "staging"].includes(environment) ||
  !["blue", "green"].includes(slot)
)
  throw new Error("Explicit DEPLOY_ENV and DEPLOY_SLOT required");
const port =
  (environment === "production" ? 3101 : 3201) + (slot === "green" ? 1 : 0);
module.exports = {
  apps: [
    {
      name: `crm-${environment}-${slot}`,
      cwd: root,
      script: "server/src/index.js",
      node_args: [`--env-file=/etc/hd-crm/${environment}/server.env`],
      env: {
        NODE_ENV: "production",
        PORT: port,
        RELEASE_SHA: path.basename(root),
      },
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 310000,
      min_uptime: 10000,
      max_restarts: 10,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "750M",
      merge_logs: true,
      time: true,
    },
  ],
};
