#!/bin/sh
# Page-triggered update for side-car machines (not H2Z OS): after "Upgrade" is clicked in IOC admin (Device & system -> Upgrade), host-agent starts this script on the host with systemd-run.
#   git-update.sh <deploy dir> <owner> [upgrade state dir, default /var/lib/h2z/upgrade]
# Runs as root (it may have to complete the host layer), but git / docker compose always run as the owner of the deploy directory (who is in the docker group and holds the GitHub access, so files in .git never become root-owned).
# Why not inside the host-agent container: scripts/update.sh rebuilds host-agent and backend, so this script must not be their child process.
# Steps (progress goes to <upgrade state dir>/state.json, the same file and UI as the H2Z OS full-image upgrade, job = git):
#   backing-up  back up the database to <upgrade state dir>/backups/ (keep the latest 3); no update if the backup fails
#   switching   scripts/update.sh (check space -> git pull -> pull images -> up -d --wait -> prune old images); the timestamp is refreshed every 30 s while it runs so the UI knows it is still alive
#   host layer  host/setup-host.sh (only when something is pending; e.g. watchdog updates brought by git pull)
#   done / failed  log is in <upgrade state dir>/git-update.log
# No automatic rollback: when update.sh fails the old containers are usually still running; for a rollback see docs/OPERATIONS.md (git checkout the old commit + docker compose up -d, restore the database from the backup).
set -u
REPO=${1:?deploy dir}
OWNER=${2:?owner}
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
MSG='Backing up the database'
FINISHED=''
BACKUP=''
write_state() {
  tmp="$STATE.tmp.$$"
  fin='null'; [ -n "$FINISHED" ] && fin="\"$FINISHED\""
  bk='null'; [ -n "$BACKUP" ] && bk="\"$BACKUP\""
  printf '{"job":"git","source":"online","phase":"%s","message":"%s","from":{"version":"%s","commit":"%s"},"to":{"version":"%s","commit":"%s"},"startedAt":"%s","updatedAt":"%s","finishedAt":%s,"backup":%s}\n' \
    "$PHASE" "$(clean "$MSG")" "$FROM" "$FROM" "${TO:-}" "${TO:-}" "$START" "$(now)" "$fin" "$bk" > "$tmp" && mv -f "$tmp" "$STATE"
}
finish() { # phase message
  PHASE=$1; MSG=$2; FINISHED=$(now)
  [ -n "${HB:-}" ] && kill "$HB" 2>/dev/null
  write_state
}
log() { echo "[$(now)] $*" >> "$LOG"; }

: > "$LOG"
log "git update start repo=$REPO owner=$OWNER from=$FROM"
write_state

# ---- 1. Back up the database
cid=$(docker ps -q --filter label=com.docker.compose.service=postgres | head -1)
if [ -z "$cid" ]; then finish failed "Database container not found, cannot back up; nothing was updated"; log "no postgres container"; exit 1; fi
name="db-$(date -u +%Y%m%d-%H%M%S).sql.gz"
if docker exec "$cid" sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip' > "$UPG/backups/$name" 2>>"$LOG" && [ -s "$UPG/backups/$name" ] && gunzip -t "$UPG/backups/$name" 2>>"$LOG"; then
  BACKUP=$name
  ls -1t "$UPG/backups"/db-*.sql.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
  log "backup $name"
else
  rm -f "$UPG/backups/$name"
  finish failed "Database backup failed; nothing was updated (log $LOG)"; exit 1
fi

# ---- 2. Update
PHASE=switching; MSG='Updating code and images, restarting services'
write_state
# Send the heartbeat output to /dev/null: otherwise the sleep child keeps the caller's pipe open (spawnSync in the tests would wait 30 s for it)
( while :; do sleep 30; write_state; done ) >/dev/null 2>&1 &
HB=$!
as_owner sh -c 'cd "$1" && sh scripts/update.sh' sh "$REPO" >> "$LOG" 2>&1
rc=$?
TO=$(as_owner git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '')
if [ "$rc" -ne 0 ]; then
  last=$(tail -n 3 "$LOG" | tr '\n' ' ')
  finish failed "update.sh did not succeed (exit code $rc): $last (log $LOG)"
  log "update.sh failed rc=$rc"
  exit 1
fi

# ---- 3. Host layer (git pull may bring watchdog / NIC script updates; runs only when something is pending)
if [ -f "$REPO/host/setup-host.sh" ] && ! sh "$REPO/host/setup-host.sh" --check >/dev/null 2>&1; then
  log "host layer pending → setup-host.sh"
  sh "$REPO/host/setup-host.sh" >> "$LOG" 2>&1 || log "setup-host.sh did not fully succeed (does not block the update)"
fi

finish done "Updated to ${TO:-the new version}"
log "done to=$TO"
