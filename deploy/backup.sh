#!/usr/bin/env bash
set -euo pipefail
umask 077
# Run as the deployment user. Secrets are read by Node, never sourced as shell code.
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
backup_env="${CRM_BACKUP_ENV_FILE:-/etc/hd-crm/backup.env}"
backup_dir="${BACKUP_DIR:-/var/backups/hd-crm}"
mkdir -p -- "$backup_dir"
exec flock -n "$backup_dir/.backup.lock" node --env-file="$backup_env" "$task_root/deploy/backup.mjs"
