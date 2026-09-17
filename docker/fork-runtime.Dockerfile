# syntax=docker/dockerfile:1.6
# Both named contexts are supplied by the application-only Bake graph.
FROM runtime AS image
COPY --link --from=rootfs / /
# The amd64 dependency image runs as the unprivileged user; the rocm target,
# the only one that sets ROCM, needs root for the GPU device nodes.
ARG ROCM=""
ARG RUNTIME_USER=${ROCM:+root}
USER ${RUNTIME_USER:-65534:65534}
