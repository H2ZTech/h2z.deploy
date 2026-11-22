#!/bin/sh
# 旁挂机器（不是 H2Z OS）的页面更新：IOC 后台「设备与系统 → 升级」点「升级」后，host-agent 用 systemd-run 在宿主上起这个脚本。
#   git-update.sh <部署目录> <属主> [升级状态目录，默认 /var/lib/h2z/upgrade]
# 以 root 跑（要补宿主层），但 git / docker compose 一律以部署目录的属主身份跑（他在 docker 组里、有 GitHub 部署密钥，.git 里的文件不会变成 root 的）。
# 为什么不在 host-agent 容器里跑：scripts/update.sh 会重建 host-agent 和 backend，脚本不能是它们的子进程。
# 步骤（进度写进 <升级状态目录>/state.json，和 H2Z OS 整包升级同一个文件、同一套界面，job = git）：
#   backing-up  备份数据库到 <升级状态目录>/backups/（留最近 3 份）；备份不成功就不更新
#   switching   scripts/update.sh（查空间 → git pull → 拉镜像 → up -d --wait → 清旧镜像）；跑的时候每 30 秒更新一次时间戳，界面据此判断还在跑
#   补宿主层    host/setup-host.sh（只在有待补项时；git pull 带来的看门狗等更新）
#   done / failed  日志在 <升级状态目录>/git-update.log
# 不做自动回退：update.sh 失败时旧容器多半还在跑；要回退见 docs/OPERATIONS.md（git checkout 旧提交 + docker compose up -d，库用备份恢复）。
set -u
REPO=${1:?部署目录}
OWNER=${2:?属主}
UPG=${3:-/var/lib/h2z/upgrade}
STATE="$UPG/state.json"
LOG="$UPG/git-update.log"
mkdir -p "$UPG/backups"
HOME_DIR=$(getent passwd "$OWNER" | cut -d: -f6)
as_owner() { runuser -u "$OWNER" -- env HOME="$HOME_DIR" "$@"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
clean() { printf '%s' "$1" | tr -d '"\\' | tr '\n\r\t' '   ' | cut -c1-300; }

START=$(now)
FROM=$(as_owner git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?')
TO=''
PHASE=backing-up
MSG='备份数据库'
FINISHED=''
BACKUP=''
write_state() {
  tmp="$STATE.tmp.$$"
  fin='null'; [ -n "$FINISHED" ] && fin="\"$FINISHED\""
  bk='null'; [ -n "$BACKUP" ] && bk="\"$BACKUP\""
  printf '{"job":"git","source":"online","phase":"%s","message":"%s","from":{"version":"%s","commit":"%s"},"to":{"version":"%s","commit":"%s"},"startedAt":"%s","updatedAt":"%s","finishedAt":%s,"backup":%s}\n' \
    "$PHASE" "$(clean "$MSG")" "$FROM" "$FROM" "${TO:-}" "${TO:-}" "$START" "$(now)" "$fin" "$bk" > "$tmp" && mv -f "$tmp" "$STATE"
}
finish() { # 阶段 消息
  PHASE=$1; MSG=$2; FINISHED=$(now)
  [ -n "${HB:-}" ] && kill "$HB" 2>/dev/null
  write_state
}
log() { echo "[$(now)] $*" >> "$LOG"; }

: > "$LOG"
log "git update start repo=$REPO owner=$OWNER from=$FROM"
write_state

# ---- 1. 备份数据库
cid=$(docker ps -q --filter label=com.docker.compose.service=postgres | head -1)
if [ -z "$cid" ]; then finish failed "找不到数据库容器，不能备份；没有更新"; log "no postgres container"; exit 1; fi
name="db-$(date -u +%Y%m%d-%H%M%S).sql.gz"
if docker exec "$cid" sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip' > "$UPG/backups/$name" 2>>"$LOG" && [ -s "$UPG/backups/$name" ] && gunzip -t "$UPG/backups/$name" 2>>"$LOG"; then
  BACKUP=$name
  ls -1t "$UPG/backups"/db-*.sql.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
  log "backup $name"
else
  rm -f "$UPG/backups/$name"
  finish failed "数据库备份失败；没有更新（日志 $LOG）"; exit 1
fi

# ---- 2. 更新
PHASE=switching; MSG='更新代码和镜像、重启服务'
write_state
# 心跳的输出接到 /dev/null：不然 sleep 子进程会一直占着调用方的管道（测试里 spawnSync 会等它 30 秒）
( while :; do sleep 30; write_state; done ) >/dev/null 2>&1 &
HB=$!
as_owner sh -c 'cd "$1" && sh scripts/update.sh' sh "$REPO" >> "$LOG" 2>&1
rc=$?
TO=$(as_owner git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '')
if [ "$rc" -ne 0 ]; then
  last=$(tail -n 3 "$LOG" | tr '\n' ' ')
  finish failed "update.sh 没成功（退出码 $rc）：$last（日志 $LOG）"
  log "update.sh failed rc=$rc"
  exit 1
fi

# ---- 3. 宿主层（git pull 可能带来看门狗 / 网口脚本的更新；有待补项才跑）
if [ -f "$REPO/host/setup-host.sh" ] && ! sh "$REPO/host/setup-host.sh" --check >/dev/null 2>&1; then
  log "host layer pending → setup-host.sh"
  sh "$REPO/host/setup-host.sh" >> "$LOG" 2>&1 || log "setup-host.sh 没全成功（不挡更新）"
fi

finish done "已更新到 ${TO:-新版本}"
log "done to=$TO"
