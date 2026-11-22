#!/bin/sh
# Install the local display scripts from the repo (HDMI detection, Chrome watchdog) into the system directories -- they take effect with `git pull` / scripts/update.sh, no manual install.
#   sudo sh host/install-kiosk.sh        safe to re-run: does nothing if the files did not change
# Who runs it: host-agent at start-up and every 10 minutes (as root on the host); scripts/update.sh runs it once right after rebuilding host-agent.
# Acts only on machines with a local display (H2Z OS x86: /usr/local/bin/h2z-kiosk-session exists); Orange Pi, NAS and plain Linux skip silently.
# Only replaces scripts, never touches /etc/h2z/kiosk.env (field changes are kept; defaults for new settings live in the scripts, not in that file).
# The local screen is restarted (flickers for a few seconds) only if files changed; not restarted when nobody is logged in on the local screen.
# Test: H2Z_INSTALL_ROOT=<temp dir> (prefix for all system paths, no root check, systemd untouched) -- scripts/install-kiosk.test.mjs
set -eu
R=${H2Z_INSTALL_ROOT:-}
[ -n "$R" ] || [ "$(id -u)" = 0 ] || { echo "Root is required: sudo sh $0" >&2; exit 1; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
SRC="$REPO/os/x86/rootfs-system/usr/local/bin"
# The C-line scripts (h2z.backend based H2Z OS, stack under docker2/) live in os2/x86: the local h2z-os-stack treats docker2 as C.
# Always installing os/x86 regardless of line would replace the C-line kiosk scripts (blank-screen protection, boot text) brought by a full-image upgrade with the B-line ones, and restart the local screen for nothing.
# B line (field customers, os/x86) is unchanged: without docker2, os/x86 is installed.
if grep -q docker2 "$R/usr/local/sbin/h2z-os-stack" 2>/dev/null && [ -d "$REPO/os2/x86/rootfs-system/usr/local/bin" ]; then
  SRC="$REPO/os2/x86/rootfs-system/usr/local/bin"
fi
DST="$R/usr/local/bin"
[ -x "$DST/h2z-kiosk-session" ] || { echo "kiosk: this machine has no local display, skipping"; exit 0; }
[ -d "$SRC" ] || { echo "kiosk: $SRC is not in the repo, skipping"; exit 0; }
changed=""
for f in h2z-kiosk-session h2z-kiosk-browser h2z-kiosk-restart h2z-kiosk-window; do
  [ -f "$SRC/$f" ] || continue
  if ! cmp -s "$SRC/$f" "$DST/$f"; then install -m 755 "$SRC/$f" "$DST/$f"; changed="$changed $f"; fi
done
if [ -z "$changed" ]; then echo "kiosk: already up to date"; exit 0; fi
if [ -z "$R" ] && systemctl is-active --quiet getty@tty1.service 2>/dev/null; then
  # New scripts only take effect after the local screen restarts; use --no-block so host-agent / update.sh do not wait for it
  command -v h2z-boot-mark >/dev/null 2>&1 && h2z-boot-mark kiosk-sync "updated$changed restart-getty"
  systemctl restart --no-block getty@tty1.service
  echo "kiosk: updated$changed, restarting the local screen"
else
  echo "kiosk: updated$changed"
fi
