#!/bin/sh
# Board update: run only this, instead of typing git pull + docker compose pull + up by hand.
#   sh scripts/update.sh                 check space -> pull code -> pull images -> check space again -> start -> prune our own old images (keep the previous version)
#   sh scripts/update.sh --prune-old     when space is short, first prune our own old images (those no container uses), then update
#   sh scripts/update.sh --check         only check space, do not update
# Stops when free space is below MIN_FREE_GB (default 10) and lists what is using the space. Only prunes old images under our registry (OUR_REGISTRY) that no container uses;
# the previous version is kept for rollback; public images and other people's containers are never touched.
# The watchdog is paused during the update (otherwise it would restart containers that are being rebuilt).
set -eu
# Run from a temporary copy: git pull below can change this script itself, and sh reads as it executes, so a swapped file would resume at the wrong place
if [ -z "${H2Z_UPDATE_REPO:-}" ]; then
  H2Z_UPDATE_REPO=$(cd "$(dirname "$0")/.." && pwd); export H2Z_UPDATE_REPO
  copy=$(mktemp "${TMPDIR:-/tmp}/h2z-update.XXXXXX"); cp "$0" "$copy"
  sh "$copy" "$@"; rc=$?; rm -f "$copy"; exit $rc
fi
cd "$H2Z_UPDATE_REPO"
# Where the "previous images" are recorded: .h2z-update/ in the repo (writable by the user who cloned it; runtime/ may have been created as root by the init container and not be writable)
STATE=.h2z-update
MIN_FREE_GB=${MIN_FREE_GB:-10}           # free space needed on the Docker disk (images land there)
MIN_FREE_ROOT_GB=${MIN_FREE_ROOT_GB:-1}  # the system disk / and the repo directory hold only code and config; the H2Z OS system disk is only 6 GB with images on /data, so it cannot also need 10 GB
WD=${WATCHDOG_STATE_DIR:-/var/lib/h2z/watchdog}
PRUNE=0; CHECK=0
for a in "$@"; do case $a in --prune-old) PRUNE=1 ;; --check) CHECK=1 ;; *) echo "Unknown option: $a" >&2; exit 2 ;; esac; done

docker_root() { docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker; }
free_gb() { df -P -B1 "$1" 2>/dev/null | awk 'NR==2 {printf "%d", $4 / 1e9}'; }

# Our own images: those used in compose that live under our registry (public images such as node / postgres / tailscale may be used by neighbours too, so they are not pruned)
# Our own registries (several allowed, separated by |): only ghcr.io/h2ztech/
OUR_REGISTRY=${OUR_REGISTRY:-ghcr.io/h2ztech/}
our_repos() { docker compose config --images 2>/dev/null | sed 's/@.*//; s/:[^/:]*$//' | grep -E "^($OUR_REGISTRY)" | sort -u; }

usage_report() {
  echo "-- What is using the space --"
  docker system df 2>/dev/null || true
  echo "5 largest container logs:"
  du -b "$(docker_root)"/containers/*/*-json.log 2>/dev/null | sort -rn | head -5 | awk '{printf "  %6.1f MB  %s\n", $1/1e6, $2}' || true
  journalctl --disk-usage 2>/dev/null | sed 's/^/  /' || true
  [ -n "${RECORDER_POOL_DIR:-}" ] && du -sh "$RECORDER_POOL_DIR" 2>/dev/null | sed 's/^/  recording directory: /' || true
  echo "Our old images that nobody uses (sh scripts/update.sh --prune-old removes these):"
  old_images | while read -r id ref; do echo "  $ref ($id)"; done
}

# Our images that no container uses (those listed in the KEEP file = previous version, kept for rollback)
old_images() {
  used=$(docker ps -aq | xargs -r docker inspect -f '{{.Image}}' 2>/dev/null | sort -u)
  keep=$(cat "$STATE/previous-images" runtime/previous-images 2>/dev/null || true)
  for repo in $(our_repos); do
    docker images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' "$repo" 2>/dev/null
  done | sort -u | while read -r id ref; do
    echo "$used" | grep -qx "$id" && continue
    echo "$keep" | grep -qx "$id" && continue
    echo "$id $ref"
  done
}

prune_old() {
  n=0
  for id in $(old_images | awk '{print $1}' | sort -u); do docker rmi "$id" >/dev/null 2>&1 && n=$((n + 1)) || true; done
  echo "Removed $n of our old images (the previous version is kept for rollback)"
}

check_space() { # stage
  bad=0
  dr=$(docker_root)
  for p in / "$dr" "$(pwd)"; do
    f=$(free_gb "$p"); [ -n "$f" ] || continue
    # The Docker disk uses MIN_FREE_GB; the system disk / and the repo directory use MIN_FREE_ROOT_GB -- but if they are the same disk as the Docker disk (common on boards / NAS), MIN_FREE_GB applies
    need=$MIN_FREE_ROOT_GB
    if [ "$p" = "$dr" ] || [ "$(df -P "$p" 2>/dev/null | awk 'NR==2{print $1}')" = "$(df -P "$dr" 2>/dev/null | awk 'NR==2{print $1}')" ]; then need=$MIN_FREE_GB; fi
    if [ "$f" -lt "$need" ]; then echo "Not enough space ($1): $p has only ${f} GB left, at least ${need} GB needed"; bad=1; fi
  done
  if [ "$bad" = 1 ]; then usage_report; return 1; fi
  echo "Enough space ($1): / has $(free_gb /) GB free, the Docker disk has $(free_gb "$(docker_root)") GB free"
}

[ "$PRUNE" = 1 ] && prune_old
check_space "before update" || { echo "Not updated. Free some space and run again; to prune only our own old images: sh scripts/update.sh --prune-old"; exit 1; }
[ "$CHECK" = 1 ] && exit 0

# Pause the watchdog for 30 minutes (resumed right after the update)
if [ -d "$WD" ] && [ -w "$WD" ]; then echo $(( $(date +%s) + 1800 )) > "$WD/pause"; trap 'rm -f "$WD/pause"' EXIT
elif [ -d "$WD" ]; then echo "Note: no permission to pause the watchdog (re-run sudo sh host/install-watchdog.sh to fix); the update goes on"; fi

# Record the images in use now = the previous version (kept for rollback when old images are pruned after the update)
rm -f "$STATE/previous-images.new"
if mkdir -p "$STATE" 2>/dev/null && [ -w "$STATE" ]; then
  docker compose images -q 2>/dev/null | sort -u | xargs -r docker inspect -f '{{.Id}}' 2>/dev/null | sort -u > "$STATE/previous-images.new" || true
else
  echo "Note: cannot write $(pwd)/$STATE (wrong directory owner?), the previous images cannot be recorded this time, old images will not be pruned after the update"
fi
git pull --ff-only
# Host layer (outside Docker: cloudflared, NICs / hotspot, watchdog ...): run host/setup-host.sh when --check reports something pending (first time on a side-car machine, and later watchdog updates brought by git pull).
# If it cannot be done (sudo password needed / NIC takeover not safe) only a note is printed and the update is not blocked. H2Z OS images have all of this baked in, so nothing is ever pending there.
if [ -f host/setup-host.sh ] && ! sh host/setup-host.sh --check >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ]; then sh host/setup-host.sh || echo "Note: the host layer was not fully completed (see the output above); the update goes on"
  elif sudo -n true 2>/dev/null; then sudo sh host/setup-host.sh || echo "Note: the host layer was not fully completed (see the output above); the update goes on"
  else echo "Note: the host layer has pending items (see them with sh host/setup-host.sh --check); after the update run: sudo sh host/setup-host.sh"; fi
fi
{ [ -f scripts/budget.sh ] && sh scripts/budget.sh; } || true   # recompute the transcode budget from total machine memory (ZLM memory cap + transcode streams); values written by hand outside the .env auto block are left alone
docker compose config --quiet
docker compose pull --ignore-pull-failures
check_space "after pulling images" || { echo "The new version was not started (the old one is still running). Free some space and run sh scripts/update.sh again"; exit 1; }
{ [ -f scripts/gpu-calibrate.sh ] && sh scripts/gpu-calibrate.sh; } || true   # measure GPU hardware-decode capacity (images were just pulled; exits immediately if hardware / images did not change)
docker compose up -d --build --wait --wait-timeout 300 --remove-orphans
if [ -f "$STATE/previous-images.new" ]; then
  mv "$STATE/previous-images.new" "$STATE/previous-images"
  prune_old
else
  echo "Previous images were not recorded: old images are not pruned this time (so the rollback version is not removed too)"
fi
echo "Update complete: $(git log -1 --format='%h %s')"
