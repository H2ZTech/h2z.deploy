#!/bin/sh
# 在 RK3588 板上启用 / 关闭 ZLM 硬件转码：改 .env 的 COMPOSE_FILE 与 ZLM_IMAGE（不动别的行）。
#   sh scripts/enable-zlm-hw.sh        启用
#   sh scripts/enable-zlm-hw.sh --off  关闭（回到官方 ZLM 镜像 + 软件转码）
# 之后：docker compose pull && docker compose up -d
set -eu
cd "$(dirname "$0")/.."
RK_IMAGE="ghcr.io/h2ztech/zlm-rk3588:latest"
OFFICIAL='zlmediakit/zlmediakit:master'
OVERRIDE='compose.zlm-rk3588.yaml'
[ -f .env ] || { echo "没有 .env，先运行 scripts/init.sh"; exit 1; }

set_kv() { # 名 值：有就替换，没有就追加
  if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
cur_files=$(grep '^COMPOSE_FILE=' .env | cut -d= -f2- || true)

if [ "${1:-}" = "--off" ]; then
  new=$(printf '%s' "$cur_files" | tr ':' '\n' | grep -v "^$OVERRIDE$" | grep -v '^$' | paste -sd: - || true)
  [ -n "$new" ] && set_kv COMPOSE_FILE "$new" || sed -i '/^COMPOSE_FILE=/d' .env
  set_kv ZLM_IMAGE "$OFFICIAL"
  echo "已关闭 ZLM 硬件转码。运行：docker compose pull && docker compose up -d"
  exit 0
fi

[ "$(uname -m)" = aarch64 ] || { echo "不是 arm64 机器，不启用"; exit 1; }
[ -c /dev/mpp_service ] && [ -c /dev/rga ] || { echo "没有 /dev/mpp_service 或 /dev/rga（不是 RK3588 厂商内核），不启用"; exit 1; }
if [ -z "$cur_files" ]; then new="compose.yaml:$OVERRIDE"
elif printf '%s' "$cur_files" | tr ':' '\n' | grep -qx "$OVERRIDE"; then new="$cur_files"
else new="$cur_files:$OVERRIDE"; fi
set_kv COMPOSE_FILE "$new"
set_kv ZLM_IMAGE "$RK_IMAGE"
echo "已启用 ZLM 硬件转码（COMPOSE_FILE=$new）。运行：docker compose pull && docker compose up -d"
