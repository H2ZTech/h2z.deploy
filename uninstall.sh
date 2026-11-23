#!/bin/sh
# B-line uninstall: undo what install.sh set up on this machine.
#
#   sudo sh uninstall.sh                 safe mode (default): stop and remove the H2Z containers and network, the watchdog timer and the
#                                        Cloudflare tunnel unit. KEEPS the database, settings, recordings, images and the code directory,
#                                        so a later install.sh resumes where it left off.
#   sudo sh uninstall.sh --purge         also delete the Docker volumes (database, IOC data, the "recordings" volume), the H2Z images
#                                        (ghcr.io/h2ztech/*), the code directory and /etc/h2z, /var/lib/h2z. NOT reversible.
#
# Options:
#   --dir PATH   code directory (default /opt/h2z.security, same as install.sh)
#   --yes        do not ask for confirmation (required for --purge when there is no terminal)
#   --dry-run    print what would be done, change nothing
#
# Never touched, in any mode: Docker itself, the cloudflared package, apt packages that install.sh added (git, jq, nodejs ...), the docker group
# membership, and anything under /srv/h2z (recording disks and arrays are never unmounted or wiped here; delete them by hand if you want to).
# If install.sh took over the network (/etc/h2z/host.env exists) the network settings are NOT reverted automatically: the originals are in /etc/h2z/netplan-orig.
set -u

PROJECT=h2z-security
DIR=/opt/h2z.security; PURGE=0; YES=0; DRY=0
while [ $# -gt 0 ]; do
  case $1 in
    --dir) DIR=$2; shift ;;
    --purge) PURGE=1 ;;
    --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac; shift
done

# This script usually lives inside the directory that --purge deletes: run a copy from /tmp instead
if [ -z "${H2Z_UNINSTALL_COPY:-}" ]; then
  case $(cd "$(dirname "$0")" 2>/dev/null && pwd) in
    "$DIR"|"$DIR"/*)
      T=$(mktemp /tmp/h2z-uninstall.XXXXXX) && cp "$0" "$T" && H2Z_UNINSTALL_COPY=1 exec sh "$T" --dir "$DIR" $( [ "$PURGE" = 1 ] && echo --purge ) $( [ "$YES" = 1 ] && echo --yes ) $( [ "$DRY" = 1 ] && echo --dry-run ) ;;
  esac
fi

say()  { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
FAILED=""
run()  { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@" || { FAILED="$FAILED | $*"; return 1; }; fi; }
quiet() { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@" >/dev/null 2>&1 || true; fi; }

[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || { echo "ERROR: run with sudo" >&2; exit 1; }

# Safety: only ever delete a directory that really is the H2Z code directory
looks_like_h2z_dir() { [ -n "$DIR" ] && [ "$DIR" != / ] && [ -f "$DIR/compose.yaml" ] && [ -f "$DIR/scripts/init.sh" ]; }

say "Plan"
if [ "$PURGE" = 1 ]; then
  note "PURGE: remove containers, network, ALL Docker volumes of project $PROJECT (database, IOC data, recordings volume), H2Z images, $DIR, /etc/h2z, /var/lib/h2z"
else
  note "SAFE: remove containers, network, watchdog timer and tunnel unit. Keep data, images and $DIR"
fi
note "Never touched: Docker, cloudflared package, apt packages, /srv/h2z (recording disks / arrays)"
if [ "$PURGE" = 1 ] && [ "$YES" = 0 ] && [ "$DRY" = 0 ]; then
  (exec </dev/tty) 2>/dev/null || { echo "ERROR: --purge needs a terminal to confirm, or pass --yes" >&2; exit 1; }
  printf 'This permanently deletes the H2Z database and settings. Type DELETE to continue: ' >/dev/tty
  read -r ans </dev/tty; [ "$ans" = DELETE ] || { echo "Cancelled."; exit 1; }
fi

HAVE_DOCKER=1; command -v docker >/dev/null 2>&1 || HAVE_DOCKER=0

# ---------- 1. Containers and network ----------
say "1/5 Stopping and removing the stack"
if [ "$HAVE_DOCKER" = 0 ]; then note "docker not found, skipping"; else
  if [ -f "$DIR/compose.yaml" ]; then
    if [ "$PURGE" = 1 ]; then
      quiet docker compose --project-directory "$DIR" -p "$PROJECT" --profile '*' down --remove-orphans --volumes
    else
      quiet docker compose --project-directory "$DIR" -p "$PROJECT" --profile '*' down --remove-orphans
    fi
  else note "no $DIR/compose.yaml, using labels only"; fi
  # Sweep by label too: covers a missing / broken compose file and containers from profiles that were never listed
  C=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)
  [ -z "$C" ] || { note "removing leftover containers"; for c in $C; do quiet docker rm -f "$c"; done; }
  N=$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)
  [ -z "$N" ] || for n in $N; do quiet docker network rm "$n"; done
  if [ "$PURGE" = 1 ]; then
    V=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null || true)
    [ -z "$V" ] || { note "removing volumes: $(echo $V | tr '\n' ' ')"; for v in $V; do quiet docker volume rm "$v"; done; }
  fi
fi

# ---------- 2. Watchdog ----------
say "2/5 Removing the watchdog"
if [ -f /etc/systemd/system/h2z-watchdog.timer ] || [ -L /etc/systemd/system/h2z-watchdog.timer ]; then
  quiet systemctl disable --now h2z-watchdog.timer
  quiet systemctl stop h2z-watchdog.service
  run rm -f /etc/systemd/system/h2z-watchdog.timer /etc/systemd/system/h2z-watchdog.service /usr/local/lib/h2z/watchdog.sh /etc/h2z/watchdog.env
  HWD=0; [ -f /etc/systemd/system.conf.d/h2z-watchdog.conf ] && HWD=1
  run rm -f /etc/systemd/system.conf.d/h2z-watchdog.conf
  run rm -rf /var/lib/h2z/watchdog
  quiet systemctl daemon-reload
  [ "$HWD" = 0 ] || quiet systemctl daemon-reexec
else note "not installed"; fi

# ---------- 3. Cloudflare tunnel unit written by host-agent ----------
say "3/5 Removing the Cloudflare tunnel unit"
if [ -f /etc/systemd/system/h2z-os-cloudflared.service ]; then
  quiet systemctl disable --now h2z-os-cloudflared.service
  run rm -f /etc/systemd/system/h2z-os-cloudflared.service
  quiet systemctl daemon-reload
  [ "$PURGE" = 0 ] || run rm -rf /etc/h2z/cloudflared
else note "not installed"; fi

# ---------- 4. Purge ----------
say "4/5 Images, code and configuration"
if [ "$PURGE" = 1 ]; then
  if [ "$HAVE_DOCKER" = 1 ]; then
    IMGS=$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^ghcr.io/h2ztech/' || true)
    [ -z "$IMGS" ] || for i in $IMGS; do quiet docker rmi "$i"; done
    note "removed ghcr.io/h2ztech/* images (third-party images such as postgres / emqx / zlmediakit are left in place: other apps may use them)"
  fi
  if looks_like_h2z_dir; then run rm -rf "$DIR"; else note "$DIR is not an H2Z code directory (or already gone), not deleting"; fi
  if [ -f /etc/h2z/host.env ]; then
    note "KEEPING /etc/h2z: the network was taken over (host.env exists), originals are in /etc/h2z/netplan-orig and must be restored by hand"
  else run rm -rf /etc/h2z; fi
  run rm -rf /var/lib/h2z
else note "safe mode: nothing deleted here"; fi

# ---------- 5. Summary ----------
say "5/5 Done"
if [ -d /srv/h2z ] && [ -n "$(ls -A /srv/h2z 2>/dev/null)" ]; then
  note "Recordings were NOT touched: /srv/h2z ($(du -sh /srv/h2z 2>/dev/null | cut -f1)). Delete or unmount it yourself if you want the space back."
fi
if [ -f /etc/h2z/host.env ]; then note "Network settings were changed by H2Z earlier and are not reverted (see /etc/h2z/netplan-orig)."; fi
if [ "$PURGE" = 0 ]; then note "To remove everything, including the database: sudo sh uninstall.sh --purge"; fi
if [ -n "$FAILED" ]; then echo "Some steps failed:$FAILED" >&2; exit 1; fi
echo "Uninstall finished."
