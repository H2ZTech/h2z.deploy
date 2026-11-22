#!/bin/sh
# 显卡自适应校准：实测这台机器的显卡能同时硬解几路 H.265，结果写进 .env 自动块（H2Z_GPU_* / IOC_VAAPI_MAX），
# 本地屏据此决定「浏览器原生硬解上限」，后端据此决定「VAAPI 硬转上限」。设计和规则见 docs/VIDEO-DECODE-STRATEGY-2026-11-09.md §5。
# 用法：sh scripts/gpu-calibrate.sh [.env 路径，缺省 .env]        强制重测：FORCE=1 sh scripts/gpu-calibrate.sh
# 什么时候测：显卡 / 内核 / zlm-x86 镜像变了（指纹变了）才测，其余时候秒退；测一次约 45 秒（4 / 8 路硬解样片，再 4 路硬转），所以放在 up.sh / update.sh / 开机起栈之前。
# 安全：只读 /dev/dri，容器限 512 MB / 2 核；可用内存不足 1.2 GB 就跳过（不写结果，下次再测）；任何失败都不挡启动。
# 手工写在 .env 自动块外面的键优先（见 scripts/gpu-calibrate.mjs）。
set -u
cd "$(dirname "$0")/.."
ENV=${1:-.env}
[ -f "$ENV" ] || exit 0
IMG=$(grep '^ZLM_VAAPI_IMAGE=' "$ENV" 2>/dev/null | tail -1 | cut -d= -f2-); IMG=${IMG:-ghcr.io/h2ztech/zlm-x86:latest}

# 选显卡节点：先找驱动认识的（amdgpu / i915），没有就取第一个
RND=""
for n in /dev/dri/renderD*; do
  [ -e "$n" ] || continue
  d=$(basename "$(readlink "/sys/class/drm/$(basename "$n")/device/driver" 2>/dev/null)" 2>/dev/null)
  case "$d" in amdgpu|i915) RND=$n; break ;; esac
  [ -n "$RND" ] || RND=$n
done
[ -n "$RND" ] || { echo "显卡校准：没有 /dev/dri/renderD*，跳过"; exit 0; }
docker image inspect "$IMG" >/dev/null 2>&1 || { echo "显卡校准：本机没有 $IMG，跳过（有镜像后再测）"; exit 0; }

b=$(basename "$RND")
# CAL_VER：测量内容变了就加一，已经校准过的机器会重测一次（v2 = 加了显卡转码的实测，2026-11-10）
CAL_VER=2
FP=$(printf '%s|%s|%s|%s|%s|v%s' "$RND" "$(cat /sys/class/drm/$b/device/vendor 2>/dev/null)" "$(cat /sys/class/drm/$b/device/device 2>/dev/null)" "$(uname -r)" "$(docker image inspect -f '{{.Id}}' "$IMG" 2>/dev/null)" "$CAL_VER" | sha1sum | cut -c1-12)
if [ "${FORCE:-0}" != 1 ] && grep -q "^H2Z_GPU_FINGERPRINT=$FP\$" "$ENV" 2>/dev/null; then echo "显卡校准：硬件没变（$FP），沿用上次结果"; exit 0; fi

AVAIL=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
if [ "${AVAIL:-0}" -gt 0 ] && [ "$AVAIL" -lt 1200 ]; then echo "显卡校准：可用内存只有 ${AVAIL} MB，跳过（不写结果，下次再测）"; exit 0; fi

OUT="$PWD/.gpu-measure.out"
timeout 120 docker run --rm --pull never --device "$RND" --memory 512m --cpus 2 -e RND="$RND" \
  -v "$PWD/scripts/gpu-measure.sh:/gpu-measure.sh:ro" --entrypoint sh "$IMG" /gpu-measure.sh > "$OUT" 2>/dev/null || { echo "显卡校准：测量没跑完，沿用 .env 现有值"; rm -f "$OUT"; exit 0; }
docker run --rm --pull never --user "$(id -u):$(id -g)" -v "$PWD:/project" -w /project node:22-alpine node scripts/gpu-calibrate.mjs "$ENV" .gpu-measure.out "$FP" || echo "显卡校准：结果没写进去，沿用 .env 现有值"
rm -f "$OUT"
exit 0
