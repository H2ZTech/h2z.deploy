#!/bin/sh
# B 线一键部署：在一台全新的 Debian / Ubuntu 机器（x86_64 或 arm64）上，从零装到服务启动。
#
# 一条命令（在目标 Linux 上，不需要任何 token / 账号）：
#   curl -fsSL https://raw.githubusercontent.com/H2ZTech/h2z.deploy/main/install.sh | sudo sh
#   先只看会做什么：... | sudo sh -s -- --dry-run
# 代码来自公开仓库 H2ZTech/h2z.deploy（由私有仓库 h2z.security 自动同步部署所需文件，见
# .github/workflows/publish-deploy-mirror.yml）；镜像来自 GHCR，也是公开的。
# 内部人员要从私有仓库取代码：REPO_SLUG=H2ZTech/h2z.security GH_TOKEN=github_pat_xxx（只读 token）sudo -E sh ...
#   或 --auth deploykey（生成只读 SSH key，等你加到 GitHub Deploy keys）。
#
# 选项：
#   --dir PATH      代码目录（默认 <登录用户家目录>/h2z.security）
#   --branch NAME   分支（默认 main）
#   --auth MODE     none | token | deploykey（默认：设了 GH_TOKEN 用 token，否则 none）
#   --network MODE  传给 host/setup-host.sh 的 --network（默认 skip：远程装机不碰网口，装好后再手动处理）
#   --no-start      装好工具、拉好代码、初始化配置，但不 docker compose up
#   --force         arm64 镜像检查有 FAIL 也继续
#   --yes           保留的兼容选项（没有终端时脚本本来就不会提问）
#   --dry-run       不改任何东西
#
# 镜像全部来自 GHCR（ghcr.io/h2ztech/，公开，免登录）；脚本不会登录任何镜像仓库。
# 可以重复跑：做过的步骤自动跳过。
set -eu

REPO_SLUG=${REPO_SLUG:-H2ZTech/h2z.deploy}   # 公开的部署镜像仓库，免 token
REPO_URL=${REPO_URL:-https://github.com/$REPO_SLUG.git}
BRANCH=main; DIR=; AUTH=; NET=skip; START=1; FORCE=0; YES=0; DRY=0
while [ $# -gt 0 ]; do
  case $1 in
    --dir) DIR=$2; shift ;; --branch) BRANCH=$2; shift ;; --auth) AUTH=$2; shift ;; --network) NET=$2; shift ;;
    --no-start) START=0 ;; --force) FORCE=1 ;; --yes) YES=1 ;; --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac; shift
done

say() { printf '\n== %s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

# ---------- 1. 检测 ----------
say "1/8 检测系统和硬件"
[ -r /etc/os-release ] || die "没有 /etc/os-release，无法判断系统"
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "只支持 Debian / Ubuntu（当前：${PRETTY_NAME:-未知}）" ;; esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "不支持的 CPU 架构：$(uname -m)（只支持 x86_64 / arm64）" ;;
esac
MODEL=$( { [ -r /proc/device-tree/model ] && tr -d '\0' < /proc/device-tree/model; } 2>/dev/null || cat /sys/class/dmi/id/product_name 2>/dev/null || echo 未知)
MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
KIND=通用
case "$MODEL" in *[Oo]range*|*RK35*|*Rockchip*) KIND="Orange Pi / RK3588 类板子" ;; esac
echo "系统：${PRETTY_NAME}    架构：$ARCH    机型：$MODEL ($KIND)    内存：${MEM_MB} MB"
[ "$MEM_MB" -ge 3500 ] || echo "警告：内存不足 4 GB，全栈可能起不来"
[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || die "请用 sudo 运行"
if [ "$ARCH" = arm64 ] && [ "$KIND" = 通用 ]; then echo "提示：这是 arm64 但不是常见的 Orange Pi 板子，镜像检查通过才会启动"; fi

U=${SUDO_USER:-$(id -un)}
HOME_U=$(getent passwd "$U" | cut -d: -f6); [ -n "$HOME_U" ] || HOME_U=$HOME
[ -n "$DIR" ] || DIR=$HOME_U/h2z.security
have_tty() { (exec </dev/tty) 2>/dev/null; }
as_user() { if [ "$(id -u)" = 0 ] && [ "$U" != root ]; then sudo -u "$U" -H "$@"; else "$@"; fi; }
# docker 组刚加入、当前会话还没生效时用 sg 兜底
dk() { if as_user docker info >/dev/null 2>&1; then as_user sh -c "$1"; else as_user sg docker -c "$1"; fi; }
echo "登录用户：$U    代码目录：$DIR    分支：$BRANCH"

# 磁盘：Docker 数据目录所在盘空闲（还没装 docker 就看 /var/lib/docker 所在盘）
DR=/var/lib/docker; command -v docker >/dev/null 2>&1 && DR=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
CHK=$DR; [ -e "$CHK" ] || CHK=/var/lib
FREE_GB=$(df -P -B1 "$CHK" | awk 'NR==2 {printf "%d", $4/1e9}')
echo "Docker 数据盘空闲：${FREE_GB} GB（需要 ≥ 15 GB）"
[ "$FREE_GB" -ge 15 ] || { [ "$FORCE" = 1 ] || die "磁盘空闲不足 15 GB；腾出空间，或加 --force 硬装"; }
if [ "$ARCH" = arm64 ]; then
  ROOTDEV=$(findmnt -n -o SOURCE / 2>/dev/null || true)
  case "$ROOTDEV" in /dev/mmcblk*) echo "警告：根分区在 TF 卡（$ROOTDEV）。录像和数据库会很快把卡写坏，生产请用 SSD" ;; esac
fi

# ---------- 2. 基础工具 ----------
say "2/8 安装基础工具"
run apt-get update -y
run apt-get install -y git ca-certificates curl jq python3 nodejs npm openssh-client

# ---------- 3. 取代码 ----------
say "3/8 取代码（$REPO_SLUG）"
[ -n "$AUTH" ] || { if [ -n "${GH_TOKEN:-}" ]; then AUTH=token; else AUTH=none; fi; }
if [ -d "$DIR/.git" ]; then
  echo "代码目录已存在，只更新：$DIR"
  run as_user git -C "$DIR" fetch origin
  run as_user git -C "$DIR" switch "$BRANCH"
  run as_user git -C "$DIR" pull --ff-only origin "$BRANCH"
else
  case $AUTH in
    none)
      run as_user git clone --branch "$BRANCH" "$REPO_URL" "$DIR" ;;
    token)
      if [ -z "${GH_TOKEN:-}" ] && [ "$DRY" = 0 ]; then
        have_tty || die "没有终端可输入 token：请用 sudo GH_TOKEN=xxx sh ... 传入"
        printf 'GitHub token（只读，输入不显示）：' >/dev/tty; stty -echo </dev/tty; read -r GH_TOKEN </dev/tty; stty echo </dev/tty; printf '\n' >/dev/tty
        [ -n "$GH_TOKEN" ] || die "token 为空"
      fi
      if [ "$DRY" = 1 ]; then echo "[dry-run] git clone（token）并把 token 存进 $HOME_U/.git-credentials（600）"
      else
        CRED=$HOME_U/.git-credentials
        ( umask 077; touch "$CRED"; grep -v '@github.com' "$CRED" > "$CRED.tmp" 2>/dev/null || true
          printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" >> "$CRED.tmp"; mv "$CRED.tmp" "$CRED" )
        chown "$U" "$CRED"; chmod 600 "$CRED"
        as_user git config --global credential.helper store
        as_user git clone --branch "$BRANCH" "git@github-h2z-security:$REPO_SLUG.git" "$DIR"
      fi ;;
    deploykey)
      KEY=$HOME_U/.ssh/h2z_security_deploy
      if [ "$DRY" = 1 ]; then echo "[dry-run] 生成 $KEY，等你把公钥加到 GitHub Deploy keys，然后 git clone"
      else
        as_user mkdir -p "$HOME_U/.ssh"; as_user chmod 700 "$HOME_U/.ssh"
        [ -f "$KEY" ] || as_user ssh-keygen -t ed25519 -N '' -C "h2z-$(hostname)" -f "$KEY"
        if ! grep -q 'Host github-h2z-security' "$HOME_U/.ssh/config" 2>/dev/null; then
          as_user sh -c "cat >> '$HOME_U/.ssh/config' <<EOF
Host github-h2z-security
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF"
          as_user chmod 600 "$HOME_U/.ssh/config"
        fi
        until as_user git ls-remote "git@github-h2z-security:$REPO_SLUG.git" HEAD >/dev/null 2>&1; do
          echo; echo "把下面这一行公钥加到 https://github.com/$REPO_SLUG/settings/keys （Add deploy key，不要勾 Allow write access）："
          echo; cat "$KEY.pub"; echo
          have_tty || die "没有终端可等待：请先把上面的公钥加到 GitHub 后重跑，或改用 GH_TOKEN"
          printf '添加完按回车继续（Ctrl-C 退出）…' >/dev/tty; read -r _ </dev/tty
        done
        as_user git clone --branch "$BRANCH" "git@github-h2z-security:$REPO_SLUG.git" "$DIR"
      fi ;;
    *) die "--auth 只能是 token / deploykey / none" ;;
  esac
fi
[ "$DRY" = 1 ] || [ -f "$DIR/compose.yaml" ] || die "代码目录里没有 compose.yaml：$DIR"

# ---------- 4. 宿主层（Docker、看门狗等） ----------
say "4/8 安装 Docker 和宿主层（host/setup-host.sh --network=$NET）"
run sh "$DIR/host/setup-host.sh" "--network=$NET"
[ "$DRY" = 1 ] || command -v docker >/dev/null 2>&1 || die "Docker 没装上，看上面 setup-host 的输出"
[ "$DRY" = 1 ] || [ "$U" = root ] || id -nG "$U" | tr ' ' '\n' | grep -qx docker || run usermod -aG docker "$U"

# ---------- 5. 初始化配置 ----------
say "5/8 生成 .env 和密钥（scripts/init.sh）"
if [ "$DRY" = 1 ]; then echo "[dry-run] sh scripts/init.sh"; else dk "cd '$DIR' && sh scripts/init.sh"; fi
if [ "$DRY" = 0 ]; then
  # 隔离检查：自家镜像必须都是 GHCR
  BAD=$(grep -E '^[A-Z_]+_IMAGE=' "$DIR/.env" | grep -E 'h2z|riser' | grep -v '=ghcr.io/h2ztech/' || true)
  [ -z "$BAD" ] || die ".env 里有非 GHCR 的自家镜像，删掉 $DIR/.env 重跑：
$BAD"
fi

# ---------- 6. 镜像检查（arm64） ----------
say "6/8 镜像检查"
if [ "$ARCH" = arm64 ]; then
  if [ "$DRY" = 1 ]; then echo "[dry-run] node scripts/check-images.mjs arm64"
  elif ! dk "cd '$DIR' && node scripts/check-images.mjs arm64"; then
    [ "$FORCE" = 1 ] || die "有镜像没有 arm64 版本（见上面的 FAIL）。先在对应仓库的 Actions 触发 arm64 构建；确认要硬装加 --force"
  fi
else echo "x86：跳过 arm64 检查"; fi

# ---------- 7. 启动 ----------
if [ "$START" = 0 ]; then
  say "7/8 已按 --no-start 停在这里"; echo "之后启动：cd $DIR && docker compose pull && docker compose up -d --wait --wait-timeout 180"; exit 0
fi
say "7/8 拉镜像并启动（第一次要下载几个 GB，几分钟到几十分钟）"
if [ "$DRY" = 1 ]; then echo "[dry-run] docker compose config / pull / up -d --wait"; else
  dk "cd '$DIR' && docker compose config --quiet && docker compose pull && docker compose up -d --wait --wait-timeout 180"
fi

# ---------- 8. 建默认项目 + 冒烟 ----------
say "8/8 建默认项目并冒烟"
if [ "$DRY" = 1 ]; then echo "[dry-run] node scripts/seed-project.mjs && node scripts/smoke.mjs"; else
  dk "cd '$DIR' && node scripts/seed-project.mjs" || echo "seed-project 失败（可稍后手动重跑）"
  dk "cd '$DIR' && node scripts/smoke.mjs" || echo "smoke 有失败项，见上面输出"
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

完成。
  大屏：   http://${IP:-<本机IP>}:8096/ioc   （默认只绑本机；让局域网访问：编辑 $DIR/.env 把 HTTP_BIND 改成 0.0.0.0，再 docker compose up -d）
  后台：   /ioc/admin    默认账号 admin / h2z2026   —— 交付前必须修改
  以后更新：cd $DIR && sh scripts/update.sh
  详细验收清单：$DIR/docs/DEPLOY-B-LINE.md 第 4 节
EOF
