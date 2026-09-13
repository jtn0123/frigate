# Sonar security redesign in PR #43

This change addresses the two PR security blockers with code. It does not waive
HTTP camera findings or the five accelerator-specific root-runtime findings.
Scan confirmation is required before counting either PR finding as closed.

## Reolink discovery destinations

Optional Reolink protocol detection now selects a destination from
`networking.reolink_targets`. The request cannot supply a connection URL, IP,
port, transport, CA bundle, or TLS server name. Unlisted wizard host values
receive HTTP 403 before any connection. The wizard retains its existing fallback
when optional detection is unavailable; manual stream configuration and recording
are unaffected by the discovery allowlist.

Connections use the fixed configured IP, preventing DNS rebinding. The configured
server name is used only for HTTP Host, TLS SNI, and certificate verification.
Proxy environment variables are not used and redirects are never followed.
HTTPS requires TLS 1.2 or newer by default and certificate verification cannot
be disabled. A private
camera CA can be configured without trusting it globally.

Example (replace these addresses and names with your camera settings):

```yaml
networking:
  reolink_targets:
    camera.local:
      address: 192.168.1.20
      server_name: camera.local
      ca_certs: /config/camera-ca.pem
    "192.168.1.21":
      address: 192.168.1.21
      scheme: http
      port: 80
```

Keys must exactly match the host entered in the wizard, including any explicit
port. Prefer DHCP reservations or fixed camera addresses. Configure only camera
API endpoints. Loopback, link-local (including cloud metadata addresses),
multicast, unspecified, and reserved addresses are rejected. There is no blanket
LAN/subnet authorization. Configuration-editing administrators remain trusted;
this change constrains the discovery request, not the administrator's ability
to edit the entire NVR configuration.

An empty allowlist disables automatic Reolink protocol probing. Existing installs
must add camera entries to retain that optional recommendation. HTTP is an
explicit per-camera compatibility setting with no automatic TLS downgrade;
it still sends credentials unencrypted and its security findings remain open.
The existing HTTP-FLV stream templates are also unchanged and remain backlog.

Regression evidence includes an administrator request to an unconfigured
loopback destination returning 200 before this change and 403 afterward.
Real local TLS tests verify trusted certificates, hostname mismatch, untrusted
certificates, proxy isolation, and redirects. Requests with malformed hosts and
requests from non-admin users remain rejected.

## Main container runtime

The final main image runs as UID/GID `65534:65534`. Image-owned s6, nginx, TLS,
home, config, and media directories are prepared at build time. s6 setuid/setgid
bits are removed and the image does not regain root during initialization.
Non-root log writers retain the container identity. Root-run variant images keep
their existing nginx user and log handling until separately validated.

### Existing installation migration

Before deploying the changed main image:

1. Back up the configuration and database and stop the NVR for the migration.
2. Grant UID/GID 65534 read/write access to the dedicated config, database, model
   cache, media, and TLS mounts. Existing files as well as directories must be
   writable where the NVR updates them. Use ownership or appropriate ACLs for
   your storage system; check NFS identity mapping and root-squash behavior.
3. For a tmpfs cache, specify `uid=65534,gid=65534,mode=0700`. A bind-mounted cache
   must be owned by UID 65534 and cannot be a symlink. Prepare any custom `/run`
   mount for the same user. The container never recursively changes ownership of
   mounted user data at startup.
4. Grant the required device groups with Docker `group_add` and map only the
   required devices. Check camera decoding and detector access on the actual
   hardware before deploying. Custom privileged listening ports require a
   separate container-manager configuration; default Frigate ports are above
   1024.
5. Validate startup, camera capture, recording, playback, config updates, TLS,
   and graceful shutdown on the migrated deployment before promotion.

There is no automatic root fallback. This PR does not deploy these changes or
modify existing host storage permissions. Do not switch accelerator variants to
non-root based solely on a CPU test.

### Repeatable runtime validation

```sh
docker build -f fork/Dockerfile.rootless-test \
  --build-arg BASE=frigate-fork-test -t frigate-rootless-check .
python3 fork/scripts/test_rootless_runtime.py frigate-rootless-check
```

CI builds this runtime from the existing dependency test image plus current
backend and service files. It runs an isolated synthetic camera with networking
disabled, all Linux capabilities dropped, and `no-new-privileges`. It checks
real CPU inference on a deterministic tensor, recording, decoded API clip
playback, preview, every process UID, private cache
and camera-file permissions, and clean shutdown. It does not prove accelerator
hardware compatibility or replace a full release image build and deployment
migration validation.
