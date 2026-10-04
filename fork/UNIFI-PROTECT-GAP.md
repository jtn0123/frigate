# UniFi Protect gap analysis (2026-10-02)

What UniFi Protect 6.2 (with an AI Key or AI cameras) offers that this fork
does not, how hard each gap is to close here, and whether it is worth it.

Protect features come from Ubiquiti's 6.0 and 6.2 announcements and release
notes (see Sources). Fork state was checked against `origin/next` at
`7885a0488`. Upstream (`origin/dev`, `38b87feec`) has no work in progress on
any item below, so none of them would collide with an upstream merge.

## How to read this

Each gap has an ID like `3.2` (area 3, item 2). These are not ledger IDs;
whoever builds one takes a ledger ID as usual.

- **Difficulty**, 1 to 5:
  - 1: docs or wording.
  - 2: a few days, mostly fork-only files.
  - 3: about a week, with a few small upstream hunks.
  - 4: large, or spread across many upstream files.
  - 5: a new subsystem, or dependent on camera hardware.
- **Impact**, 1 to 5: value to a self-hosted home or small-business user
  of this fork. 5 means users would notice it daily or it closes a real
  security gap.
- **Upstream touch:**
  - None: fork files only.
  - Hunk: one to three small edits to upstream files.
  - Wide: many upstream files.
  - Migration: needs a new DB table or column.
- **Call:** Do (high value for the cost), Next (worth doing after the Do
  items), Later (only on demand), Skip (out of scope or better done outside
  Frigate).

## Scoreboard

| ID | Feature | Difficulty | Impact | Upstream touch | Call |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Line crossing and counting | 3 | 4 | Hunk | Do |
| 1.2 | Direction of travel | 2 (with 1.1) | 3 | Hunk | Do |
| 1.3 | Dwell time per zone | 2 | 2 | Hunk | Later |
| 1.4 | Attribute search (clothing, vehicle) | 2 / 4 | 3 | None | Next |
| 1.5 | "Seen on other cameras" | 2 / 5 | 3 | Hunk | Next |
| 1.6 | Exclusion zones (alert-only) | 1 / 3 | 3 | Hunk | Do |
| 1.7 | Heatmaps and counting reports | 3 | 2 | None | Later |
| 2.1 | Synced full-res multi-camera playback | 3 | 4 | Hunk | Do |
| 2.2 | Evidence export (hash, who, watermark) | 2 / 3 | 2 | Migration | Later |
| 2.3 | Per-camera storage quotas | 3 | 3 | Hunk | Next |
| 2.4 | Archive to NAS or cloud | 2 / 4 | 3 | None | Next |
| 2.5 | Privacy masks | 3 | 2 | Hunk | Later |
| 3.1 | Sessions list and revoke | 3 | 4 | Hunk, Migration | Do |
| 3.2 | Audit log | 3 | 3 | Hunk, Migration | Next |
| 3.3 | 2FA (TOTP) | 3 | 4 | Hunk, Migration | Do |
| 3.4 | Granular per-camera permissions | 4 | 2 | Wide | Later |
| 3.5 | Temporary guest live access | 4 | 2 | Hunk, Migration | Later |
| 4.1 | Server-side notification schedules | 2 | 4 | Hunk | Do |
| 4.2 | Spotlights feed | 2 | 3 | None | Next |
| 4.3 | Rich push (clip or animation) | 3 | 2 | Hunk | Skip |
| 4.4 | Alarm Manager rules engine | 4 | 3 | Hunk, Migration | Later |
| 4.5 | Siren, light, chime, relay outputs | 5 | 2 | None | Skip |
| 5.1 | Kiosk / wall display mode | 2 | 4 | Hunk | Do |
| 5.2 | Live telemetry widgets | 2 | 2 | None | Next |
| 5.3 | PTZ patrols and return to home | 3 | 3 | Hunk | Next |
| 5.4 | Network camera discovery | 3 | 2 | Hunk | Later |
| 5.5 | Camera image settings, firmware | 4 | 2 | None | Later |
| 6.1 | Backup and restore from the UI | 2 / 3 | 3 | Hunk | Next |
| 6.2 | Geofenced arming | 1 | 3 | None | Do |
| 6.3 | Remote access without port forwarding | 1 | 3 | None | Do |
| 6.4 | Native mobile app | 5 | 3 | None | Skip |
| 6.5 | Multi-site single pane | 5 | 1 | None | Skip |

"2 / 4" means two versions: the cheaper one first, then the full Protect
equivalent.

## Already matched or ahead of Protect

These need no work. Frigate runs them on any camera, with no vendor hardware.

| Feature | Fork | Where |
| --- | --- | --- |
| Object, face, plate detection | Yes | `frigate/data_processing/common/{face,license_plate}/` |
| Audio events (glass, smoke alarm, bark, crying, siren) | Yes | `frigate/config/camera/audio.py` |
| Speech to text | Yes | `audio_transcription.py`, `fork/audio_trial/` |
| Natural language search, GenAI summaries | Yes, plus a chat agent | `frigate/embeddings/`, `frigate/genai/`, `frigate/api/chat.py` |
| Loitering, speed in zones | Yes | `frigate/config/camera/zone.py` |
| Arming modes | Yes (Profiles) | `frigate/config/profile_manager.py` |
| Per-camera roles | Yes | `frigate/config/auth.py`, `RolesView.tsx` |
| Share clip links | Yes (fork) | `frigate/api/fork_share.py` |
| Camera health, offline alerts | Yes (fork) | `CameraHealthView.tsx`, `frigate/video/camera_outage.py` |
| Two-way audio, picture in picture, low latency | Yes | `WebRTCPlayer.tsx`, `MsePlayer.tsx` |
| Export cases, bulk export | Yes | `frigate/api/export.py` |
| Custom trainable classifiers | Yes; Protect has no equivalent | `frigate/config/classification.py` |
| Detector latency charts | Yes | `GeneralMetrics.tsx` |

---

## 1. Detection and analytics

### 1.1 Line crossing and line-cross counting

- **Protect:** draw a line; alert and count when a person or vehicle crosses it.
- **Fork today:** zones only. Nothing tests whether an object crossed a line.
- **Assessment:** the most useful detection feature Frigate lacks. Zones can
  approximate it, but they don't count crossings and a narrow zone misses
  fast objects. The trick that keeps this cheap: on a crossing, add a
  pseudo-zone name to `entered_zones`. Review `required_zones`,
  `Event.zones`, `/events?zones=` and MQTT then all work with no further
  changes.
- **Difficulty 3, Impact 4. Call: Do.**
- **Plugs in at:**
  - `frigate/track/tracked_object.py:186-303` (the per-object zone loop; test
    the previous and current `bottom_center` against each line segment).
  - A `type: line` field on `ZoneConfig` (`frigate/config/camera/zone.py:14`);
    `generate_contour` (`:124`) assumes a polygon.
  - The zone editor only closes shapes with 3+ points (`PolygonCanvas.tsx:148`,
    `PolygonDrawer.tsx:64`); `ZoneEditPane.tsx` needs a two-point line mode.
  - The crossing math itself can live in `frigate/fork/`.
- **Risks:** it runs on the per-frame hot path, but the cost is O(lines) and
  trivial. Running counts need a table (migration) or Timeline rows with
  `class_type="line_crossed"`, which needs no migration.

### 1.2 Direction of travel

- **Protect:** only trigger when crossing in one direction (entering, not
  leaving).
- **Fork today:** `velocity_angle` is computed only inside speed zones
  (`tracked_object.py:214`); the Kalman `estimate_velocity` is always
  available but unused for rules.
- **Assessment:** cuts false alerts sharply on driveways and sidewalks. For
  lines, the sign of a cross product gives direction for free, so build it
  with 1.1.
- **Difficulty 2 with 1.1 (3 alone), Impact 3. Call: Do (with 1.1).**
- **Plugs in at:** gate zone entry at `tracked_object.py:283-287`; one field
  in `zone.py`; an arrow picker in the zone editor.
- **Risks:** pixel velocity is noisy for slow or distant objects; require
  agreement across a few frames, as zone `inertia` does.

### 1.3 Dwell time per zone

- **Protect:** shows how long each object stayed in view or in a zone.
- **Fork today:** `loitering_time` is a threshold; nothing stores how long an
  object stayed. Timeline rows record zone entry only, never exit, so it
  can't be derived after the fact.
- **Assessment:** nice context ("car parked 47 min") but rarely acted on.
- **Difficulty 2, Impact 2. Call: Later.**
- **Plugs in at:** track first and last seen per zone in `TrackedObject`,
  expose it in `to_dict` (`tracked_object.py:400-435`), and write
  `data["zone_dwell"]` in `frigate/events/maintainer.py:237-251`. `Event.data`
  is JSON, so no migration is needed. Show it in `TrackingDetails.tsx`.

### 1.4 Attribute search (clothing color, bags, vehicle make and color)

- **Protect:** "Find Anything" filters by color, accessories, vehicle brand.
- **Fork today:** semantic search ("person in red shirt") works loosely.
  Attribute classifiers can be trained by the user
  (`CustomClassificationObjectConfig`, `config/classification.py:151-161`),
  and results are already searchable through `/events?attributes=`
  (`api/event.py:81-96`).
- **Assessment:** the plumbing is complete; the gap is that users must train
  models themselves. The cheap version ships preset templates (for example
  "upper clothing color" with suggested classes) and a filter chip in
  Explore. Shipping pretrained models is a different, much bigger project.
- **Difficulty 2 (templates and UI) / 4 (pretrained models), Impact 3. Call:
  Next.**
- **Risks:** each attribute model adds inference per object. The
  `attributes` filter is a substring match over all of `Event.data`, so values
  from different models can collide, and it scans the whole table.

### 1.5 "Seen on other cameras" (multi-camera tracking)

- **Protect:** follows a person or vehicle across cameras (G6 and AI cameras).
- **Fork today:** no cross-camera association. Faces are stored in
  `Event.sub_label`, plates in `Event.data.recognized_license_plate`, and
  `/events` can already filter by both, plus camera and time.
  `/events/search?search_type=similarity` gives appearance matches.
- **Assessment:** true re-identification is research-grade. A panel in the
  tracked-object dialog listing the same face, plate or close CLIP match on
  other cameras within ±N minutes gets most of the value from existing
  APIs.
- **Difficulty 2 (panel) / 5 (re-identification), Impact 3. Call: Next (panel).**
- **Plugs in at:** a fork component mounted in `SearchDetailDialog.tsx`;
  no backend change.

### 1.6 Exclusion zones

- **Protect:** areas where detections never raise an alert (a road, a tree).
- **Fork today:** object masks drop detections before tracking
  (`util/object.py:252-266`), which can break tracks for objects passing
  through. There is no "track but never alert here".
- **Assessment:** false alerts from passing traffic are a top complaint. Two
  steps:
  1. Present masks in the editor as exclusion areas, with clear help text
     (wording only).
  2. Add an `exclude_zones` check next to `required_zones` in the review
     maintainer, so objects are tracked but don't alert.
- **Difficulty 1 (wording) / 3 (alert-only), Impact 3. Call: Do.**
- **Plugs in at:** `frigate/review/maintainer.py:213-235`; `MasksAndZonesView.tsx`.

### 1.7 Heatmaps, people counting, occupancy reports

- **Protect:** activity heatmaps, counts over time.
- **Fork today:** `Event.data.path_data` stores normalized positions with
  timestamps (`events/maintainer.py:250`); `Recordings.motion_heatmap` is a
  16x16 grid used only by motion search. `/events/summary` gives daily counts.
  apexcharts, which has a heatmap chart type, is already a dependency.
- **Assessment:** fun but rarely acted on at home; more useful for small
  shops.
- **Difficulty 3, Impact 2. Call: Later.**
- **Plugs in at:** `frigate/api/fork_reports.py` plus a page in
  `web/src/pages/fork/`. Fork-only.
- **Risks:** aggregating JSON across the events table is slow at scale in
  SQLite; precompute per day. The counts are of tracked objects, not unique
  people.

---

## 2. Recording, playback, export

### 2.1 Synced full-resolution multi-camera playback

- **Protect:** pick several cameras and play history side by side, in sync.
- **Fork today:** one full player plus a strip of low-res preview clips
  (`RecordingView.tsx:1036`, `:1086-1110`).
- **Assessment:** the most visible playback gap. Reconstructing an incident
  across cameras means switching the main camera back and forth today.
- **Difficulty 3, Impact 4. Call: Do.**
- **Plugs in at:** a fork view under `web/src/views/fork/` that runs several
  `DynamicVideoPlayer`s on one master clock (`DynamicVideoController.ts:17`),
  plus a toggle in `RecordingView.tsx`. Streams come from the existing
  `vod/.../master.m3u8` endpoints (`api/media.py:1016`).
- **Risks:** browser decode limits (several H.265 streams), nginx-vod remux CPU
  per stream, drift between players. Use sub-stream recordings when
  available, and cap at four players.

### 2.2 Evidence export (hash manifest, who and when, watermark)

- **Protect:** audit-friendly downloads.
- **Fork today:** case zips stream without a manifest
  (`api/export.py:476-534`); `Export` rows don't record the creator.
- **Assessment:** matters for insurance or police handoffs, rare otherwise.
  The hash manifest is cheap: hash each file while it streams and add
  `manifest.json` as the last zip entry. A burned-in watermark forces a
  re-encode.
- **Difficulty 2 (manifest) / 3 (watermark), Impact 2. Call: Later.**
- **Risks:** storing the creator needs a migration or a sidecar JSON per
  export.

### 2.3 Per-camera storage quotas

- **Protect:** caps storage per camera.
- **Fork today:** one global rule. When free space drops below an hour of
  expected usage, delete the oldest hour across all cameras
  (`frigate/storage.py:232-243`). `calculate_camera_usages` (`:183`) already
  sums usage per camera.
- **Assessment:** one chatty camera can push out history from the quiet
  ones. A per-camera `max_size` is a clean addition.
- **Difficulty 3, Impact 3. Call: Next.**
- **Plugs in at:** a field on `RecordConfig` (`config/camera/record.py:142`)
  and a per-camera pass in `StorageMaintainer._maintain_once`
  (`storage.py:420`), or a fork subclass swapped in at `frigate/app.py`.
- **Risks:** deletes must stay consistent with previews and review segments;
  the size query is heavy, so cache it.

### 2.4 Archive to NAS or cloud

- **Protect:** scheduled backup of recordings to NAS or cloud.
- **Fork today:** nothing. Segments are immutable files under
  `/media/frigate/recordings/<date>/<hour>/<camera>/`, and exports are under
  `/media/frigate/exports`.
- **Assessment:** offloading exports and alert clips is easy as a sidecar,
  modeled on `fork/audio_trial` (its own compose service, read-only mounts,
  API reads). Making archived footage play back in the UI is the hard part,
  because `Recordings.path` points at local disk.
- **Difficulty 2 (offload) / 4 (playable archive), Impact 3. Call: Next
  (offload only).**

### 2.5 Privacy masks

- **Protect:** blacks out regions (a neighbor's window) in live and
  recordings.
- **Fork today:** none. Every record preset uses `-c copy`
  (`ffmpeg_presets.py:453-547`), so painting a box means decoding and
  re-encoding.
- **Assessment:** route the camera through a masked go2rtc transcode and
  record from that. The Birdseye restream already does a transcode like
  this (`go2rtc/create_config.py:185`). Costs a full encode per camera.
- **Difficulty 3, Impact 2. Call: Later** (legal need only).
- **Risks:** CPU or GPU load, quality loss, added latency.

---

## 3. Security and access

**Found during this review.** These are separate from the Protect comparison
but should be fixed first:

- `logout` only deletes the cookie (`frigate/api/auth.py:974-979`); the token
  stays valid until it expires.
- A password change only invalidates other sessions when they try to refresh
  (`auth.py:879-895`). With the defaults (24 h session, 30 min refresh
  window) a stolen token keeps working for up to about 23.5 hours after the
  password is changed.
- `failed_login_rate_limit` defaults to `None`, which disables the login
  rate limiter (`fastapi_app.py:199-200`). That must change before 3.3, or
  six-digit codes can be brute forced.
- Export creation only requires camera access (`export.py:858,989`), so any
  viewer can export a camera they can see. That may be intended, but it is
  worth a deliberate decision (see 3.4).

### 3.1 Sessions list and revoke

- **Protect:** active sessions widget; sign out a device.
- **Fork today:** JWTs are stateless (`create_encoded_jwt`, `auth.py:546`,
  sets `sub`, `role`, `exp`, `iat`). There is no `jti` and no session table.
- **Assessment:** also fixes the first two findings above. Add a `jti`,
  record sessions at login, and keep revoked IDs in memory. Frigate runs one
  uvicorn process, so an in-memory set checked in `/auth` is safe and fast.
- **Difficulty 3, Impact 4. Call: Do.**
- **Plugs in at:** `login()` (`auth.py:991`), `logout`, the `/auth` handler
  (`auth.py:756`). The table, endpoints and UI can be fork-only.
- **Risks:** `/auth` runs on every proxied request, including every HLS
  segment, so the check must stay in memory and `last_seen` writes must be
  throttled. Tokens issued before the change have no `jti`; treat them as
  legacy until they expire.

### 3.2 Audit log

- **Protect:** logs logins, config changes, recording access, downloads and
  deletes, with filters.
- **Fork today:** none. Failed logins raise a notice
  (`auth.py:340-380`), nothing else.
- **Assessment:** API actions are easy to capture with a middleware.
  Recording views and downloads are served by nginx and never reach FastAPI;
  they only pass through `/auth`, so they need de-duplication per user,
  camera and time window or they flood the log.
- **Difficulty 3, Impact 3 (4 for multi-user installs). Call: Next** (build on
  3.1's session table).
- **Plugs in at:** a middleware added near `fastapi_app.py:207`; `login()`
  (`auth.py:991`) for usernames; `/config/save` and `/config/set`
  (`api/app.py:548,833`); a hook in `/auth` for media access.
- **Risks:** SQLite write contention on the `/auth` path, so queue or batch
  the writes. Share tokens must be redacted.

### 3.3 Two-factor authentication (TOTP)

- **Protect:** MFA through the UI account.
- **Fork today:** none. Authelia or similar through a proxy is the only
  option.
- **Assessment:** important for anyone exposing Frigate to the internet.
  RFC 6238 is about 30 lines of standard library, so no new dependency; the
  fork already has a QR encoder (`web/src/lib/fork/qr-encode.ts`).
- **Difficulty 3, Impact 4. Call: Do** (after enabling the rate limiter).
- **Plugs in at:** a step after `verify_password` in `login()`
  (`auth.py:1010`); a `totp` field on `AppPostLoginBody`; User fields for
  secret and recovery codes (migration); a second step in `AuthForm.tsx`.
- **Risks:** Home Assistant and API clients log in with username and password,
  so 2FA must be opt-in per user. `reset_admin_password` must also clear TOTP.
  The secret is stored in plaintext in SQLite.

### 3.4 Granular per-camera permissions

- **Protect:** separate view, playback, export and admin rights per camera.
- **Fork today:** a role maps to a camera list; access is all or nothing per
  camera. Enforcement lives in three places: FastAPI dependencies (about 77
  uses of `require_camera_access`), nginx `/auth` with `media_auth.py`, and
  the WebSocket classifier.
- **Assessment:** live-versus-playback can be gated centrally by URL in
  `/auth`. Export, PTZ and delete need per-route edits across many upstream
  files, and a missed route is a silent leak.
- **Difficulty 4, Impact 2. Call: Later.** A cheap slice is one
  `can_export` capability per role.

### 3.5 Temporary guest live access

- **Protect:** share live view with a guest for a limited time.
- **Fork today:** share links cover clips only (`ShareLink` model,
  `fork_share.py:338-394`).
- **Assessment:** live streams go through go2rtc WebSockets behind
  `auth_request`, so `/auth` would have to accept a guest token scoped to one
  camera, including the WebRTC POST.
- **Difficulty 4, Impact 2. Call: Later.**
- **Risks:** tokens in WebSocket URLs need log redaction; open sockets
  outlive token expiry and need a server-side kill; WebRTC ICE for outside
  guests.

---

## 4. Alerts and automation

### 4.1 Server-side notification schedules

- **Protect:** per-camera schedules for when notifications fire.
- **Fork today:** cooldowns, suspend, and Profiles. The fork inbox's quiet
  hours only mark items read in the browser
  (`web/src/lib/fork/inbox-store.ts:241,286`); the phone push still
  arrives. `NotificationConfig` has no time or zone filter.
- **Assessment:** high value, low cost. The current quiet hours look like
  they silence the phone but don't. Two options, both small:
  1. A schedule gate in `WebPushClient.publish` (`comms/webpush.py:222-274`).
  2. A profile scheduler (for example "Away" from 08:00 to 17:00 on
     weekdays) as an asyncio task like `camera_ping_sampler`.
- **Difficulty 2, Impact 4. Call: Do.**
- **Risks:** time zones and DST; a scheduler must not fight manual profile
  switches. Note that `docs/docs/configuration/profiles.md:256` calls built-in
  scheduling out of scope upstream, so this stays fork-only.

### 4.2 Spotlights feed

- **Protect:** a dashboard of the important events: known faces, plates,
  threats.
- **Fork today:** review alerts and the inbox. `ReviewSegment.data` already
  holds `sub_labels`, zones, audio and `metadata.potential_threat_level`, but
  the inbox drops them (`InboxItem`, `inbox-store.ts:13-27`).
- **Assessment:** a ranked feed (unreviewed, known face or plate, threat
  level) on top of `/review` is a good daily landing page.
- **Difficulty 2, Impact 3. Call: Next.**
- **Plugs in at:** a fork page, plus `frigate/api/fork_spotlight.py` if
  `/review` needs a `sub_label` filter.

### 4.3 Rich push (clip or animated preview)

- **Protect:** push notifications with video.
- **Fork today:** thumbnail plus a deep link (`webpush.py:316-325`).
- **Assessment:** a platform limit, not a code gap. Web Push payloads cap at
  about 4 KB, iOS Safari ignores `image`, and Android shows only the first
  GIF frame. The most this can become is a "Play clip" action button.
- **Difficulty 3, Impact 2. Call: Skip** (maybe add the action button).

### 4.4 Alarm Manager rules engine

- **Protect:** "if trigger and condition, then action" rules in the UI, with a
  test button, last-trigger time and 24-hour hit counts.
- **Fork today:** none. Users automate in Home Assistant or Node-RED over
  MQTT. Semantic triggers support only notification, sub_label and attribute
  actions (`config/classification.py:47`).
- **Assessment:** the plumbing is easy: a fork `RulesCommunicator` added to
  the dispatcher list (`frigate/app.py:337-352`) sees every review, event,
  audio and outage message. The UI is the big part. Most users of this fork
  already have Home Assistant, which lowers the impact.
- **Difficulty 4, Impact 3. Call: Later.** Ship webhooks as the only action
  first (`httpx` is already installed).
- **Risks:** SSRF from user-supplied webhook URLs; rule loops; the test
  button needs a synthetic event path.

### 4.5 Siren, light, chime, relay outputs

- **Protect:** triggers sirens, floodlights, chimes and relays from alarms.
- **Fork today:** none. The ONVIF controller creates only media, PTZ and
  imaging services (`frigate/ptz/onvif.py:334-342`).
- **Assessment:** go2rtc can play a file into a camera's speaker, and ONVIF
  has `SetRelayOutputState`, but support varies by camera and can't be
  tested without the hardware. Home Assistant already does this well.
- **Difficulty 5, Impact 2. Call: Skip.**

---

## 5. Live view and devices

### 5.1 Kiosk / wall display mode

- **Protect:** Viewport, a wall display that cycles layouts.
- **Fork today:** none; the docs point at third-party extensions.
- **Assessment:** cheap and visible. `App.tsx:81-93` already has an early
  return for public share pages, the same pattern a chrome-free
  `/kiosk?group=...&cycle=30` route needs. Camera groups, saved layouts and
  the wake lock helper already exist.
- **Difficulty 2, Impact 4. Call: Do.**
- **Plugs in at:** `web/src/pages/fork/KioskPage.tsx`, a flag in
  `web/src/fork/flags.ts`, one route in `App.tsx`.
- **Risks:** the screen wake lock needs HTTPS or localhost; fullscreen needs a
  click, so recommend the browser's own kiosk flag. Each cycle reconnects
  streams. Sessions refresh while streaming, so the display stays logged
  in; document using a camera-limited viewer role.

### 5.2 Live telemetry widgets

- **Protect:** live total bitrate, viewer count, AI latency.
- **Fork today:** detector latency is already charted. The fork's go2rtc
  reader (`frigate/fork/go2rtc_state.py`) already measures per-stream
  `bytes_per_second` and `consumers`.
- **Assessment:** almost free; sum the values and add a card on the System
  page. Low impact, but nice to have.
- **Difficulty 2, Impact 2. Call: Next.**
- **Risks:** the consumer count includes Frigate's own restream readers;
  filter by type. Cameras ffmpeg reads directly (not through go2rtc) are
  missing from the bitrate.

### 5.3 PTZ patrols and return to home

- **Protect:** preset tours, a home position, return home after manual
  control.
- **Fork today:** `GotoPreset` exists (`onvif.py:756-774`); autotracking
  returns to `return_preset`, but only after autotracking
  (`autotrack.py:1529-1584`), never after a manual move. No
  `GotoHomePosition`.
- **Assessment:** return-after-manual is a small timer on the PTZ command
  path (`comms/dispatcher.py:902`). A patrol is a scheduler that steps
  through presets and pauses while autotracking or a user is in control.
- **Difficulty 3, Impact 3 (PTZ owners only). Call: Next.**

### 5.4 Network camera discovery

- **Protect:** cameras on the network show up for adoption automatically.
- **Fork today:** the wizard probes one host you type (`api/camera.py:683`).
- **Assessment:** ONVIF WS-Discovery multicast does not cross Docker's default
  bridge network, so it only works with `network_mode: host`. A fallback
  "scan this subnet" that probes each address works everywhere. It's a
  one-time setup convenience.
- **Difficulty 3, Impact 2. Call: Later.** Use a small hand-written UDP probe
  rather than a new library (which would touch the lock files).

### 5.5 Camera image settings and firmware

- **Protect:** IR, WDR, exposure and firmware updates from the NVR.
- **Fork today:** the imaging service is used only for focus. The ONVIF
  controller fails on cameras without PTZ (service creation at
  `onvif.py:334` isn't guarded), so fixed cameras need a separate client.
- **Assessment:** support for ONVIF imaging varies widely across vendors.
  Firmware over ONVIF risks bricking cameras; leave it out.
- **Difficulty 4, Impact 2. Call: Later** (image settings only, never firmware).

---

## 6. Platform and operations

### 6.1 Backup and restore from the UI

- **Protect:** scheduled backups and one-click restore of config and
  database.
- **Fork today:** `backup.db` is a file copy taken only before migrations
  (`frigate/app.py:216-219`); config is editable in the UI. SQLite's online
  backup API isn't used.
- **Assessment:** a "download backup" button (config plus an online SQLite
  backup) is easy and protects against bad upgrades. Restore must be staged
  and swapped in at the next start, before migrations run.
- **Difficulty 2 (backup) / 3 (restore), Impact 3. Call: Next.**
- **Risks:** the DB can be large (embeddings); a schema version mismatch on
  restore.

### 6.2 Geofenced arming

- **Protect:** the app arms when everyone leaves.
- **Fork today:** everything needed exists. Profiles switch over MQTT
  (`frigate/profile/set`) or `PUT /api/camera/*/set/profile`.
- **Assessment:** write a Home Assistant recipe (companion app zones →
  profile switch). No code.
- **Difficulty 1, Impact 3. Call: Do (docs).**

### 6.3 Remote access without port forwarding

- **Protect:** Ubiquiti's cloud relay and Teleport.
- **Fork today:** Tailscale gets brief mentions in three upstream docs;
  Cloudflare Tunnel isn't mentioned; `fork/DEPLOYMENT.md` says nothing about
  remote access.
- **Assessment:** a relay is out of scope. A fork guide covering Tailscale and
  Cloudflare Tunnel, including WebRTC candidate settings, closes most of the
  practical gap.
- **Difficulty 1, Impact 3. Call: Do (docs).**

### 6.4 Native mobile app

- **Fork today:** a heavily polished PWA. **Difficulty 5, Impact 3. Call: Skip.**
  The PWA plus the Home Assistant companion app covers push and geofencing.

### 6.5 Multi-site single pane

- **Fork today:** nothing. Cross-site auth, CORS and stream relaying make it a
  new product. **Difficulty 5, Impact 1. Call: Skip.**

---

## Suggested order

1. **Security fixes** (section 3 findings), then 3.1 sessions and 3.3 TOTP.
   These close real exposure, not just a feature gap.
2. **Quick wins:** 6.2 and 6.3 (docs), 5.1 kiosk, 4.1 notification schedules,
   1.6 exclusion wording. Each is days, not weeks.
3. **Detection:** 1.1 line crossing with 1.2 direction, then 1.6 alert-only
   exclusion.
4. **Playback:** 2.1 synced multi-camera grid.
5. **Next tier:** 3.2 audit log, 4.2 Spotlights, 2.3 quotas, 6.1 backup,
   1.5 "seen elsewhere", 5.3 PTZ return-home, 5.2 telemetry, 1.4 attribute
   templates, 2.4 offload.

## Notes for whoever builds these

- **Migrations:** the fork already has two `036_*` files, and upstream's
  latest is `039`. The next upstream migration will likely be `040_*`, so
  a fork migration should use a number unlikely to collide, and say so in
  its ledger row.
- **Fork config:** `frigate/config/fork/__init__.py` is empty. Any new YAML
  setting (line zones, quotas, schedules) means a small hunk in an upstream
  config class. Creating one fork config section first would let later
  items add settings without touching upstream files.
- **Fork routers:** register in `frigate/api/fastapi_app.py:229-234`.
  `assert_routes_have_auth_gate` (`auth.py:210`) fails startup for an ungated
  route, and non-admin fork paths must be added to `EXEMPT_PATHS` or
  `EXEMPT_PREFIXES`. Regenerate `docs/static/frigate-api.yaml` after any
  endpoint change.
- **`/auth` hot path:** it runs, uncached, on every proxied request including
  every HLS segment. Anything added there (3.1, 3.2, 3.5) must be in-memory
  and non-blocking.
- **WebSocket topics:** a new outbound topic (for example rule hits for 4.4)
  must be classified in `frigate/comms/ws.py` or it is dropped silently.

## Sources

- [Introducing Protect 6.0](https://blog.ui.com/article/introducing-protect-6-0)
- [Introducing UniFi Protect 6.2](https://blog.ui.com/article/introducing-unifi-protect-6-2)
- [UniFi Protect 6.0 Update, LazyAdmin](https://lazyadmin.nl/home-network/unifi-protect-6-update/)
- [UniFi Protect 6.2 in detail, varia.org](https://www.varia.org/en/unifi-protect-6-2-in-detail/)
- [UniFi Protect Application 6.2.72 release notes](https://community.ui.com/releases/UniFi-Protect-Application-6-2-72/b45268b0-bee2-41c7-b409-8e2d5c0ca47c)
- [Ubiquiti release notes, Releasebot](https://releasebot.io/updates/ubiquiti)
- [UniFi Protect got Amazing, The Smart Home Hookup](https://www.thesmarthomehookup.com/test_install/unifi-protect-got-amazing/)
