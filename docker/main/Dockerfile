# syntax=docker/dockerfile:1.6

# https://askubuntu.com/questions/972516/debian-frontend-environment-variable
ARG DEBIAN_FRONTEND=noninteractive

# Globally set pip break-system-packages option to avoid having to specify it every time
ARG PIP_BREAK_SYSTEM_PACKAGES=1

ARG BASE_IMAGE=debian:12
ARG SLIM_BASE=debian:12-slim

# A hook that allows us to inject commands right after the base images
ARG BASE_HOOK=

FROM ${BASE_IMAGE} AS base
ARG PIP_BREAK_SYSTEM_PACKAGES
ARG BASE_HOOK

RUN sh -c "$BASE_HOOK"

FROM --platform=${BUILDPLATFORM} debian:12 AS base_host
ARG PIP_BREAK_SYSTEM_PACKAGES

FROM ${SLIM_BASE} AS slim-base
ARG PIP_BREAK_SYSTEM_PACKAGES
ARG BASE_HOOK

RUN sh -c "$BASE_HOOK"

FROM slim-base AS wget
ARG DEBIAN_FRONTEND
RUN apt-get update \
    && apt-get install -y ca-certificates curl wget xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /rootfs

FROM base AS nginx
ARG DEBIAN_FRONTEND
ENV CCACHE_DIR /root/.ccache
ENV CCACHE_MAXSIZE 2G

RUN --mount=type=bind,source=docker/main/build_nginx.sh,target=/deps/build_nginx.sh \
    /deps/build_nginx.sh

FROM wget AS sqlite-vec
ARG DEBIAN_FRONTEND

# Build sqlite_vec from source
COPY docker/main/build_sqlite_vec.sh /deps/build_sqlite_vec.sh
RUN --mount=type=tmpfs,target=/tmp --mount=type=tmpfs,target=/var/cache/apt \
    --mount=type=bind,source=docker/main/build_sqlite_vec.sh,target=/deps/build_sqlite_vec.sh \
    --mount=type=cache,target=/root/.ccache \
    /deps/build_sqlite_vec.sh

# Build intel-media-driver from source against bookworm's system libva so it
# works with Debian 12's glibc/libstdc++ (pre-built noble/trixie packages
# require glibc 2.38 which is not available on bookworm).
FROM base AS intel-media-driver
ARG DEBIAN_FRONTEND
RUN --mount=type=bind,source=docker/main/build_intel_media_driver.sh,target=/deps/build_intel_media_driver.sh \
    /deps/build_intel_media_driver.sh

# Build the pinned go2rtc release with H.265 RTP aggregation support.
# The patch and regression tests stay local until included in an upstream release.
FROM --platform=${BUILDPLATFORM} golang:1.27.1-bookworm AS go2rtc
ARG TARGETARCH
WORKDIR /src
ADD --checksum=sha256:e3d59e553dfd0085889a2956281cfc0fd78bb7b4d6269d1c90c217d2ffcf2c7b \
    "https://codeload.github.com/AlexxIT/go2rtc/tar.gz/refs/tags/v1.9.14" /tmp/go2rtc.tar.gz
COPY docker/main/go2rtc/hevc-aggregation.patch /tmp/hevc-aggregation.patch
COPY docker/main/go2rtc/onvif-keyframe-startup.patch /tmp/onvif-keyframe-startup.patch
RUN tar -xzf /tmp/go2rtc.tar.gz --strip-components=1 \
    && git apply /tmp/hevc-aggregation.patch /tmp/onvif-keyframe-startup.patch \
    && go test ./internal/mp4 ./pkg/h265 ./pkg/h264 ./pkg/mp4 ./pkg/rtsp \
    && CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -trimpath \
        -o /rootfs/usr/local/go2rtc/bin/go2rtc .

FROM wget AS tempio
ARG TARGETARCH
RUN --mount=type=bind,source=docker/main/install_tempio.sh,target=/deps/install_tempio.sh \
    /deps/install_tempio.sh

####
#
# OpenVino Support
#
# 1. Download and convert a model from Intel's Public Open Model Zoo
#
####
# Download and Convert OpenVino model
FROM base_host AS ov-converter
ARG DEBIAN_FRONTEND

# Install OpenVINO for model conversion
COPY docker/main/requirements-ov.lock /requirements-ov.lock
RUN apt-get -qq update \
    && apt-get -qq install -y wget curl ca-certificates python3 python3-distutils \
    && curl --proto '=https' --proto-redir '=https' -fsSL --output get-pip.py https://bootstrap.pypa.io/get-pip.py \
    && sed -i 's/args.append("setuptools")/args.append("setuptools==84.0.0")/' get-pip.py \
    && python3 get-pip.py "pip" \
    && pip3 install --only-binary=:all: --require-hashes -r /requirements-ov.lock

# Get OpenVino Model
RUN --mount=type=bind,source=docker/main/build_ov_model.py,target=/build_ov_model.py \
    mkdir /models && cd /models \
    && curl --proto '=https' --proto-redir '=https' -fsSL --remote-name https://storage.googleapis.com/download.tensorflow.org/models/object_detection/ssdlite_mobilenet_v2_coco_2018_05_09.tar.gz \
    && tar -xvf ssdlite_mobilenet_v2_coco_2018_05_09.tar.gz \
    && python3 /build_ov_model.py

####
#
# Coral Compatibility
#
# Builds libusb without udev. Needed for synology and other devices with USB coral
####
# libUSB - No Udev
FROM wget as libusb-build
ARG TARGETARCH
ARG DEBIAN_FRONTEND
ENV CCACHE_DIR /root/.ccache
ENV CCACHE_MAXSIZE 2G

# Build libUSB without udev.  Needed for Openvino NCS2 support
WORKDIR /opt
RUN apt-get update && apt-get install -y unzip build-essential automake libtool ccache pkg-config
ADD --chmod=644 --checksum=sha256:4175f942e74f3c34b71d01b107d33e713f9ff47563f49bcc6e8b2534f414dd54 \
    https://github.com/libusb/libusb/archive/v1.0.26.zip v1.0.26.zip
RUN --mount=type=cache,target=/root/.ccache unzip v1.0.26.zip && cd libusb-1.0.26 && \
    ./bootstrap.sh && \
    ./configure CC='ccache gcc' CCX='ccache g++' --disable-udev --enable-shared && \
    make -j $(nproc --all)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libusb-1.0-0-dev && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /opt/libusb-1.0.26/libusb
RUN /bin/mkdir -p '/usr/local/lib' && \
    /bin/bash ../libtool  --mode=install /usr/bin/install -c libusb-1.0.la '/usr/local/lib' && \
    /bin/mkdir -p '/usr/local/include/libusb-1.0' && \
    /usr/bin/install -c -m 644 libusb.h '/usr/local/include/libusb-1.0' && \
    /bin/mkdir -p '/usr/local/lib/pkgconfig' && \
    cd  /opt/libusb-1.0.26/ && \
    /usr/bin/install -c -m 644 libusb-1.0.pc '/usr/local/lib/pkgconfig' && \
    ldconfig

FROM wget AS models

# Get model and labels
ADD --chmod=644 --checksum=sha256:4a2be2bbb614e576d56dcb914fa52752bf0f13411512710d355d97faa1b35641 \
    https://github.com/google-coral/test_data/raw/release-frogfish/ssdlite_mobiledet_coco_qat_postprocess_edgetpu.tflite edgetpu_model.tflite
ADD --chmod=644 --checksum=sha256:90bb33a634e041914cc1819aa5df99818e6c396c4d2db952c0fd7a9cffc4724f \
    https://github.com/google-coral/test_data/raw/release-frogfish/ssdlite_mobiledet_coco_qat_postprocess.tflite cpu_model.tflite
COPY labelmap.txt .
# Copy OpenVino model
COPY --from=ov-converter /models/ssdlite_mobilenet_v2.xml openvino-model/
COPY --from=ov-converter /models/ssdlite_mobilenet_v2.bin openvino-model/
ADD --chmod=644 --checksum=sha256:e428f6bc489647c67d776c41995a0b66e351bf850ebb11d21994164c9a2b5d44 \
    https://github.com/openvinotoolkit/open_model_zoo/raw/master/data/dataset_classes/coco_91cl_bkgr.txt openvino-model/coco_91cl_bkgr.txt
RUN sed -i 's/truck/car/g' openvino-model/coco_91cl_bkgr.txt
# Get Audio Model and labels
ADD --chmod=644 --checksum=sha256:1b971b2132760273a5fb8f5dc504e86783b27853bb3135d555ae06f1e1e365f3 \
    https://www.kaggle.com/api/v1/models/google/yamnet/tfLite/classification-tflite/1/download yamnet.tar.gz
RUN tar xzf yamnet.tar.gz && mv 1.tflite cpu_audio_model.tflite && rm yamnet.tar.gz
COPY audio-labelmap.txt .


FROM wget AS s6-overlay
ARG TARGETARCH
RUN --mount=type=bind,source=docker/main/install_s6_overlay.sh,target=/deps/install_s6_overlay.sh \
    /deps/install_s6_overlay.sh


FROM base AS wheels
ARG DEBIAN_FRONTEND
ARG TARGETARCH
ARG DEBUG=false

# Use a separate container to build wheels to prevent build dependencies in final image
RUN apt-get -qq update \
    && apt-get -qq install -y \
    apt-transport-https wget curl ca-certificates unzip \
    && apt-get -qq update \
    && apt-get -qq install -y \
    python3.11 \
    python3.11-dev \
    # opencv dependencies
    build-essential cmake git pkg-config libgtk-3-dev \
    libavcodec-dev libavformat-dev libswscale-dev libv4l-dev \
    libxvidcore-dev libx264-dev libjpeg-dev libpng-dev libtiff-dev \
    gfortran openexr libatlas-base-dev libssl-dev\
    libtbbmalloc2 libtbb-dev libdc1394-dev libopenexr-dev \
    libgstreamer-plugins-base1.0-dev libgstreamer1.0-dev \
    # sqlite3 dependencies
    tclsh \
    # scipy dependencies
    gcc gfortran libopenblas-dev liblapack-dev && \
    rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

ADD --chmod=644 --checksum=sha256:fb24e693bab954209a063d90953621412ccad4a500905a726286e038f508ddf6 \
    https://bootstrap.pypa.io/get-pip.py get-pip.py
RUN sed -i 's/args.append("setuptools")/args.append("setuptools==84.0.0")/' get-pip.py \
    && python3 get-pip.py "pip"

COPY docker/main/requirements.lock /requirements.lock
COPY docker/main/requirements-dev.txt /requirements-dev.txt

RUN pip3 install --only-binary=:all: --require-hashes -r /requirements.lock

# Build pysqlite3 from source
COPY docker/main/build_pysqlite3.sh /build_pysqlite3.sh
RUN /build_pysqlite3.sh

COPY docker/main/requirements-wheels.txt /requirements-wheels.txt
RUN pip3 wheel --wheel-dir=/wheels -r /requirements-wheels.txt && \
    if [ "$DEBUG" = "true" ]; then \
        pip3 wheel --wheel-dir=/wheels -r /requirements-dev.txt; \
    fi

# Install HailoRT & Wheels
RUN --mount=type=bind,source=docker/main/install_hailort.sh,target=/deps/install_hailort.sh \
    /deps/install_hailort.sh

# Collect deps in a single layer
FROM scratch AS deps-rootfs
COPY --from=nginx /usr/local/nginx/ /usr/local/nginx/
COPY --from=sqlite-vec /usr/local/lib/ /usr/local/lib/
COPY --from=intel-media-driver /rootfs/ /
COPY --from=go2rtc /rootfs/ /
COPY --from=libusb-build /usr/local/lib /usr/local/lib
COPY --from=tempio /rootfs/ /
COPY --from=s6-overlay /rootfs/ /
COPY --from=models /rootfs/ /
COPY --from=wheels /rootfs/ /
COPY docker/main/rootfs/ /


# Frigate deps (ffmpeg, python, nginx, go2rtc, s6-overlay, etc)
FROM slim-base AS deps
ARG TARGETARCH
ARG BASE_IMAGE

ARG DEBIAN_FRONTEND
# http://stackoverflow.com/questions/48162574/ddg#49462622
ARG APT_KEY_DONT_WARN_ON_DANGEROUS_USAGE=DontWarn

# https://github.com/NVIDIA/nvidia-docker/wiki/Installation-(Native-GPU-Support)
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES="compute,video,utility"

# Disable tokenizer parallelism warning
# https://stackoverflow.com/questions/62691279/how-to-disable-tokenizers-parallelism-true-false-warning/72926996#72926996
ENV TOKENIZERS_PARALLELISM=true
# https://github.com/huggingface/transformers/issues/27214
ENV TRANSFORMERS_NO_ADVISORY_WARNINGS=1

# Set OpenCV ffmpeg loglevel to fatal: https://ffmpeg.org/doxygen/trunk/log_8h.html
ENV OPENCV_FFMPEG_LOGLEVEL=8

# Set NumPy to ignore getlimits warning
ENV PYTHONWARNINGS="ignore:::numpy.core.getlimits"

# Set HailoRT to disable logging
ENV HAILORT_LOGGER_PATH=NONE

# TensorFlow C++ logging suppression (must be set before import)
# TF_CPP_MIN_LOG_LEVEL: 0=all, 1=INFO+, 2=WARNING+, 3=ERROR+ (we use 3 for errors only)
ENV TF_CPP_MIN_LOG_LEVEL=3
# Suppress verbose logging from TensorFlow C++ code
ENV TF_CPP_MIN_VLOG_LEVEL=3
# Disable oneDNN optimization messages ("optimized with oneDNN...")
ENV TF_ENABLE_ONEDNN_OPTS=0
# Suppress AutoGraph verbosity during conversion
ENV AUTOGRAPH_VERBOSITY=0
# Google Logging (GLOG) suppression for TensorFlow components
ENV GLOG_minloglevel=3
ENV GLOG_logtostderr=0

ENV PATH="/usr/local/go2rtc/bin:/usr/local/tempio/bin:/usr/local/nginx/sbin:${PATH}"

# Install dependencies
RUN --mount=type=bind,source=docker/main/install_deps.sh,target=/deps/install_deps.sh \
    /deps/install_deps.sh

ENV DEFAULT_FFMPEG_VERSION="8.0"
ENV INCLUDED_FFMPEG_VERSIONS="${DEFAULT_FFMPEG_VERSION}:7.0:5.0"

ADD --chmod=644 --checksum=sha256:fb24e693bab954209a063d90953621412ccad4a500905a726286e038f508ddf6 \
    https://bootstrap.pypa.io/get-pip.py get-pip.py
RUN sed -i 's/args.append("setuptools")/args.append("setuptools==84.0.0")/' get-pip.py \
    && python3 get-pip.py "pip"

RUN --mount=type=bind,from=wheels,source=/wheels,target=/deps/wheels \
    pip3 install --only-binary=:all: -U /deps/wheels/*.whl

# Install Axera Engine
COPY docker/main/requirements-axengine.lock /requirements-axengine.lock
RUN pip3 install --only-binary=:all: --require-hashes -r /requirements-axengine.lock

ENV PATH="${PATH}:/usr/bin/axcl"
ENV LD_LIBRARY_PATH="${LD_LIBRARY_PATH}:/usr/lib/axcl"

# Install MemryX runtime (requires libgomp (OpenMP) in the final docker image)
RUN --mount=type=bind,source=docker/main/install_memryx.sh,target=/deps/install_memryx.sh \
    bash -c "bash /deps/install_memryx.sh"

COPY --from=deps-rootfs / /

RUN ldconfig

EXPOSE 5000
EXPOSE 8554
EXPOSE 8555/tcp 8555/udp

# Configure logging to prepend timestamps, log to stdout, keep 0 archives and rotate on 10MB
ENV S6_LOGGING_SCRIPT="T 1 n0 s10000000 T"
# Do not fail on long-running download scripts
ENV S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0

ENTRYPOINT ["/init"]
CMD []

HEALTHCHECK --start-period=300s --start-interval=5s --interval=15s --timeout=5s --retries=3 \
    CMD test -f /dev/shm/.frigate-is-stopping && exit 0; curl --fail --silent --show-error http://127.0.0.1:5000/api/version || exit 1

# Frigate deps with Node.js and NPM for devcontainer
FROM deps AS devcontainer

# Do not start the actual Frigate service on devcontainer as it will be started by VS Code
# But start a fake service for simulating the logs
COPY docker/main/fake_frigate_run /etc/s6-overlay/s6-rc.d/frigate/run

# Create symbolic link to the frigate source code, as go2rtc's create_config.sh uses it
RUN mkdir -p /opt/frigate \
    && ln -svf /workspace/frigate/frigate /opt/frigate/frigate

# Install Node 20
ADD --chmod=644 --checksum=sha256:2af36fc425b3aeffeef0d5cf83960ddf98a7e612f507198f6710bead450db9cf \
    https://deb.nodesource.com/nsolid_setup_deb.sh nsolid_setup_deb.sh
RUN chmod 500 nsolid_setup_deb.sh && \
    ./nsolid_setup_deb.sh 20 && \
    apt-get install nodejs -y \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --ignore-scripts npm@10.9.9

WORKDIR /workspace/frigate

RUN apt-get update \
    && apt-get install make -y \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=bind,source=./fork/requirements-dev.lock,target=/workspace/frigate/requirements-dev.lock \
    pip3 install --only-binary=:all: --require-hashes -r requirements-dev.lock

HEALTHCHECK NONE

CMD ["sleep", "infinity"]


# Frigate web build
# This should be architecture agnostic, so speed up the build on multiarch by not using QEMU.
FROM --platform=$BUILDPLATFORM node:20 AS web-build
# Bundling Monaco and the UI exceeds Node 20's default 2 GiB heap.
ARG NODE_OPTIONS=--max-old-space-size=4096

WORKDIR /work
COPY web/package.json web/package-lock.json ./
COPY web/patches ./patches
RUN npm ci --ignore-scripts && npm run postinstall

COPY web/ ./
RUN npm run build \
    && mv dist/BASE_PATH/monacoeditorwork/* dist/assets/ \
    && rm -rf dist/BASE_PATH

# Publish just the compiled frontend, without its Node build environment.
FROM scratch AS web-assets
COPY --from=web-build /work/dist/ /work/dist/

# Collect final files in a single layer
FROM scratch AS rootfs

WORKDIR /opt/frigate/
COPY frigate frigate/
COPY migrations migrations/
COPY --from=web-build /work/dist/ web/

# Prepare system paths independently of application updates.
FROM deps AS frigate-runtime

WORKDIR /opt/frigate/

RUN --mount=type=bind,source=docker/main/prepare_rootless.sh,target=/tmp/prepare_rootless.sh \
    bash /tmp/prepare_rootless.sh

ENV HOME=/home/frigate
ENV S6_READ_ONLY_ROOT=1
USER 65534:65534

# Frigate final container. The application destination is a real directory.
FROM frigate-runtime AS frigate
COPY --link --from=rootfs / /
