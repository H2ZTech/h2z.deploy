#!/usr/bin/env bash
# 瘦底座验证（开发计划 M0，docs/DEV-PLAN-2026-11-04-LEAN-BASE-PACKS.md）：
# 去掉扩展服务（emqx / AI / tailscale / TDengine / 运动检测）之后，底座还能不能起，
# 本地控制台各接口和报警是否正常，日志有没有刷屏；顺便量各组镜像的体积（docs/LEAN-BASE-MEASURE.md）。
#
# 在测试机上跑（要 docker compose ≥ 2.24.4、curl、jq）。它会临时把本项目的栈改成「只有底座」：
#   1. 暂停看门狗（装了的话）；删除扩展服务的容器（数据卷不动）
#   2. 用临时覆盖文件重建 backend（去掉对 emqx / h2z-api 的依赖和 MQTT / H2Z 环境变量）
#      和 host-agent（去掉对 tailscale-cli 的依赖，并让它找不到 Tailscale）
#   3. 像本地控制台那样轮询接口 --settle 秒，再检查：容器健康、接口、报警、日志、资源占用
#   4. 恢复原来的完整栈
# 不改仓库里的任何文件；覆盖文件、日志和报告都在 --out 目录。不打印口令，日志片段里的 URL 口令 / token 会打码。
#
# 用法（sudo：要读 secrets/、写看门狗暂停文件）：
#   sudo bash lean-base-probe.sh --project-dir /opt/h2z.security               只看会做什么，不改任何东西
#   sudo bash lean-base-probe.sh --project-dir /opt/h2z.security --yes         真跑（约 6–8 分钟，本地控制台会中断 1–2 分钟）
#   sudo bash lean-base-probe.sh --project-dir /opt/h2z.security --images-only 只量镜像体积，不动栈
# 其它：--settle 秒数（默认 120，要 ≥ 90 才能等到防抖后的报警）
#       --alarm-drill   停 recorder 看报警能不能出、恢复后能不能自己消失（要本地录像机里有摄像头；录像会断几分钟）
#       --stop-tailscale 也删 tailscale 容器（默认不动：经 Tailscale 登录这台机器时删了会断线）
#       --keep          跑完不恢复，留着瘦底座自己看（恢复命令会打印出来）
#       --print-override 只把要用的覆盖文件打印出来就退出（不碰 Docker；compose.lean.yaml 是它的正式版，测试会核对两者一致）
#       --out 目录      覆盖文件 / 日志 / 报告放哪（默认 /tmp/h2z-lean-probe）
set -u

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -f /opt/h2z.security/compose.yaml ]; then PROJECT_DIR=/opt/h2z.security; else PROJECT_DIR=$(cd "$SELF_DIR/.." && pwd); fi
OUT=/tmp/h2z-lean-probe
SETTLE=120
YES=0; KEEP=0; IMAGES_ONLY=0; DRILL=0; STOP_TS=0; PRINT_OVERRIDE=0
LOOP_SEC=${H2Z_PROBE_LOOP:-10}   # 轮询间隔（秒；本地控制台报警 / 录像机是 10 秒）。测试时调小
POLL_SEC=${H2Z_PROBE_POLL:-15}   # 报警演练里看报警的间隔（秒）

usage() { sed -n '2,/^set -u/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case $1 in
    --project-dir) PROJECT_DIR=${2:-}; shift 2 ;;
    --out) OUT=${2:-}; shift 2 ;;
    --settle) SETTLE=${2:-}; shift 2 ;;
    --yes) YES=1; shift ;;
    --keep) KEEP=1; shift ;;
    --images-only) IMAGES_ONLY=1; shift ;;
    --alarm-drill) DRILL=1; shift ;;
    --stop-tailscale) STOP_TS=1; shift ;;
    --print-override) PRINT_OVERRIDE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done
case $SETTLE in ''|*[!0-9]*) echo "--settle 要是整数秒" >&2; exit 2 ;; esac

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1：$2" >&2; exit 2; }; }
need docker "先装 Docker"; need curl "apt install curl"; need jq "apt install jq"
docker compose version >/dev/null 2>&1 || { echo "没有 docker compose 插件" >&2; exit 2; }
[ "$PRINT_OVERRIDE" = 1 ] || docker info >/dev/null 2>&1 || { echo "连不上 Docker（docker info 失败）：Docker 没在跑，或者当前用户没权限（用 sudo 跑）" >&2; exit 2; }
CV=$(docker compose version --short 2>/dev/null | sed 's/^v//')
[ "$(printf '%s\n%s\n' 2.24.4 "$CV" | sort -V | head -n1)" = 2.24.4 ] || { echo "docker compose $CV 太老：覆盖文件要用 !reset / !override，需要 ≥ 2.24.4" >&2; exit 2; }
PROJECT_DIR=$(cd "$PROJECT_DIR" 2>/dev/null && pwd) || { echo "--project-dir 目录不存在" >&2; exit 2; }
[ -f "$PROJECT_DIR/compose.yaml" ] || { echo "$PROJECT_DIR 里没有 compose.yaml（--project-dir 要指向 h2z.security 的目录）" >&2; exit 2; }
[ -f "$PROJECT_DIR/.env" ] || { echo "$PROJECT_DIR/.env 不存在：先 node scripts/init.mjs（H2Z OS 开过机就有）" >&2; exit 2; }
mkdir -p "$OUT" || exit 2
chmod 700 "$OUT" 2>/dev/null || true

TS=$(date -u +%Y%m%dT%H%M%SZ)
REPORT="$OUT/report-$TS.txt"
: > "$REPORT"
PASS=0; WARN=0; FAIL=0
say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
sec() { say ""; say "== $* =="; }
ok() { PASS=$((PASS + 1)); say "PASS  $*"; }
warn() { WARN=$((WARN + 1)); say "WARN  $*"; }
bad() { FAIL=$((FAIL + 1)); say "FAIL  $*"; }
info() { say "      $*"; }
# 日志 / 响应片段进报告前打码：URL 里的口令、Bearer token、secret/token/password 之类的值，以及终端颜色码
redact() { sed -E 's/\x1b\[[0-9;]*m//g; s#(://)[^/@[:space:]]+@#\1***@#g; s#(Bearer )[A-Za-z0-9._~+/=-]+#\1***#g; s/((secret|token|password|passwd|authkey|auth-key|apikey|api_key)[=:] ?)[^&[:space:]",}]+/\1***/Ig'; }

envval() { sed -n "s/^$1=//p" "$PROJECT_DIR/.env" 2>/dev/null | tail -n1 | tr -d '\r' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"; }
HTTP_PORT=$(envval HTTP_PORT); HTTP_PORT=${HTTP_PORT:-8096}
# 对外端口要登录（契约 §13.2）：有 LOCAL_HTTP_PORT（只绑本机、不登录的屏幕入口）就走它，探测脚本没有会话
LOCAL_HTTP_PORT=$(envval LOCAL_HTTP_PORT)
BASE="http://127.0.0.1:${LOCAL_HTTP_PORT:-$HTTP_PORT}"

# compose 文件：和这台机器平时用的一致（.env 的 COMPOSE_FILE，或 compose.yaml + compose.override.yaml）
FILES=()
CF=$(envval COMPOSE_FILE)
if [ -n "$CF" ]; then
  IFS=':' read -r -a _parts <<<"$CF"
  for p in "${_parts[@]}"; do case $p in /*) FILES+=(-f "$p") ;; *) FILES+=(-f "$PROJECT_DIR/$p") ;; esac; done
else
  FILES+=(-f "$PROJECT_DIR/compose.yaml")
  [ -f "$PROJECT_DIR/compose.override.yaml" ] && FILES+=(-f "$PROJECT_DIR/compose.override.yaml")
fi
# 原来的 profile：环境变量 > /etc/h2z/os.env（H2Z OS）> recorder
ORIG_PROFILES=${COMPOSE_PROFILES:-}
if [ -z "$ORIG_PROFILES" ] && [ -f /etc/h2z/os.env ]; then ORIG_PROFILES=$(sed -n 's/^COMPOSE_PROFILES=//p' /etc/h2z/os.env | tail -n1 | tr -d "\r\"'"); fi
ORIG_PROFILES=${ORIG_PROFILES:-recorder}
OVERRIDE="$OUT/lean-base.override.yaml"
# 原样的 compose（不带 -f，和 h2z-os-stack / 平时敲命令一样让 compose 自己按 .env 找文件）/ 瘦底座的 compose
dc_orig() { COMPOSE_PROFILES="$ORIG_PROFILES" docker compose --project-directory "$PROJECT_DIR" "$@"; }
dc_lean() { COMPOSE_PROFILES=recorder docker compose --project-directory "$PROJECT_DIR" "${FILES[@]}" -f "$OVERRIDE" "$@"; }

PROJECT=$(dc_orig config --format json 2>/dev/null | jq -r '.name // empty' 2>/dev/null)
PROJECT=${PROJECT:-h2z-security}
cid() { docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" 2>/dev/null | head -n1; }
cstate() { # 服务 → 状态/健康，例如 running/healthy、running/-、exited/-、none
  local id; id=$(cid "$1")
  [ -n "$id" ] || { echo none; return; }
  docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$id" 2>/dev/null || echo none
}

# 底座 / 各扩展包的服务（和开发计划 §2 一致）
BASE_SERVICES=(web backend postgres zlm zlm-config recorder recorder-playback recorder-config-init storage-agent host-agent host-network secrets-init ioc-storage-init)
UP_SERVICES=(web backend postgres zlm recorder recorder-playback host-agent host-network)
EXT_SERVICES=(emqx h2z-api ai-server nodered-bridge nodered yolo recorder-motion tdengine)
[ "$STOP_TS" = 1 ] && EXT_SERVICES+=(tailscale tailscale-cli)

# ---------- 环境 ----------
# ---------- 覆盖文件 ----------
# 和 compose.lean.yaml（瘦底座叠加层的正式版）接的线一样：去掉 backend 对 emqx / h2z-api 的依赖和 MQTT / H2Z / 运动索引的环境变量，
# 一样（2026-11-08 起远程接入并入底座，正式版 host-agent 照样依赖 tailscale-cli）。不一样的只有 host-agent 这一段（探测专用：量「没有远程接入」的底座有多轻——
# 去掉对 tailscale-cli 的依赖，并让 host-agent 找不到 Tailscale，即使 tailscale 容器还在跑）。compose-matrix.test.mjs 用 --print-override 核对 backend 的线一致。
write_override() {
  local BDEP
  BDEP=$(dc_orig config --format json 2>/dev/null | jq -c '.services.backend.depends_on // empty | del(.emqx, ."h2z-api")' 2>/dev/null)
  [ -n "$BDEP" ] || BDEP='{"secrets-init":{"condition":"service_completed_successfully"},"recorder-config-init":{"condition":"service_completed_successfully"},"host-network":{"condition":"service_started"},"host-agent":{"condition":"service_started"},"postgres":{"condition":"service_healthy"},"ioc-storage-init":{"condition":"service_completed_successfully"}}'
  cat > "$OVERRIDE" <<EOF
# 瘦底座验证用的临时覆盖文件（lean-base-probe.sh 生成，不入库）。不动仓库里的 compose.yaml。
services:
  backend:
    # 去掉对 emqx / h2z-api 的依赖（其余依赖照原样）
    depends_on: !override $BDEP
    environment:
      IOC_MQTT_URL: !reset null
      MQTT_BROKER_URL: !reset null
      MQTT_USERNAME: !reset null
      MQTT_PASSWORD: !reset null
      IOC_H2Z_URL: !reset null
      IOC_H2Z_TOKEN_FILE: !reset null
      RECORDER_MOTION_URL: !reset null
      RECORDER_SITE: !reset null
  host-agent:
    # 探测专用：去掉对 tailscale-cli 的依赖，并让它找不到 Tailscale（量没有远程接入的底座；正式版不去掉）
    depends_on: !reset {}
    environment:
      H2Z_TAILSCALE_CLI: /opt/tailscale/absent
      H2Z_TAILSCALE_SOCKET: /var/run/tailscale/absent.sock
EOF
}
if [ "$PRINT_OVERRIDE" = 1 ]; then write_override; cat "$OVERRIDE"; exit 0; fi

sec "环境"
say "时间       $(date -Is)"
say "机器       $(uname -srm)；CPU $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs) × $(nproc 2>/dev/null)；内存 $(free -m 2>/dev/null | awk '/^Mem:/{print $2" MB"}')"
DV=$(docker version --format '{{.Server.Version}}' 2>/dev/null); say "Docker     ${DV:-?}；compose $CV"
say "项目       $PROJECT_DIR（git $(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')$([ -n "$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null)" ] && echo '，有未提交改动')）；compose 项目名 $PROJECT"
say "profile    原来 $ORIG_PROFILES；compose 文件 ${FILES[*]}"
[ -f /usr/share/h2z/os-release ] && say "H2Z OS     $(tr '\n' ' ' < /usr/share/h2z/os-release | cut -c1-200)"

# ---------- 1 镜像体积 ----------
sec "1 镜像体积"
say "（docker images 原始输出；docker 报的是未压缩大小，安装盘里是 docker save 之后压缩的，最终大小以构建产物为准）"
docker images --format '{{.Size}}\t{{.Repository}}:{{.Tag}}' 2>/dev/null | tee -a "$REPORT"
CFG_JSON=$(dc_orig --profile '*' config --format json 2>/dev/null)
[ -n "$CFG_JSON" ] || CFG_JSON=$(dc_orig config --format json 2>/dev/null)
group_sum() { # 标题 服务…：这几个服务用到的镜像（去重）各自大小相加；共享层会重复计，只用来比较大小
  local label=$1; shift
  local imgs="" s img sz total=0 n=0 missing=""
  for s in "$@"; do imgs="$imgs
$(jq -r --arg s "$s" '.services[$s].image // empty' <<<"$CFG_JSON" 2>/dev/null)"; done
  while IFS= read -r img; do
    [ -n "$img" ] || continue
    if sz=$(docker image inspect -f '{{.Size}}' "$img" 2>/dev/null); then total=$((total + sz)); n=$((n + 1)); else missing="$missing $img"; fi
  done < <(printf '%s\n' "$imgs" | sort -u)
  say "$(printf '%s：%d MB（%d 个镜像）%s' "$label" $((total / 1000000)) "$n" "${missing:+；本机没有：$missing}")"
}
if [ -n "$CFG_JSON" ]; then
  say ""
  say "按开发计划分组（MB = 10^6 字节，和 docker images 同口径）："
  group_sum "底座" "${BASE_SERVICES[@]}"
  group_sum "iot（emqx）" emqx
  group_sum "ai（ai-server…nodered）" ai-server h2z-api nodered-bridge nodered
  group_sum "vision（yolo）" yolo
  group_sum "remote（tailscale）" tailscale tailscale-cli
  group_sum "要删除的（tdengine）" tdengine
  group_sum "现在的全部" "${BASE_SERVICES[@]}" emqx ai-server h2z-api nodered-bridge nodered yolo tailscale tailscale-cli tdengine recorder-motion
else
  warn "读不出 compose 配置（.env 不全？），没法按组算体积"
fi
if [ "$IMAGES_ONLY" = 1 ]; then
  say ""; say "（--images-only：到此为止，没有动任何容器）"
  exit 0
fi

# ---------- 要做什么 ----------
RUNNING_EXT=""
for s in "${EXT_SERVICES[@]}"; do [ "$(cstate "$s")" = none ] || RUNNING_EXT="$RUNNING_EXT $s"; done
sec "要做的事"
info "1. 暂停看门狗（/var/lib/h2z/watchdog/pause，装了才有）；删除这些容器（数据卷不动）：${EXT_SERVICES[*]}"
info "   现在存在的：${RUNNING_EXT:- 无}"
info "2. 用覆盖文件 $OVERRIDE 重建 backend / host-agent，等底座服务健康：${UP_SERVICES[*]}"
info "3. 像本地控制台那样轮询接口 $SETTLE 秒，再检查接口、报警、日志、资源；报告写到 $REPORT"
if [ "$KEEP" = 1 ]; then info "4. （--keep）不恢复，留着瘦底座"; else info "4. 恢复原来的完整栈（profile=$ORIG_PROFILES）"; fi
[ "$DRILL" = 1 ] && info "5. 报警演练：停 recorder 几分钟（录像会断），看报警能不能出、能不能自己消失"
if [ "$YES" != 1 ]; then
  say ""; say "（没加 --yes：只是列出来，什么都没动。确认后加 --yes 重跑）"
  exit 0
fi

write_override
if ! dc_lean config --quiet >"$OUT/override-check.log" 2>&1; then
  say "覆盖文件和 compose 合不上（compose config 报错），没有动任何容器："
  redact < "$OUT/override-check.log" | tail -n 15 | sed 's/^/      /' | tee -a "$REPORT"
  exit 2
fi

# ---------- 改栈（出错 / 中断 / 结束都会恢复，除非 --keep）----------
BACKEND_OK=0
summary() {
  sec "结论"
  say "PASS $PASS　WARN $WARN　FAIL $FAIL"
  if [ "$BACKEND_OK" = 1 ]; then say "- backend 在没有 emqx / h2z-api / MQTT 时能起来并保持健康：是"; else say "- backend 在没有 emqx / h2z-api / MQTT 时能起来并保持健康：否 → 按计划停在这里，把原因告诉负责人，由他定是保留 emqx 在底座还是改 backend"; fi
  say "- FAIL 项：$([ "$FAIL" = 0 ] && echo 无 || echo "$FAIL 个（见上面标 FAIL 的行）")；WARN 项要人看一眼"
  say "- 整份报告：$REPORT（backend / host-agent 日志在同目录）；把本次终端输出整段贴回即可"
  say "- 没验证的：预览画面（要真实摄像头）、录像写盘（只查了链路）、重启后的开机自启（这个脚本只重建容器，没重启机器）"
}

CHANGED=0; RESTORED=0; WD_PAUSED=0
WD_STATE=${WATCHDOG_STATE_DIR:-/var/lib/h2z/watchdog}
restore() {
  local rc=$? t
  [ "$CHANGED" = 1 ] && [ "$RESTORED" = 0 ] || return 0
  RESTORED=1
  if [ "$KEEP" = 1 ]; then
    say ""; say "（--keep：没恢复。想恢复原样：）"
    say "  cd $PROJECT_DIR && COMPOSE_PROFILES=$ORIG_PROFILES docker compose up -d --wait"
    [ "$WD_PAUSED" = 1 ] && say "  rm -f $WD_STATE/pause   # 看门狗暂停是脚本加的，1 小时后自己过期"
  else
    sec "恢复原来的完整栈"
    t=$(date +%s)
    if dc_orig up -d --wait --wait-timeout 600 >"$OUT/restore.log" 2>&1; then
      ok "已恢复（$(( $(date +%s) - t )) 秒）"
    else
      bad "恢复没成功：手动跑  cd $PROJECT_DIR && COMPOSE_PROFILES=$ORIG_PROFILES docker compose up -d"
      redact < "$OUT/restore.log" | tail -n 15 | sed 's/^/      /' | tee -a "$REPORT"
    fi
    [ "$WD_PAUSED" = 1 ] && rm -f "$WD_STATE/pause"
    http GET /api/ioc/health
    if [ "$CODE" = 200 ]; then ok "恢复后 /api/ioc/health 200"; else warn "恢复后 /api/ioc/health 是 $CODE（再等一会儿看看）"; fi
  fi
  summary
  if [ "$rc" = 0 ] && [ "$FAIL" != 0 ]; then exit 1; fi
}
trap restore EXIT
trap 'echo; echo "中断：先恢复原来的栈…"; exit 130' INT TERM

BODY="$OUT/.body"
CODE=000; TIME=0
http() { # 方法 路径 [头文件] [JSON 内容]  → CODE、$BODY
  local m=$1 p=$2 h=${3:-} d=${4:-}
  local args=(-sS -o "$BODY" -w '%{http_code} %{time_total}' --max-time 20 --noproxy '*' -X "$m") res
  [ -n "$h" ] && args+=(-H "@$h")
  [ -n "$d" ] && args+=(-H 'content-type: application/json' -d "$d")
  res=$(curl "${args[@]}" "$BASE$p" 2>/dev/null) || res="000 0"
  CODE=${res%% *}; TIME=${res#* }
}
slow() { awk -v t="$1" 'BEGIN{exit !(t + 0 > 2.5)}'; }   # 响应超过 2.5 秒算慢
snippet() { head -c 160 "$BODY" 2>/dev/null | redact | tr '\n' ' '; }
chk_json() { # 名称 路径 [头文件]：200 且是 JSON
  http GET "$2" "${3:-}"
  if [ "$CODE" = 200 ] && jq -e . "$BODY" >/dev/null 2>&1; then ok "$1"; return 0; fi
  bad "$1：HTTP $CODE（GET $2）$(snippet)"; return 1
}
chk_code() { # 名称 路径 期望状态
  http GET "$2"
  [ "$CODE" = "$3" ] && { ok "$1"; return 0; }
  bad "$1：HTTP $CODE，应为 $3（GET $2）"; return 1
}

sec "2 切到底座 only"
CHANGED=1
if [ -d "$WD_STATE" ] && [ ! -e "$WD_STATE/pause" ] && echo $(( $(date +%s) + 3600 )) > "$WD_STATE/pause" 2>/dev/null; then WD_PAUSED=1; info "看门狗已暂停 1 小时（结束时撤销）"; fi
for s in "${EXT_SERVICES[@]}"; do
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$s" 2>/dev/null)
  [ -n "$ids" ] || continue
  # shellcheck disable=SC2086
  if docker rm -f $ids >/dev/null 2>&1; then info "已删除容器：$s"; else warn "删不掉 $s 的容器"; fi
done
T_UP=$(date -u +%Y-%m-%dT%H:%M:%SZ); T_UP_EPOCH=$(date +%s)
if dc_lean up -d --wait --wait-timeout 300 "${UP_SERVICES[@]}" >"$OUT/up.log" 2>&1; then
  ok "底座 only 起来了（$(( $(date +%s) - T_UP_EPOCH )) 秒，要求的服务都在跑 / 健康）"
else
  bad "docker compose up --wait 没成功（backend 在没有 emqx / h2z-api 时起不来？这是 M0 要找的情况）"
  redact < "$OUT/up.log" | tail -n 25 | sed 's/^/      /' | tee -a "$REPORT"
fi

sec "3 容器状态"
want_healthy=(backend web postgres zlm recorder recorder-playback)
want_running=(host-agent host-network)
for s in "${want_healthy[@]}"; do
  st=$(cstate "$s"); [ "$st" = running/healthy ] && ok "$s 健康" || bad "$s 状态是 $st（应为 running/healthy）"
done
for s in "${want_running[@]}"; do
  st=$(cstate "$s"); case $st in running/*) ok "$s 在跑" ;; *) bad "$s 状态是 $st（应在跑）" ;; esac
done
for s in "${EXT_SERVICES[@]}"; do
  st=$(cstate "$s"); [ "$st" = none ] || bad "扩展服务 $s 还在（$st）：探测环境不对，下面的结论不可信"
done
BACKEND_OK=0; [ "$(cstate backend)" = running/healthy ] && BACKEND_OK=1

PROJ=""
if [ "$BACKEND_OK" = 1 ]; then
  sec "4 接口（像本地控制台那样）"
  chk_code "nginx /healthz" /healthz 200
  chk_code "本地控制台页面 /ioc/local" /ioc/local 200
  chk_code "IOC /api/ioc/health" /api/ioc/health 200
  chk_code "security /api/security/health" /api/security/health 200
  if chk_json "设备 brief（不要口令）" /api/ioc/device/network/brief; then PROJ=$(jq -r '.currentProject // empty' "$BODY" 2>/dev/null); fi
  if [ -z "$PROJ" ]; then
    http GET /api/ioc/projects
    PROJ=$(jq -r 'if type=="array" then .[0] else (.projects // [])[0] end | (.projectId // .id // empty)' "$BODY" 2>/dev/null)
  fi
  chk_json "录像状态 /device/recording" /api/ioc/device/recording
  chk_json "码流列表 /device/channels/streams" /api/ioc/device/channels/streams
  # 设备管理口令：secrets/ioc/device-password；只放在 600 权限的头文件里，不进命令行和报告
  HDR_DEV="$OUT/.hdr-dev"
  if [ -s "$PROJECT_DIR/secrets/ioc/device-password" ]; then
    (umask 077; printf 'x-ioc-device-key: %s\n' "$(tr -d '\r\n' < "$PROJECT_DIR/secrets/ioc/device-password")" > "$HDR_DEV")
    http POST /api/ioc/device/network/login "$HDR_DEV" '{}'
    if [ "$CODE" = 200 ] || [ "$CODE" = 201 ]; then  # Nest 的 POST 登录默认回 201（真机 2026-11-11 实测）
      ok "设备口令登录"
      if chk_json "设备网络状态 /device/network" /api/ioc/device/network "$HDR_DEV"; then
        info "tailscale 字段（host-agent 找不到 Tailscale 时的现状）：$(jq -c '.tailscale // "无该字段"' "$BODY" 2>/dev/null | redact | cut -c1-200)"
      fi
      chk_json "设备信息 / 时间 /device/network/system" /api/ioc/device/network/system "$HDR_DEV"
      chk_json "升级状态 /device/network/upgrade" /api/ioc/device/network/upgrade "$HDR_DEV"
    else
      bad "设备口令登录：HTTP $CODE（口令文件 secrets/ioc/device-password 和后端不一致？）"
    fi
  else
    warn "读不到 $PROJECT_DIR/secrets/ioc/device-password（没用 sudo？）：设备网络 / 设备信息 / 升级三项没测"
  fi
  if [ -n "$PROJ" ]; then
    info "当前项目：$PROJ"
    if chk_json "摄像头清单 /projects/$PROJ/network/cameras" "/api/ioc/projects/$PROJ/network/cameras"; then info "摄像头 $(jq -r '(.cameras // []) | length' "$BODY" 2>/dev/null) 台"; fi
    if chk_json "本地录像机状态 /projects/$PROJ/recorder" "/api/ioc/projects/$PROJ/recorder"; then
      info "录像机 online=$(jq -r '.online // "?"' "$BODY" 2>/dev/null)，录像摄像头 $(jq -r '(.channels // []) | length' "$BODY" 2>/dev/null) 台；响应 ${TIME} 秒"
      # 后端每次读录像机状态还会去问 recorder-motion（没配 RECORDER_MOTION_URL 时默认 http://recorder-motion:9303，超时 3 秒）；容器没了名字解析可能很慢
      if slow "$TIME"; then warn "本地录像机状态响应 ${TIME} 秒，偏慢：疑似后端在等已经不存在的 recorder-motion（DNS 解析 / 超时）"; fi
    fi
    chk_json "存储情况 /projects/$PROJ/recorder/storage" "/api/ioc/projects/$PROJ/recorder/storage"
  else
    warn "没有当前项目（设备还没做首次设置？）：摄像头 / 录像 / 存储 / 报警按项目的接口没测"
  fi
  info "预览（直播画面）要有真实摄像头：这里只查链路——zlm、recorder 健康见上；画面请在 HDMI 控制台人工看一眼"

  # 像本地控制台那样轮询（报警每 10 秒、录像机每 10 秒、摄像头每 30 秒）；也等报警防抖（连续 2 次、约 1 分钟才报）
  if [ "$SETTLE" -gt 0 ]; then
    sec "轮询 $SETTLE 秒（模拟本地控制台）"
    paths=(/api/ioc/device/network/brief)
    [ -n "$PROJ" ] && paths+=("/api/ioc/projects/$PROJ/alarms?status=active&limit=100" "/api/ioc/projects/$PROJ/recorder" "/api/ioc/projects/$PROJ/network/cameras")
    end=$(( $(date +%s) + SETTLE )); n=0; f=0
    while [ "$(date +%s)" -lt "$end" ]; do
      for p in "${paths[@]}"; do http GET "$p"; n=$((n + 1)); [ "$CODE" = 200 ] || f=$((f + 1)); done
      sleep "$LOOP_SEC"
    done
    [ "$f" = 0 ] && ok "轮询 $n 次，全部 200" || bad "轮询 $n 次，其中 $f 次不是 200"
  fi

  sec "5 报警"
  if [ -n "$PROJ" ]; then
    if chk_json "报警接口 /projects/$PROJ/alarms" "/api/ioc/projects/$PROJ/alarms?status=active&limit=100"; then
      codes=$(grep -oE 'SITEOPS_[A-Z0-9_]+' "$BODY" | sort | uniq -c | awk '{printf "%s×%s ", $2, $1}')
      info "未处理报警 $(jq -r '(.alarms // []) | length' "$BODY" 2>/dev/null) 条；类型：${codes:-无}"
      case "$codes" in
        *TAILSCALE_DOWN*|*SERVICE_DOWN*) bad "出现了和被去掉的扩展服务有关的报警（${codes}）：看门狗 / 后端会把没装的包当成故障" ;;
        *) ok "没有和被去掉的扩展服务有关的报警" ;;
      esac
    fi
  else
    warn "没有当前项目，报警没测"
  fi

  # 报警演练
  if [ "$DRILL" = 1 ] && [ -n "$PROJ" ]; then
    sec "报警演练：停 recorder，看 SITEOPS_OFFLINE 能不能出、恢复后能不能自己消失"
    alarm_codes() { http GET "/api/ioc/projects/$PROJ/alarms?status=active&limit=100"; [ "$CODE" = 200 ] && grep -oE 'SITEOPS_[A-Z0-9_]+' "$BODY" | sort -u | tr '\n' ' '; }
    http GET "/api/ioc/projects/$PROJ/recorder"; nch=$(jq -r '(.channels // []) | length' "$BODY" 2>/dev/null); nch=${nch:-0}
    rid=$(cid recorder)
    if [ "$nch" -lt 1 ]; then
      warn "没做成：本地录像机里一台摄像头都没有（SITEOPS_OFFLINE 只在有录像摄像头时才报）。先把一台摄像头加进本地录像机，再加 --alarm-drill 跑一次"
    elif [ -z "$rid" ]; then
      bad "找不到 recorder 容器"
    elif ! docker stop "$rid" >/dev/null 2>&1; then
      bad "停不了 recorder"
    else
      t0=$(date +%s); got=0
      while [ $(( $(date +%s) - t0 )) -lt 180 ]; do sleep "$POLL_SEC"; case " $(alarm_codes)" in *" SITEOPS_OFFLINE "*) got=1; break ;; esac; done
      [ "$got" = 1 ] && ok "停 recorder 后 $(( $(date +%s) - t0 )) 秒，SITEOPS_OFFLINE 报出来了" || bad "停 recorder 180 秒，SITEOPS_OFFLINE 没出来：瘦底座下报警不工作"
      docker start "$rid" >/dev/null 2>&1 || bad "recorder 没能重新启动：手动  docker start $rid"
      t0=$(date +%s); gone=0
      while [ $(( $(date +%s) - t0 )) -lt 240 ]; do sleep "$POLL_SEC"; case " $(alarm_codes)" in *" SITEOPS_OFFLINE "*) ;; *) gone=1; break ;; esac; done
      [ "$gone" = 1 ] && ok "恢复后 $(( $(date +%s) - t0 )) 秒，报警自己消失了" || warn "恢复后 240 秒报警还在（再等一会儿，手动看一眼）"
    fi
  fi
else
  sec "4 接口 / 5 报警"
  warn "backend 没起来，接口和报警都没法测——先看下面 backend 的日志"
fi

# ---------- 日志 ----------
ERR_RE='(^|[^A-Za-z])(ERROR|WARN)([^A-Za-z]|$)|"level":"(error|warn)"|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|[Uu]nhandled|Exception'
EXT_RE='mqtt|emqx|h2z-api|nodered|tdengine|tailscale|recorder-motion|1883'
norm() { sed -E 's/^\[Nest\] +[0-9]+ +- +[0-9\/]+, +[0-9:]+( [AP]M)? +//; s/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+Z?//g; s/[0-9]+/N/g'; }
log_report() { # 服务
  local svc=$1 f="$OUT/$1.log" total errs top win rate
  if [ -z "$(cid "$svc")" ]; then warn "$svc 没有容器，看不了日志"; return; fi
  dc_lean logs --no-color --since "$T_UP" "$svc" 2>&1 | redact > "$f"
  total=$(wc -l < "$f"); errs=$(grep -cE "$ERR_RE" "$f")
  win=$(( ($(date +%s) - T_UP_EPOCH) / 60 )); [ "$win" -ge 1 ] || win=1
  if [ "$errs" = 0 ]; then ok "$svc 日志干净（$total 行，没有错误 / 警告）"; return; fi
  top=$(grep -E "$ERR_RE" "$f" | norm | sort | uniq -c | sort -rn | head -n 1 | awk '{print $1}')
  rate=$(( errs / win ))
  if [ "${top:-0}" -ge 30 ] || [ "$rate" -gt 10 ]; then
    bad "$svc 疑似报错刷屏：$win 分钟里 $errs 行错误 / 警告（同一条最多 ${top} 次，平均每分钟 $rate 行）"
  else
    warn "$svc 有 $errs 行错误 / 警告（共 $total 行；启动期少量属正常，逐条看下面）"
  fi
  info "其中提到扩展服务的有 $(grep -E "$ERR_RE" "$f" | grep -ciE "$EXT_RE") 行；最常见的几条（数字已换成 N）："
  grep -E "$ERR_RE" "$f" | norm | sort | uniq -c | sort -rn | head -n 8 | cut -c1-220 | sed 's/^/        /' | tee -a "$REPORT"
}
sec "6 日志（从重建那一刻起）"
log_report backend
log_report host-agent
log_report web

# ---------- 资源 ----------
sec "7 瘦底座的资源占用（docker stats，一次采样）"
# shellcheck disable=SC2046
STATS=$(docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null) 2>/dev/null)
if [ -n "$STATS" ]; then
  printf '%s\n' "$STATS" | awk -F'\t' '{printf "      %-34s %-24s CPU %s\n", $1, $2, $3}' | tee -a "$REPORT"
  tot=$(printf '%s\n' "$STATS" | awk -F'\t' '{split($2,a," / "); v=a[1]; n=v+0; if (v ~ /GiB/) n*=1024; else if (v ~ /KiB/) n/=1024; else if (v !~ /MiB/) n/=1048576; t+=n} END{printf "%.0f", t}')
  say "      容器内存合计约 ${tot} MiB（含还在跑的 tailscale 等；对比：原来的完整栈同样口径再测一次）"
else
  warn "docker stats 没有输出"
fi
say "      主机 $(free -m 2>/dev/null | awk '/^Mem:/{print "内存 已用 "$3" / "$2" MB"}')；Docker 根目录 $(df -h "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /)" 2>/dev/null | awk 'NR==2{print $3" 已用 / "$2"，剩 "$4}')"
