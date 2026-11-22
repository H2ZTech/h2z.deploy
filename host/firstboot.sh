#!/bin/sh
# First boot of a board cloned from the master image (docs/ORANGE-PI.md §10), run by systemd:
#   identity  h2z-firstboot.service, before SSH / hotspot / Docker: SSH host keys, hostname
#             h2z-<last 4 of the WiFi MAC> (same suffix as the hotspot SSID), hotspot SSID re-derived,
#             host network files re-rendered
#   stack     h2z-firstboot-stack.service, after Docker: removes the master's containers and volumes,
#             generates this board's secrets (scripts/init.sh), starts the stack
# The same stack unit also restarts the stack on the master after prepare.sh (/etc/h2z/resume-pending).
# Flags in /etc/h2z are removed only on success, so a failed step is retried at the next boot.
# Log: /var/log/h2z-firstboot.log
set -eu
H=${H2Z_ETC:-/etc/h2z}
LOG=${H2Z_FIRSTBOOT_LOG:-/var/log/h2z-firstboot.log}
exec >>"$LOG" 2>&1
echo "=== $(date -Is) firstboot ${1:-}"
REPO=$(cd "$(dirname "$0")/.." && pwd)
OWNER=$(stat -c %U "$REPO")

identity() {
  [ -f "$H/firstboot-pending" ] || { echo "nothing to do"; return 0; }
  # machine-id: emptied by generalize-root.sh, systemd creates a new one at boot
  if [ ! -s /etc/machine-id ] || grep -qx uninitialized /etc/machine-id; then systemd-machine-id-setup; fi
  rm -f /etc/ssh/ssh_host_*
  ssh-keygen -A
  wifi=$(sed -n "s/^AP_IF='\(.*\)'$/\1/p" "$H/host.env" 2>/dev/null || true)
  [ -n "$wifi" ] && [ -e "/sys/class/net/$wifi/address" ] || for d in /sys/class/net/*; do [ -d "$d/wireless" ] && { wifi=$(basename "$d"); break; }; done
  suffix=$(tr -d ':\n' < "/sys/class/net/$wifi/address" | tail -c 4 | tr 'A-F' 'a-f')
  name="h2z-$suffix"
  echo "$name" > /etc/hostname
  hostname "$name"
  if grep -q '^127\.0\.1\.1' /etc/hosts; then sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$name/" /etc/hosts; else printf '127.0.1.1\t%s\n' "$name" >> /etc/hosts; fi
  echo "hostname $name"
  # hotspot SSID from this board's MAC (AP_SSID was removed from host.env), networkd / nft files
  sh "$REPO/host/setup-host-network.sh" --auto
  rm -f "$H/firstboot-pending"
  echo "identity done"
}

stack() {
  if [ -f "$H/firstboot-pending" ]; then echo "identity step has not completed; not starting the stack"; exit 1; fi
  cd "$REPO"
  as_owner() { runuser -u "$OWNER" -- "$@"; }
  if [ -f "$H/firstboot-stack-pending" ]; then
    # containers and volumes of the master (stopped by prepare.sh) → gone; fresh ones for this board
    as_owner docker compose down -v --remove-orphans
    # stable DSH name for this board (cookie survives DHCP changes)
    if grep -q '^DSH_TRUSTED_NAMES=$' .env; then sed -i "s/^DSH_TRUSTED_NAMES=$/DSH_TRUSTED_NAMES=$(hostname).local/" .env; fi
    as_owner sh scripts/init.sh
    as_owner docker compose up -d
    sh "$REPO/host/install-watchdog.sh" || echo "watchdog install failed (retry: sudo sh host/install-watchdog.sh)"
    rm -f "$H/firstboot-stack-pending"
    echo "stack started on new board $(hostname)"
  elif [ -f "$H/resume-pending" ]; then
    as_owner docker compose up -d
    rm -f "$H/resume-pending" "$H/image-prepared"
    echo "stack resumed after prepare.sh"
  else
    echo "nothing to do"
  fi
}

case ${1:-} in
  identity) identity ;;
  stack) stack ;;
  *) echo "usage: firstboot.sh identity|stack" >&2; exit 2 ;;
esac
