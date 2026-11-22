#!/bin/sh
# 站点整机数据备份（老 B 线 / Orange Pi，如 LA31）。只读备份，不停服务、不改任何东西。
#
# 用法（在板子上，建议 sudo：要读 docker 卷和 /etc 下的网络配置）：
#   sudo sh backup-site.sh [--out 目录] [--with-recordings] [--skip-td] [--force] [--dry-run]
# 不想先在板子上 git pull（老板子），可以从自己电脑直接灌进去跑：
#   ssh <板子> 'sudo sh -s -- --out /home/orangepi' < backup-site.sh
#
# 备份内容（全部自动发现，不写死路径和卷名）：
#   1 db/        PG 逻辑备份（pg_dump -Fc，在线一致）+ 角色/全局对象；pg_restore -l 校验
#   2 config/    部署目录里的 .env、secrets/、runtime/recorder 等配置（含口令，目录权限 700）、git 版本、compose 配置
#   3 volumes/   项目的全部 docker 卷（IOC 项目数据、backend 上传/模型、Node-RED、DSH home、emqx、tailscale 状态、TDengine …）
#                默认跳过：pg-data（已有 pg_dump）、录像块池 recorder-pool / recordings（体积大，录像机里有同一批；要就加 --with-recordings）、
#                td-log / yolo-outbox / 各种 socket 卷
#   4 host/      宿主层：/var/lib/h2z、网络配置（netplan / NetworkManager 含热点）、cloudflared、systemd 单元、docker daemon.json 等
#   5 info/      容器 / 镜像 / 磁盘 / 网络 / tailscale 状态快照，方便以后对账
# 结束时写 MANIFEST.txt、SHA256SUMS、RESTORE.txt。退出码：0 全部成功，1 有关键项失败（PG 或配置），2 只有可选项告警。
set -u

OUT_BASE=""; WITH_REC=0; SKIP_TD=0; FORCE=0; DRY=0
while [ $# -gt 0 ]; do
  case $1 in
    --out) OUT_BASE=${2:-}; shift ;;
    --with-recordings) WITH_REC=1 ;;
    --skip-td) SKIP_TD=1 ;;
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null; exit 0 ;;
    *) echo "不认识的参数：$1" >&2; exit 64 ;;
  esac; shift
done

say()  { echo "[$(date +%H:%M:%S)] $*"; }
warn() { echo "[$(date +%H:%M:%S)] ⚠ $*" >&2; WARNS=$((WARNS+1)); }
fail() { echo "[$(date +%H:%M:%S)] ✗ $*" >&2; FAILS=$((FAILS+1)); }
WARNS=0; FAILS=0

command -v docker >/dev/null 2>&1 || { echo "没有 docker 命令" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker 没权限/没起来：请用 sudo 运行" >&2; exit 1; }
[ "$(id -u)" = 0 ] || warn "不是 root：宿主层（/etc 网络配置等）可能读不全，建议 sudo 重跑"

# ---- 1 自动发现：postgres 容器 → compose 项目名、部署目录 ----
PG=$(docker ps -q --filter label=com.docker.compose.service=postgres | head -1)
[ -n "$PG" ] || { echo "没找到运行中的 postgres 容器（站点没起？）。库没法在线备份，先 docker compose up -d postgres 再来。" >&2; exit 1; }
label() { docker inspect -f "{{ index .Config.Labels \"$1\" }}" "$2" 2>/dev/null; }
PROJ=$(label com.docker.compose.project "$PG")
DEPLOY=$(label com.docker.compose.project.working_dir "$PG")
HELPER_IMG=$(docker inspect -f '{{.Config.Image}}' "$PG")   # 自带 busybox tar/gzip，且和板子同架构，不用另拉镜像
say "项目：$PROJ  部署目录：${DEPLOY:-未知}  PG 容器：$(docker inspect -f '{{.Name}}' "$PG" | tr -d /)"

# ---- 2 输出目录 + 空间预估 ----
if [ -z "$OUT_BASE" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then OUT_BASE=$(getent passwd "$SUDO_USER" | cut -d: -f6); else OUT_BASE=${HOME:-/root}; fi
fi
SITE=$(hostname)
OUT="$OUT_BASE/h2z-backup-$SITE-$(date +%Y%m%d-%H%M%S)"

SKIP_RE='^(pg-data|tailscale-socket|tailscale-cli|storage-ctl|host-agent|td-log|yolo-outbox)$'
[ "$WITH_REC" = 1 ] || SKIP_RE='^(pg-data|tailscale-socket|tailscale-cli|storage-ctl|host-agent|td-log|yolo-outbox|recorder-pool|recordings)$'
[ "$SKIP_TD" = 1 ] && SKIP_RE=$(echo "$SKIP_RE" | sed 's/^\^(/^(td-data|/')
VOLS=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJ")
[ -n "$VOLS" ] || VOLS=$(docker volume ls -q | grep "^${PROJ}_" || true)

short() { echo "${1#${PROJ}_}"; }
PLAN=""; NEED_KB=0
for v in $VOLS; do
  s=$(short "$v")
  if echo "$s" | grep -Eq "$SKIP_RE"; then continue; fi
  mp=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null)
  kb=$(du -sk "$mp" 2>/dev/null | cut -f1); kb=${kb:-0}
  NEED_KB=$((NEED_KB+kb)); PLAN="$PLAN $v"
  printf '  卷 %-34s %8s MB\n' "$s" "$((kb/1024))"
done
PGKB=$(docker exec "$PG" sh -c 'du -sk /var/lib/postgresql/data 2>/dev/null | cut -f1'); NEED_KB=$((NEED_KB+${PGKB:-0}/2+102400))
mkdir -p "$OUT_BASE" 2>/dev/null
AVAIL_KB=$(df -Pk "$OUT_BASE" | awk 'NR==2{print $4}')
say "预计占用约 $((NEED_KB/1024)) MB（压缩前上限），$OUT_BASE 可用 $((AVAIL_KB/1024)) MB"
if [ "$AVAIL_KB" -lt $((NEED_KB*6/10)) ] && [ "$FORCE" != 1 ]; then
  echo "空间可能不够。换个目录（--out /挂载的U盘或大盘），或者去掉大卷，或者 --force 硬跑。" >&2; exit 1
fi
if [ "$DRY" = 1 ]; then say "dry-run：不写任何文件。输出目录将是 $OUT"; exit 0; fi

mkdir -p "$OUT"/db "$OUT"/config "$OUT"/volumes "$OUT"/host "$OUT"/info || exit 1
chmod 700 "$OUT"
say "输出到：$OUT"

# ---- 3 PG ----
say "1/5 备份 PG ..."
if docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$OUT/db/postgres.dump" 2> "$OUT/db/pg_dump.err" && [ -s "$OUT/db/postgres.dump" ]; then
  if docker exec -i "$PG" pg_restore -l < "$OUT/db/postgres.dump" > "$OUT/db/postgres.toc" 2>/dev/null && [ -s "$OUT/db/postgres.toc" ]; then
    say "  ✓ postgres.dump $(du -h "$OUT/db/postgres.dump" | cut -f1)，目录可读（$(wc -l < "$OUT/db/postgres.toc") 行）"
  else fail "pg_restore -l 读不了这份备份"; fi
else fail "pg_dump 失败：$(head -3 "$OUT/db/pg_dump.err" 2>/dev/null)"; fi
docker exec "$PG" sh -c 'pg_dumpall -U "$POSTGRES_USER" --globals-only' > "$OUT/db/globals.sql" 2>/dev/null || warn "角色备份（globals）失败，不影响库恢复"
docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from information_schema.tables where table_schema=\$\$public\$\$"' > "$OUT/db/public-table-count.txt" 2>/dev/null

# ---- 4 配置 ----
say "2/5 备份部署目录配置 ..."
if [ -n "$DEPLOY" ] && [ -d "$DEPLOY" ]; then
  ( cd "$DEPLOY" && tar czf "$OUT/config/deploy-config.tgz" \
      --ignore-failed-read --warning=no-file-changed \
      --exclude='runtime/*.png' --exclude='runtime/*.log' --exclude='runtime/*.zip' --exclude='runtime/*.mjs' \
      --exclude='runtime/recorder/pool*' --exclude='.git' --exclude='node_modules' --exclude='.h2z-update/backups' \
      .env .env.* secrets runtime config compose*.yaml docker2/.env docker2/secrets 2>"$OUT/config/tar.err" ) ; rc=$?
  [ $rc -le 1 ] && [ -s "$OUT/config/deploy-config.tgz" ] && say "  ✓ deploy-config.tgz $(du -h "$OUT/config/deploy-config.tgz" | cut -f1)（含 .env 和 secrets）" || fail "配置打包失败 rc=$rc"
  ( cd "$DEPLOY" && { git rev-parse HEAD; git status --short; git remote -v; git log --oneline -5; } > "$OUT/config/git-info.txt" 2>&1 ) || true
  ( cd "$DEPLOY" && git diff > "$OUT/config/git-local-changes.diff" 2>/dev/null ) || true
  ( cd "$DEPLOY" && docker compose config > "$OUT/config/compose.resolved.yaml" 2>/dev/null ) || warn "docker compose config 导不出（不影响）"
  ls -la "$DEPLOY/.h2z-update/backups" > "$OUT/config/earlier-pg-backups.txt" 2>/dev/null || true
else fail "找不到部署目录（$DEPLOY）：.env / secrets 没备份"; fi

# ---- 5 卷 ----
say "3/5 备份 docker 卷（不停服务；Node-RED / TDengine 在线打包，恢复时以 PG 为准）..."
UIDGID="$(id -u):$(id -g)"
[ -n "${SUDO_UID:-}" ] && UIDGID="$SUDO_UID:${SUDO_GID:-$SUDO_UID}"
for v in $PLAN; do
  s=$(short "$v")
  docker run --rm --entrypoint sh -v "$v":/v:ro -v "$OUT/volumes":/out "$HELPER_IMG" -c \
    "tar czf /out/$s.tgz -C /v . 2>/out/$s.tar.err; rc=\$?; chown $UIDGID /out/$s.tgz /out/$s.tar.err 2>/dev/null; exit \$rc" ; rc=$?
  if [ $rc -le 1 ] && [ -s "$OUT/volumes/$s.tgz" ]; then
    [ $rc = 1 ] && warn "$s：打包时文件有变化（在线备份的正常现象）"
    say "  ✓ $s $(du -h "$OUT/volumes/$s.tgz" | cut -f1)"
  else warn "卷 $s 备份失败 rc=$rc"; fi
  [ -s "$OUT/volumes/$s.tar.err" ] || rm -f "$OUT/volumes/$s.tar.err"
done
echo "$VOLS" | while read -r v; do [ -n "$v" ] && echo "$(short "$v")"; done > "$OUT/info/all-volumes.txt"
for v in $VOLS; do s=$(short "$v"); echo "$s" | grep -Eq "$SKIP_RE" && echo "$s" ; done > "$OUT/info/skipped-volumes.txt"

# ---- 6 宿主层 ----
say "4/5 备份宿主层 ..."
HOSTPATHS=""
for p in /var/lib/h2z /etc/h2z /etc/netplan /etc/NetworkManager/system-connections /etc/hostapd /etc/cloudflared /root/.cloudflared \
         /etc/systemd/system/h2z*.service /etc/systemd/system/h2z*.timer /etc/systemd/system/h2z*.path /etc/docker/daemon.json \
         /etc/hostname /etc/hosts /etc/fstab /etc/chrony /etc/systemd/timesyncd.conf /etc/cron.d /var/spool/cron/crontabs /etc/ssh/sshd_config.d /etc/environment; do
  [ -e "$p" ] && HOSTPATHS="$HOSTPATHS $p"
done
[ -n "${SUDO_USER:-}" ] && [ -d "/home/$SUDO_USER/.ssh" ] && HOSTPATHS="$HOSTPATHS /home/$SUDO_USER/.ssh/authorized_keys"
# shellcheck disable=SC2086
tar czf "$OUT/host/host-files.tgz" --ignore-failed-read --warning=no-file-changed $HOSTPATHS 2>"$OUT/host/tar.err"; rc=$?
[ $rc -le 1 ] && [ -s "$OUT/host/host-files.tgz" ] && say "  ✓ host-files.tgz（$(echo $HOSTPATHS | wc -w) 项）" || warn "宿主层打包失败 rc=$rc（用 sudo 重跑）"
[ -s "$OUT/host/tar.err" ] || rm -f "$OUT/host/tar.err"
ls -la /srv/h2z /srv/h2z/disks 2>/dev/null > "$OUT/host/srv-h2z-listing.txt" || true

for f in "$OUT/config/tar.err" "$OUT/db/pg_dump.err"; do [ -s "$f" ] || rm -f "$f"; done

# ---- 7 快照信息 ----
say "5/5 记录系统快照 ..."
{ uname -a; echo; cat /etc/os-release 2>/dev/null; echo; date -u; timedatectl 2>/dev/null; } > "$OUT/info/system.txt" 2>&1
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' > "$OUT/info/containers.txt" 2>&1
docker image ls --digests --format 'table {{.Repository}}\t{{.Tag}}\t{{.Digest}}\t{{.ID}}\t{{.Size}}' > "$OUT/info/images.txt" 2>&1
docker volume ls > "$OUT/info/volumes-all.txt" 2>&1
{ df -h; echo; lsblk 2>/dev/null; echo; free -m; } > "$OUT/info/disk-mem.txt" 2>&1
{ ip -br addr; echo; ip route; echo; nmcli -t con show 2>/dev/null; } > "$OUT/info/network.txt" 2>&1
tailscale status > "$OUT/info/tailscale.txt" 2>&1 || docker exec "$(docker ps -q --filter label=com.docker.compose.service=tailscale | head -1)" tailscale status > "$OUT/info/tailscale.txt" 2>&1 || true

cat > "$OUT/RESTORE.txt" <<EOF
恢复要点（备份于 $(date '+%F %T')，站点 $SITE，compose 项目 $PROJ）
1. 部署目录：解开 config/deploy-config.tgz（含 .env、secrets），其中 CAMERA_SECRET_KEY / Node-RED credential-secret 必须和数据一起恢复，否则摄像头 / 流程凭据解不开。
2. 库：docker compose up -d postgres 后
     docker compose exec -T postgres sh -c 'pg_restore -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" --clean --if-exists' < db/postgres.dump
3. 卷：docker volume create <项目>_<卷名>；
     docker run --rm -v <项目>_<卷名>:/v -v \$PWD/volumes:/in <busybox 或 postgres:16-alpine> tar xzf /in/<卷名>.tgz -C /v
4. 宿主层：host/host-files.tgz 里是网络配置 / systemd 单元 / /var/lib/h2z 等，按需挑着解到 /（先看清再覆盖，网口配置不要直接覆盖到别的板子上）。
5. 跳过的卷见 info/skipped-volumes.txt；录像本体不在这份备份里（除非用了 --with-recordings）。
EOF

( cd "$OUT" && find . -type f ! -name SHA256SUMS ! -name MANIFEST.txt -exec sha256sum {} + > SHA256SUMS 2>/dev/null; ls -lhR . > MANIFEST.txt )
[ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && chown -R "$SUDO_UID:${SUDO_GID:-$SUDO_UID}" "$OUT" 2>/dev/null
echo
say "完成：$OUT（$(du -sh "$OUT" | cut -f1)），告警 $WARNS 个，失败 $FAILS 个"
IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p'); TS=$(tailscale ip -4 2>/dev/null | head -1)
echo "拉回自己电脑：scp -r ${SUDO_USER:-$(id -un)}@${TS:-${IP:-<板子IP>}}:$OUT ."
echo "拉回后校验：cd $(basename "$OUT") && sha256sum -c SHA256SUMS"
[ $FAILS -gt 0 ] && exit 1
[ $WARNS -gt 0 ] && exit 2
exit 0
