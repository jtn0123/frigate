#!/bin/sh
# Seed /config on first start. The named volume hides anything COPY'd there.
set -e
mkdir -p /config
if [ ! -f /config/config.yml ]; then
  cp /opt/frigate/demo/config.yml /config/config.yml
fi
exec /init
