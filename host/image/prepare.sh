#!/bin/sh
# Step 1 of making a master image (docs/ORANGE-PI.md §10). Run on the board that becomes the master,
# booted from its NVMe, from the repository:
#   sudo sh host/image/prepare.sh
#
# Nothing is deleted here: the captured image is a complete backup of this board. Everything that
# identifies this board or this site (machine-id, SSH host keys, hotspot SSID, LAN address, secrets,
# Tailscale login, project data, DSH model keys) is removed later on each *copy* (flash.sh →
# generalize-root.sh, then h2z-firstboot on its first boot), never on this board.
#
# What it does:
#   1. checks every image the stack needs is already local (clones must start without internet)
#   2. installs / refreshes the host units (h2z-firstboot*), so clones carry them
#   3. `docker compose stop` (stopped, not removed: containers set to unless-stopped stay down at the
#      next boot, so a clone does not start this board's containers before its first-boot cleanup)
#   4. marks /etc/h2z/resume-pending: when THIS board boots from NVMe again, h2z-firstboot-stack just
#      runs `docker compose up -d` (nothing to do by hand)
#   5. powers off. Next: boot from the maintenance SD card and run capture.sh.
set -eu
[ "$(id -u)" = 0 ] || exec sudo sh "$0" "$@"
REPO=$(cd "$(dirname "$0")/../.." && pwd)
OWNER=$(stat -c %U "$REPO")
NO_POWEROFF=0; [ "${1:-}" = --no-poweroff ] && NO_POWEROFF=1
cd "$REPO"
as_owner() { runuser -u "$OWNER" -- "$@"; }

[ -f .env ] || { echo ".env missing: this board was never initialised" >&2; exit 1; }
for f in host/firstboot.sh host/systemd/h2z-firstboot.service host/systemd/h2z-firstboot-stack.service; do
  [ -f "$f" ] || { echo "$f missing: git pull first" >&2; exit 1; }
done

echo "== images (clones start offline, so all of them must be local)"
missing=''
for img in $(as_owner docker compose config --images | sort -u); do
  docker image inspect "$img" >/dev/null 2>&1 || missing="$missing $img"
done
# scripts/init.sh runs in node:22-alpine on the clone's first boot
docker image inspect node:22-alpine >/dev/null 2>&1 || missing="$missing node:22-alpine"
if [ -n "$missing" ]; then
  echo "pulling:$missing"
  for img in $missing; do docker pull "$img"; done
fi

echo "== host units"
sh host/setup-host-network.sh --auto
systemctl is-enabled --quiet h2z-firstboot.service || { echo "h2z-firstboot.service not enabled" >&2; exit 1; }
systemctl is-enabled --quiet h2z-firstboot-stack.service || { echo "h2z-firstboot-stack.service not enabled" >&2; exit 1; }

echo "== stopping the stack"
as_owner docker compose stop
docker image prune -f >/dev/null || true
docker builder prune -af >/dev/null 2>&1 || true
apt-get clean || true
journalctl --vacuum-size=64M >/dev/null 2>&1 || true

mkdir -p /etc/h2z
rm -f /etc/h2z/firstboot-pending /etc/h2z/firstboot-stack-pending
date -Is > /etc/h2z/resume-pending
{
  echo "prepared=$(date -Is)"
  echo "repo=$REPO"
  echo "rev=$(as_owner git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "hostname=$(hostname)"
} > /etc/h2z/image-prepared
sync
echo "Prepared. Next: power off, insert the maintenance SD card, boot from it and run capture.sh."
echo "(Booting this board from NVMe again just restarts the stack; run prepare.sh again before capturing.)"
[ "$NO_POWEROFF" = 1 ] || { sleep 3; poweroff; }
