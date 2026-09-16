# syntax=docker/dockerfile:1.6
# Both named contexts are supplied by the application-only Bake graph.
FROM runtime AS image
COPY --link --from=rootfs / /
