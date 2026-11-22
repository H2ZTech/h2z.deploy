#!/bin/sh
# Bring a side-car machine's host layer (everything outside Docker) up to what the H2Z OS installer does. Safe to re-run: finished steps are skipped.
#   sudo sh host/setup-host.sh                 apply
#   sh host/setup-host.sh --check              only report what is missing (no root, changes nothing); exit code 3 if anything is pending
#   sudo sh host/setup-host.sh --network=skip  leave the NICs alone (auto = default, take over only when safe; force = skip the safety check, at your own risk)
#
# Who runs it:
#   new side-car machine  git clone -> sudo sh host/setup-host.sh -> sh scripts/init.sh -> docker compose up -d
#   existing sites        scripts/update.sh runs it again after git pull when something is pending
#   H2Z OS installer      does not run this: everything is baked into the image, h2z-os-firstboot handles first boot
#
# Steps (each step checks first and is skipped if already done; one failure does not block the others, a summary is printed at the end, exit code 1):
#   1. docker + compose plugin         scripts/install-docker.sh if missing (Ubuntu / Debian only)
#   2. cloudflared                     installed from the official Cloudflare repo, repo and key removed afterwards (version stays pinned to the machine; the service unit is written by host-agent when binding, see docs/TUNNEL-API.md)
#   3. NICs / maintenance hotspot / firewall  host/setup-host-network.sh; guarded: only taken over with systemd-networkd + netplan + DHCP and no static address,
#                                      otherwise skipped and the reason written to /etc/h2z/setup-host.manual, so a remote machine is never cut off. Afterwards host-agent keeps it in sync with git pull
#   4. board watchdog                  host/install-watchdog.sh (also updated when the script changes)
#   5. local display scripts           host/install-kiosk.sh (skipped automatically on machines without a local display)
# Test: H2Z_INSTALL_ROOT=<temp dir> (prefix for system paths) plus fake commands on PATH -- scripts/setup-host.test.mjs
set -eu
R=${H2Z_INSTALL_ROOT:-}
REPO=$(cd "$(dirname "$0")/.." && pwd)
MODE=apply; NET=auto
for a in "$@"; do
  case $a in
    --check) MODE=check ;;
    --network=auto|--network=skip|--network=force) NET=${a#--network=} ;;
    *) echo "Unknown option: $a (see the top of this script for usage)" >&2; exit 2 ;;
  esac
done
[ "$MODE" = check ] || [ -n "$R" ] || [ "$(id -u)" = 0 ] || exec sudo sh "$0" "$@"

H="$R/etc/h2z"
MANUAL_FILE="$H/setup-host.manual"
PENDING=""; FAILED=""

ok()      { echo "[ok]   $1"; }
todo()    { echo "[pending] $1"; PENDING="$PENDING $2"; }
manual()  { echo "[manual] $1"; }
skipped() { echo "[skipped] $1"; }

# Run one step in apply mode; record a failure and carry on
do_step() { # name command...
  name=$1; shift
  echo "── $name"
  if "$@"; then echo "[done] $name"; else echo "[FAILED] $name" >&2; FAILED="$FAILED $name"; fi
}

# ---------------------------------------------------------------- 1. docker
have_docker() { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }
install_docker() { sh "$REPO/scripts/install-docker.sh"; }

# ---------------------------------------------------------------- 2. cloudflared
have_cloudflared() { [ -x "$R/usr/bin/cloudflared" ] || command -v cloudflared >/dev/null 2>&1; }
install_cloudflared() {
  # shellcheck disable=SC1091
  . "$R/etc/os-release"
  case ${ID:-} in ubuntu|debian) ;; *) echo "This distribution (${ID:-?}): install cloudflared by hand following the official Cloudflare docs" >&2; return 1 ;; esac
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /etc/apt/keyrings/cloudflare-main.gpg
  chmod a+r /etc/apt/keyrings/cloudflare-main.gpg
  cat > /etc/apt/sources.list.d/cloudflared.sources <<SRC
Types: deb
URIs: https://pkg.cloudflare.com/cloudflared
Suites: any
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/cloudflare-main.gpg
SRC
  rc=0
  { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cloudflared; } || rc=$?
  # Leave no repo or key behind: apt upgrade will not silently upgrade it later, the version stays with this machine
  rm -f /etc/apt/sources.list.d/cloudflared.sources /etc/apt/keyrings/cloudflare-main.gpg
  return $rc
}

# ---------------------------------------------------------------- 3. NICs
# Is it safe to let setup-host-network.sh take over the wired ports? Print the reason if not (empty = safe). netplan config is readable by root only.
netplan_unreadable=0
# net_unsafe runs in a subshell (its output is captured), so "unreadable" is detected separately
netplan_readable() {
  files=$(ls "$R"/etc/netplan/*.yaml 2>/dev/null || true)
  [ -z "$files" ] && return 0
  # shellcheck disable=SC2086
  cat $files >/dev/null 2>&1
}
net_unsafe() {
  systemctl is-active --quiet systemd-networkd 2>/dev/null || { echo "systemd-networkd is not running (this machine uses another network manager)"; return; }
  command -v netplan >/dev/null 2>&1 || { echo "netplan is not installed"; return; }
  files=$(ls "$R"/etc/netplan/*.yaml 2>/dev/null || true)
  [ -n "$files" ] || { echo "no config in /etc/netplan"; return; }
  # shellcheck disable=SC2086
  text=$(cat $files 2>/dev/null || true)
  if [ -z "$text" ]; then echo "cannot read /etc/netplan (root is needed to decide)"; return; fi
  text=$(printf '%s\n' "$text" | sed 's/#.*//')
  printf '%s\n' "$text" | grep -qi 'renderer: *NetworkManager' && { echo "netplan is handed to NetworkManager"; return; }
  printf '%s\n' "$text" | grep -q 'addresses:' && { echo "netplan has a static address (taking over would switch it to DHCP)"; return; }
  printf '%s\n' "$text" | grep -Eq 'dhcp4: *(true|yes)' || { echo "netplan has no dhcp4: true"; return; }
  ip -4 route show default 2>/dev/null | grep -q 'proto dhcp' || { echo "the default route did not come from DHCP"; return; }
}

# ---------------------------------------------------------------- 4. Watchdog
watchdog_ok() {
  [ -f "$R/usr/local/lib/h2z/watchdog.sh" ] && cmp -s "$REPO/host/watchdog.sh" "$R/usr/local/lib/h2z/watchdog.sh" \
    && systemctl is-enabled --quiet h2z-watchdog.timer 2>/dev/null
}

# ================================================================= Summary / run
echo "Host layer ($MODE, directory $REPO)"

if have_docker; then ok "docker + compose"; else
  if [ "$MODE" = check ]; then todo "docker + compose not installed" docker; else do_step "Install docker" install_docker; fi
fi

if have_cloudflared; then ok "cloudflared"; else
  if [ "$MODE" = check ]; then todo "cloudflared not installed (needed for the Cloudflare tunnel)" cloudflared; else do_step "Install cloudflared" install_cloudflared; fi
fi

# NICs
if [ -f "$H/host.env" ]; then
  ok "NICs / hotspot (already initialized; host-agent keeps them in sync with git pull from now on)"
  rm -f "$MANUAL_FILE" 2>/dev/null || true
elif [ "$NET" = skip ]; then
  skipped "NICs / hotspot (--network=skip)"
else
  reason=""
  [ "$NET" = force ] || reason=$(net_unsafe)
  netplan_readable || netplan_unreadable=1
  if [ "$MODE" = check ]; then
    if [ "$netplan_unreadable" = 1 ] && [ ! -f "$MANUAL_FILE" ]; then todo "NICs / hotspot not initialized yet ($reason)" network
    elif [ -f "$MANUAL_FILE" ] && [ -n "$reason" ]; then manual "NICs / hotspot were not taken over automatically: $(cat "$MANUAL_FILE" 2>/dev/null || echo "$reason") (once you are sure it is safe: sudo sh host/setup-host.sh --network=force)"
    elif [ -n "$reason" ]; then todo "NICs / hotspot not initialized yet (automatic takeover would be blocked: $reason)" network
    else todo "NICs / hotspot not initialized yet" network; fi
  elif [ -n "$reason" ]; then
    mkdir -p "$H"; echo "$reason" > "$MANUAL_FILE"
    manual "NICs / hotspot were not taken over automatically: $reason. Once you are sure it is safe, run: sudo sh host/setup-host.sh --network=force"
  else
    rm -f "$MANUAL_FILE"
    do_step "Initialize NICs / hotspot / firewall (host/setup-host-network.sh)" sh "$REPO/host/setup-host-network.sh"
  fi
fi

# Watchdog
if watchdog_ok; then ok "board watchdog"; else
  if [ "$MODE" = check ]; then todo "board watchdog missing or outdated" watchdog; else do_step "Install / update the watchdog" sh "$REPO/host/install-watchdog.sh"; fi
fi

# Local display scripts (the script skips itself on machines without a local display; host-agent also runs it periodically, so --check does not count it as pending)
if [ "$MODE" = apply ]; then do_step "Local display scripts" sh "$REPO/host/install-kiosk.sh"; fi

if [ "$MODE" = check ]; then
  if [ -n "$PENDING" ]; then echo "Pending: $PENDING (sudo sh host/setup-host.sh)"; exit 3; fi
  echo "Host layer is complete"; exit 0
fi
if [ -n "$FAILED" ]; then echo "Failed steps: $FAILED (fix them and re-run sudo sh host/setup-host.sh; finished steps are skipped)" >&2; exit 1; fi
echo "Host layer done. Next: sh scripts/init.sh (new machine) then docker compose up -d"
