#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ "$DEPLOY_ENV" == staging || "$DEPLOY_ENV" == production ]] || exit 2
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || exit 2
expected=crm-prod; [[ "$DEPLOY_ENV" != staging ]] || expected=crm-stage
[[ "$DEPLOY_USER" == "$expected" ]] || exit 2
mkdir -p "$HOME/.ssh"
printf '%s\n' "$SSH_KEY" > "$HOME/.ssh/crm_deploy"
printf '%s\n' "${SSH_KNOWN_HOSTS//$'\r'/}" > "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/crm_deploy" "$HOME/.ssh/known_hosts"
# Host keys must be verified out-of-band. Never use ssh-keyscan in this job.
# Only the keys written above count, whatever the runner's SSH configuration
# or account home directory says.
opts=(-i "$HOME/.ssh/crm_deploy" -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes
      -o UserKnownHostsFile="$HOME/.ssh/known_hosts" -o GlobalKnownHostsFile=/dev/null)
base="/srv/hd-crm/$DEPLOY_ENV"
remote="$DEPLOY_USER@$DEPLOY_HOST"
# A failed SHA is immutable too: inspect/quarantine it manually, don't overwrite it.
ssh "${opts[@]}" "$remote" "mkdir '$base/releases/$RELEASE_SHA'"
scp "${opts[@]}" /tmp/release.tar.gz "$remote:$base/releases/$RELEASE_SHA/release.tar.gz"
# systemd keeps the release/rollback trap alive if the runner disconnects.
ssh "${opts[@]}" "$remote" "tar -xzf '$base/releases/$RELEASE_SHA/release.tar.gz' -C '$base/releases/$RELEASE_SHA' && systemd-run --user --wait --pipe --setenv=PATH=/usr/local/bin:/usr/bin:/bin --unit=release-$RELEASE_SHA bash '$base/releases/$RELEASE_SHA/deploy/production/release.sh' deploy '$DEPLOY_ENV' '$RELEASE_SHA'"
