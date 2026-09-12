#!/bin/bash
set -euxo pipefail

# Keep transport restrictions consistent for every download in this stage.
download_https() {
    curl --proto '=https' --proto-redir '=https' -fsSL "$@"
}


hailo_version="4.21.0"

if [[ "${TARGETARCH}" == "amd64" ]]; then
    arch="x86_64"
elif [[ "${TARGETARCH}" == "arm64" ]]; then
    arch="aarch64"
fi

download_https "https://github.com/frigate-nvr/hailort/releases/download/v${hailo_version}/hailort-debian12-${TARGETARCH}.tar.gz" | tar -C / -xzf -
download_https --create-dirs --output-dir /wheels/ --remote-name "https://github.com/frigate-nvr/hailort/releases/download/v${hailo_version}/hailort-${hailo_version}-cp311-cp311-linux_${arch}.whl"
