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

# sha256 digests of the release artifacts, from the .sha256 files published at
# https://github.com/just-containers/s6-overlay/releases/tag/v3.2.1.0
# Update these when bumping s6_version.
declare -A s6_checksums=(
    ["noarch"]="42e038a9a00fc0fef70bf0bc42f625a9c14f8ecdfe77d4ad93281edf717e10c5"
    ["x86_64"]="8bcbc2cada58426f976b159dcc4e06cbb1454d5f39252b3bb0c778ccf71c9435"
    ["aarch64"]="c8fd6b1f0380d399422fc986a1e6799f6a287e2cfa24813ad0b6a4fb4fa755cc"
)

if [[ "${TARGETARCH}" == "amd64" ]]; then
    s6_arch="x86_64"
elif [[ "${TARGETARCH}" == "arm64" ]]; then
    s6_arch="aarch64"
fi

mkdir -p /rootfs/

# Downloaded rather than streamed into tar, so the digest is checked before
# anything is extracted.
download_and_extract() {
    local arch="$1"
    local tarball="/tmp/s6-overlay-${arch}.tar.xz"
    download_https --output "${tarball}" \
        "https://github.com/just-containers/s6-overlay/releases/download/v${s6_version}/s6-overlay-${arch}.tar.xz"
    echo "${s6_checksums[${arch}]}  ${tarball}" | sha256sum -c -
    tar -C /rootfs/ -Jxpf "${tarball}"
    rm -f "${tarball}"
}

download_and_extract "noarch"
download_and_extract "${s6_arch}"
