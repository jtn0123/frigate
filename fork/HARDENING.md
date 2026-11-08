# Container hardening versus upstream

Upstream hardened its container in five pull requests during 0.18 development:
#24061 (phase 1), #24068 (phase 2), #24081 (phase 3, breaking), #24140
(phase 4) and #24148 (network isolation docs). This page compares them with the
fork, records what E36 took over, and lists what was deliberately left alone.

The two designs start from different places:

- **Upstream** starts the container as root. s6 init remaps a `frigate` user
  (uid 1000, or `PUID`/`PGID`), chowns `/config` and `/media` to it, grants
  device access with ACLs, and then drops each service to its own user: Frigate
  and nginx as `frigate`, go2rtc as a separate restricted `go2rtc` user.
  `FRIGATE_RUN_AS_ROOT` and `FRIGATE_ROOT_SERVICES` keep services root.
- **The fork** never runs as root (the main amd64 image). The image runs as
  `65534:65534` (`USER` in `docker/main/Dockerfile`). Everything that needs
  write access at build time is prepared by `docker/main/prepare_rootless.sh`;
  s6 setuid bits are stripped, so nothing can regain root. Mounted data is
  never chowned. The ROCm image still runs as root
  (`docker/fork-runtime.Dockerfile`). The migration steps for an existing
  install are in `SONAR-SECURITY-REDESIGN.md`, and
  `fork/scripts/test_rootless_runtime.py` (CI "Python - non-root NVR runtime")
  starts the image with `--cap-drop ALL` and `no-new-privileges`, records,
  plays back, and checks that every process runs as 65534.

## Gap table

"Has" means the fork already does it; "equivalent" means a different mechanism
gives the same protection; "E36" means this change added it; "lacks" means the
fork does not do it (see the recommendations below).

| Upstream item | Phase | Fork |
| --- | --- | --- |
| sha256 pins for ffmpeg tarballs | 1 | has |
| go2rtc pin | 1 | equivalent: built from a source tarball with `ADD --checksum` |
| s6-overlay, tempio, HailoRT (tarball and wheel), libedgetpu, Intel debs | 1 | E36 |
| Pins for downloads upstream does not make or pin: yq, MemryX accelerator zip, ROCm `amdgpu-install` deb, the ov-converter stage's get-pip and SSDLite model | none | E36 |
| Builder sources (nginx and its modules, gmmlib, intel-media-driver, sqlite-vec, SQLite amalgamation, pysqlite3) | none | lacks, upstream does not pin them either |
| Generated TLS key `600`, certificate `644` | 1 | E36 (OpenSSL 3 already wrote the key `600`; the mode is now pinned) |
| `server_tokens off` | 1 | E36 |
| `X-Content-Type-Options`, `Referrer-Policy` | 1 | has, plus HSTS, CSP and `Permissions-Policy` (E1, E6) |
| No `X-Frame-Options` (Home Assistant iframe cards) | 1 | differs: the fork sends `SAMEORIGIN`, left for the owner to decide |
| `go2rtc.yaml` not world-readable | 1 | equivalent: written `600` by `write_private_file` |
| Failed login warning with the client address | 1 | lacks: the fork raises a per-burst notice instead, with no log line |
| Docs: no `privileged: true`, add `no-new-privileges` and `cap_drop: ALL` | 1 | lacks in `installation.md`; the image supports both |
| Log services that work without root | 2 | equivalent: `frigate-log-run` runs `s6-log` directly when not root |
| `frigate` and `go2rtc` users, `init-usermod` (`PUID`/`PGID`) | 2, 3 | not applicable: one fixed uid, choose it with Docker's `--user` |
| `fix-ownership` sweep of `/config` and `/media` | 2, 3 | deliberately not: mounted data is never chowned |
| `init-devices` ACLs on `/dev/dri` and other nodes | 3 | not possible without root; use `group_add` |
| go2rtc as a separate user | 3 | not applicable: one uid for every service |
| nginx without root, temp and pid paths writable | 3 | equivalent: `user root;` removed, temp directories owned by 65534 |
| JWT secret ownership migration | 3 | not applicable: `/config/.jwt_secret` is created `600` by the runtime user |
| nethogs bandwidth stat turned off when not root | 3 | lacks: the stat logs an error every interval if enabled |
| `S6_READ_ONLY_ROOT=1` | 4 | has |
| Read-only root filesystem (certificates in `/config/tls`, nginx config copied to `/tmp/nginx`, `compileall`) | 4 | lacks: not supported or tested |
| Network isolation guidance | #24148 | E36: summarized below |

## Running the fork non-root

- `/config` and `/media/frigate` must be writable by uid 65534, including the
  files already in them. An install moved from a root-run image needs a one-time
  `chown` or ACL on the host; see `SONAR-SECURITY-REDESIGN.md`.
- `/tmp/cache` must be a tmpfs owned by the runtime user:
  `--tmpfs /tmp/cache:uid=65534,gid=65534,mode=0700` (I19). Root-run images
  leave out `uid` and `gid`.
- Devices: the process has no supplementary groups unless Docker adds them, and
  nothing in the container can change device permissions. For Intel or AMD
  VAAPI, map `/dev/dri/renderD128` and add the host's render group with
  `group_add` (`getent group render` on the host gives the number), unless the
  node is already readable by everyone, as it often is inside a Proxmox LXC.
  `privileged: true` does not help here: it maps every device, but a non-root
  process is still checked against each node's owner and mode.
- Intel per-process GPU stats read `/proc/<pid>/fdinfo`. Every process in the
  fork runs as the same uid, so the kernel's same-user rule allows this without
  `CAP_SYS_PTRACE`, including go2rtc's ffmpeg (which upstream loses once go2rtc
  has its own user). No fork test covers this on real hardware.
- `--cap-drop ALL` and `no-new-privileges` are supported and tested. The
  `telemetry.stats.network_bandwidth` stat needs nethogs with `CAP_NET_ADMIN`
  and `CAP_NET_RAW` as root, so it cannot work in the main image; leave it off.
- A custom TLS certificate mounted at `/etc/letsencrypt/live/frigate` must be
  readable by uid 65534, because nginx runs as that user. The generated
  self-signed pair is only written when neither file exists, so a mounted pair
  is never modified.
- A read-only root filesystem is not supported: nginx's start script edits
  `nginx.conf` in place and writes the generated certificate under
  `/etc/letsencrypt`.

## Network isolation

Upstream's #24148 advice applies unchanged. Put cameras on their own VLAN or
subnet with a route from the Frigate host into it and no route out, so Frigate
opens the stream connections and the cameras reach nothing; give them a local
NTP server. Frigate's only default outbound request is the version check
(`telemetry.version_check: false` turns it off). Brokers and other containers
that only talk to Frigate can share an `internal: true` Compose network.
Docker's published ports bypass host firewalls such as ufw, so bind each port
to the interface that should reach it (for example `127.0.0.1:8971:8971` behind
a reverse proxy on the same host).

## Recommendations left out of E36

Each of these changes which user runs a service, device or file ownership, the
JWT secret, or the s6 service graph, so none is safe to change without a
migration. The risks are written for an existing install that mounts `/config`
and `/media` and decodes with Intel iHD VAAPI through `/dev/dri`.

1. **Root init with per-service users (phases 2 and 3).** The container would
   start as root and drop to uid 1000. Files that 65534 owns in `/config` and
   `/media` would be unreadable until swept, so Frigate would fail to open its
   database and recordings. `--cap-drop ALL` would also stop s6 from dropping
   privileges (that needs `CAP_SETUID` and `CAP_SETGID`), so a deployment that
   follows the hardening advice would not start. A container-side render group
   rarely has the host's GID, so VAAPI would fail until the ACL step below ran.
2. **`fix-ownership` sweep.** A recursive chown of `/media` at every start takes
   minutes on a large recordings tree, fails on NFS with root squash, and
   changes host-side ownership that backups or other tools rely on. Undoing it
   means another manual chown.
3. **`init-devices` ACLs.** Needs root and the `acl` package. Inside an LXC the
   device node is a bind mount from the host, so an ACL either fails or changes
   the host's node for every other container. `group_add` gives the same access
   without touching the node.
4. **go2rtc as its own user.** go2rtc reads `/dev/shm/go2rtc.yaml`, which the
   fork writes `600` as 65534. A second user needs a shared group and a `640`
   file; without both, go2rtc cannot read its config and every live stream
   stops. It would also hide go2rtc's ffmpeg from Intel per-process GPU stats.
5. **JWT secret move or ownership change.** `get_jwt_secret` reads
   `/config/.jwt_secret` without catching a permission error, so a secret the
   runtime user cannot read stops startup; a new secret signs out every
   session. Keep the current location and `600` owned by the runtime user.
6. **s6 service restructure (root log services, `init-usermod`,
   `init-devices`).** The fork's graph is tested non-root as it is. New
   oneshots that expect root would fail at boot in the main image.
7. **Read-only root filesystem (phase 4).** Moves the default certificate path
   and the nginx config. A certificate mounted at the old path would stop being
   used, and a bind-mounted custom `nginx.conf` would no longer be the one
   loaded. `compileall` would add a `RUN` to the final stage, which
   `fork/scripts/test_dependency_images.py` forbids.

Smaller, safe follow-ups outside the files E36 owns:

- Log failed logins with the client address for fail2ban, in
  `frigate/api/auth.py`. Use lazy `%s` formatting and the truncated username:
  upstream's f-string writes an attacker-chosen username into the log as is.
- Skip the nethogs stat with one warning when not root, as upstream does, in
  `frigate/util/services.py`.
- Update `docs/docs/frigate/installation.md`: the main Compose example still has
  `privileged: true`, and there is no `security_opt`/`cap_drop` example.
- `docs/docs/configuration/hardware_acceleration_video.md` says root is the
  default and non-root may need `CAP_SYS_PTRACE` for GPU stats; neither is true
  of the fork's main image.
- Pin the builder sources listed in the table. Each edit to those build scripts
  invalidates their cached stage, and the nginx stage cannot be rebuilt right
  now (next item), so this belongs in its own change.

## Known hazard: the secure-token module source is gone

`docker/main/build_nginx.sh` downloads
`kaltura/nginx-secure-token-module` 1.5 from GitHub. As of 2026-11-08 that
repository (and `kaltura/nginx-vod-module`) returns 404, while a CI build on
2026-11-06 still fetched it. Any build of the `nginx` stage without a cache hit
now fails, including CI's `docker build --target nginx` in "Python - non-root
NVR runtime". Upstream's open #24893 replaces the module with `sub_filter`,
which nginx already includes; port it under its own ledger ID once it lands, or
pin a reviewed copy of the 1.5 source.
