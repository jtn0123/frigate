# syntax=docker/dockerfile:1.6
# Keep this application-only stage independent of dependency build definitions.
FROM scratch AS rootfs
WORKDIR /opt/frigate/
COPY frigate frigate/
COPY migrations migrations/
COPY --from=web-build /work/dist/ web/
