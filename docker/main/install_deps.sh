#!/bin/bash
set -euxo pipefail

# Keep transport restrictions consistent for every download in this stage.
download_https() {
    curl --proto '=https' --proto-redir '=https' -fsSL "$@"
}


apt-get -qq update

apt-get -qq install --no-install-recommends -y \
    apt-transport-https \
    ca-certificates \
    gnupg \
    wget \
    lbzip2 \
    procps vainfo \
    unzip locales tzdata libxml2 xz-utils \
    python3.11 \
    curl \
    lsof \
    jq \
    nethogs \
    libgl1 \
    libglib2.0-0 \
    libusb-1.0.0 \
    python3-h2 \
    libgomp1  # memryx detector

update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

mkdir -p -m 600 /root/.gnupg

# install coral runtime
# sha256 digests of the release debs; update when bumping the libedgetpu release.
declare -A edgetpu_checksums=(
    ["amd64"]="63fd00989d29160fa9894e115156a9abe456e88751fc9be89d26e4696200441b"
    ["arm64"]="eab8aa4576b4dbf738135d8094f32270b24117f77147d25cbe0f49d0144d85f2"
)
download_https --output /tmp/libedgetpu1-max.deb "https://github.com/feranick/libedgetpu/releases/download/16.0TF2.17.1-1/libedgetpu1-max_16.0tf2.17.1-1.bookworm_${TARGETARCH}.deb"
echo "${edgetpu_checksums[${TARGETARCH}]}  /tmp/libedgetpu1-max.deb" | sha256sum -c -
unset DEBIAN_FRONTEND
yes | dpkg -i /tmp/libedgetpu1-max.deb && export DEBIAN_FRONTEND=noninteractive
rm /tmp/libedgetpu1-max.deb

# install mesa-teflon-delegate from bookworm-backports
# Only available for arm64 at the moment
if [[ "${TARGETARCH}" == "arm64" ]]; then
    if [[ "${BASE_IMAGE}" == *"nvcr.io/nvidia/tensorrt"* ]]; then
        echo "Info: Skipping apt-get commands because BASE_IMAGE includes 'nvcr.io/nvidia/tensorrt' for arm64."
    else
        echo "deb https://deb.debian.org/debian bookworm-backports main" | tee /etc/apt/sources.list.d/bookworm-backbacks.list
        apt-get -qq update
        apt-get -qq install --no-install-recommends --no-install-suggests -y mesa-teflon-delegate/bookworm-backports
    fi
fi

# ffmpeg -> amd64 (each tarball is verified against its release checksum)
if [[ "${TARGETARCH}" == "amd64" ]]; then
    mkdir -p /usr/lib/ffmpeg/5.0
    download_https --output ffmpeg.tar.xz "https://github.com/NickM-27/FFmpeg-Builds/releases/download/autobuild-2022-07-31-12-37/ffmpeg-n5.1-2-g915ef932a3-linux64-gpl-5.1.tar.xz"
    echo "377abec133f9d9e8014dee1b91c9684ac8bb0b5b7d80100a57116ff837c4c0d4  ffmpeg.tar.xz" | sha256sum -c -
    tar -xf ffmpeg.tar.xz -C /usr/lib/ffmpeg/5.0 --strip-components 1 amd64/bin/ffmpeg amd64/bin/ffprobe
    rm -rf ffmpeg.tar.xz
    mkdir -p /usr/lib/ffmpeg/7.0
    download_https --output ffmpeg.tar.xz "https://github.com/NickM-27/FFmpeg-Builds/releases/download/autobuild-2024-09-19-12-51/ffmpeg-n7.0.2-18-g3e6cec1286-linux64-gpl-7.0.tar.xz"
    echo "e13860eb90409c8218319c928067834ce450128e86f24cfed5cfe91ce6e31037  ffmpeg.tar.xz" | sha256sum -c -
    tar -xf ffmpeg.tar.xz -C /usr/lib/ffmpeg/7.0 --strip-components 1 amd64/bin/ffmpeg amd64/bin/ffprobe
    rm -rf ffmpeg.tar.xz
    mkdir -p /usr/lib/ffmpeg/8.0
    download_https --output ffmpeg.tar.xz "https://github.com/NickM-27/FFmpeg-Builds/releases/download/autobuild-2026-06-02-14-20/ffmpeg-n8.1.1-9-g58d4114d36-linux64-gpl-8.1.tar.xz"
    echo "9bac85054d351cdc89c0a4f45c8ea5c44df94009aabd964b719bbadd56aedae9  ffmpeg.tar.xz" | sha256sum -c -
    tar -xf ffmpeg.tar.xz -C /usr/lib/ffmpeg/8.0 --strip-components 1 amd64/bin/ffmpeg amd64/bin/ffprobe
    rm -rf ffmpeg.tar.xz
fi

# ffmpeg -> arm64
if [[ "${TARGETARCH}" == "arm64" ]]; then
    mkdir -p /usr/lib/ffmpeg/5.0
    download_https --output ffmpeg.tar.xz "https://github.com/NickM-27/FFmpeg-Builds/releases/download/autobuild-2022-07-31-12-37/ffmpeg-n5.1-2-g915ef932a3-linuxarm64-gpl-5.1.tar.xz"
    echo "57ee475407bad49910ba9b946428396e30cf075ea28a7912fbe1aa2578085af0  ffmpeg.tar.xz" | sha256sum -c -
    tar -xf ffmpeg.tar.xz -C /usr/lib/ffmpeg/5.0 --strip-components 1 arm64/bin/ffmpeg arm64/bin/ffprobe
    rm -f ffmpeg.tar.xz
    mkdir -p /usr/lib/ffmpeg/7.0
    download_https --output ffmpeg.tar.xz "https://github.com/NickM-27/FFmpeg-Builds/releases/download/autobuild-2024-09-19-12-51/ffmpeg-n7.0.2-18-g3e6cec1286-linuxarm64-gpl-7.0.tar.xz"
    echo "16c8b04e9d0ea9c769ad964c4c453fcf05121a1947237329d2e9d8a5e43e2a3c  ffmpeg.tar.xz" | sha256sum -c -
    tar -xf ffmpeg.tar.xz -C /usr/lib/ffmpeg/7.0 --strip-components 1 arm64/bin/ffmpeg arm64/bin/ffprobe
    rm -f ffmpeg.tar.xz
    mkdir -p /usr/lib/ffmpeg/8.0
    download_https --output ffmpeg.tar.xz "https://github.com/NickM-27/FFmpeg-Builds/releases/download/autobuild-2026-06-02-14-20/ffmpeg-n8.1.1-9-g58d4114d36-linuxarm64-gpl-8.1.tar.xz"
    echo "cd91948468d0f11ce795a2cdaa0c69911bd1db313b49bb19c22512beb88cde69  ffmpeg.tar.xz" | sha256sum -c -
    tar -xf ffmpeg.tar.xz -C /usr/lib/ffmpeg/8.0 --strip-components 1 arm64/bin/ffmpeg arm64/bin/ffprobe
    rm -f ffmpeg.tar.xz
fi

# arch specific packages
if [[ "${TARGETARCH}" == "amd64" ]]; then
  # Install non-free version of i965 driver
  sed -i -E "/^Components: main$/s/main/main contrib non-free non-free-firmware/" "/etc/apt/sources.list.d/debian.sources" \
      && apt-get -qq update \
      && apt-get install --no-install-recommends --no-install-suggests -y i965-va-driver-shaders \
      && sed -i -E "/^Components: main contrib non-free non-free-firmware$/s/main contrib non-free non-free-firmware/main/" "/etc/apt/sources.list.d/debian.sources" \
      && apt-get update

    # install amd / intel-i965 driver packages
    apt-get -qq install --no-install-recommends --no-install-suggests -y \
        intel-gpu-tools onevpl-tools \
        libva-drm2 \
        mesa-va-drivers radeontop

    # intel packages use zst compression so we need to update dpkg
    apt-get install -y dpkg

    # use intel apt repo for libmfx1 (legacy QSV, pre-Gen12)
    download_https --output - https://repositories.intel.com/gpu/intel-graphics.key | gpg --yes --dearmor --output /usr/share/keyrings/intel-graphics.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu jammy client" | tee /etc/apt/sources.list.d/intel-gpu-jammy.list
    apt-get -qq update

    # intel-media-va-driver-non-free is built from source in the
    # intel-media-driver Dockerfile stage for Battlemage (Xe2) support
    apt-get -qq install --no-install-recommends --no-install-suggests -y \
        libmfx1
    rm -f /usr/share/keyrings/intel-graphics.gpg
    rm -f /etc/apt/sources.list.d/intel-gpu-jammy.list

    # upgrade libva2, oneVPL runtime, and libvpl2 from trixie for Battlemage support
    echo "deb https://deb.debian.org/debian trixie main" > /etc/apt/sources.list.d/trixie.list
    apt-get -qq update
    apt-get -qq install -y -t trixie libva2 libva-drm2 libzstd1
    apt-get -qq install -y -t trixie libmfx-gen1.2 libvpl2
    rm -f /etc/apt/sources.list.d/trixie.list
    apt-get -qq update
    apt-get -qq install -y ocl-icd-libopencl1

    # install libtbb12 for NPU support
    apt-get -qq install -y libtbb12

    # install legacy and standard intel compute packages
    # sha256 digests of the driver debs, taken from the ww<week>.sum asset
    # compute-runtime ships per release and the checksum.sha256 on npu-driver
    # v1.19.0; intel-graphics-compiler and level-zero publish none, so those
    # five are hash-what-you-get. Refresh after a version bump with
    # `curl -sL <url> | sha256sum`, cross-checking upstream's sum where the
    # release still has one. npu-driver stopped publishing them after v1.19.0.
    declare -A intel_checksums=(
        ["libigdgmm12_22.9.0_amd64.deb"]="9d712f71c18baee076de9961dda71e8089291e1bd0deb5d649ab5ba5de114f97"
        ["intel-opencl-icd-legacy1_24.35.30872.36_amd64.deb"]="bbe71e4f414259e06a10cde72c29a2bd78d41b2bb2f6f8463b1806797fe66e85"
        ["intel-level-zero-gpu-legacy1_1.5.30872.36_amd64.deb"]="40dfbd15ab62de036a00824b304a2aa1fa2d81ad60ef83da09cfe3c5a80c429f"
        ["intel-igc-opencl_1.0.17537.24_amd64.deb"]="dd016400f87fa2b6a9fa9fbcca7eb4a2629174a29de679709f9bec5cede88b0e"
        ["intel-igc-core_1.0.17537.24_amd64.deb"]="c1e1ecdfe2064c047c552651cfdcdafc504f2033afafba65654338b880048b67"
        ["intel-opencl-icd_26.14.37833.4-0_amd64.deb"]="2e15eeb4fe9c1bba467a655967373eec6a20dd04cc7159de53c359f17ab53e41"
        ["libze-intel-gpu1_26.14.37833.4-0_amd64.deb"]="34ce5791160d87ce6d54edb558a4030858ee1dad2afb067b9c5c58d4cde774c6"
        ["intel-igc-opencl-2_2.32.7+21184_amd64.deb"]="3c9bddbfe558279402bbeaabcf9c63b8de46b956b0ad9625415fd35dda53ad52"
        ["intel-igc-core-2_2.32.7+21184_amd64.deb"]="64e5230788e3a31e611e8d815a141b1facb91e5f0ef239233ef3f0614bfe3fd6"
        ["level-zero_1.28.2+u22.04_amd64.deb"]="9015a579abef960166f8e943858d5c81fd4199a960f07260c1da66038257effb"
        ["intel-driver-compiler-npu_1.19.0.20250707-16111289554_ubuntu22.04_amd64.deb"]="8087bfcc0872d7976d0163203c7c783a4176f813c473766587e86c7b34135dff"
        ["intel-fw-npu_1.19.0.20250707-16111289554_ubuntu22.04_amd64.deb"]="740219c03495f8812c03ab74baf8199acf17d13929001105418d4ba226ba2290"
        ["intel-level-zero-npu_1.19.0.20250707-16111289554_ubuntu22.04_amd64.deb"]="f4f5eb97aa7da52c7fec97e4ddfb43aae01703bbadc767bae1f2d4faf342ba42"
    )

    fetch_intel_deb() {
        local url="$1" name
        name=$(basename "$url")
        download_https --remote-name "$url"
        echo "${intel_checksums[${name}]}  ${name}" | sha256sum -c -
    }

    # see https://github.com/intel/compute-runtime/blob/master/LEGACY_PLATFORMS.md for more info
    # needed core package
    fetch_intel_deb https://github.com/intel/compute-runtime/releases/download/26.14.37833.4/libigdgmm12_22.9.0_amd64.deb
    dpkg -i libigdgmm12_22.9.0_amd64.deb
    rm libigdgmm12_22.9.0_amd64.deb

    # legacy compute-runtime packages
    fetch_intel_deb https://github.com/intel/compute-runtime/releases/download/24.35.30872.36/intel-opencl-icd-legacy1_24.35.30872.36_amd64.deb
    fetch_intel_deb https://github.com/intel/compute-runtime/releases/download/24.35.30872.36/intel-level-zero-gpu-legacy1_1.5.30872.36_amd64.deb
    fetch_intel_deb https://github.com/intel/intel-graphics-compiler/releases/download/igc-1.0.17537.24/intel-igc-opencl_1.0.17537.24_amd64.deb
    fetch_intel_deb https://github.com/intel/intel-graphics-compiler/releases/download/igc-1.0.17537.24/intel-igc-core_1.0.17537.24_amd64.deb
    # standard compute-runtime packages
    fetch_intel_deb https://github.com/intel/compute-runtime/releases/download/26.14.37833.4/intel-opencl-icd_26.14.37833.4-0_amd64.deb
    fetch_intel_deb https://github.com/intel/compute-runtime/releases/download/26.14.37833.4/libze-intel-gpu1_26.14.37833.4-0_amd64.deb
    fetch_intel_deb https://github.com/intel/intel-graphics-compiler/releases/download/v2.32.7/intel-igc-opencl-2_2.32.7+21184_amd64.deb
    fetch_intel_deb https://github.com/intel/intel-graphics-compiler/releases/download/v2.32.7/intel-igc-core-2_2.32.7+21184_amd64.deb
    # npu packages
    fetch_intel_deb https://github.com/oneapi-src/level-zero/releases/download/v1.28.2/level-zero_1.28.2+u22.04_amd64.deb
    fetch_intel_deb https://github.com/intel/linux-npu-driver/releases/download/v1.19.0/intel-driver-compiler-npu_1.19.0.20250707-16111289554_ubuntu22.04_amd64.deb
    fetch_intel_deb https://github.com/intel/linux-npu-driver/releases/download/v1.19.0/intel-fw-npu_1.19.0.20250707-16111289554_ubuntu22.04_amd64.deb
    fetch_intel_deb https://github.com/intel/linux-npu-driver/releases/download/v1.19.0/intel-level-zero-npu_1.19.0.20250707-16111289554_ubuntu22.04_amd64.deb

    dpkg -i *.deb
    rm *.deb
    apt-get -qq install -f -y

    # Battlemage uses the xe kernel driver, but the VA-API driver is still iHD.
    # The oneVPL runtime may look for a driver named after the kernel module.
    ln -sf /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so /usr/lib/x86_64-linux-gnu/dri/xe_drv_video.so
fi

if [[ "${TARGETARCH}" == "arm64" ]]; then
    apt-get -qq install --no-install-recommends --no-install-suggests -y \
        libva-drm2 mesa-va-drivers radeontop
fi

# install vulkan
apt-get -qq install --no-install-recommends --no-install-suggests -y \
    libvulkan1 mesa-vulkan-drivers

apt-get purge gnupg apt-transport-https xz-utils -y
apt-get clean autoclean -y
apt-get autoremove --purge -y
rm -rf /var/lib/apt/lists/*

# Install yq, for frigate-prepare and go2rtc echo source
# sha256 digests from the release's published checksums file; update when
# bumping the yq release.
declare -A yq_checksums=(
    ["amd64"]="0ffc35320180d4911bc3a772934da508715e08af444cb33d4d43660065e25bcc"
    ["arm64"]="3c21630fda217239a5b7d718d08f08e02503098230b3abd49195d315a6dcfe45"
)
yq_arch="$(dpkg --print-architecture)"
download_https \
    "https://github.com/mikefarah/yq/releases/download/v4.48.2/yq_linux_${yq_arch}" \
    --output /usr/local/bin/yq
echo "${yq_checksums[${yq_arch}]}  /usr/local/bin/yq" | sha256sum -c -
chmod +x /usr/local/bin/yq
