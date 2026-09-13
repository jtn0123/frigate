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
