#!/bin/sh
# Install / update the board watchdog. Safe to re-run:
#   sudo sh host/install-watchdog.sh
# - host/watchdog.sh -> /usr/local/lib/h2z/watchdog.sh, run by systemd every minute (h2z-watchdog.timer)
# - /etc/h2z/watchdog.env records the deployment directory (the watchdog uses docker compose --project-directory so it only touches this project)
# - Hardware watchdog: systemd RuntimeWatchdogSec=60 (reboots only if the OS itself hangs; a network outage does not trigger it). systemd skips it automatically when there is no /dev/watchdog (virtual machines);
#   NAS systems manage the hardware watchdog themselves and are left alone
# Test: H2Z_INSTALL_ROOT=<temp dir> (prefix for all system paths, no root check) -- scripts/install-watchdog.test.mjs
set -eu
R=${H2Z_INSTALL_ROOT:-}
[ -n "$R" ] || [ "$(id -u)" = 0 ] || { echo "Root is required: sudo sh $0" >&2; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
STATE="$R/var/lib/h2z/watchdog"
install -d -m 755 "$R/usr/local/lib/h2z" "$R/etc/h2z" "$STATE" "$R/etc/systemd/system" "$R/etc/systemd/system.conf.d"
install -m 755 "$REPO/host/watchdog.sh" "$R/usr/local/lib/h2z/watchdog.sh"
# The update script (a regular user in the docker group) must be able to write the pause file: give the state directory to the docker group
if getent group docker >/dev/null 2>&1; then chgrp docker "$STATE" && chmod 2775 "$STATE"; fi
printf "H2Z_DIR='%s'\n" "$REPO" > "$R/etc/h2z/watchdog.env"
# setup-host-network.sh systemctl-links the units under host/systemd/ as symlinks into the repo (watchdog included): no need to install a unit that is already the same file
# (install exits with an error when source and target are the same file; seen on a side-car machine in the field)
for u in h2z-watchdog.service h2z-watchdog.timer; do
  [ "$REPO/host/systemd/$u" -ef "$R/etc/systemd/system/$u" ] || install -m 644 "$REPO/host/systemd/$u" "$R/etc/systemd/system/$u"
done
# NAS systems (fnOS / TrueNAS / Synology ...) manage the hardware watchdog themselves: leave it alone (same markers storage-agent uses to detect managed mode)
nas=""
for m in /usr/trim /etc/synoinfo.conf /etc/unraid-version /usr/share/openmediavault /etc/default/truenas; do
  if [ -e "$R$m" ]; then nas=$m; fi
done
if grep -qiE 'fnos|truenas|unraid|openmediavault|synology' "$R/etc/os-release" 2>/dev/null; then nas=${nas:-os-release}; fi
case "$(uname -r)" in *-trim) nas=${nas:-kernel} ;; esac
if [ -z "$nas" ]; then
  cat > "$R/etc/systemd/system.conf.d/h2z-watchdog.conf" <<'CONF'
# H2Z: hardware watchdog. Reboot if the OS itself hangs (kernel / systemd stuck) and 60 s pass without feeding it; force a reboot if shutdown hangs for 10 minutes
[Manager]
RuntimeWatchdogSec=60
RebootWatchdogSec=10min
CONF
fi
systemctl daemon-reload
if [ -z "$nas" ]; then systemctl daemon-reexec; fi   # make RuntimeWatchdogSec take effect (does not restart services)
systemctl enable --now h2z-watchdog.timer >/dev/null
systemctl start h2z-watchdog.service || true
if [ -n "$nas" ]; then
  hw="unchanged (the NAS system manages it, $nas)"
elif [ -e "$R/dev/watchdog" ] || [ -e "$R/dev/watchdog0" ]; then
  hw="$(systemctl show -p RuntimeWatchdogUSec --value 2>/dev/null || echo set)"
else
  hw="none (virtual machine or no driver, systemd skips it)"
fi
echo "watchdog: $(systemctl is-active h2z-watchdog.timer 2>/dev/null || echo unknown); hardware watchdog: $hw; status: /var/lib/h2z/watchdog/status.json"
