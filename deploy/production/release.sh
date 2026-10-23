#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
mode=${1:?deploy or rollback}; environment=${2:?production or staging}
[[ "$mode" == deploy || "$mode" == rollback ]] || exit 2
[[ "$environment" == production || "$environment" == staging ]] || exit 2
base="${HD_CRM_ROOT:-/srv/hd-crm}/$environment"
exec 9>"$base/release.lock"
flock -n 9 || { echo 'Another release is running'; exit 1; }
# PM2 must run as its systemd service. A daemon started from this script would
# live inside the release job and stop with it, taking the API down.
systemctl is-active --quiet "pm2-$(id -un)" || { echo "PM2 service pm2-$(id -un) is not running; start it before releasing" >&2; exit 1; }
cd "$base"
old_slot=; old_sha=
if [[ -f active ]]; then read -r old_slot old_sha < active; fi
[[ -z "$old_slot" || "$old_slot" == blue || "$old_slot" == green ]] || exit 2
[[ -z "$old_sha" || "$old_sha" =~ ^[a-f0-9]{40}$ ]] || exit 2
slot=blue; [[ "$old_slot" != blue ]] || slot=green
if [[ "$mode" == rollback ]]; then
  read -r slot sha < previous
else
  sha=${3:?Full tested commit SHA required}
fi
[[ "$sha" =~ ^[a-f0-9]{40}$ && ( "$slot" == blue || "$slot" == green ) ]] || exit 2
[[ "$sha" != "$old_sha" ]] || { echo 'Already active'; exit 1; }
release="$base/releases/$sha"
port=3101; [[ "$environment" != staging ]] || port=3201
[[ "$slot" != green ]] || port=$((port+1))
name="crm-$environment-$slot"
if [[ "$mode" == deploy ]]; then
  if pm2 describe "$name" >/dev/null 2>&1; then
    echo 'Inactive slot is retained. Follow the retirement procedure before another deploy.'; exit 1
  fi
  [[ -f "$release/client/dist/index.html" && -f "$release/RELEASE_SHA" ]] || exit 1
  [[ "$(cat "$release/RELEASE_SHA")" == "$sha" ]] || exit 1
  cd "$release"
  # Never run setup, seeds or SQL. Build/test ran on Ubuntu CI, not this VPS.
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  DEPLOY_ENV="$environment" node --env-file="/etc/hd-crm/$environment/server.env" deploy/production/check-target.mjs
  mkdir -p "$base/assets"
  cp -an client/dist/assets/. "$base/assets/"
  DEPLOY_ENV="$environment" DEPLOY_SLOT="$slot" pm2 start deploy/production/ecosystem.config.cjs
fi
switched=false
recover() {
  status=${1:-1}
  trap - ERR INT TERM
  if [[ "$switched" == true ]]; then
    restore_sha=${old_sha:-0000000000000000000000000000000000000000}
    restore_slot=${old_slot:-blue}
    if sudo /usr/local/sbin/hd-crm-switch "$environment" "$restore_sha" "$restore_slot"; then
      if [[ -n "$old_sha" ]]; then
        printf '%s %s\n' "$old_slot" "$old_sha" > "$base/active.next"
        mv "$base/active.next" "$base/active"
      fi
      echo 'Traffic returned to previous application; investigate candidate before retiring it.'
    else
      echo 'CRITICAL: rollback failed. Inspect Nginx and both processes immediately.' >&2
    fi
  fi
  echo 'Release failed; no database rollback attempted.' >&2
  exit "${status:-1}"
}
trap 'recover $?' ERR
trap 'recover 130' INT
trap 'recover 143' TERM
healthy=false
for attempt in {1..12}; do
  if node "$release/deploy/production/health.mjs" "http://127.0.0.1:$port" "$sha"; then healthy=true; break; fi
  sleep 5
done
[[ "$healthy" == true ]] || { echo "Candidate never became ready; traffic unchanged" >&2; exit 1; }
if [[ "$environment" == staging ]]; then
  node --env-file=/etc/hd-crm/staging/smoke.env "$release/deploy/production/staging-smoke.mjs" "http://127.0.0.1:$port"
fi
# Mark before calling switch so ambiguous reload errors restore the prior target.
switched=true
sudo /usr/local/sbin/hd-crm-switch "$environment" "$sha" "$slot"
for attempt in {1..12}; do
  node "$release/deploy/production/health.mjs" "http://127.0.0.1:$port" "$sha"
  curl --fail --silent --show-error --max-time 10 -D "$base/probe.headers" "$(cat "$base/origin")/health" >/dev/null
  tr -d '\r' < "$base/probe.headers" | grep -iq "^x-release-sha: $sha$"
  curl --fail --silent --show-error --max-time 10 "$(cat "$base/origin")/" >/dev/null
  sleep 5
done
if [[ -n "$old_sha" ]]; then
  printf '%s %s\n' "$old_slot" "$old_sha" > "$base/previous.next"
  mv "$base/previous.next" "$base/previous"
fi
printf '%s %s\n' "$slot" "$sha" > "$base/active.next"
mv "$base/active.next" "$base/active"
pm2 save
trap - ERR INT TERM
echo "Active $environment release: $sha ($slot). Previous API retained; worker unchanged."
