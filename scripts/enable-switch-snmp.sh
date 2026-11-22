#!/usr/bin/env bash
# 用客户给的管理员账号，在 H3C(Comware) 交换机 / AC 上开一个「只读」SNMP v2c 团体名。
# 只做：开 snmp-agent、v2c、加一个只读团体名、保存。不改 VLAN / 路由 / 其它任何配置。
# 在 Orange Pi 上运行；默认只打印要执行的命令（不连设备），加 --apply 才真的去配。
#
#   scripts/enable-switch-snmp.sh 172.21.20.2                 # 看要执行什么
#   scripts/enable-switch-snmp.sh --apply 172.21.20.2         # 先在一台（建议核心）上配
#   scripts/enable-switch-snmp.sh --apply 172.21.20.2 172.21.20.3 172.21.20.4
#   选项：--user admin  --community <团体名，不给就随机生成>  管理员密码运行时输入（不回显，不写文件）
set -u
APPLY=0; USER_NAME="${SW_USER:-admin}"; COMM="${SNMP_COMMUNITY:-}"; IPS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --user) USER_NAME="$2"; shift ;;
    --community) COMM="$2"; shift ;;
    -h|--help) sed -n 2,11p "$0"; exit 0 ;;
    *) IPS+=("$1") ;;
  esac; shift
done
[ ${#IPS[@]} -gt 0 ] || { echo "用法：$0 [--apply] <交换机IP> [<交换机IP> ...]"; exit 1; }
for ip in "${IPS[@]}"; do [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "地址不对：$ip"; exit 1; }; done
[ -n "$COMM" ] || COMM="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)"
[[ "$COMM" =~ ^[A-Za-z0-9._-]{8,64}$ ]] || { echo "团体名只能是字母数字 . _ -，8~64 位"; exit 1; }

CMDS=( "system-view" "snmp-agent" "snmp-agent sys-info version v2c" "snmp-agent community read $COMM" "lldp global enable" "return" "save force" "display snmp-agent community read" )

if [ "$APPLY" -ne 1 ]; then
  echo "【只看不配】对 ${IPS[*]} 会依次执行（登录用户 $USER_NAME）："
  printf '  %s\n' "${CMDS[@]}"; echo; echo "确认没问题后加 --apply 再运行。"; exit 0
fi
command -v sshpass >/dev/null || { echo "需要 sshpass：sudo apt-get install -y sshpass"; exit 1; }
read -rs -p "交换机管理员密码（$USER_NAME）：" PASS; echo
[ -n "$PASS" ] || { echo "密码不能为空"; exit 1; }
# H3C 老版本 SSH 只支持老算法，这里放开兼容
SSHO=(-tt -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
      -o KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group1-sha1 -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa)
OK=0; BAD=0
for ip in "${IPS[@]}"; do
  echo "== $ip"
  OUT="$(mktemp)"
  { sleep 2; for c in "${CMDS[@]}"; do echo "$c"; sleep 0.7; done; sleep 2; echo quit; } \
    | SSHPASS="$PASS" sshpass -e ssh "${SSHO[@]}" "$USER_NAME@$ip" >"$OUT" 2>&1
  if grep -qiE 'permission denied|authentication fail|connection (refused|timed out)|no route' "$OUT"; then
    echo "   登录失败："; tail -3 "$OUT" | sed 's/^/   /'; BAD=$((BAD+1))
  elif grep -qE '^% |Unrecognized command|Wrong parameter|Incomplete command' "$OUT"; then
    echo "   有命令被设备拒绝（型号 / 版本可能不同），回显如下："; grep -nE '^% |Unrecognized|Wrong|Incomplete' "$OUT" | head -5 | sed 's/^/   /'; BAD=$((BAD+1))
  else
    echo "   已配置并保存"; OK=$((OK+1))
  fi
  rm -f "$OUT"
done
unset PASS
echo; echo "完成：成功 $OK 台，失败 $BAD 台"
echo "只读团体名（填到 IOC 拓扑页「交换机 · 端口拓扑 → 高级 → SNMP v2c」）：$COMM"
