#!/bin/sh
# 按整机内存重算转码预算并写进 .env（up.sh / update.sh 每次都会调；设备上不一定装了 node，所以用容器跑，/proc/meminfo 读到的是整机的）
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || exit 0
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/project" -w /project node:22-alpine node scripts/transcode-budget.mjs || echo "转码预算计算失败，沿用 .env 现有值"
