#!/bin/sh
# B-line one-command install: take a fresh Debian / Ubuntu machine (x86_64 or arm64) from nothing to running services.
#
# One command, on the target Linux machine (no token or account needed):
#   curl -fsSL https://raw.githubusercontent.com/H2ZTech/h2z.deploy/main/install.sh | sudo sh
#   To only see what it would do:  ... | sudo sh -s -- --dry-run
# Code comes from the public repo H2ZTech/h2z.deploy. Images come from GHCR, also public. No token or account is needed.
# To pull from another repo (a fork, say): REPO_SLUG=<owner>/<repo> sudo -E sh ... ; for a private one add GH_TOKEN=<read-only token>
#   or --auth deploykey (generates a read-only SSH key and waits for you to add it to GitHub Deploy keys).
#
# Options:
#   --dir PATH      code directory (default /opt/h2z.security, same as the H2Z OS installer; owned by the login user)
#   --branch NAME   branch (default main)
#   --auth MODE     none | token | deploykey (default: token if GH_TOKEN is set, otherwise none)
#   --network MODE  passed to host/setup-host.sh as --network (default skip: a remote install must not touch NICs)
#   --no-start      install tools, fetch code, initialize config, but do not run docker compose up
#   --force         continue even if the arm64 image check reports FAIL
#   --yes           kept for compatibility (the script never prompts when there is no terminal anyway)
#   --dry-run       change nothing
#
# All images come from GHCR (ghcr.io/h2ztech/, public, no login). The script never logs in to any image registry.
# Safe to re-run: steps that are already done are skipped.
set -eu
# A strict login umask (077) would leave the checked-out config unreadable to containers (EMQX failed with eacces).
umask 022

REPO_SLUG=${REPO_SLUG:-H2ZTech/h2z.deploy}   # public deployment repo, no token needed
REPO_URL=${REPO_URL:-https://github.com/$REPO_SLUG.git}
BRANCH=main; DIR=; AUTH=; NET=skip; START=1; FORCE=0; YES=0; DRY=0
while [ $# -gt 0 ]; do
  case $1 in
    --dir) DIR=$2; shift ;; --branch) BRANCH=$2; shift ;; --auth) AUTH=$2; shift ;; --network) NET=$2; shift ;;
    --no-start) START=0 ;; --force) FORCE=1 ;; --yes) YES=1 ;; --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac; shift
done

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

# ---------- 1. Detect ----------
say "1/8 Detecting OS and hardware"
[ -r /etc/os-release ] || die "no /etc/os-release, cannot identify the OS"
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "only Debian / Ubuntu are supported (found: ${PRETTY_NAME:-unknown})" ;; esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU architecture: $(uname -m) (only x86_64 / arm64)" ;;
esac
MODEL=$( { [ -r /proc/device-tree/model ] && tr -d '\0' < /proc/device-tree/model; } 2>/dev/null || cat /sys/class/dmi/id/product_name 2>/dev/null || echo unknown)
MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
KIND=generic
case "$MODEL" in *[Oo]range*|*RK35*|*Rockchip*) KIND="Orange Pi / RK3588 class board" ;; esac
echo "OS: ${PRETTY_NAME}    arch: $ARCH    model: $MODEL ($KIND)    memory: ${MEM_MB} MB"
[ "$MEM_MB" -ge 3500 ] || echo "WARNING: less than 4 GB of memory, the full stack may not start"
[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || die "run with sudo"
if [ "$ARCH" = arm64 ] && [ "$KIND" = generic ]; then echo "Note: arm64 but not a common Orange Pi board; services start only if the image check passes"; fi

U=${SUDO_USER:-$(id -un)}
HOME_U=$(getent passwd "$U" | cut -d: -f6); [ -n "$HOME_U" ] || HOME_U=$HOME
[ -n "$DIR" ] || DIR=/opt/h2z.security
have_tty() { (exec </dev/tty) 2>/dev/null; }
as_user() { if [ "$(id -u)" = 0 ] && [ "$U" != root ]; then sudo -u "$U" -H "$@"; else "$@"; fi; }
# Use sg as a fallback when the docker group was just added and this session has not picked it up yet
dk() { if as_user docker info >/dev/null 2>&1; then as_user sh -c "$1"; else as_user sg docker -c "$1"; fi; }
echo "login user: $U    code directory: $DIR    branch: $BRANCH"

# Home directory (holds .ssh / .git-credentials) and code directory: create them as root and hand them to the
# login user if missing (some machines have no writable home / parent directory for that user, and a plain
# git clone as that user fails with Permission denied)
UG=$(id -gn "$U" 2>/dev/null || echo "$U")
if [ "$DRY" = 0 ] && [ "$(id -u)" = 0 ]; then
  [ -d "$HOME_U" ] || install -d -o "$U" -g "$UG" -m 755 "$HOME_U"
  [ -d "$(dirname "$DIR")" ] || install -d -m 755 "$(dirname "$DIR")"
  [ -d "$DIR/.git" ] || install -d -o "$U" -g "$UG" -m 755 "$DIR"
fi

# Disk: free space on the disk holding Docker data (before Docker is installed, the disk of /var/lib/docker)
DR=/var/lib/docker; command -v docker >/dev/null 2>&1 && DR=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
CHK=$DR; [ -e "$CHK" ] || CHK=/var/lib
FREE_GB=$(df -P -B1 "$CHK" | awk 'NR==2 {printf "%d", $4/1e9}')
echo "Free space on the Docker data disk: ${FREE_GB} GB (need >= 15 GB)"
[ "$FREE_GB" -ge 15 ] || { [ "$FORCE" = 1 ] || die "less than 15 GB free; free some space or use --force"; }
if [ "$ARCH" = arm64 ]; then
  ROOTDEV=$(findmnt -n -o SOURCE / 2>/dev/null || true)
  case "$ROOTDEV" in /dev/mmcblk*) echo "WARNING: root filesystem is on an SD card ($ROOTDEV). Recordings and the database will wear it out quickly; use an SSD in production" ;; esac
fi

# ---------- 2. Base tools ----------
say "2/8 Installing base tools"
# A leftover apt source of ours (host/setup-host.sh adds and removes it around the cloudflared install) must not break apt update
if [ "$DRY" = 0 ] && grep -qs 'Signed-By: /etc/apt/keyrings/cloudflare-main.gpg' /etc/apt/sources.list.d/cloudflared.sources 2>/dev/null; then
  echo "Removing a leftover cloudflared apt source (re-added only when cloudflared is installed)"
  rm -f /etc/apt/sources.list.d/cloudflared.sources /etc/apt/keyrings/cloudflare-main.gpg
fi
# apt update can fail because of an unrelated third-party source on the machine (expired key, unreachable mirror):
# warn and carry on; the install below fails clearly if a needed package is really unavailable.
run apt-get update -y || echo "WARNING: apt-get update reported errors (see above); continuing with the package lists that were fetched"
run apt-get install -y git ca-certificates curl jq python3 nodejs npm openssh-client

# ---------- 3. Fetch code ----------
say "3/8 Fetching code ($REPO_SLUG)"
[ -n "$AUTH" ] || { if [ -n "${GH_TOKEN:-}" ]; then AUTH=token; else AUTH=none; fi; }
if [ -d "$DIR/.git" ]; then
  echo "Code directory already exists, updating only: $DIR"
  run as_user git -C "$DIR" fetch origin
  run as_user git -C "$DIR" switch "$BRANCH"
  run as_user git -C "$DIR" pull --ff-only origin "$BRANCH"
else
  case $AUTH in
    none)
      run as_user git clone --branch "$BRANCH" "$REPO_URL" "$DIR" ;;
    token)
      if [ -z "${GH_TOKEN:-}" ] && [ "$DRY" = 0 ]; then
        have_tty || die "no terminal to read a token from: pass it as sudo GH_TOKEN=xxx sh ..."
        printf 'GitHub token (read-only, input hidden): ' >/dev/tty; stty -echo </dev/tty; read -r GH_TOKEN </dev/tty; stty echo </dev/tty; printf '\n' >/dev/tty
        [ -n "$GH_TOKEN" ] || die "empty token"
      fi
      if [ "$DRY" = 1 ]; then echo "[dry-run] git clone (token) and store the token in $HOME_U/.git-credentials (mode 600)"
      else
        CRED=$HOME_U/.git-credentials
        ( umask 077; touch "$CRED"; grep -v '@github.com' "$CRED" > "$CRED.tmp" 2>/dev/null || true
          printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" >> "$CRED.tmp"; mv "$CRED.tmp" "$CRED" )
        chown "$U" "$CRED"; chmod 600 "$CRED"
        as_user git config --global credential.helper store
        as_user git clone --branch "$BRANCH" "$REPO_URL" "$DIR"
      fi ;;
    deploykey)
      KEY=$HOME_U/.ssh/h2z_security_deploy
      if [ "$DRY" = 1 ]; then echo "[dry-run] generate $KEY, wait for you to add the public key to GitHub Deploy keys, then git clone"
      else
        as_user mkdir -p "$HOME_U/.ssh"; as_user chmod 700 "$HOME_U/.ssh"
        [ -f "$KEY" ] || as_user ssh-keygen -t ed25519 -N '' -C "h2z-$(hostname)" -f "$KEY"
        if ! grep -q 'Host github-h2z-security' "$HOME_U/.ssh/config" 2>/dev/null; then
          as_user sh -c "cat >> '$HOME_U/.ssh/config' <<EOF
Host github-h2z-security
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF"
          as_user chmod 600 "$HOME_U/.ssh/config"
        fi
        until as_user git ls-remote "git@github-h2z-security:$REPO_SLUG.git" HEAD >/dev/null 2>&1; do
          echo; echo "Add this public key at https://github.com/$REPO_SLUG/settings/keys (Add deploy key, do NOT tick Allow write access):"
          echo; cat "$KEY.pub"; echo
          have_tty || die "no terminal to wait on: add the key above to GitHub and re-run, or use GH_TOKEN instead"
          printf 'Press Enter once it is added (Ctrl-C to quit)... ' >/dev/tty; read -r _ </dev/tty
        done
        as_user git clone --branch "$BRANCH" "git@github-h2z-security:$REPO_SLUG.git" "$DIR"
      fi ;;
    *) die "--auth must be none / token / deploykey" ;;
  esac
fi
[ "$DRY" = 1 ] || [ -f "$DIR/compose.yaml" ] || die "no compose.yaml in the code directory: $DIR"
# Make tracked files (config, scripts) readable by containers even if the checkout ran under a strict umask.
# Only tracked files are touched, never .env / secrets / runtime.
if [ "$DRY" != 1 ]; then
  as_user sh -c 'cd "$1" && git ls-files -z | xargs -0 chmod go+rX && git ls-files | sed -n "s#/[^/]*\$##p" | sort -u | xargs chmod go+rx' sh "$DIR"
fi

# ---------- 4. Host layer (Docker, watchdog, ...) ----------
say "4/8 Installing Docker and the host layer (host/setup-host.sh --network=$NET)"
run sh "$DIR/host/setup-host.sh" "--network=$NET"
[ "$DRY" = 1 ] || command -v docker >/dev/null 2>&1 || die "Docker was not installed, see the setup-host output above"
[ "$DRY" = 1 ] || [ "$U" = root ] || id -nG "$U" | tr ' ' '\n' | grep -qx docker || run usermod -aG docker "$U"

# ---------- 5. Initialize config ----------
say "5/8 Generating .env and secrets (scripts/init.sh)"
if [ "$DRY" = 1 ]; then echo "[dry-run] sh scripts/init.sh"; else dk "cd '$DIR' && sh scripts/init.sh"; fi
if [ "$DRY" = 0 ]; then
  # Isolation check: no image may come from a registry other than GHCR / Docker Hub.
  # An image reference whose first path segment looks like a host name (contains a dot) is a foreign registry;
  # local build tags such as h2z-security/yolo:0.1.0 and Docker Hub names such as emqx/emqx are fine.
  BAD=$(grep -E '^[A-Z_]+_IMAGE=' "$DIR/.env" | grep -E '=[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:[0-9]+)?/' | grep -v '=ghcr.io/h2ztech/' || true)
  [ -z "$BAD" ] || die "found image(s) from a registry other than GHCR in .env; delete $DIR/.env and re-run:
$BAD"
fi

# Same defaults as the C line (h2z-os-stack): the backend creates the device project and its space on first start,
# and the device language is English (switchable in the admin). A value already in .env is kept.
if [ "$DRY" = 0 ]; then
  setenv() { if grep -q "^$1=" "$DIR/.env"; then sed -i "s|^$1=.*|$1=$2|" "$DIR/.env"; else echo "$1=$2" >> "$DIR/.env"; fi; }
  setenv IOC_AUTO_PROJECT 1
  grep -q '^IOC_DEFAULT_LANG=' "$DIR/.env" || setenv IOC_DEFAULT_LANG en
fi

# ---------- 6. Image check (arm64) ----------
say "6/8 Image check"
if [ "$ARCH" = arm64 ]; then
  if [ "$DRY" = 1 ]; then echo "[dry-run] node scripts/check-images.mjs arm64"
  elif ! dk "cd '$DIR' && node scripts/check-images.mjs arm64"; then
    [ "$FORCE" = 1 ] || die "some images have no arm64 build (see FAIL above). Trigger an arm64 build in the relevant repo's Actions first; use --force to install anyway"
  fi
else echo "x86: skipping the arm64 check"; fi

# ---------- 7. Start ----------
if [ "$START" = 0 ]; then
  say "7/8 Stopping here because of --no-start"; echo "To start later: cd $DIR && docker compose pull && docker compose up -d --wait --wait-timeout 180"; exit 0
fi
say "7/8 Pulling images and starting (the first pull downloads several GB: minutes to tens of minutes)"
if [ "$DRY" = 1 ]; then echo "[dry-run] docker compose config / pull / up -d --wait"; else
  dk "cd '$DIR' && docker compose config --quiet && docker compose pull && docker compose up -d --wait --wait-timeout 180"
fi

# ---------- 8. Seed the default project + smoke test ----------
say "8/8 Seeding the default project and running the smoke test"
if [ "$DRY" = 1 ]; then echo "[dry-run] node scripts/seed-project.mjs && node scripts/smoke.mjs"; else
  # secrets/ is root:20001 mode 640 after init (by design), so the login user cannot read the admin token: run these as root
  # when we are root, and hand any file they create back to the login user.
  rt() { if [ "$(id -u)" = 0 ]; then sh -c "$1"; else dk "$1"; fi; }
  rt "cd '$DIR' && node scripts/seed-project.mjs" || echo "seed-project failed (you can re-run it later)"
  rt "cd '$DIR' && node scripts/smoke.mjs" || echo "the smoke test has failures, see the output above"
  [ "$(id -u)" = 0 ] && [ -e "$DIR/runtime/smoke-results.json" ] && chown "$U" "$DIR/runtime/smoke-results.json" || true
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

Done.
  Dashboard: http://${IP:-<this machine's IP>}:8096/ioc   (bound to localhost by default; to open it to the LAN set HTTP_BIND=0.0.0.0 in $DIR/.env, then docker compose up -d)
  Admin:     /ioc/admin    default account admin / h2z2026   -- change it before handing over
  Update:    cd $DIR && sh scripts/update.sh
  Acceptance checklist: $DIR/docs/DEPLOY-B-LINE.md, section 4
EOF
