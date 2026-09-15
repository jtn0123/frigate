# Host and container monitoring

The API collects model samples in the background every ten seconds. It retains
one sample per minute for 24 hours in `/config/ai-model-history.sqlite`, including
source timestamps and gaps. Only admins can read this history or `/metrics`.
Existing Prometheus scrapers must use an admin identity.

For host and CT pressure, run `collect_proxmox.py` on the Proxmox host as root
through a systemd timer or cron every minute. It uses local kernel files and
`lxc-info`, opens no network listener and needs no Portainer or Proxmox API token.
It reads host/CT counters and writes a sanitized snapshot into Frigate CT 106's
existing local model cache. Change the CT IDs and config path for other layouts.

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
Ollama process readings appear as their own service scope. They are not allocated
across individual models because doing so would invent per-model RAM/CPU figures.

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
