#!/bin/sh
# Step 3: write the master image to this board's NVMe and turn it into a new board
# (docs/ORANGE-PI.md §10). Runs on the maintenance SD card system:
#   sudo sh flash.sh [--image /h2z-image] [--disk /dev/nvme0n1] [--yes] [--skip-verify]
#   --auto   unattended (h2z-autoflash.service at boot, see install-flasher.sh): 30 s grace, LED
#            heartbeat while working, steady on + power off when done, fast blink on error.
#
#   1. verifies the image (SHA256SUMS)
#   2. writes the partition table; the last partition grows to fill the target disk
#   3. restores every partition (partclone), grows the root filesystem
#   4. generalize-root.sh: new identity on first boot, site data and secrets removed
#   5. writes the master's SPI bootloader if this board's differs (needed to boot from NVMe)
set -eu
[ "$(id -u)" = 0 ] || exec sudo sh "$0" "$@"
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"
IMG=/h2z-image; DISK=/dev/nvme0n1; AUTO=0; YES=0; VERIFY=1
while [ $# -gt 0 ]; do
  case $1 in
    --image) IMG=$2; shift ;;
    --disk) DISK=$2; shift ;;
    --auto) AUTO=1; YES=1 ;;
    --yes) YES=1 ;;
    --skip-verify) VERIFY=0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
H2Z_IMAGE_LOG="$IMG/flash.log"
need_tools partclone.ext4 zstd sfdisk lsblk blkid e2fsck resize2fs partx sha256sum
[ -f "$IMG/manifest" ] || die "no image in $IMG (run capture.sh first)"
m() { sed -n "s/^$1=//p" "$IMG/manifest"; }
ID=$(m id)
log "=== flash $ID → $DISK"
if [ ! -b "$DISK" ]; then
  [ "$AUTO" = 1 ] && { log "no NVMe disk ($DISK): nothing to do"; led error; exit 0; }
  die "no disk $DISK"
fi
assert_not_mounted "$DISK"

# ---- safety ------------------------------------------------------------------------------------
target_serial=$(disk_serial "$DISK")
if [ -n "$target_serial" ] && [ "$target_serial" = "$(m source_serial)" ]; then
  die "$DISK is the master's own disk (serial $target_serial): not overwriting it"
fi
if [ "$AUTO" = 1 ]; then
  # already flashed with this image and the card was left in: do not wipe the board again
  root_dev=$(part_dev "$DISK" "$(m root_partition)")
  if [ -b "$root_dev" ]; then
    MNT=$(mktemp -d)
    if mount -o ro,noload "$root_dev" "$MNT" 2>/dev/null; then
      flashed=$(cat "$MNT/etc/h2z/image-id" 2>/dev/null || true)
      umount "$MNT"
      if [ "$flashed" = "$ID" ]; then rmdir "$MNT"; log "$DISK already has image $ID: remove the SD card and boot from NVMe"; led ok; exit 0; fi
    fi
    rmdir "$MNT"
  fi
  log "flashing in 30 s (remove the SD card / power off to cancel)"
  led busy
  sleep 30
elif [ "$YES" != 1 ]; then
  lsblk -o NAME,SIZE,MODEL,SERIAL "$DISK"
  printf 'Everything on %s will be replaced by image %s. Type YES to continue: ' "$DISK" "$ID"
  read -r answer
  [ "$answer" = YES ] || { echo "cancelled"; exit 1; }
fi
led busy

if [ "$VERIFY" = 1 ]; then
  log "verifying image files"
  (cd "$IMG" && sha256sum -c --quiet SHA256SUMS) || die "image files are damaged (SHA256SUMS): capture again or copy the image again"
fi

# ---- size: everything before the last partition as-is, the last one must hold its filesystem ----
sector=$(sed -n 's/^sector-size: *//p' "$IMG/table.sfdisk"); sector=${sector:-512}
last_line=$(grep '^/dev/' "$IMG/table.sfdisk" | tail -1)
last_start=$(printf '%s' "$last_line" | sed -n 's/.*start= *\([0-9]*\).*/\1/p')
last_n=$(tail -1 "$IMG/parts" | cut -d' ' -f1)
last_fs_bytes=$(tail -1 "$IMG/parts" | cut -d' ' -f3)
need=$((last_start * sector + last_fs_bytes + 1048576))
have=$(lsblk -bndo SIZE "$DISK")
gb() { awk -v b="$1" 'BEGIN { printf "%.1f GB", b / 1e9 }'; }
[ "$have" -ge "$need" ] || die "$DISK is too small: $(gb "$have"), the image needs at least $(gb "$need")"

# ---- partition table ---------------------------------------------------------------------------
log "writing partition table"
wipefs -aq "$DISK"
# drop the master's disk size; the last partition takes the rest of this disk
grep -v -e '^device:' -e '^last-lba:' "$IMG/table.sfdisk" \
  | awk -v last="$last_line" '$0 == last { sub(/size= *[0-9]+, */, "") } { print }' \
  | sfdisk -q --no-reread "$DISK"
partx -u "$DISK" 2>/dev/null || partx -a "$DISK" 2>/dev/null || true
command -v udevadm >/dev/null && udevadm settle || true

# ---- partitions --------------------------------------------------------------------------------
while read -r n fs _fsbytes _partbytes file; do
  dev=$(part_dev "$DISK" "$n")
  i=0; while [ ! -b "$dev" ] && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  [ -b "$dev" ] || die "partition $dev did not appear"
  tool=$(partclone_tool "$fs")
  log "restoring $file → $dev"
  if [ "$tool" = partclone.dd ]; then
    zstd -dc "$IMG/$file" | dd of="$dev" bs=4M conv=fsync status=none
  else
    zstd -dc "$IMG/$file" | "$tool" -r -s - -o "$dev" 2>>"$IMG/partclone-restore.log" || die "restore of $dev failed (see $IMG/partclone-restore.log)"
  fi
  if [ "$n" = "$last_n" ]; then
    case $fs in ext2|ext3|ext4)
      rc=0; e2fsck -fy "$dev" >/dev/null 2>&1 || rc=$?
      [ $rc -le 1 ] || die "e2fsck failed on $dev ($rc)"
      resize2fs "$dev" >/dev/null 2>&1 || die "resize2fs failed on $dev"
      log "grew $dev to $(($(lsblk -bndo SIZE "$dev") / 1000000000)) GB" ;;
    esac
  fi
done < "$IMG/parts"

# ---- new board ---------------------------------------------------------------------------------
root_dev=$(part_dev "$DISK" "$(m root_partition)")
MNT=$(mktemp -d)
mount "$root_dev" "$MNT"
if ! sh "$HERE/generalize-root.sh" "$MNT" >>"$H2Z_IMAGE_LOG" 2>&1; then
  umount "$MNT"; rmdir "$MNT"; die "generalize-root.sh failed (see $H2Z_IMAGE_LOG)"
fi
echo "$ID" > "$MNT/etc/h2z/image-id"
sync
# discard the freed blocks (the master's site data that generalize-root.sh deleted) on the SSD
fstrim "$MNT" >/dev/null 2>&1 || true
umount "$MNT"; rmdir "$MNT"
log "new identity is created on first boot"

# ---- SPI bootloader ----------------------------------------------------------------------------
if [ -b /dev/mtdblock0 ]; then
  spi=''
  [ "$(m spi)" = spi.img ] && spi="$IMG/spi.img"
  if [ -z "$spi" ]; then spi=$(ls /usr/lib/linux-u-boot-*/rkspi_loader.img 2>/dev/null | head -1 || true); fi
  if [ -n "$spi" ]; then
    if cmp -s -n "$(stat -c %s "$spi")" "$spi" /dev/mtdblock0; then
      log "SPI bootloader already up to date"
    else
      log "writing SPI bootloader ($(basename "$spi"))"
      dd if="$spi" of=/dev/mtdblock0 bs=64k conv=fsync status=none
      cmp -s -n "$(stat -c %s "$spi")" "$spi" /dev/mtdblock0 || die "SPI bootloader verify failed"
    fi
  else
    log "WARNING: no SPI bootloader image; if this board does not boot from NVMe, write one with armbian-install"
  fi
else
  log "WARNING: no /dev/mtdblock0: SPI bootloader not checked"
fi

sync
led ok
log "=== done: $DISK has image $ID. Remove the SD card and power on."
[ "$AUTO" = 1 ] && { sleep 5; poweroff; }
exit 0
