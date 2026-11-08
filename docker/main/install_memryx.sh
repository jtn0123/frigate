#!/bin/bash
set -e

# Keep transport restrictions consistent for every download in this stage.
download_https() {
    curl --proto '=https' --proto-redir '=https' -fsSL "$@"
}

# Download the MxAccl for Frigate github release. The digest is the one the
# runtime manifest in frigate/detectors/plugins/memryx.py pins; update both
# when bumping the release.
download_https https://github.com/memryx/mx_accl_frigate/archive/refs/tags/v2.1.0.zip --output /tmp/mxaccl.zip
echo "54d1971dee54688541561b7bd9136342be51707b68c11a2a5e575fa19e69bc51  /tmp/mxaccl.zip" | sha256sum -c -
unzip /tmp/mxaccl.zip -d /tmp
mv /tmp/mx_accl_frigate-2.1.0 /opt/mx_accl_frigate
rm /tmp/mxaccl.zip

# Install Python dependencies
pip3 install --only-binary=:all: -r /opt/mx_accl_frigate/freeze

# Link the Python package dynamically
SITE_PACKAGES=$(python3 -c "import site; print(site.getsitepackages()[0])")
ln -s /opt/mx_accl_frigate/memryx "$SITE_PACKAGES/memryx"

# Copy architecture-specific shared libraries
ARCH=$(uname -m)
if [[ "$ARCH" == "x86_64" ]]; then
    cp /opt/mx_accl_frigate/memryx/x86/libmemx.so* /usr/lib/x86_64-linux-gnu/
    cp /opt/mx_accl_frigate/memryx/x86/libmx_accl.so* /usr/lib/x86_64-linux-gnu/
elif [[ "$ARCH" == "aarch64" ]]; then
    cp /opt/mx_accl_frigate/memryx/arm/libmemx.so* /usr/lib/aarch64-linux-gnu/
    cp /opt/mx_accl_frigate/memryx/arm/libmx_accl.so* /usr/lib/aarch64-linux-gnu/
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

# Refresh linker cache
ldconfig
