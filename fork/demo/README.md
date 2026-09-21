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

The base image is selected in `fork/runtime-base.env`, shared with backend
tests and CI. Direct Compose commands must include
`--env-file fork/runtime-base.env` from the repository root. Changing this
file updates both overlays; rebuild them after a base change.

## What it is

- Base image `ghcr.io/blakeblackshear/frigate:0.18.0` (multi-arch, so this
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

## Audit

`make demo-audit` drives the running demo in Chrome as an Android phone
(Galaxy S24 Ultra user agent, 412x915, touch) and visits every page: Live,
each camera, Review, Explore, Export, every Settings section, the System
tabs, Logs, Config, Faces and Classification. Per page it records console
errors and warnings, Chrome's own warnings, exceptions, HTTP errors, axe-core
WCAG 2.1 AA violations, sideways overflow, tap targets under 24/40 px, broken
images, request storms, long tasks, layout shift, and whether every menu or
drawer closes on back without leaving the page.

```
make demo-audit                                  # phone
make demo-audit ARGS="--profile=desktop"
make demo-audit ARGS="--update-baseline"         # save this run as the baseline
make demo-audit ARGS="--strict"                  # exit 1 on findings new since the baseline
```

It signs in with `FRIGATE_DEMO_PASSWORD` from `fork/demo/.env`. Reports,
JSON and screenshots go to `fork/demo/.data/audit/<timestamp>-<profile>/`.
Findings known to come from upstream or a fresh demo (preview 404s before
Frigate has written previews, review lookups for objects with no review item)
are listed separately. axe-core is installed into `fork/demo/.data/tools` on
first run.

## Reset

`docker compose --env-file fork/runtime-base.env -f fork/demo/compose.yml down -v` drops the database and
recordings. Sample clips stay in `fork/demo/.data/samples`.

Preview thumbnails can 404 for a minute after first boot, until Frigate
writes preview frames. Live tiles and Explore events still work.

## Do not

- Publish the ports on a LAN.
- Copy config, recordings, or credentials from the live server.
- Run `make local` / a full image build for this stack.
