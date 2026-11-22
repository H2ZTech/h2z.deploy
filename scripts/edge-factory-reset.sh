#!/bin/sh
# 边缘（edge-link）恢复出厂：停 edge-link → 清它的数据卷里的身份文件（密钥、认领、审计、配对码、状态）→ 重启，得到新的录像机 ID 和新配对码。
# 只动 edge-link 数据卷里 `edge-link factory-reset` 列出的文件；录像、数据库、其他卷一概不碰。
# 用法（在应用目录，C 线 docker2/ 或 H2Z OS 的应用目录）：sh scripts/edge-factory-reset.sh --yes
# host-agent 的 POST /v1/link/factory-reset 也是用它。新 ID 要在云端项目里吊销旧录像机并重新扫码认领。
set -eu
[ "${1:-}" = "--yes" ] || { echo "拒绝：这会换掉录像机身份（新 ID，需重新认领并在云端吊销旧机）。确认请加 --yes" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
# compose 文件所在目录：scripts/ 的上一级（B 形态瘦底座、H2Z OS 栈），或 docker2/（这个脚本被 docker2 的应用目录引用时用 H2Z_STACK_DIR）
cd "${H2Z_STACK_DIR:-$HERE/..}"
docker compose stop edge-link
docker compose run --rm --no-deps edge-link factory-reset --key-file /data/edge.key --yes
docker compose up -d edge-link
echo "EDGE_FACTORY_RESET done: 新的录像机 ID 和配对码见 docker compose logs edge-link | grep -E 'EDGE_ID|EDGE_PAIR'"
