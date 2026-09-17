# syntax=docker/dockerfile:1.6
# Keep this application-only stage independent of dependency build definitions.
FROM scratch AS rootfs
# Nothing runs from this stage; it is only copied into the runtime image.
USER 65534:65534
WORKDIR /opt/frigate/
COPY frigate frigate/
COPY migrations migrations/
COPY --from=web-build /work/dist/ web/
