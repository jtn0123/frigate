# Host and container monitoring

The API collects model samples in the background every ten seconds. It retains
one sample per minute for 24 hours in `/config/ai-model-history.sqlite`, including
source timestamps and gaps. Only admins can read this history or `/metrics`.
Existing Prometheus scrapers must use an admin identity.

For host and CT pressure, run `collect_proxmox.py` on the Proxmox host as root
through a systemd timer or cron every minute. It uses local kernel files,
`lxc-info`, and bounded container-local `systemctl show` calls for the Ollama
service's state, PID and cgroup. It opens no network listener and needs no
Portainer or Proxmox API token.
It reads host/CT counters and writes a sanitized snapshot into Frigate CT 106's
existing local model cache. Change the CT IDs and config path for other layouts.

For an Ollama container managed without `ollama.service`, attribution remains
unavailable rather than falling back to process-name matching.

Example command (after copying this script to `/opt/frigate-monitoring/`):

```sh
python3 /opt/frigate-monitoring/collect_proxmox.py --containers 106 108 --frigate 106
```

The first CPU sample is unknown; a second run measures the interval. CPU percent
is per logical core, so 200% means two busy cores. Memory limits include ancestor
cgroups. OOM kills are cumulative; increases between retained samples identify
new kills. Pressure is the kernel's average percentage of time stalled. Container
memory includes cache; host RAM uses MemAvailable; Ollama RSS may include shared
pages and is not additive with container memory. Container scopes that cannot be
read are omitted, never reported as zero. No camera URLs or process arguments
are exported. Files older than 90 seconds show as stale.

Deployment verification: check `/api/version`, then `/api/ai/models`, confirm both
CT scopes and the host scope, wait one minute for CPU, close all browser tabs and
confirm `/api/ai/models/history` still gains samples. The Docker version health
check establishes API liveness only, not camera capture or recording integrity.

The supplied `frigate-monitoring.service` and `.timer` automate the command.
After reviewing the CT IDs, install on pve05:

```sh
install -d /opt/frigate-monitoring
install -m 644 collect_proxmox.py /opt/frigate-monitoring/
install -m 644 frigate-monitoring.service frigate-monitoring.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now frigate-monitoring.timer
systemctl start frigate-monitoring.service
```

Stop collection with `systemctl disable --now frigate-monitoring.timer`.
Ollama readings include verified service workers and nested worker cgroups,
regardless of process names. RSS sums unique service PIDs and can include shared
pages. CPU uses the service's inclusive cgroup counter, expressed per logical
core; the first interval after a service restart is unknown. If identity,
membership, access or bounded traversal fails, the Ollama measurement is omitted
and the snapshot is partial. Other measured host/container rows remain available.
These readings are not allocated across individual models because doing so
would invent per-model RAM/CPU figures.

## Review image limits

`review.genai.max_frames` optionally limits images in each review description.
It accepts an integer from 2 to 28, globally or per camera. An unset value keeps
the existing context, duration and frame-mode limits. The cap applies after
those budgets and again at the provider handoff, including manual regeneration.
It never increases the number of available frames. Uniform sampling preserves
the first and last available frames and their annotation timestamps.

```yaml
review:
  genai:
    max_frames: 6
```

Lower values reduce image work and temporal detail; they do not establish GPU
latency or detection improvement without a comparable runtime measurement.
Object descriptions, model selection, context size and camera recording
settings are unchanged. The model-history Ollama request count represents
recent completions over its existing overlapping observation window, not an
active queue or simultaneous GPU jobs.

## Prometheus metric migration

Storage values from Frigate are MiB. `/metrics` converts them to bytes with
`1024 ** 2`; existing byte-valued charts now match the server's storage figures.

`frigate_camera_events_total` has been replaced by the gauge
`frigate_camera_events_retained{camera,label}`. It counts events currently retained
in the database and can fall when retention removes events. Update dashboards to
show this gauge directly. Do not apply `rate()` or `increase()` to retained counts;
they cannot measure event arrivals. The previous counter described these counts
incorrectly as events since exporter startup.

Model history includes expandable, paginated value tables. Missing/stale samples
remain gaps. Metric explanations expand using touch or keyboard, and graph series
use shared theme colors plus different line patterns.

## Camera health metrics

`/api/metrics` also carries the fork's camera health figures (I59), after
upstream's metrics and the model samples. All of them come from values Frigate
already tracks. A value that is unknown is left out, never exported as zero.

| Metric | Labels | Meaning |
| --- | --- | --- |
| `frigate_camera_up` | `camera_name` | 1 while the camera delivers frames and is not in an outage |
| `frigate_camera_outage_seconds` | `camera_name` | How long the camera has been unreachable, 0 when it is not |
| `frigate_camera_outages_24h` | `camera_name` | Outages that started in the last 24 hours |
| `frigate_camera_uptime_ratio` | `camera_name`, `window` | Share of the last 24 hours with frames (0.0 to 1.0), as on the Health tab |
| `frigate_camera_restarts_24h` | `camera_name` | ffmpeg and capture restarts in the last 24 hours |
| `frigate_camera_restarts_by_kind_24h` | `camera_name`, `kind` | The same, by cause (`connection`, `stalled`, `hwaccel`, `other`) |
| `frigate_camera_reconnects_last_hour`, `frigate_camera_stalls_last_hour` | `camera_name` | Detect stream reconnects and stalls |
| `frigate_camera_connection_quality` | `camera_name`, `quality` | 1 on the series of the current quality, 0 on the others |
| `frigate_camera_expected_fps`, `frigate_camera_skipped_percent` | `camera_name` | Configured detect rate, and frames dropped before detection |
| `frigate_camera_hwaccel_fallback` | `camera_name` | 1 while detect decodes in software after hardware decoding failed |
| `frigate_camera_watchdog_age_seconds` | `camera_name` | Seconds since the capture watchdog last ran (SV12). It reports every 5 seconds, so minutes mean it hung |
| `frigate_camera_ping_up`, `frigate_camera_ping_seconds`, `frigate_camera_ping_loss_ratio` | `camera_name` | Whether the camera's host answered Frigate's last ping round, the best round trip, and the share of the three pings that went unanswered (I60) |
| `frigate_go2rtc_available` | | 1 while go2rtc answers |
| `frigate_go2rtc_stream_connected`, `frigate_go2rtc_stream_received_bytes`, `frigate_go2rtc_stream_consumers` | `camera_name`, `stream` | go2rtc's state of each stream a camera uses (I57). The source address is never a label |
| `frigate_enrichment_speed_seconds`, `frigate_enrichment_per_second` | `name` | Time per inference and rate of each enabled enrichment (embeddings, face, plate, classification, descriptions) |
| `frigate_container_memory_bytes`, `frigate_container_memory_limit_bytes`, `frigate_container_oom_kills` | | The Frigate container's cgroup memory, its limit when it has one, and how many of its processes the kernel killed for memory |
| `frigate_server_*` | `scope`, `id` | The host collector's figures above, when it is installed |

go2rtc dials a source only while something reads the stream, so an idle
live-only stream and an unreachable camera both show as not connected. Read
`frigate_go2rtc_stream_connected` together with `frigate_go2rtc_stream_consumers`.

Rules worth having, written as PromQL:

```
# a camera delivers nothing
frigate_camera_up == 0

# a capture watchdog hung (SV12 restarts it after 5 minutes)
frigate_camera_watchdog_age_seconds > 120

# the kernel killed a Frigate process for memory
increase(frigate_container_oom_kills[15m]) > 0

# the container is within 10% of its memory limit
frigate_container_memory_bytes / frigate_container_memory_limit_bytes > 0.9

# a camera keeps reconnecting
frigate_camera_restarts_24h > 50
```

Only admins can read `/api/metrics`. A scraper on another host has two ways in:

- Through the authenticated port (8971) with an admin identity: a bearer token
  in the `Authorization` header, or the proxy headers when Frigate sits behind
  an authenticating proxy. Tokens from a login expire with the session, so this
  needs a refresh step.
- Through the internal port (5000), which has no authentication. Publish it
  only to the scraper, for example bound to one address and limited by the
  firewall to the Prometheus host. Anyone who can reach that port has full
  admin access to Frigate.

## Native recording completeness

System > Health keeps capture history and saved recording coverage separately.
Capture uptime means frames arrived; it does not establish that footage was
saved continuously. The Health table's Recorded column and camera drawer show
main-recording coverage, missing time, the longest gap, significant gap count,
assessed time and the latest assessed endpoint. Percentages describe assessed
time alone; the table shows how much time was checked and the drawer also shows
the requested duration. No data is unavailable rather than 100 percent.

The recording collector runs inside Frigate independently of browser tabs. It
observes recording policy at runtime, analyzes completed five-minute intervals
after at least 120 seconds for ingestion, and retains seven days of compact
summaries in `/config/.recording_health.json`. Runtime camera/recording toggles
invalidate mixed-policy intervals. Disabled, non-continuous, unobserved and
failed scans do not become recording outages. Main and sub streams are not
combined: a sub stream cannot conceal a gap in the configured continuous main
recording. Sub-stream coverage is not assessed by this collector.

The background reader uses a dedicated read-only SQLite connection, indexed
time bounds, a one-second query budget, bounded rows and a bounded number of
queries per tick. Tiny clips contribute only their actual registered duration,
so fresh half-second clips cannot disguise 50 percent coverage. Overlaps are
merged, and gaps crossing adjacent assessed intervals are counted once. Gaps
never bridge unobserved periods. A deficit below 99 percent coverage or a gap
lasting at least ten seconds is shown separately from live capture health.
These are diagnostic thresholds, not vendor guarantees.

Recent observations are reconciled while the original observed retention
policy still protects their recording rows, so late ingestion can repair an
apparent deficit. A failed retry or later deletion cannot reduce coverage
already observed. Completed observations survive later footage expiry and
process restarts; a restart does not infer past recording policy from current
settings. New tracking initially reports unavailable until a complete observed
interval has finished saving.

Coverage uses registered segment timestamps. It does not decode footage or
prove playback integrity. This native history requires no third-party scraper,
uptime service, camera credentials, active camera probes or new network access.

New saved segments are checked once with a bounded final-file packet probe,
replacing the former cache keyframe probe. Verified video timing determines
the registered duration. Video with corrupt or missing expected audio retains
its verified video coverage and raises a camera-scoped audio notice. Uncertain
video mapping is withheld from coverage and raises a video notice. Source
probe failures still use the existing bounded cache discard behavior.

Unverified remuxed outputs are preserved under
`/media/frigate/recordings/.integrity/` for diagnosis, limited globally to 128
files, 256 MiB and 24 hours, with periodic expiry. They are absent from normal
playback and do not claim a recording interval. Probe work has a five-second
time budget, four MiB output budget and bounded packet count. This checks packet
timing, not complete decoding of every image or audio sample.

Native camera notices coalesce repeated failures by video/audio category for
five minutes. Sustained verified success starts a new episode; it does not
repair or erase historical warnings. Notices remain available to acknowledge.
Sub-stream success, stale observations and unknown probe results cannot clear
a main-stream failure. No automatic camera restart or model change is applied
by these checks, and existing recordings are not rescanned or relabeled.
The existing host collectors remain useful for pressure and whole-server
failures, which an application cannot observe while it is stopped.

## Camera pings for an uptime monitor

Cameras normally sit on a network that only Frigate can reach, so an uptime
monitor on another host cannot ping them, and giving it a route would undo the
isolation. Frigate pings them instead (I60) and passes on the answer alone.

Every 30 seconds Frigate sends three ICMP echoes to the host each enabled
camera's stream comes from (the source of its go2rtc stream, or its ffmpeg
input when it does not use go2rtc). When the container may not open an ICMP
socket, or the camera does not answer echoes, a TCP connect to the stream's
port decides instead. The result shows in the Health drawer, in the metrics
above, and is pushed to every camera that has a push URL.

For Uptime Kuma, add one monitor of type "Push" per camera (heartbeat interval
60 seconds, one retry) and give Frigate the URLs as `camera=url` pairs,
separated by spaces, commas or line breaks:

```yaml
environment_vars:
  FRIGATE_FORK_UPTIME_PUSH: >-
    doorbell=http://kuma.example:3001/api/push/<token>
    backyard=http://kuma.example:3001/api/push/<token>
```

The query string Uptime Kuma shows after the URL (`?status=up&msg=OK&ping=`)
may stay or go; Frigate sends its own. Each push carries `status` (`up` or
`down`), a short `msg` and the round trip in `ping`. The camera's address,
credentials and stream never leave Frigate, and the push URLs are never
logged. The variable is read at startup, so a change needs a restart.

The monitor turns red when the camera stops answering, and also when Frigate
itself stops pushing, which is the right reading for "Frigate cannot see this
camera". A camera that answers pings while `frigate_camera_up` is 0 is on the
network with a broken stream; one that answers neither is off the network or
without power.

## Stability incidents

Install `incident_monitor.py`, `incidents.py`, and `collect_proxmox.py` together
in `/opt/frigate-monitoring`, then install `frigate-incidents.service` in
`/etc/systemd/system` and run `systemctl daemon-reload` followed by
`systemctl enable --now frigate-incidents`. This host service needs no API token.
It samples CT 106 and CT 108 every 15 seconds with bounded subprocess timeouts.
The service runs independently of the dashboard. Stop it with
`systemctl disable --now frigate-incidents`.

The root-only `/var/lib/frigate-incidents/history.sqlite` retains 24 hours of
samples and incident evidence across service restarts. The latest occurrence of
each incident is retained; recurrent occurrences also remain visible in samples.
`journalctl -u frigate-incidents` shows local open/recovery alerts. No external
notifications are sent. The admin-only model health API reads the sanitized
`/config/model_cache/stability.json` snapshot. It shows separate server, capture,
continuous recording, and AI incident status, graphs, and recent evidence.

Initial diagnostic thresholds are detector latency above 30 ms or skipped frames
above 0.5 fps for three distinct fresh Frigate samples, zero capture FPS for
20 seconds, and continuous recording more than 120 seconds behind. These are
operator warning thresholds, not universal performance guarantees. Event-only
recording is excluded from the continuity check. This checks recent database
segments, not playback integrity or every historical gap. Missing measurements
cannot establish recovery. Stats older than 90 seconds and dashboard snapshots
older than 60 seconds show unknown status. Sustained-threshold counters restart
with the collector; persisted incidents require valid measurements to resolve.
A camera or container that a fresh sample no longer lists (disabled or removed)
resolves its incidents and loses its counters, and a stats gap restarts the
20-second capture grace.

Evidence contains GPU measurements, per-camera rates and recording freshness,
container restarts/OOM state, safe audio failure stages, and Ollama timings.
Generation lifecycle files record actual request start/end, image count and
completion state after the application update. Journal completion windows overlap
and must not be summed as request totals. Prompts, images, transcripts, camera
URLs, credentials and raw logs are not retained by this collector. A running
request without an end can indicate an interrupted process, not ongoing work.

For a contention investigation, compare distinct source timestamps before,
during and after an optional Ollama workload. Restore Ollama in a `finally`
handler and stop the trial when detector latency or skipped frames increase.
A phase boundary does not make a cached Frigate statistic a fresh measurement.
For camera faults, compare direct and restream capture, check recording segment
freshness, and record network latency. Stream-copy timestamp warnings alone do
not establish a decoder or network fault.
