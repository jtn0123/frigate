# syntax=docker/dockerfile:1.6

# https://askubuntu.com/questions/972516/debian-frontend-environment-variable
ARG DEBIAN_FRONTEND=noninteractive

# Globally set pip break-system-packages option to avoid having to specify it every time
ARG PIP_BREAK_SYSTEM_PACKAGES=1

FROM wheels AS synap1680-wheels
ARG TARGETARCH

# Install dependencies
ADD --chmod=644 --checksum=sha256:ca3e42bdf2a683c1e02a6db7143f2a7fa46dd3e7f6763850c98a8a6942dc2866 \
    https://github.com/GaryHuang-ASUS/synaptics_astra_sdk/releases/download/v1.5.0/Synaptics-SL1680-v1.5.0-rt.tar /tmp/synaptics-runtime.tar
RUN tar -C / -xzf /tmp/synaptics-runtime.tar && rm /tmp/synaptics-runtime.tar
ADD --chmod=644 --checksum=sha256:6ac2716a5d568793d61bec52d8795ea5eded67a762d8d4243460b63fa41156a8 \
    https://github.com/synaptics-synap/synap-python/releases/download/v0.0.4-preview/synap_python-0.0.4-cp311-cp311-manylinux_2_35_aarch64.whl /wheels/synap_python-0.0.4-cp311-cp311-manylinux_2_35_aarch64.whl

FROM deps AS synap1680-deps
ARG TARGETARCH
ARG PIP_BREAK_SYSTEM_PACKAGES

RUN --mount=type=bind,from=synap1680-wheels,source=/wheels,target=/deps/synap-wheels \
pip3 install --only-binary=:all: --no-deps -U /deps/synap-wheels/*.whl

WORKDIR /opt/frigate/
COPY --from=rootfs / /

COPY --from=synap1680-wheels /rootfs/usr/local/lib/*.so /usr/lib

ADD https://raw.githubusercontent.com/synaptics-astra/synap-release/v1.5.0/models/dolphin/object_detection/coco/model/mobilenet224_full80/model.synap /synaptics/mobilenet.synap
