#!/bin/sh
# 旁挂机器补齐「宿主」这一层（docker 之外的东西），和 H2Z OS 安装盘做的事对齐。可以重复跑：做过的步骤自动跳过。
#   sudo sh host/setup-host.sh                 补齐
#   sh host/setup-host.sh --check              只看缺什么（不要 root，不改任何东西）；有待补项退出码 3
#   sudo sh host/setup-host.sh --network=skip  不碰网口（auto = 默认，只在安全时接管；force = 不做安全检查，自己承担）
#
# 谁来跑：
#   新旁挂机器    git clone → sudo sh host/setup-host.sh → sh scripts/init.sh → docker compose up -d
#   老站点        scripts/update.sh 在 git pull 后发现有待补项会再跑
#   H2Z OS 安装盘 不跑这个：镜像里已经装好，首次开机由 h2z-os-firstboot 处理
#
# 步骤（每步先检查，已经做过就跳过；一步失败不挡后面的步骤，最后汇总，退出码 1）：
#   1. docker + compose 插件           缺就 scripts/install-docker.sh（只认 Ubuntu / Debian）
#   2. cloudflared                     Cloudflare 官方源装，装完删源和密钥（版本随机器锁定；服务单元由 host-agent 绑定时写出，见 docs/TUNNEL-API.md）
#   3. 网口 / 维护热点 / 防火墙        host/setup-host-network.sh；先做保护检查——只有 systemd-networkd + netplan + DHCP、没有静态地址时才接管，
#                                      否则跳过并写 /etc/h2z/setup-host.manual（原因），不会把远程机器搞断网。装过以后由 host-agent 跟着 git pull 自动同步
#   4. 板子看门狗                      host/install-watchdog.sh（脚本有变化也会更新）
#   5. 本地显示脚本                    host/install-kiosk.sh（没有本地显示的机器自动跳过）
# 测试：H2Z_INSTALL_ROOT=临时目录（系统路径加这个前缀）+ PATH 里放假命令——scripts/setup-host.test.mjs
set -eu
R=${H2Z_INSTALL_ROOT:-}
REPO=$(cd "$(dirname "$0")/.." && pwd)
MODE=apply; NET=auto
for a in "$@"; do
  case $a in
    --check) MODE=check ;;
    --network=auto|--network=skip|--network=force) NET=${a#--network=} ;;
    *) echo "不认识的参数：$a（用法见脚本开头）" >&2; exit 2 ;;
  esac
done
[ "$MODE" = check ] || [ -n "$R" ] || [ "$(id -u)" = 0 ] || exec sudo sh "$0" "$@"

H="$R/etc/h2z"
MANUAL_FILE="$H/setup-host.manual"
PENDING=""; FAILED=""

ok()      { echo "[ok]   $1"; }
todo()    { echo "[待补] $1"; PENDING="$PENDING $2"; }
manual()  { echo "[手动] $1"; }
skipped() { echo "[跳过] $1"; }

# 做一步：apply 模式执行，失败记下来继续
do_step() { # 名字 命令...
  name=$1; shift
  echo "── $name"
  if "$@"; then echo "[完成] $name"; else echo "[失败] $name" >&2; FAILED="$FAILED $name"; fi
}

# ---------------------------------------------------------------- 1. docker
have_docker() { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }
install_docker() { sh "$REPO/scripts/install-docker.sh"; }

# ---------------------------------------------------------------- 2. cloudflared
have_cloudflared() { [ -x "$R/usr/bin/cloudflared" ] || command -v cloudflared >/dev/null 2>&1; }
install_cloudflared() {
  # shellcheck disable=SC1091
  . "$R/etc/os-release"
  case ${ID:-} in ubuntu|debian) ;; *) echo "这个发行版（${ID:-?}）请按 Cloudflare 官方文档手动装 cloudflared" >&2; return 1 ;; esac
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /etc/apt/keyrings/cloudflare-main.gpg
  chmod a+r /etc/apt/keyrings/cloudflare-main.gpg
  cat > /etc/apt/sources.list.d/cloudflared.sources <<SRC
Types: deb
URIs: https://pkg.cloudflare.com/cloudflared
Suites: any
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/cloudflare-main.gpg
SRC
  rc=0
  { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cloudflared; } || rc=$?
  # 装完不留源和密钥：以后 apt upgrade 不会悄悄升级它，版本跟着这台机器走
  rm -f /etc/apt/sources.list.d/cloudflared.sources /etc/apt/keyrings/cloudflare-main.gpg
  return $rc
}

# ---------------------------------------------------------------- 3. 网口
# 能不能放心让 setup-host-network.sh 接管有线口：打印不能的原因（空 = 可以）。netplan 配置只有 root 能读。
netplan_unreadable=0
# net_unsafe 在子 shell 里跑（拿它的输出），所以「读不了」另外判断
netplan_readable() {
  files=$(ls "$R"/etc/netplan/*.yaml 2>/dev/null || true)
  [ -z "$files" ] && return 0
  # shellcheck disable=SC2086
  cat $files >/dev/null 2>&1
}
net_unsafe() {
  systemctl is-active --quiet systemd-networkd 2>/dev/null || { echo "systemd-networkd 没在跑（这台机器用别的网络管理器）"; return; }
  command -v netplan >/dev/null 2>&1 || { echo "没有 netplan"; return; }
  files=$(ls "$R"/etc/netplan/*.yaml 2>/dev/null || true)
  [ -n "$files" ] || { echo "/etc/netplan 里没有配置"; return; }
  # shellcheck disable=SC2086
  text=$(cat $files 2>/dev/null || true)
  if [ -z "$text" ]; then echo "读不了 /etc/netplan（要 root 才能判断）"; return; fi
  text=$(printf '%s\n' "$text" | sed 's/#.*//')
  printf '%s\n' "$text" | grep -qi 'renderer: *NetworkManager' && { echo "netplan 交给了 NetworkManager"; return; }
  printf '%s\n' "$text" | grep -q 'addresses:' && { echo "netplan 里有静态地址（接管会改成 DHCP）"; return; }
  printf '%s\n' "$text" | grep -Eq 'dhcp4: *(true|yes)' || { echo "netplan 里没有 dhcp4: true"; return; }
  ip -4 route show default 2>/dev/null | grep -q 'proto dhcp' || { echo "默认路由不是 DHCP 来的"; return; }
}

# ---------------------------------------------------------------- 4. 看门狗
watchdog_ok() {
  [ -f "$R/usr/local/lib/h2z/watchdog.sh" ] && cmp -s "$REPO/host/watchdog.sh" "$R/usr/local/lib/h2z/watchdog.sh" \
    && systemctl is-enabled --quiet h2z-watchdog.timer 2>/dev/null
}

# ================================================================= 汇总 / 执行
echo "宿主补齐（$MODE，目录 $REPO）"

if have_docker; then ok "docker + compose"; else
  if [ "$MODE" = check ]; then todo "docker + compose 没装" docker; else do_step "安装 docker" install_docker; fi
fi

if have_cloudflared; then ok "cloudflared"; else
  if [ "$MODE" = check ]; then todo "cloudflared 没装（Cloudflare 隧道要用）" cloudflared; else do_step "安装 cloudflared" install_cloudflared; fi
fi

# 网口
if [ -f "$H/host.env" ]; then
  ok "网口 / 热点（已初始化；之后 host-agent 跟着 git pull 自动同步）"
  rm -f "$MANUAL_FILE" 2>/dev/null || true
elif [ "$NET" = skip ]; then
  skipped "网口 / 热点（--network=skip）"
else
  reason=""
  [ "$NET" = force ] || reason=$(net_unsafe)
  netplan_readable || netplan_unreadable=1
  if [ "$MODE" = check ]; then
    if [ "$netplan_unreadable" = 1 ] && [ ! -f "$MANUAL_FILE" ]; then todo "网口 / 热点还没初始化（$reason）" network
    elif [ -f "$MANUAL_FILE" ] && [ -n "$reason" ]; then manual "网口 / 热点没自动接管：$(cat "$MANUAL_FILE" 2>/dev/null || echo "$reason")（确认安全后：sudo sh host/setup-host.sh --network=force）"
    elif [ -n "$reason" ]; then todo "网口 / 热点还没初始化（自动接管会被拦下：$reason）" network
    else todo "网口 / 热点还没初始化" network; fi
  elif [ -n "$reason" ]; then
    mkdir -p "$H"; echo "$reason" > "$MANUAL_FILE"
    manual "网口 / 热点没自动接管：$reason。确认安全后手动：sudo sh host/setup-host.sh --network=force"
  else
    rm -f "$MANUAL_FILE"
    do_step "初始化网口 / 热点 / 防火墙（host/setup-host-network.sh）" sh "$REPO/host/setup-host-network.sh"
  fi
fi

# 看门狗
if watchdog_ok; then ok "板子看门狗"; else
  if [ "$MODE" = check ]; then todo "板子看门狗没装或有更新" watchdog; else do_step "安装 / 更新看门狗" sh "$REPO/host/install-watchdog.sh"; fi
fi

# 本地显示脚本（没有本地显示的机器脚本自己跳过；host-agent 也会定期跑，所以 check 不算待补）
if [ "$MODE" = apply ]; then do_step "本地显示脚本" sh "$REPO/host/install-kiosk.sh"; fi

if [ "$MODE" = check ]; then
  if [ -n "$PENDING" ]; then echo "待补：$PENDING（sudo sh host/setup-host.sh）"; exit 3; fi
  echo "宿主都已就绪"; exit 0
fi
if [ -n "$FAILED" ]; then echo "失败的步骤：$FAILED（修好后重跑 sudo sh host/setup-host.sh，做过的会跳过）" >&2; exit 1; fi
echo "宿主补齐完成。接着：sh scripts/init.sh（新机器）→ docker compose up -d"
