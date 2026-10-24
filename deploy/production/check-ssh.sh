#!/usr/bin/env bash
# Checks the deployment SSH settings before remote.sh uploads anything:
# DEPLOY_KNOWN_HOSTS must hold the server's ED25519 host key under DEPLOY_HOST
# with the fingerprint reviewed in release.yml (TRUSTED_HOST_KEY), the runner's
# SSH configuration must not override it, and the deploy key must open the
# server. Prints names, counts and public fingerprints only, never a key.
# SSH_CHECK_CONNECT=0 skips the final test connection (used by the unit tests).
set -uo pipefail
failed=0
error() { echo "::error title=Deployment SSH check::$*"; failed=1; }
ok() { echo "OK    $*"; }
host=${DEPLOY_HOST:-}
user=${DEPLOY_USER:-}
trusted=${TRUSTED_HOST_KEY:-}
dir=$(mktemp -d)
trap 'rm -rf -- "$dir"' EXIT
chmod 700 "$dir"
known=$dir/known_hosts
key=$dir/key

if [[ "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]; then ok "DEPLOY_HOST is $host"
else error "The DEPLOY_HOST variable is missing or is not a plain host name or IP address."; fi
if [[ "$user" == crm-prod ]]; then ok "DEPLOY_USER is crm-prod"
else error "The DEPLOY_USER variable must be crm-prod."; fi
[[ "$trusted" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || error "TRUSTED_HOST_KEY in release.yml is missing or not a SHA256 fingerprint."

if [[ -z "${SSH_KNOWN_HOSTS:-}" ]]; then
  error "The DEPLOY_KNOWN_HOSTS secret reached this job empty. It must be a production environment secret, and production.yml must pass it to release.yml by name (secrets: DEPLOY_KNOWN_HOSTS)."
else
  # Exactly what remote.sh writes.
  printf '%s\n' "${SSH_KNOWN_HOSTS//$'\r'/}" > "$known"
  [[ "$SSH_KNOWN_HOSTS" != *$'\r'* ]] || echo "NOTE  DEPLOY_KNOWN_HOSTS has Windows line endings; they are removed before use."
  lines=$(grep -cvE '^[[:space:]]*(#.*)?$' "$known" || true)
  readable=$(ssh-keygen -l -f "$known" 2>/dev/null | grep -c . || true)
  echo "INFO  DEPLOY_KNOWN_HOSTS: $lines line(s), $readable readable as host keys"
  if grep -qE 'SHA256:|fingerprint' "$known"; then
    echo "HINT  It contains fingerprint text. Paste the key lines (host, key type, key), not the fingerprint lines."
  fi
  entries=$(ssh-keygen -F "$host" -f "$known" 2>/dev/null | grep -v '^#' || true)
  if [[ -z "$entries" ]]; then
    error "DEPLOY_KNOWN_HOSTS has no line for $host. Each line must start with $host, followed by the key type and the key."
  else
    ok "key types for $host: $(awk '{print $2}' <<<"$entries" | sort -u | tr '\n' ' ')"
    ed25519=$(awk '$2 == "ssh-ed25519" {print $2, $3; exit}' <<<"$entries")
    if [[ -z "$ed25519" ]]; then
      error "DEPLOY_KNOWN_HOSTS has no ssh-ed25519 line for $host."
    else
      found=$(ssh-keygen -l -f - <<<"$ed25519" 2>/dev/null | awk '{print $2}')
      if [[ -n "$trusted" && "$found" == "$trusted" ]]; then ok "ED25519 host key $found matches the trusted fingerprint"
      else error "The ED25519 host key in DEPLOY_KNOWN_HOSTS is ${found:-unreadable}; the trusted fingerprint is ${trusted:-not set}."; fi
    fi
  fi
fi

if [[ -z "${SSH_KEY:-}" ]]; then
  error "The DEPLOY_SSH_KEY secret reached this job empty. It must be a production environment secret, and production.yml must pass it to release.yml by name (secrets: DEPLOY_SSH_KEY)."
else
  (umask 077; printf '%s\n' "${SSH_KEY//$'\r'/}" > "$key")
  if public=$(ssh-keygen -y -P "" -f "$key" 2>/dev/null); then
    ok "deploy key $(ssh-keygen -l -f - <<<"$public" | awk '{print $2, $NF}') (public fingerprint)"
  else
    error "DEPLOY_SSH_KEY is not a private key that opens without a passphrase."
  fi
fi

if ((failed == 0)); then
  opts=(-i "$key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes
        -o UserKnownHostsFile="$known" -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=20)
  config=$(ssh -G "${opts[@]}" "$user@$host" 2>/dev/null)
  if grep -qx 'stricthostkeychecking true' <<<"$config" && grep -qx "userknownhostsfile $known" <<<"$config"; then
    ok "SSH reads only the DEPLOY_KNOWN_HOSTS keys, with strict host key checking"
  else
    error "The runner's SSH configuration overrides the host key settings: $(grep -E '^(stricthostkeychecking|userknownhostsfile|globalknownhostsfile) ' <<<"$config" | tr '\n' ';')"
  fi
fi

if ((failed == 0)) && [[ "${SSH_CHECK_CONNECT:-1}" != 0 ]]; then
  # Runs only "true" on the server: proves host verification and the key.
  output=$(ssh "${opts[@]}" "$user@$host" true 2>&1 < /dev/null)
  status=$?
  if ((status == 0)); then
    ok "connected to $user@$host: host key verified and deploy key accepted"
  elif grep -qE 'Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key is known' <<<"$output"; then
    error "$host presented a host key that is not in DEPLOY_KNOWN_HOSTS. Keep strict checking: verify the server's key out-of-band, then update the secret and TRUSTED_HOST_KEY."
  elif grep -q 'Permission denied' <<<"$output"; then
    error "$host refused DEPLOY_SSH_KEY. Its public key must be in $user's authorized_keys on the server."
  else
    error "Could not connect to $host over SSH: $(head -n 1 <<<"$output")"
  fi
fi
exit "$failed"
