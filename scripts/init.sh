#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker run --rm --user 0 -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -e HOST_LSM="$(cat /sys/kernel/security/lsm 2>/dev/null || true)" \
  -v "$PWD:/project" -w /project node:22-alpine node scripts/init.mjs
