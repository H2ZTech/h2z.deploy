#!/bin/sh
# H2Z 板子看门狗（2026-11-02 负责人确认）：systemd 每分钟跑一次（h2z-watchdog.timer），装在主机上、不依赖 Docker。
# 查：网口 / 网关 / 外网、Tailscale、我们的容器、Docker 本身、系统盘和 Docker 盘的空闲。
# 自动动作（只有这三种，都限频）：
#   外网通但 Tailscale 连续 5 分钟不在线      → 重启我们的 tailscale 容器（15 分钟最多一次）
#     本机已有别的 Tailscale（飞牛 / 群晖自带的 tailscaled，不在容器里）或 tailscale 服务被禁用（compose.override.yaml
#     profiles）时完全不管 Tailscale：我们的容器一起来就抢 tailscale0，把宿主机 Tailscale 的地址冲掉（LA9 2026-11-02）
#   网口通但连续 5 分钟没地址 / 网关不通      → 重启主机网络服务（30 分钟最多一次）
#   我们的长期运行容器退出 / 不健康（连续 2 次）→ docker compose up -d（只动本项目，10 分钟最多一次）
# 不做：重启 Docker（会连带邻居的容器）、因为断网重启整机（现场断网时录像照常写本地）。
# 系统死机由硬件看门狗处理（systemd RuntimeWatchdogSec，install-watchdog.sh 设置）。
# 结果写 $STATE_DIR/status.json（后端读来发告警），动作写系统日志（logger -t h2z-watchdog）。
# 维护时暂停：touch $STATE_DIR/pause（文件里可写到期时间戳；update.sh 更新时自动暂停）。
set -u
DIR=${H2Z_DIR:-}
[ -n "$DIR" ] || [ ! -f /etc/h2z/watchdog.env ] || . /etc/h2z/watchdog.env
DIR=${H2Z_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
STATE_DIR=${WATCHDOG_STATE_DIR:-/var/lib/h2z/watchdog}
NOW=${WATCHDOG_NOW:-$(date +%s)}
TS_GRACE=${WATCHDOG_TS_GRACE:-300}; TS_EVERY=${WATCHDOG_TS_EVERY:-900}
NET_GRACE=${WATCHDOG_NET_GRACE:-300}; NET_EVERY=${WATCHDOG_NET_EVERY:-1800}
SVC_EVERY=${WATCHDOG_SVC_EVERY:-600}
PROC=${WATCHDOG_PROC:-/proc}
DISK_LOW_PCT=${WATCHDOG_DISK_LOW_PCT:-5}
mkdir -p "$STATE_DIR"
STATE="$STATE_DIR/state"
ACTIONS="$STATE_DIR/actions"
touch "$STATE" "$ACTIONS"

get() { sed -n "s/^$1=//p" "$STATE" | tail -n 1; }
put() { grep -v "^$1=" "$STATE" > "$STATE.tmp" 2>/dev/null; echo "$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }
log() { logger -t h2z-watchdog "$1" 2>/dev/null || true; }
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r'; }
act() { # 动作 说明
  log "$1：$2"
  printf '%s\t%s\t%s\n' "$NOW" "$1" "$2" >> "$ACTIONS"
  tail -n 20 "$ACTIONS" > "$ACTIONS.tmp" && mv "$ACTIONS.tmp" "$ACTIONS"
}
dc() { docker compose --project-directory "$DIR" "$@"; }
since() { # 名字 条件(0/1)：条件成立就记开始时间，返回持续秒数；不成立清掉
  if [ "$2" = 1 ]; then s=$(get "$1"); [ -n "$s" ] || { s=$NOW; put "$1" "$s"; }; echo $((NOW - s)); else put "$1" ""; echo 0; fi
}
due() { l=$(get "$1"); [ -z "$l" ] || [ $((NOW - l)) -ge "$2" ]; }

paused=0
if [ -f "$STATE_DIR/pause" ]; then
  until=$(cat "$STATE_DIR/pause" 2>/dev/null | tr -cd 0-9)
  if [ -z "$until" ] || [ "$until" -gt "$NOW" ]; then paused=1; else rm -f "$STATE_DIR/pause"; fi
fi

# ── 网络 ──
link=0; ipok=0; gw=""; gwok=0; inet=0
for i in $(ip -o link show up 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1); do
  case $i in lo|docker*|br-*|veth*|tailscale*|wl*|virbr*) continue ;; esac
  ip -o link show "$i" 2>/dev/null | grep -q LOWER_UP && { link=1; ip -o -4 addr show "$i" 2>/dev/null | grep -q inet && ipok=1; }
done
gw=$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')
[ -n "$gw" ] && ping -c 1 -W 2 "$gw" >/dev/null 2>&1 && gwok=1
if getent hosts controlplane.tailscale.com >/dev/null 2>&1; then
  for t in 1.1.1.1 8.8.8.8 223.5.5.5; do ping -c 1 -W 2 "$t" >/dev/null 2>&1 && { inet=1; break; }; done
fi
lan_bad=0; [ "$link" = 1 ] && { [ "$ipok" = 0 ] || [ "$gwok" = 0 ]; } && lan_bad=1
lan_down=$(since lan_bad_since "$lan_bad")
inet_down=$(since inet_down_since $((1 - inet)))

# ── Docker / 我们的容器 ──
dock=0; docker_root=""
if timeout 20 docker info >/dev/null 2>&1; then
  dock=1; docker_root=$(timeout 10 docker info -f '{{.DockerRootDir}}' 2>/dev/null); put docker_root "$docker_root"
else docker_root=$(get docker_root); fi
docker_down=$(since docker_down_since $((1 - dock)))
down=""
ts_state=""; ts_online=0
if [ "$dock" = 1 ]; then
  for id in $(timeout 20 docker compose --project-directory "$DIR" ps -aq 2>/dev/null); do
    info=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.HostConfig.RestartPolicy.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null) || continue
    set -- $info
    case ${2:-} in always|unless-stopped|on-failure) ;; *) continue ;; esac   # 一次性的初始化服务退出是正常的
    if [ "${3:-}" != running ] || [ "${4:-}" = unhealthy ]; then down="$down ${1:-?}"; fi
  done
  # 本机自己的 Tailscale（进程不在 Docker 里）/ 本机禁用了我们的 tailscale 服务：不管
  for p in $(pgrep -x tailscaled 2>/dev/null); do grep -qE 'docker|containerd' "$PROC/$p/cgroup" 2>/dev/null || ts_state=HostTailscale; done
  if [ -z "$ts_state" ] && ! timeout 20 docker compose --project-directory "$DIR" config --services 2>/dev/null | grep -qx tailscale; then ts_state=Disabled; fi
  tsid=""; [ -n "$ts_state" ] || tsid=$(timeout 20 docker compose --project-directory "$DIR" ps -q tailscale 2>/dev/null)
  if [ -n "$ts_state" ]; then :
  elif [ -n "$tsid" ]; then
    j=$(timeout 15 docker exec "$tsid" tailscale status --json 2>/dev/null | tr -d ' \n')
    ts_state=$(printf '%s' "$j" | sed -n 's/.*"BackendState":"\([A-Za-z]*\)".*/\1/p')
    printf '%s' "$j" | grep -q '"Online":true' && ts_online=1
  else ts_state="NoContainer"; fi
fi
down=${down# }
svc_bad=0; [ -n "$down" ] && svc_bad=1
svc_n=$(get svc_bad_count); [ "$svc_bad" = 1 ] && svc_n=$(( ${svc_n:-0} + 1 )) || svc_n=0; put svc_bad_count "$svc_n"
ts_bad=0; [ "$dock" = 1 ] && [ "$inet" = 1 ] && { [ "$ts_state" != Running ] || [ "$ts_online" = 0 ]; } && ts_bad=1
case $ts_state in HostTailscale|Disabled) ts_bad=0 ;; esac
ts_down=$(since ts_bad_since "$ts_bad")

# ── 自动动作（暂停时不做）──
if [ "$paused" = 0 ]; then
  if [ "$ts_bad" = 1 ] && [ "$ts_down" -ge "$TS_GRACE" ] && due last_ts_restart "$TS_EVERY"; then
    put last_ts_restart "$NOW"
    if [ "$ts_state" = NoContainer ]; then dc up -d tailscale >/dev/null 2>&1; else dc restart tailscale >/dev/null 2>&1; fi \
      && act restart-tailscale "外网通但 Tailscale $((ts_down / 60)) 分钟不在线（$ts_state）：重启 tailscale 容器" \
      || act failed "重启 tailscale 容器没成功"
  fi
  if [ "$lan_bad" = 1 ] && [ "$lan_down" -ge "$NET_GRACE" ] && due last_net_restart "$NET_EVERY"; then
    put last_net_restart "$NOW"
    why="网口通但 $((lan_down / 60)) 分钟$([ "$ipok" = 0 ] && echo 没有地址 || echo 网关 "$gw" 不通)"
    if systemctl is-active --quiet NetworkManager 2>/dev/null; then systemctl restart NetworkManager && act restart-network "$why：重启 NetworkManager" || act failed "重启 NetworkManager 没成功"
    elif command -v netplan >/dev/null 2>&1; then netplan apply && act restart-network "$why：netplan apply" || act failed "netplan apply 没成功"
    else systemctl restart systemd-networkd && act restart-network "$why：重启 systemd-networkd" || act failed "重启 systemd-networkd 没成功"; fi
  fi
  if [ "$svc_n" -ge 2 ] && due last_svc_up "$SVC_EVERY"; then
    put last_svc_up "$NOW"
    dc up -d >/dev/null 2>&1 && act restart-services "服务没在运行：$down → docker compose up -d" || act failed "docker compose up -d 没成功（$down）"
  fi
fi

# ── 磁盘 ──
disks=""; seen_mounts=""
for p in / $docker_root; do
  [ -d "$p" ] || continue
  set -- $(df -P -B1 "$p" 2>/dev/null | awk 'NR==2 {print $2, $4, $6}')
  [ -n "${1:-}" ] || continue
  case " $seen_mounts " in *" $3 "*) continue ;; esac
  seen_mounts="$seen_mounts $3"
  pct=$(( ${2} * 100 / ${1} ))
  low=false; [ "$pct" -lt "$DISK_LOW_PCT" ] && low=true
  disks="$disks{\"path\":\"$(esc "$p")\",\"mount\":\"$(esc "$3")\",\"totalBytes\":$1,\"freeBytes\":$2,\"freePct\":$pct,\"low\":$low},"
done

# ── 状态文件（后端读来发告警）──
acts=""
while IFS="$(printf '\t')" read -r at a d; do
  [ -n "$at" ] || continue
  acts="{\"at\":$at,\"action\":\"$(esc "$a")\",\"detail\":\"$(esc "$d")\"},$acts"
done < "$ACTIONS"
dl=""; for s in $down; do dl="$dl\"$(esc "$s")\","; done
b() { [ "$1" = 1 ] && echo true || echo false; }
cat > "$STATE_DIR/status.json.tmp" <<EOF
{"version":1,"at":$NOW,"paused":$(b $paused),
"net":{"link":$(b $link),"ip":$(b $ipok),"gateway":"$(esc "$gw")","gatewayOk":$(b $gwok),"internet":$(b $inet),"lanBadSec":$lan_down,"internetDownSec":$inet_down},
"tailscale":{"state":"$(esc "$ts_state")","online":$(b $ts_online),"badSec":$ts_down},
"docker":{"ok":$(b $dock),"downSec":$docker_down,"root":"$(esc "$docker_root")"},
"services":{"down":[${dl%,}],"badChecks":$svc_n},
"disks":[${disks%,}],
"actions":[${acts%,}]}
EOF
mv "$STATE_DIR/status.json.tmp" "$STATE_DIR/status.json"
chmod 644 "$STATE_DIR/status.json"
