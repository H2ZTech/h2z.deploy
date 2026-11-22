#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || sh scripts/init.sh
{ [ -f scripts/budget.sh ] && sh scripts/budget.sh; } || true
{ [ -f scripts/gpu-calibrate.sh ] && sh scripts/gpu-calibrate.sh; } || true   # 显卡硬解路数实测（硬件没变就秒退）
docker compose config --quiet
docker compose pull web
docker compose up -d --build --wait --wait-timeout 180 "$@"
