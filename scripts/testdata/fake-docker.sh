#!/usr/bin/env bash
# 测试替身：lean-base-probe.test.mjs 用的「假 docker」，不是真 Docker。只实现 lean-base-probe.sh 用到的子命令，
# 用来测脚本自己的逻辑（干跑、打码、刷屏判断、失败也恢复…）；不能代替在真机器上跑一遍。
# 状态目录 $FAKE_DOCKER_STATE：services（现存的服务，一行一个）、calls.log（每次调用一行）。
# 场景 $FAKE_SCENARIO：ok | up-fails | flood | override-invalid
set -u
ST=${FAKE_DOCKER_STATE:?FAKE_DOCKER_STATE}
SC=${FAKE_SCENARIO:-ok}
mkdir -p "$ST"
ALL="secrets-init ioc-storage-init recorder-config-init postgres emqx backend host-network host-agent tailscale tailscale-cli zlm-config zlm nodered nodered-bridge ai-server h2z-api model-gateway web recorder recorder-playback recorder-motion tdengine"
LEAN="secrets-init ioc-storage-init recorder-config-init postgres backend host-network host-agent zlm-config zlm web recorder recorder-playback"
[ -f "$ST/services" ] || tr ' ' '\n' <<<"$ALL" > "$ST/services"
has() { grep -qx "$1" "$ST/services"; }

# docker compose [全局选项] 子命令 …
compose() {
  local args=("$@") i=0 lean=0 sub=""
  while [ $i -lt ${#args[@]} ]; do
    case ${args[$i]} in
      --project-directory|--profile) i=$((i + 2)); continue ;;
      -f) case ${args[$((i + 1))]} in *lean-base.override.yaml) lean=1 ;; esac; i=$((i + 2)); continue ;;
      version|config|up|logs|ps|rm) sub=${args[$i]}; break ;;
    esac
    i=$((i + 1))
  done
  local rest=("${args[@]:$((i + 1))}")
  echo "compose $sub lean=$lean ${rest[*]:-}" >> "$ST/calls.log"
  case $sub in
    version)
      case "${rest[*]:-}" in *--short*) echo 2.40.3 ;; *) echo "Docker Compose version v2.40.3" ;; esac ;;
    config)
      case "${rest[*]:-}" in
        *--quiet*) if [ "$lean" = 1 ] && [ "$SC" = override-invalid ]; then echo "yaml: unknown tag !override" >&2; exit 1; fi; exit 0 ;;
        *) cat <<'JSON'
{"name":"h2z-security","services":{
 "backend":{"image":"b:1","depends_on":{"emqx":{"condition":"service_healthy","required":true},"h2z-api":{"condition":"service_healthy","required":true},"postgres":{"condition":"service_healthy","required":true},"host-agent":{"condition":"service_started","required":true}}},
 "web":{"image":"w:1"},"postgres":{"image":"postgres:16-alpine"},"zlm":{"image":"zlm:1"},"zlm-config":{"image":"node:22-alpine"},
 "recorder":{"image":"rec:1"},"recorder-playback":{"image":"rec:1"},"recorder-config-init":{"image":"alpine:3.20"},"storage-agent":{"image":"rec:1"},
 "host-agent":{"image":"node:22-slim"},"host-network":{"image":"node:22-alpine"},"secrets-init":{"image":"node:22-alpine"},"ioc-storage-init":{"image":"alpine:3.20"},
 "emqx":{"image":"emqx:5"},"ai-server":{"image":"ai:1"},"h2z-api":{"image":"ai:1"},"model-gateway":{"image":"ai:1"},"nodered-bridge":{"image":"ai:1"},"nodered":{"image":"nr:1"},
 "yolo":{"image":"yolo:1"},"tailscale":{"image":"ts:1"},"tailscale-cli":{"image":"ts:1"},"tdengine":{"image":"td:1"},"recorder-motion":{"image":"rec:1"}}}
JSON
        ;;
      esac ;;
    up)
      if [ "$lean" = 1 ]; then
        [ "$SC" = up-fails ] && { echo "container h2z-security-backend-1 is unhealthy (mqtt://security:upfailsecret@emqx:1883)" >&2; exit 1; }
        tr ' ' '\n' <<<"$LEAN" > "$ST/services"
      else
        tr ' ' '\n' <<<"$ALL" > "$ST/services"
      fi ;;
    logs)
      local svc=${rest[$((${#rest[@]} - 1))]}
      if [ "$svc" = backend ]; then
        case $SC in
          flood) for _ in $(seq 1 60); do echo "[Nest] 1  - 11/04/2026, 8:0$((RANDOM % 10)):00 PM   ERROR [HostBridge] connect ECONNREFUSED 127.0.0.1:1883"; done ;;
          *) echo "[Nest] 1  - 11/04/2026, 8:00:00 PM     LOG [NestApplication] Nest application successfully started"
             echo "[Nest] 1  - 11/04/2026, 8:00:01 PM   ERROR [MqttService] MQTT_BROKER_URL 未配置，无法连接到MQTT broker"
             echo "[Nest] 1  - 11/04/2026, 8:00:02 PM    WARN [X] retry mqtt://security:topsecretpw@emqx:1883 Authorization: Bearer abc.def.ghi token=hunter2" ;;
        esac
      else
        echo "[$svc] started"
      fi ;;
    *) : ;;
  esac
}

case ${1:-} in
  compose) shift; compose "$@" ;;
  version) echo 29.0.0 ;;
  info) echo /var/lib/docker ;;
  images)
    printf '%s\t%s\n' 100MB b:1 100MB w:1 300MB ai:1 700MB td:1 ;;
  image)
    # docker image inspect -f '{{.Size}}' REF
    case ${*: -1} in ai:1) echo 300000000 ;; td:1) echo 700000000 ;; missing:*) exit 1 ;; *) echo 100000000 ;; esac ;;
  ps)
    svc=""; for a in "$@"; do case $a in label=com.docker.compose.service=*) svc=${a#label=com.docker.compose.service=} ;; esac; done
    if [ -n "$svc" ]; then has "$svc" && echo "id-$svc"; else sed 's/^/id-/' "$ST/services"; fi ;;
  inspect)
    id=${*: -1}; svc=${id#id-}
    has "$svc" || exit 1
    case $svc in
      backend) [ "$SC" = up-fails ] && echo running/unhealthy || echo running/healthy ;;
      web|postgres|zlm|recorder|recorder-playback) echo running/healthy ;;
      secrets-init|ioc-storage-init|recorder-config-init|zlm-config) echo exited/- ;;
      *) echo running/- ;;
    esac ;;
  rm)
    echo "$*" >> "$ST/calls.log"
    for a in "$@"; do case $a in id-*) grep -vx "${a#id-}" "$ST/services" > "$ST/services.tmp"; mv "$ST/services.tmp" "$ST/services" ;; esac; done ;;
  stop) echo "$*" >> "$ST/calls.log"; touch "$ST/recorder-stopped" ;;
  start) echo "$*" >> "$ST/calls.log"; rm -f "$ST/recorder-stopped" ;;
  stats) printf 'h2z-security-backend-1\t300MiB / 1.5GiB\t1.2%%\nh2z-security-postgres-1\t100MiB / 1.5GiB\t0.5%%\n' ;;
  *) echo "fake docker: 没实现 $*" >&2; exit 1 ;;
esac
