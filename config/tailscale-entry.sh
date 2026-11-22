#!/bin/sh
# Tailscale 启动入口：按端口绑定决定要不要用 Tailscale Serve 转发（负责人 2026-10-16 板上实测踩到）。
#
# Tailscale 跑在 host 网络 + 内核 tun 模式，tailnet 地址（100.x）就在板子的 tailscale0 网卡上：
#   - 端口发布在 0.0.0.0（HTTP_BIND / AI_WEB_BIND=0.0.0.0，现场 LAN 要直接打开时的设置）：
#     100.x:端口 本来就通，不需要 Serve；而且 Serve 会在 100.x:端口 上真的监听，
#     docker 再绑 0.0.0.0:端口 就报 address already in use（谁先起谁赢，重启后 web 起不来）。
#   - 端口只发布在 127.0.0.1（默认）：tailnet 访问不到，才用 Serve 把 100.x:端口 转到 127.0.0.1:端口。
# 所以 Serve 只转「绑在回环地址上的端口」。不需要转时也写一个空配置：Serve 设置会存进 tailscaled 状态，
# 必须显式清掉，否则老版本留下的转发还会占着端口。
set -eu
# 本机已经有别的 Tailscale（飞牛 / 群晖这类系统自带的，占着 tailscale0）：不启动、也不反复重启（重启会把它的地址冲掉，
# tailnet 上 IOC 8096 就打不开；LA9 2026-11-02）。我们自己的 tailscaled 退出时网卡随之删除，所以启动时网卡还在 = 别人的。
if [ -e /sys/class/net/tailscale0 ]; then
  echo "h2z: 本机已有 Tailscale（tailscale0 被别的程序占用），不启动产品自带的 tailscale；远程访问走本机的 Tailscale"
  exec sleep 2147483647
fi
out=/tmp/h2z-serve.json
entries=''
add() { # $1 = 绑定地址  $2 = 端口
  case "${1:-127.0.0.1}" in
    127.*|localhost|::1) entries="${entries}${entries:+,}\"$2\":{\"TCPForward\":\"127.0.0.1:$2\"}" ;;
  esac
}
add "${H2Z_HTTP_BIND:-127.0.0.1}" "${H2Z_HTTP_PORT:-8096}"
add "${H2Z_DSH_BIND:-127.0.0.1}" "${H2Z_DSH_PORT:-3096}"
# 设备网页代理端口段（与 IOC 同一个绑定；h2z.ioc docs/DEVICE-WEB-PROXY.md）
case "${H2Z_DEVICE_WEB_PORTS:-}" in
  *-*) dw_from=${H2Z_DEVICE_WEB_PORTS%-*}; dw_to=${H2Z_DEVICE_WEB_PORTS#*-}
       p=$dw_from; while [ "$p" -le "$dw_to" ]; do add "${H2Z_HTTP_BIND:-127.0.0.1}" "$p"; p=$((p + 1)); done ;;
esac
if [ -n "$entries" ]; then printf '{"TCP":{%s}}\n' "$entries" > "$out"; else printf '{}\n' > "$out"; fi
echo "h2z: tailscale serve config: $(cat "$out")"
export TS_SERVE_CONFIG="$out"
# 没有授权密钥、也还没登录过：不能直接交给 containerboot。它会自己跑一次不带密钥的 tailscale up 等 60 秒，
# 等不到就杀掉 tailscaled、容器重启、换一个新的节点密钥和登录链接——页面上发的链接刚点开就作废，
# 登录永远完不成（LA18 2026-11-11：日志里反复 "tailscale up failed: context deadline exceeded"）。
# 所以这种情况先只跑 tailscaled，等 IOC 页面（host-agent 的 tailscale login）登录成功，再把守护进程交给 containerboot
# 接管（它读已保存的登录，不再 up，并套上面的 Serve 配置）。有授权密钥、或已经登录过的，照旧直接 containerboot。
if [ -z "${TS_AUTHKEY:-}" ]; then
  sock="${TS_SOCKET:-/var/run/tailscale/tailscaled.sock}"
  tailscaled --socket="$sock" --statedir="${TS_STATE_DIR:-/var/lib/tailscale}" &
  tsd=$!
  state=''
  i=0
  while [ "$i" -lt 30 ]; do # 守护进程刚起来是 NoState，等它报出真实状态
    state=$(tailscale --socket="$sock" status --json 2>/dev/null | sed -n 's/^  "BackendState": "\([A-Za-z]*\)".*/\1/p' | head -n1 || true)
    case "$state" in ''|NoState) sleep 1; i=$((i + 1)) ;; *) break ;; esac
  done
  case "$state" in
    NeedsLogin|NeedsMachineAuth|'')
      echo "h2z: tailscale 还没登录，只运行 tailscaled，等页面登录（状态: ${state:-未知}）"
      while kill -0 "$tsd" 2>/dev/null; do
        state=$(tailscale --socket="$sock" status --json 2>/dev/null | sed -n 's/^  "BackendState": "\([A-Za-z]*\)".*/\1/p' | head -n1 || true)
        case "$state" in Running|Starting|Stopped) break ;; esac
        sleep 3
      done
      ;;
  esac
  # 节点名：.env 的 TAILSCALE_HOSTNAME；没填就取对外网址（TUNNEL_DEFAULT_HOSTNAME）的第一段（la18.c2htech.com → la18），
  # 再没有就是板子的主机名（ubuntu 这种，多台分不出来）。已经登录过的也改，所以用 tailscale set 而不是靠 containerboot 的 TS_HOSTNAME
  want=${TS_HOSTNAME:-${H2Z_TUNNEL_DEFAULT_HOSTNAME%%.*}}
  want=$(printf '%s' "$want" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n-' '-' | sed 's/^-*//; s/-*$//')
  case "$state" in Running|Starting|Stopped|NeedsMachineAuth)
    [ -z "$want" ] || tailscale --socket="$sock" set --hostname="$want" >/dev/null 2>&1 || true ;;
  esac
  # 交给 containerboot：先停掉我们起的 tailscaled（登录已经存在状态目录里）
  kill "$tsd" 2>/dev/null || true
  wait "$tsd" 2>/dev/null || true
  echo "h2z: tailscale 已登录，交给 containerboot"
fi
exec /usr/local/bin/containerboot
