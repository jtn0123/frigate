#!/bin/bash

set -euxo pipefail

hailo_version="4.21.0"

if [[ "${TARGETARCH}" == "amd64" ]]; then
    arch="x86_64"
elif [[ "${TARGETARCH}" == "arm64" ]]; then
    arch="aarch64"
fi

curl --proto '=https' --proto-redir '=https' -fsSL "https://github.com/frigate-nvr/hailort/releases/download/v${hailo_version}/hailort-debian12-${TARGETARCH}.tar.gz" | tar -C / -xzf -
curl --proto '=https' --proto-redir '=https' -fsSL --create-dirs --output-dir /wheels/ --remote-name "https://github.com/frigate-nvr/hailort/releases/download/v${hailo_version}/hailort-${hailo_version}-cp311-cp311-linux_${arch}.whl"
