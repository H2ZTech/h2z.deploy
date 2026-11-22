#!/bin/sh
# One-time host setup for the maintenance WiFi hotspot, its firewall and LAN management. Run once per board
# on the Orange Pi from the repository:
#   sudo sh host/setup-host-network.sh
# Later changes to host/ arrive with `git pull`: host-agent notices (hash of host/ vs /etc/h2z/setup.sha)
# and re-runs this script with --auto, which re-renders the files and restarts only what changed
# (an open hotspot stays open; a closed one stays closed).
#
# H2Z OS (x86) runs it automatically before the first `docker compose up` (os/x86 h2z-os-stack). Boxes without a
# WiFi card (most x86) simply get no maintenance hotspot; every wired port is managed (NVR-style uplink + camera port).
#
# What it does (Armbian / Debian with systemd-networkd + netplan):
#   1. installs hostapd, nftables, iw, rfkill
#   2. writes /etc/h2z/host.env (interfaces, SSID, passphrase, ports) — existing values are kept
#   3. renders hostapd / nftables / networkd files from host/templates into /etc/h2z and /etc/systemd/network
#   4. hands the LAN port to /etc/netplan/20-h2z-lan.yaml (DHCP, same as Armbian's default); the original
#      netplan files are moved to /etc/h2z/netplan-orig/ the first time
#   5. links and enables the systemd units in host/systemd, opens the hotspot for AP_WINDOW_MIN minutes
# LAN address changes are then made from IOC admin → 设备网络 (host-agent), never by editing files.
set -eu
[ "$(id -u)" = 0 ] || exec sudo sh "$0" "$@"
AUTO=0; [ "${1:-}" = --auto ] && AUTO=1
REPO=$(cd "$(dirname "$0")/.." && pwd)
ETC=/etc/h2z
ENVF=$ETC/host.env
umask 022
mkdir -p "$ETC"

if ! systemctl is-active --quiet systemd-networkd; then
  echo "systemd-networkd is not active. This script supports the Armbian systemd-networkd + netplan setup only." >&2
  exit 1
fi
command -v netplan >/dev/null || { echo "netplan not found" >&2; exit 1; }

need=''
for pair in hostapd:hostapd nft:nftables iw:iw rfkill:rfkill; do
  bin=${pair%%:*}; pkg=${pair#*:}
  [ -x "/usr/sbin/$bin" ] || command -v "$bin" >/dev/null 2>&1 || need="$need $pkg"
done
if [ -n "$need" ]; then
  echo "Installing:$need"
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need
fi

# ---- interfaces ---------------------------------------------------------------------------------
wifi=''; for d in /sys/class/net/*; do [ -d "$d/wireless" ] && { wifi=$(basename "$d"); break; }; done
lan=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
if [ -z "$lan" ] || [ -d "/sys/class/net/$lan/wireless" ]; then
  lan=''; for d in /sys/class/net/e*; do [ -e "$d/device" ] && { lan=$(basename "$d"); break; }; done
fi
[ -n "$lan" ] || { echo "No wired LAN interface found" >&2; exit 1; }
# every physical wired port, the default-route one first (H2Z OS: "网口 1", "网口 2")
lans="$lan"; for d in /sys/class/net/e*; do n=$(basename "$d"); [ -e "$d/device" ] && [ "$n" != "$lan" ] && lans="$lans $n"; done
if [ -n "$wifi" ] && ! iw list 2>/dev/null | sed -n '/Supported interface modes/,/Band/p' | grep -q '\* AP$'; then
  echo "WiFi interface $wifi does not support AP mode: no maintenance hotspot" >&2; wifi=''
fi
[ -n "$wifi" ] || echo "No usable WiFi interface: no maintenance hotspot (LAN management only)"

# ---- settings (keep existing values) ------------------------------------------------------------
touch "$ENVF"; chmod 600 "$ENVF"
# Values are single-quoted: the file is read by sh (here), systemd (EnvironmentFile) and host-agent.
setdef() { grep -q "^$1=" "$ENVF" || printf "%s='%s'\n" "$1" "$2" >> "$ENVF"; }
dotenv() { [ -f "$REPO/.env" ] && grep "^$1=" "$REPO/.env" | tail -1 | cut -d= -f2- | tr -d '\r' || true; }
mac=$(tr -d ':' < "/sys/class/net/${wifi:-$lan}/address" | tr 'a-f' 'A-F')
setdef LAN_IF "$lan"
setdef LAN_IFS "$lans"
setdef AP_IF "$wifi"
setdef AP_SSID "H2Z-$(printf '%s' "$mac" | tail -c 4)"
setdef AP_PSK 'h2z@2026'
setdef AP_ADDRESS 192.168.234.1/24
setdef AP_NETWORK 192.168.234.0/24
setdef AP_CHANNEL 6
# Hotspot window after boot / after "open" in IOC admin. 30 was the first default; boards keep a value set on purpose.
sed -i "s/^AP_WINDOW_MIN='30'$/AP_WINDOW_MIN='120'/" "$ENVF"
setdef AP_WINDOW_MIN 120
http_port=$(dotenv HTTP_PORT); dsh_port=$(dotenv AI_WEB_HOST_PORT)
setdef AP_PORTS "${http_port:-8096}, ${dsh_port:-3096}"
# shellcheck disable=SC1090
. "$ENVF"
if [ -n "$AP_IF" ]; then case ${#AP_PSK} in [0-7]) echo "AP_PSK in $ENVF must be 8-63 characters (WPA2)" >&2; exit 1;; esac
for v in "$AP_SSID" "$AP_PSK"; do
  case $v in *[\'\"\|\&\\]*) echo "AP_SSID / AP_PSK must not contain quotes, |, & or backslash" >&2; exit 1;; esac
done
fi

CHANGED=''
render() { # template output mode   (records changed outputs in $CHANGED)
  sed -e "s|@AP_IF@|$AP_IF|g" -e "s|@AP_SSID@|$AP_SSID|g" -e "s|@AP_PSK@|$AP_PSK|g" \
      -e "s|@AP_CHANNEL@|$AP_CHANNEL|g" -e "s|@AP_ADDRESS@|$AP_ADDRESS|g" -e "s|@AP_PORTS@|$AP_PORTS|g" \
      "$REPO/host/templates/$1" > "$2.tmp"
  chmod "$3" "$2.tmp"
  if cmp -s "$2.tmp" "$2" 2>/dev/null; then rm -f "$2.tmp"; else mv "$2.tmp" "$2"; CHANGED="$CHANGED $1"; fi
}
if [ -n "$AP_IF" ]; then
render hostapd-maint.conf.in "$ETC/hostapd-maint.conf" 600
render h2z-maint.nft.in "$ETC/h2z-maint.nft" 644
render 20-h2z-maint.network.in /etc/systemd/network/20-h2z-maint.network 644
nft -c -f "$ETC/h2z-maint.nft"
fi
mkdir -p /etc/systemd/system/h2z-maint-ap-off.timer.d
printf '[Timer]\nOnBootSec=\nOnBootSec=%smin\n' "$AP_WINDOW_MIN" > /etc/systemd/system/h2z-maint-ap-off.timer.d/window.conf.tmp
if cmp -s /etc/systemd/system/h2z-maint-ap-off.timer.d/window.conf.tmp /etc/systemd/system/h2z-maint-ap-off.timer.d/window.conf 2>/dev/null; then
  rm -f /etc/systemd/system/h2z-maint-ap-off.timer.d/window.conf.tmp
else
  mv /etc/systemd/system/h2z-maint-ap-off.timer.d/window.conf.tmp /etc/systemd/system/h2z-maint-ap-off.timer.d/window.conf
fi

# ---- LAN: our own netplan file ------------------------------------------------------------------
# Same format as host-agent renderNetplanPorts: DHCP everywhere, only LAN_IF installs the default route.
if [ ! -f /etc/netplan/20-h2z-lan.yaml ]; then
  mkdir -p "$ETC/netplan-orig"
  for f in /etc/netplan/*.yaml; do [ -e "$f" ] && mv "$f" "$ETC/netplan-orig/"; done
  set -- $LAN_IFS
  {
    echo '# Managed by H2Z host-agent (IOC admin → 设备网络). Original files: /etc/h2z/netplan-orig/'
    [ $# -gt 1 ] && echo "# h2z-primary: $LAN_IF"
    printf 'network:\n  version: 2\n  renderer: networkd\n  ethernets:\n'
    printf '    %s:\n      dhcp4: true\n      dhcp6: true\n' "$LAN_IF"
    for i in "$@"; do
      [ "$i" = "$LAN_IF" ] && continue
      printf '    %s:\n      dhcp4: true\n      dhcp6: true\n      optional: true\n' "$i"
      printf '      dhcp4-overrides:\n        use-routes: false\n      dhcp6-overrides:\n        use-routes: false\n'
    done
  } > /etc/netplan/20-h2z-lan.yaml
  chmod 600 /etc/netplan/20-h2z-lan.yaml
fi
netplan generate
case $CHANGED in *20-h2z-maint.network*|'') networkctl reload ;; esac

# ---- units ----------------------------------------------------------------------------------------
# No hotspot: make sure it is not enabled — before linking, because `systemctl disable` also removes a linked unit
# (host-agent finds the repository through the h2z-maint-ap.service link to re-apply host/ after `git pull`)
[ -n "$AP_IF" ] || systemctl disable h2z-firewall.service h2z-maint-ap.service h2z-maint-ap-off.timer >/dev/null 2>&1 || true
for u in "$REPO"/host/systemd/*.service "$REPO"/host/systemd/*.timer; do systemctl link "$u" >/dev/null; done
systemctl daemon-reload
[ -z "$AP_IF" ] || systemctl enable h2z-firewall.service h2z-maint-ap.service h2z-maint-ap-off.timer >/dev/null
# first boot of cloned boards (host/image, docs/ORANGE-PI.md §10); no-ops without their /etc/h2z flags
systemctl enable h2z-firstboot.service h2z-firstboot-stack.service >/dev/null
hash=$(cd "$REPO" && find host -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-64)

if [ -z "$AP_IF" ]; then
  echo "$hash" > "$ETC/setup.sha"
  echo "LAN ports: $LAN_IFS (default route $LAN_IF); no maintenance hotspot"
  exit 0
fi

if [ "$AUTO" = 1 ]; then
  # Update after `git pull` (run by host-agent): keep the hotspot as it is, restart only what changed.
  case $CHANGED in *h2z-maint.nft*) systemctl restart h2z-firewall.service ;; esac
  if systemctl is-active --quiet h2z-maint-ap.service; then
    case $CHANGED in *hostapd-maint.conf*|*20-h2z-maint.network*) systemctl restart h2z-maint-ap.service ;; esac
  fi
  echo "$hash" > "$ETC/setup.sha"
  echo "host setup updated:${CHANGED:- nothing changed}"
  exit 0
fi

systemctl restart h2z-firewall.service
# h2z-maint-ap-off.timer (OnBootSec) only takes effect from the next boot: starting it now, long after
# boot, would fire at once and stop the hotspot. For this session the transient close timer is used.
systemctl stop h2z-maint-ap-close.timer 2>/dev/null || true
systemctl reset-failed h2z-maint-ap-close.timer h2z-maint-ap-close.service h2z-maint-ap.service 2>/dev/null || true
systemctl restart h2z-maint-ap.service || true
systemd-run --quiet --unit=h2z-maint-ap-close --on-active="${AP_WINDOW_MIN}min" --timer-property=AccuracySec=10s \
  /usr/bin/systemctl stop h2z-maint-ap.service
sleep 3
echo "$hash" > "$ETC/setup.sha"
echo "LAN: $LAN_IF   hotspot: $AP_IF  SSID $AP_SSID  ($AP_ADDRESS, open for ${AP_WINDOW_MIN} min; reopens on every boot)"
echo "firewall: $(systemctl is-active h2z-firewall.service)   hotspot: $(systemctl is-active h2z-maint-ap.service)"
if ! systemctl is-active --quiet h2z-maint-ap.service; then
  echo "Hotspot did not start. Last log lines:" >&2
  journalctl -u h2z-maint-ap.service -n 30 --no-pager >&2 || true
  exit 1
fi
