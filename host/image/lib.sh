# Shared helpers for the H2Z board imaging scripts (sourced, POSIX sh).
# See docs/ORANGE-PI.md §10 (母版与克隆).

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "${H2Z_IMAGE_LOG:-/dev/null}" >&2; }
die() { log "ERROR: $*"; led error; exit 1; }

# LED feedback (best effort; works headless): busy = heartbeat, ok = steady on, error = fast blink.
led() {
  for l in /sys/class/leds/*; do
    [ -w "$l/trigger" ] || continue
    case $1 in
      busy) echo heartbeat > "$l/trigger" 2>/dev/null || true ;;
      ok) echo default-on > "$l/trigger" 2>/dev/null || echo none > "$l/trigger" 2>/dev/null || true ;;
      error) if echo timer > "$l/trigger" 2>/dev/null; then echo 100 > "$l/delay_on" 2>/dev/null; echo 100 > "$l/delay_off" 2>/dev/null; fi; true ;;
    esac
  done
}

# Partitions of a disk, in order: "<device> <number>" per line.
partitions() {
  lsblk -lnpo NAME,TYPE "$1" | awk '$2 == "part" { print $1 }' | while read -r p; do
    printf '%s %s\n' "$p" "$(cat "/sys/class/block/$(basename "$p")/partition")"
  done
}

# Device node of partition number $2 on disk $1 (nvme0n1 → nvme0n1p1, sda → sda1, loop0 → loop0p1).
part_dev() {
  case $1 in *[0-9]) echo "${1}p$2" ;; *) echo "$1$2" ;; esac
}

# Refuse to touch a disk that holds anything mounted (e.g. the system we are running from).
assert_not_mounted() {
  if lsblk -lnpo MOUNTPOINT "$1" | grep -q .; then
    die "$1 has mounted partitions ($(lsblk -lnpo NAME,MOUNTPOINT "$1" | awk 'NF==2' | tr '\n' ' ')). Boot from the maintenance SD card first."
  fi
}

# partclone tool for a filesystem type ('' when it has no partclone support → raw copy with partclone.dd).
partclone_tool() {
  case $1 in
    ext2|ext3|ext4) echo partclone.ext4 ;;
    vfat|fat16|fat32) echo partclone.vfat ;;
    btrfs) echo partclone.btrfs ;;
    xfs) echo partclone.xfs ;;
    f2fs) echo partclone.f2fs ;;
    *) echo partclone.dd ;;
  esac
}

disk_serial() { lsblk -dno SERIAL "$1" 2>/dev/null | tr -d ' ' ; }

need_tools() {
  missing=''
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
  [ -z "$missing" ] || die "missing tools:$missing (sudo apt-get install -y partclone zstd fdisk e2fsprogs)"
}
