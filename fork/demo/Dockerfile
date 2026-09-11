# Overlay this checkout's Python, migrations and built UI on the multi-arch
# rc2 image. Sources are COPY'd (not bind-mounted) because Docker Desktop on
# this Mac does not share /Volumes, so a USB bind-mount arrives empty.
ARG BASE=ghcr.io/blakeblackshear/frigate:0.18.0-rc2
FROM ${BASE}
COPY frigate /opt/frigate/frigate
COPY migrations /opt/frigate/migrations
COPY web /opt/frigate/web
COPY samples /opt/frigate/demo/samples
COPY config.yml /opt/frigate/demo/config.yml
COPY entrypoint.sh /opt/frigate/demo/entrypoint.sh
RUN chmod 755 /opt/frigate/demo/entrypoint.sh
ENTRYPOINT ["/opt/frigate/demo/entrypoint.sh"]
