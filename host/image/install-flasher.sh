#!/bin/sh
# Turn the maintenance SD card into a flashing card (docs/ORANGE-PI.md §10). Run on the SD card system
# after capture.sh:
#   sudo sh install-flasher.sh [--image /h2z-image]   enable auto-flash at boot
#   sudo sh install-flasher.sh --off                   disable it (e.g. before capturing again)
#
# With auto-flash on, booting ANY board from this card writes the image to its NVMe without keyboard
# or screen: LED heartbeat while working (about 10-15 min), steady on and power off when done, fast
# blink on error (log: <image>/flash.log on the card). The master's own disk (same serial) and a board
# that already carries this image are never overwritten.
set -eu
[ "$(id -u)" = 0 ] || exec sudo sh "$0" "$@"
HERE=$(cd "$(dirname "$0")" && pwd)
IMG=/h2z-image; OFF=0
while [ $# -gt 0 ]; do
  case $1 in
    --image) IMG=$2; shift ;;
    --off) OFF=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
LIB=/usr/local/lib/h2z-image
UNIT=/etc/systemd/system/h2z-autoflash.service
if [ "$OFF" = 1 ]; then
  systemctl disable --quiet h2z-autoflash.service 2>/dev/null || true
  rm -f "$IMG/AUTOFLASH"
  echo "auto-flash off"
  exit 0
fi
[ -f "$IMG/manifest" ] || { echo "no image in $IMG: run capture.sh first" >&2; exit 1; }
need=''
for pair in partclone.ext4:partclone zstd:zstd sfdisk:fdisk partx:util-linux resize2fs:e2fsprogs; do
  command -v "${pair%%:*}" >/dev/null 2>&1 || need="$need ${pair#*:}"
done
[ -z "$need" ] || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need; }
mkdir -p "$LIB"
cp "$HERE/lib.sh" "$HERE/flash.sh" "$HERE/generalize-root.sh" "$HERE/capture.sh" "$HERE/install-flasher.sh" "$LIB/"
cat > "$UNIT" <<UNIT
[Unit]
Description=H2Z auto-flash: write $IMG to the NVMe disk
ConditionPathExists=$IMG/AUTOFLASH
After=local-fs.target systemd-udev-settle.service
Wants=systemd-udev-settle.service

[Service]
Type=oneshot
ExecStart=/bin/sh $LIB/flash.sh --auto --image $IMG
StandardOutput=journal+console
StandardError=journal+console
TimeoutStartSec=3h

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --quiet h2z-autoflash.service
sed -n 's/^id=//p' "$IMG/manifest" > "$IMG/AUTOFLASH"
echo "auto-flash on for image $(cat "$IMG/AUTOFLASH"). Power off now; boot each new board from this card."
echo "Before capturing a new master with this card: sudo sh $LIB/install-flasher.sh --off"
