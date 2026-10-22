#!/usr/bin/env bash
set -Eeuo pipefail
environment=${1:?production or staging}; sha=${2:?SHA}
[[ "$environment" == production || "$environment" == staging ]] || exit 2
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || exit 2
base="/srv/hd-crm/$environment"
exec 9>"$base/release.lock"
flock -n 9
read -r slot active_sha < "$base/active"
[[ "$active_sha" == "$sha" ]] || exit 2
release="$base/releases/$sha"
name="crm-$environment-jobs"
# Graceful stop awaits the current tick; never start a second worker if stop fails.
if pm2 describe "$name" >/dev/null 2>&1; then
  pm2 stop "$name"
  pm2 delete "$name"
fi
cd "$release"
NODE_ENV=production pm2 start server/src/jobs/runner.js --name "$name" \
  --node-args="--env-file=/etc/hd-crm/$environment/server.env" \
  --kill-timeout 310000 --max-memory-restart 750M --exp-backoff-restart-delay 1000 --time
pm2 save
echo 'Check admin System Status for every job heartbeat before considering worker rollout complete.'
