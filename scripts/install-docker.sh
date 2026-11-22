#!/bin/sh
# Ubuntu / Debian ARM64. Run with sudo on a fresh board.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run with sudo'; exit 1; }
. /etc/os-release
case "$ID" in ubuntu|debian) distro="$ID";; *) echo 'Use Docker official instructions for this distribution'; exit 1;; esac
codename="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
apt-get update
apt-get install -y ca-certificates curl git openssh-server
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$distro/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$distro
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker ssh
if [ -n "${SUDO_USER:-}" ]; then usermod -aG docker "$SUDO_USER"; fi
echo 'Log out and log in again, then run docker version and docker compose version.'
