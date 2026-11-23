#!/bin/sh
# Build the fpk on Linux (or WSL). Run from anywhere: sh fnos/build.sh
# Why Linux: the fnOS packer on Windows drops the executable bit of cmd/*, and the package then fails to start.
# Needs the official fnpack 1.2.3 (https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64): $FNPACK, or fnpack on PATH, or ~/fnpack-bin/fnpack (downloaded if missing).
set -eu
SRC=$(cd "$(dirname "$0")" && pwd)
OUT=$SRC/dist
FNPACK=${FNPACK:-$(command -v fnpack || true)}
[ -n "$FNPACK" ] || FNPACK=$HOME/fnpack-bin/fnpack
if [ ! -x "$FNPACK" ]; then
  mkdir -p "$(dirname "$FNPACK")"
  curl -fL -o "$FNPACK" https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-amd64
  chmod +x "$FNPACK"
fi
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
# Work on a copy on a Linux filesystem: keeps modes, and lets us force LF and the exec bits
for f in manifest ICON.PNG ICON_256.PNG app cmd config wizard; do cp -r "$SRC/$f" "$W/"; done
cp "$SRC/../uninstall.sh" "$W/app/uninstall.sh"   # the package carries its own uninstall script
find "$W" -type f ! -name '*.PNG' ! -name '*.png' -exec sed -i 's/\r$//' {} +
chmod 755 "$W"/cmd/* "$W/app/uninstall.sh"
( cd "$W" && "$FNPACK" build --directory . )
mkdir -p "$OUT"
cp "$W/com.h2ztech.security.fpk" "$OUT/"
echo "Built: $OUT/com.h2ztech.security.fpk"
sha256sum "$OUT/com.h2ztech.security.fpk"
tar -tvf "$OUT/com.h2ztech.security.fpk" | grep -E 'cmd/(main|install_init)'
