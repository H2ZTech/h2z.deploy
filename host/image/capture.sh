#!/bin/sh
# Step 2: capture the master board's NVMe into an image directory (docs/ORANGE-PI.md §10).
# Run on the maintenance SD card system (booted from SD, the NVMe is NOT mounted):
#   sudo sh capture.sh [--disk /dev/nvme0n1] [--out /h2z-image] [--force]
#
# The master is only read, never changed (its root filesystem is mounted read-only to check it).
# Output (only used blocks are copied, zstd-compressed):
#   table.sfdisk      partition table
#   pN.<fs>.pc.zst    partclone image of partition N (raw partclone.dd for unknown filesystems)
#   spi.img           SPI bootloader of the master (Orange Pi 5 Max boots NVMe through it)
#   manifest          what was captured, from where; SHA256SUMS
# The image is a full backup of the master, including its site data and secrets: keep it private.
# Copies are personalised by flash.sh (generalize-root.sh) and their first boot.
set -eu
[ "$(id -u)" = 0 ] || exec sudo sh "$0" "$@"
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib.sh"
DISK=/dev/nvme0n1; OUT=/h2z-image; FORCE=0
while [ $# -gt 0 ]; do
  case $1 in
    --disk) DISK=$2; shift ;;
    --out) OUT=$2; shift ;;
    --force) FORCE=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
need_tools partclone.ext4 partclone.dd zstd sfdisk lsblk blkid sha256sum dumpe2fs
[ -b "$DISK" ] || die "no disk $DISK"
assert_not_mounted "$DISK"
H2Z_IMAGE_LOG=/dev/null
led busy

TMP="$OUT.partial"
rm -rf "$TMP"; mkdir -p "$TMP"
sfdisk -d "$DISK" > "$TMP/table.sfdisk"

# ---- find and check the root filesystem (read-only mount, journal not replayed) -----------------
MNT=$(mktemp -d)
root_n=''; prepared=''; rev=''; src_host=''
for line in $(partitions "$DISK" | tr ' ' ':'); do
  p=${line%%:*}; n=${line#*:}
  case $(blkid -o value -s TYPE "$p" 2>/dev/null || true) in ext2|ext3|ext4) ;; *) continue ;; esac
  mount -o ro,noload "$p" "$MNT" 2>/dev/null || continue
  if [ -f "$MNT/etc/os-release" ]; then
    root_n=$n
    prepared=$(sed -n 's/^prepared=//p' "$MNT/etc/h2z/image-prepared" 2>/dev/null || true)
    rev=$(sed -n 's/^rev=//p' "$MNT/etc/h2z/image-prepared" 2>/dev/null || true)
    src_host=$(cat "$MNT/etc/hostname" 2>/dev/null || true)
    still_prepared=0; [ -f "$MNT/etc/h2z/resume-pending" ] && still_prepared=1
    firstboot=0; [ -f "$MNT/etc/h2z/firstboot-pending" ] && firstboot=1
  fi
  umount "$MNT"
  [ -n "$root_n" ] && break
done
rmdir "$MNT"
[ -n "$root_n" ] || die "no Linux root filesystem found on $DISK"
if [ -z "$prepared" ] || [ "$still_prepared" != 1 ]; then
  [ "$FORCE" = 1 ] || die "the master was not prepared (or booted again since): boot it from NVMe, run host/image/prepare.sh, then capture. --force to capture anyway"
  log "WARNING: capturing an unprepared disk (--force)"
fi
[ "$firstboot" = 0 ] || [ "$FORCE" = 1 ] || die "the disk is a fresh clone that has not booted yet; capture a prepared master instead"

# ---- space -------------------------------------------------------------------------------------
used_kb=0
for line in $(partitions "$DISK" | tr ' ' ':'); do
  p=${line%%:*}
  if [ "$(blkid -o value -s TYPE "$p" 2>/dev/null || true)" = ext4 ]; then
    bs=$(dumpe2fs -h "$p" 2>/dev/null | awk -F: '/^Block size/{gsub(/ /,"",$2);print $2}')
    free=$(dumpe2fs -h "$p" 2>/dev/null | awk -F: '/^Free blocks/{gsub(/ /,"",$2);print $2}')
    total=$(dumpe2fs -h "$p" 2>/dev/null | awk -F: '/^Block count/{gsub(/ /,"",$2);print $2}')
    used_kb=$((used_kb + (total - free) * bs / 1024))
  else
    used_kb=$((used_kb + $(lsblk -bndo SIZE "$p") / 1024))
  fi
done
avail_kb=$(df -Pk "$TMP" | awk 'NR==2{print $4}')
log "used on $DISK: $((used_kb / 1048576)) GiB (compressed is usually 40-70 %); free on $(df -P "$TMP" | awk 'NR==2{print $6}'): $((avail_kb / 1048576)) GiB"
[ "$avail_kb" -gt $((used_kb * 8 / 10)) ] || [ "$FORCE" = 1 ] || die "not enough space for the image (need about $((used_kb * 8 / 10 / 1048576)) GiB). Use a bigger SD card / USB disk with --out, or --force"

# ---- partitions --------------------------------------------------------------------------------
: > "$TMP/parts"
for line in $(partitions "$DISK" | tr ' ' ':'); do
  p=${line%%:*}; n=${line#*:}
  fs=$(blkid -o value -s TYPE "$p" 2>/dev/null || true)
  tool=$(partclone_tool "$fs")
  name="p$n.${fs:-raw}.pc.zst"
  fsbytes=$(lsblk -bndo SIZE "$p")
  case $fs in ext2|ext3|ext4)
    e2fsck -fn "$p" >/dev/null 2>&1 || log "WARNING: e2fsck reports problems on $p (the master was not shut down cleanly?)"
    bs=$(dumpe2fs -h "$p" 2>/dev/null | awk -F: '/^Block size/{gsub(/ /,"",$2);print $2}')
    bc=$(dumpe2fs -h "$p" 2>/dev/null | awk -F: '/^Block count/{gsub(/ /,"",$2);print $2}')
    fsbytes=$((bs * bc)) ;;
  esac
  log "capturing $p ($fs) with $tool → $name"
  if [ "$tool" = partclone.dd ]; then
    dd if="$p" bs=4M status=none | zstd -q -T0 -3 -o "$TMP/$name"
  else
    "$tool" -c -s "$p" -o - 2>>"$TMP/partclone.log" | zstd -q -T0 -3 -o "$TMP/$name"
  fi
  echo "$n ${fs:-raw} $fsbytes $(lsblk -bndo SIZE "$p") $name" >> "$TMP/parts"
done

# ---- SPI bootloader ----------------------------------------------------------------------------
spi=none
if [ -b /dev/mtdblock0 ]; then
  dd if=/dev/mtdblock0 of="$TMP/spi.img" bs=64k status=none
  if [ -n "$(tr -d '\000\377' < "$TMP/spi.img" | head -c 1)" ]; then spi=spi.img; else rm -f "$TMP/spi.img"; log "SPI flash is empty: not captured"; fi
else
  log "no /dev/mtdblock0: SPI bootloader not captured (flash.sh then uses the bootloader shipped with Armbian on the card)"
fi

cat > "$TMP/manifest" <<M
id=$(date +%Y%m%d-%H%M%S)-$(printf '%s' "$rev" | cut -c1-8)
created=$(date -Is)
source_disk=$DISK
source_serial=$(disk_serial "$DISK")
source_bytes=$(lsblk -bndo SIZE "$DISK")
source_hostname=$src_host
prepared=$prepared
repo_rev=$rev
root_partition=$root_n
spi=$spi
M
(cd "$TMP" && sha256sum table.sfdisk parts manifest ./*.pc.zst $( [ "$spi" = none ] || echo spi.img ) > SHA256SUMS)
if [ -e "$OUT" ]; then
  rm -rf "$OUT.previous"; mv "$OUT" "$OUT.previous"
  log "previous image kept as $OUT.previous (delete it when the new one is verified)"
fi
mv "$TMP" "$OUT"
sync
led ok
log "image ready: $OUT ($(du -sh "$OUT" | cut -f1)). Auto-flashing is off until you run install-flasher.sh."
cat "$OUT/manifest"
