# Navigation and monitoring experience

This branch builds on PR #49's React Router 7 compatibility fixes. It does not
merge that PR or deploy a server image.

## Implemented behavior

- The app uses a data router so unsaved-edit blockers cover in-app navigation
  and browser history. The Settings and YAML editors also guard tab close and
  reload. Existing same-page Settings confirmation remains responsible for
  switching sections. Saving clears the existing dirty state.
- System opens General for an empty or unsupported hash. Tab changes preserve
  query parameters and location state.
- Camera Health supports `?camera=front_door#health`. AI model history supports
  `?model=audio%3Amedium&range=15#models`, with 15-minute, 60-minute, or 24-hour
  windows over available samples. These URLs survive refresh and history.
- A copy-link control shares the current System view. It does not grant access;
  the recipient still needs the existing authenticated admin permissions.
- Only the active System tab is mounted. Tab modules load on demand, so hidden
  charts and pollers do not remain active. SWR retains its normal data cache.
- Navigation links warm supported page modules on pointer hover or keyboard
  focus. Offline, data-saving, and slow connections skip speculative downloads.
  Preloading imports code only; it does not mount players or fetch camera data.
- Page loads have an accessible text status. Camera configuration failures and
  model history failures offer retry. System does not claim freshness before
  receiving readings.

## Architecture boundaries

The Python backend, authentication, recording workers, and AI inference are
unchanged. Existing SWR readers remain the data-fetching layer. This change does
not claim that installing a data router automatically enables loader cancellation
for those readers. Moving shared polling into route loaders would require a
separate cache and ownership design to avoid aborting requests other views use.

Framework mode, generated route types, server rendering, and new animated page
transitions are not prerequisites for these improvements. No extra Node server
is introduced. Existing lazy page splitting is retained and System tab splitting
is added.

## Validation

Use `npm run typecheck`, `npm run lint`, `npm run i18n:extract:ci`,
`npm run coverage`, `npm run e2e:build`, and `npm run e2e` from `web`.
New tests exercise URL selection, query preservation, browser history, dirty
navigation cancellation, deliberate exit, and unload-handler cleanup.
The hardening tests also cover failed Settings and YAML saves retaining edits,
successful saves clearing the exit guard, expired-session redirects, viewer
denial on shared monitoring links, ingress basenames, keyboard clipboard
fallback, and long translated labels on narrow dark layouts. YAML Save Only
and its keyboard shortcut handle rejected saves after showing the error.
The fork E2E workflow enables `E2E_STRICT_ERRORS=1`, so unexpected console,
page, and request errors fail the run. Intentional error-response tests declare
their expected failures; optional API and WebP fixtures keep unrelated pages
from making unhandled requests to the preview server.
Browser tests cover both desktop and mobile layouts. Mocked streams cannot prove
physical camera continuity or live GPU performance; those need a deployment and
runtime observation.

A separate local preview was connected through an SSH tunnel to the existing
Frigate backend for a read-only smoke test. A video reached playback-ready
state, stream sockets closed when leaving Live and reopened on return, and the
shared status socket remained connected. All nine cameras reported zero skipped
frames in the before and after samples. This is short-duration evidence, not a
soak test or a production deployment. The production-base build also passed
desktop and mobile navigation under a local ingress-rewrite simulation.
The doorbell's existing hourly stall counter increased from 76 to 82 during
the observation window, despite normal sampled FPS. The health card showed
degraded status. This remains a live camera diagnostic follow-up and prevents
treating the smoke test as proof of server stability.

## Measured startup cost

On the same machine, PR #49 alone used 372179 compressed startup bytes. The
navigation build measured about 393000 bytes, an increase of approximately
21 KB (5.6%), principally the data-router runtime used for navigation blockers.
The budget is 412650 bytes, preserving 5% headroom over the new measurement.
This is a deliberate feature cost, not a claim that initial loading got faster.
System tab splitting reduces work when visiting monitoring views; it does not
offset the initial data-router download in the eager-bundle measurement.
