#!/bin/sh
# Repair bind-mounted secret ownership for containers using supplementary GID 20001.
set -eu
cd "$(dirname "$0")/.."
[ "$(id -u)" = 0 ] || { echo 'Run with sudo'; exit 1; }
[ -d secrets ] || { echo 'secrets/ does not exist; run sh scripts/init.sh first'; exit 1; }
operator="${SUDO_USER:-}"
[ -n "$operator" ] || { echo 'Run as: sudo sh scripts/fix-secret-permissions.sh'; exit 1; }
operator_uid="$(id -u "$operator")"
chown -R "$operator_uid:20001" secrets
find secrets -type d -exec chmod 0750 {} +
find secrets -type f -exec chmod 0640 {} +
if [ -d runtime/ai-shared ]; then
  chown -R "$operator_uid:20001" runtime/ai-shared
  find runtime/ai-shared -type d -exec chmod 2770 {} +
  find runtime/ai-shared -type f -exec chmod 0660 {} +
fi
echo 'Secret and AI shared-volume permissions repaired; file contents were not changed.'
