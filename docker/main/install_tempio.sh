#!/bin/bash
set -euxo pipefail

# Keep transport restrictions consistent for every download in this stage.
download_https() {
    curl --proto '=https' --proto-redir '=https' -fsSL "$@"
}

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl
rm -rf /var/lib/apt/lists/*


tempio_version="2021.09.0"

if [[ "${TARGETARCH}" == "amd64" ]]; then
    arch="amd64"
elif [[ "${TARGETARCH}" == "arm64" ]]; then
    arch="aarch64"
fi

mkdir -p /rootfs/usr/local/tempio/bin

download_https --output /rootfs/usr/local/tempio/bin/tempio "https://github.com/home-assistant/tempio/releases/download/${tempio_version}/tempio_${arch}"
chmod 755 /rootfs/usr/local/tempio/bin/tempio
