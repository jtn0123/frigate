# Local demo stack

A real Frigate with this checkout's UI and backend, for dogfooding. It never
talks to the owner's live server (Proxmox LXC 106) and must not be pointed at
it.

```
make demo-up     # build the overlay image and start on 127.0.0.1
make demo-logs
# open https://127.0.0.1:8971  (self-signed TLS; create the admin user)
make demo-down   # stop; named volumes keep db and recordings
```

First boot creates `admin` and prints the password in `make demo-logs`.
Copy it into gitignored `fork/demo/.env` if you want a reminder. The
container does not read that file.

## What it is

- Base image `ghcr.io/blakeblackshear/frigate:0.18.0-rc2` (multi-arch, so this
  Mac runs arm64 natively).
- Overlay: this tree's `frigate/`, `migrations/`, and `web/dist` (from
  `npm run e2e:build`, base `/`).
- Three looping file cameras from Intel's MIT-licensed sample videos
  (`samples.txt`). People and cars are in the clips so the CPU detector can
  open review items. Media is downloaded into `fork/demo/.data/` and never
  committed.
- Auth on. Ports bound to `127.0.0.1` only: UI `8971`, go2rtc `1984`.
- State in Docker named volumes (`demo-config`, `demo-media`), not a USB bind
  mount. Docker Desktop on this Mac does not share `/Volumes`, so a bind-mount
  of the repo or `/Volumes/512Flash/frigate-demo` arrives empty in the
  container.

## Reset

`docker compose -f fork/demo/compose.yml down -v` drops the database and
recordings. Sample clips stay in `fork/demo/.data/samples`.

Preview thumbnails can 404 for a minute after first boot, until Frigate
writes preview frames. Live tiles and Explore events still work.

## Do not

- Publish the ports on a LAN.
- Copy config, recordings, or credentials from the live server.
- Run `make local` / a full image build for this stack.
