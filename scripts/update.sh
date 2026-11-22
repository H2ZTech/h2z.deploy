#!/bin/sh
# 板子更新（2026-11-02 负责人确认）：以后只跑这一条，代替手敲 git pull + docker compose pull + up。
#   sh scripts/update.sh                 查空间 → 拉代码 → 拉镜像 → 再查空间 → 启动 → 清我们自己的旧镜像（留上一版）
#   sh scripts/update.sh --prune-old     空间不够时先清我们自己的旧镜像（没有容器在用的），再更新
#   sh scripts/update.sh --check         只查空间，不更新
# 空闲少于 MIN_FREE_GB（默认 10）就停下、列出空间被谁占了。只清我们镜像仓库（OUR_REGISTRY）下、没有任何容器在用的旧镜像，
# 上一版留着回退；公共镜像和别人的容器不碰。
# 更新期间暂停看门狗（不然它会把正在重建的容器又拉起来）。
set -eu
# 从临时副本跑：下面 git pull 会改到这个脚本本身，sh 是边读边执行的，原文件被换掉会从错位的地方接着跑
if [ -z "${H2Z_UPDATE_REPO:-}" ]; then
  H2Z_UPDATE_REPO=$(cd "$(dirname "$0")/.." && pwd); export H2Z_UPDATE_REPO
  copy=$(mktemp "${TMPDIR:-/tmp}/h2z-update.XXXXXX"); cp "$0" "$copy"
  sh "$copy" "$@"; rc=$?; rm -f "$copy"; exit $rc
fi
cd "$H2Z_UPDATE_REPO"
# 记「上一版镜像」的地方：仓库里的 .h2z-update/（克隆仓库的用户能写；runtime/ 可能是初始化容器以 root 建的，普通用户写不了）
STATE=.h2z-update
MIN_FREE_GB=${MIN_FREE_GB:-10}           # Docker 盘（镜像落在这里）要的空闲
MIN_FREE_ROOT_GB=${MIN_FREE_ROOT_GB:-1}  # 系统盘 / 和仓库目录只放代码和配置；H2Z OS 的系统盘只有 6 GB，镜像在 /data，不能也要 10 GB
WD=${WATCHDOG_STATE_DIR:-/var/lib/h2z/watchdog}
PRUNE=0; CHECK=0
for a in "$@"; do case $a in --prune-old) PRUNE=1 ;; --check) CHECK=1 ;; *) echo "不认识的参数：$a" >&2; exit 2 ;; esac; done

docker_root() { docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker; }
free_gb() { df -P -B1 "$1" 2>/dev/null | awk 'NR==2 {printf "%d", $4 / 1e9}'; }

# 我们自己的镜像：compose 里用到的、在我们镜像仓库下的（node / postgres / tailscale 这类公共镜像邻居也可能在用，不清）
# 我们自己的镜像仓库（可多个，用 | 分隔）：只有 ghcr.io/h2ztech/
OUR_REGISTRY=${OUR_REGISTRY:-ghcr.io/h2ztech/}
our_repos() { docker compose config --images 2>/dev/null | sed 's/@.*//; s/:[^/:]*$//' | grep -E "^($OUR_REGISTRY)" | sort -u; }

usage_report() {
  echo "── 空间被谁占了 ──"
  docker system df 2>/dev/null || true
  echo "容器日志最大的 5 个："
  du -b "$(docker_root)"/containers/*/*-json.log 2>/dev/null | sort -rn | head -5 | awk '{printf "  %6.1f MB  %s\n", $1/1e6, $2}' || true
  journalctl --disk-usage 2>/dev/null | sed 's/^/  /' || true
  [ -n "${RECORDER_POOL_DIR:-}" ] && du -sh "$RECORDER_POOL_DIR" 2>/dev/null | sed 's/^/  录像目录：/' || true
  echo "我们没人用的旧镜像（sh scripts/update.sh --prune-old 会清掉这些）："
  old_images | while read -r id ref; do echo "  $ref ($id)"; done
}

# 没有任何容器在用的我们的镜像（KEEP 文件里的 = 上一版，留着回退）
old_images() {
  used=$(docker ps -aq | xargs -r docker inspect -f '{{.Image}}' 2>/dev/null | sort -u)
  keep=$(cat "$STATE/previous-images" runtime/previous-images 2>/dev/null || true)
  for repo in $(our_repos); do
    docker images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' "$repo" 2>/dev/null
  done | sort -u | while read -r id ref; do
    echo "$used" | grep -qx "$id" && continue
    echo "$keep" | grep -qx "$id" && continue
    echo "$id $ref"
  done
}

prune_old() {
  n=0
  for id in $(old_images | awk '{print $1}' | sort -u); do docker rmi "$id" >/dev/null 2>&1 && n=$((n + 1)) || true; done
  echo "清掉我们自己的旧镜像 $n 个（上一版留着回退）"
}

check_space() { # 阶段
  bad=0
  dr=$(docker_root)
  for p in / "$dr" "$(pwd)"; do
    f=$(free_gb "$p"); [ -n "$f" ] || continue
    # Docker 盘按 MIN_FREE_GB；系统盘 / 和仓库目录按 MIN_FREE_ROOT_GB——但它们要是和 Docker 盘同一个盘（板子 / NAS 常见），还是按 MIN_FREE_GB
    need=$MIN_FREE_ROOT_GB
    if [ "$p" = "$dr" ] || [ "$(df -P "$p" 2>/dev/null | awk 'NR==2{print $1}')" = "$(df -P "$dr" 2>/dev/null | awk 'NR==2{print $1}')" ]; then need=$MIN_FREE_GB; fi
    if [ "$f" -lt "$need" ]; then echo "空间不够（$1）：$p 只剩 ${f} GB，要至少 ${need} GB"; bad=1; fi
  done
  if [ "$bad" = 1 ]; then usage_report; return 1; fi
  echo "空间够（$1）：/ 剩 $(free_gb /) GB，Docker 盘剩 $(free_gb "$(docker_root)") GB"
}

[ "$PRUNE" = 1 ] && prune_old
check_space "更新前" || { echo "没更新。清理后再跑；只清我们自己的旧镜像：sh scripts/update.sh --prune-old"; exit 1; }
[ "$CHECK" = 1 ] && exit 0

# 暂停看门狗 30 分钟（更新完马上恢复）
if [ -d "$WD" ] && [ -w "$WD" ]; then echo $(( $(date +%s) + 1800 )) > "$WD/pause"; trap 'rm -f "$WD/pause"' EXIT
elif [ -d "$WD" ]; then echo "提醒：没有权限暂停看门狗（重跑 sudo sh host/install-watchdog.sh 修好）；更新照常进行"; fi

# 记下现在用着的镜像 = 上一版（更新后清旧镜像时留着回退）
rm -f "$STATE/previous-images.new"
if mkdir -p "$STATE" 2>/dev/null && [ -w "$STATE" ]; then
  docker compose images -q 2>/dev/null | sort -u | xargs -r docker inspect -f '{{.Id}}' 2>/dev/null | sort -u > "$STATE/previous-images.new" || true
else
  echo "提醒：$(pwd)/$STATE 写不了（目录属主不对？），这次记不下上一版镜像，更新后不清旧镜像"
fi
git pull --ff-only
# 宿主层（docker 之外：cloudflared、网口 / 热点、看门狗……）：host/setup-host.sh --check 有待补项就补（旁挂机器第一次、之后 git pull 带来看门狗等更新）。
# 补不了（要输 sudo 密码 / 网口不安全不接管）只提醒，不挡更新。H2Z OS 的镜像里这些都已装好，不会有待补项。
if [ -f host/setup-host.sh ] && ! sh host/setup-host.sh --check >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ]; then sh host/setup-host.sh || echo "提醒：宿主补齐没全成功（见上面输出）；更新照常进行"
  elif sudo -n true 2>/dev/null; then sudo sh host/setup-host.sh || echo "提醒：宿主补齐没全成功（见上面输出）；更新照常进行"
  else echo "提醒：宿主层有待补项（sh host/setup-host.sh --check 可看）；更新完后手动跑：sudo sh host/setup-host.sh"; fi
fi
{ [ -f scripts/budget.sh ] && sh scripts/budget.sh; } || true   # 按整机内存重算转码预算（ZLM 内存上限 + 转码路数），手工写在 .env 自动块之外的值不动
docker compose config --quiet
docker compose pull --ignore-pull-failures
check_space "拉完镜像" || { echo "没启动新版本（还在跑旧版本）。清理后再跑 sh scripts/update.sh"; exit 1; }
{ [ -f scripts/gpu-calibrate.sh ] && sh scripts/gpu-calibrate.sh; } || true   # 显卡硬解路数实测（镜像刚拉完；硬件 / 镜像没变就秒退）
docker compose up -d --build --wait --wait-timeout 300 --remove-orphans
if [ -f "$STATE/previous-images.new" ]; then
  mv "$STATE/previous-images.new" "$STATE/previous-images"
  prune_old
else
  echo "没记下上一版镜像：这次不清旧镜像（免得把回退用的上一版也清掉）"
fi
echo "更新完成：$(git log -1 --format='%h %s')"
