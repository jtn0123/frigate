#!/bin/bash
set -euxo pipefail

# Keep transport restrictions consistent for every download in this stage.
download_https() {
    curl --proto '=https' --proto-redir '=https' -fsSL "$@"
}

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl
rm -rf /var/lib/apt/lists/*


s6_version="3.2.1.0"

if [[ "${TARGETARCH}" == "amd64" ]]; then
    s6_arch="x86_64"
elif [[ "${TARGETARCH}" == "arm64" ]]; then
    s6_arch="aarch64"
fi

mkdir -p /rootfs/

download_https "https://github.com/just-containers/s6-overlay/releases/download/v${s6_version}/s6-overlay-noarch.tar.xz" |
    tar -C /rootfs/ -Jxpf -

download_https "https://github.com/just-containers/s6-overlay/releases/download/v${s6_version}/s6-overlay-${s6_arch}.tar.xz" |
    tar -C /rootfs/ -Jxpf -
