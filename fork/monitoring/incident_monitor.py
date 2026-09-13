"""Capture synchronized health evidence on Proxmox without media or credentials."""

import json
import logging
import re
import signal
import subprocess
import threading
import time
from pathlib import Path

from collect_proxmox import init_pid, publish_snapshot
from incidents import Incidents

logger = logging.getLogger(__name__)
STOP = threading.Event()
# Only whitelisted measurements leave the CT. Never retain URLs, prompts or logs.
SNAPSHOT = r"""
import json,time,urllib.request,subprocess,sqlite3
from pathlib import Path
now=time.time()
def api(path):
 with urllib.request.urlopen('http://127.0.0.1:5000/api/'+path,timeout=4) as r:return json.load(r)
s=api('stats');c=api('config')
r=subprocess.run(['docker','exec','frigate','python3','-c',"import sqlite3,json; db=sqlite3.connect('file:/config/frigate.db?mode=ro',uri=True); print(json.dumps(dict(db.execute('select camera,max(end_time) from recordings group by camera'))))"],capture_output=True,text=True,timeout=5)
ends=json.loads(r.stdout) if r.returncode==0 else {}
r=subprocess.run(['docker','inspect','frigate','frigate-audio-trial'],capture_output=True,text=True,timeout=5)
containers={x['Name'].lstrip('/'):{'running':x['State']['Running'],'oom_killed':x['State']['OOMKilled'],'restarts':x['RestartCount'],'started':x['State']['StartedAt']} for x in json.loads(r.stdout or '[]')}
r=subprocess.run(['docker','logs','--since','20s','--tail','200','frigate-audio-trial'],capture_output=True,text=True,timeout=5)
errors=sum('failed:' in line for line in (r.stdout+r.stderr).splitlines())
requests=[]
for path in sorted(Path('/opt/frigate/config/model_cache/generation-requests').glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)[:20]:
 if path.stat().st_size <= 4096:
  try:
   data=json.loads(path.read_text());requests.append({k:data.get(k) for k in ('id','started','ended','images','status')})
  except (OSError,ValueError):pass
failure_path=Path('/opt/frigate/audio-trial/state/last-failure.json')
failure={}
if failure_path.exists() and failure_path.stat().st_size <= 4096:
 try:failure=json.loads(failure_path.read_text())
 except (OSError,ValueError):pass

print(json.dumps({'time':now,'source_updated':s.get('service',{}).get('last_updated'),'version':s.get('service',{}).get('version'),'detector_ms':{k:v.get('inference_speed') for k,v in s.get('detectors',{}).items()},'gpu':{k:{f:v.get(f) for f in ('gpu','mem','temp')} for k,v in s.get('gpu_usages',{}).items()},'cameras':{k:{'enabled':c['cameras'].get(k,{}).get('enabled',False),'recording_expected':bool(c['cameras'].get(k,{}).get('record',{}).get('enabled',False) and c['cameras'].get(k,{}).get('record',{}).get('continuous',{}).get('days',0)>0),'recording_end':ends.get(k),**{f:s.get('cameras',{}).get(k,{}).get(f) for f in ('camera_fps','process_fps','skipped_fps','detection_fps')}} for k,v in c.get('cameras',{}).items() if v.get('enabled',False)},'containers':containers,'audio_failures':errors,'audio_failure':{k:failure.get(k) for k in ('updated','stage','cause')},'generation_requests':requests}))
"""


def capture():
    """Capture measurements and request completion timings with bounded commands."""
    result = subprocess.run(
        ["pct", "exec", "106", "--", "python3", "-c", SNAPSHOT],
        capture_output=True,
        text=True,
        timeout=25,
        check=True,
    )
    sample = json.loads(result.stdout)
    try:
        result = subprocess.run(
            [
                "pct",
                "exec",
                "108",
                "--",
                "journalctl",
                "-u",
                "ollama",
                "--since",
                "20 seconds ago",
                "--no-pager",
                "-o",
                "cat",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
        sample["ollama_completions_last_20s"] = completion_timings(result.stdout)
    except (OSError, subprocess.SubprocessError):
        # Keep camera evidence even when the independent Ollama CT is unavailable.
        sample["ollama_completions_last_20s"] = None
    try:
        result = subprocess.run(
            [
                "pct",
                "exec",
                "108",
                "--",
                "systemctl",
                "show",
                "ollama",
                "-p",
                "ActiveState",
                "-p",
                "ExecMainStartTimestampMonotonic",
                "-p",
                "NRestarts",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
        state = {
            key: value
            for line in result.stdout.splitlines()
            if "=" in line
            for key, value in [line.split("=", 1)]
        }
        sample.setdefault("containers", {})["ollama"] = {
            "running": state.get("ActiveState") == "active",
            "started": state.get("ExecMainStartTimestampMonotonic"),
            "restarts": int(state.get("NRestarts", 0)),
        }
    except (OSError, ValueError, subprocess.SubprocessError):
        sample.setdefault("containers", {})["ollama"] = {"running": None}
    return sample


def duration_seconds(value):
    """Parse a bounded Go duration from its start, without unanchored backtracking."""
    units = {
        "ns": 1e-9,
        "us": 1e-6,
        "µs": 1e-6,
        "μs": 1e-6,
        "ms": 0.001,
        "s": 1,
        "m": 60,
        "h": 3600,
    }
    if not value or len(value) > 64:
        return None
    total = 0.0
    while value:
        match = re.match(r"(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)", value)
        if not match:
            return None
        total += float(match[1]) * units[match[2]]
        value = value[match.end() :]
    return total


def completion_timings(log):
    """Extract only safe completion fields, including compound Go durations."""
    requests = []
    for line in log.splitlines():
        fields = [field.strip() for field in line.split("|")]
        if len(fields) != 5 or not fields[1].isdigit():
            continue
        route = fields[4].split()
        if len(route) != 2 or route[0] != "POST":
            continue
        path = route[1].strip('"')
        duration = duration_seconds(fields[2])
        if path not in {"/api/chat", "/api/generate"} or duration is None:
            continue
        requests.append(
            {"http_status": int(fields[1]), "duration_seconds": duration, "route": path}
        )
    return requests[-20:]


def main():
    """Persist evidence independently of the browser and publish local alerts."""
    logging.basicConfig(level=logging.INFO)
    directory = Path("/var/lib/frigate-incidents")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    monitor = Incidents(directory / "history.sqlite")
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: STOP.set())
    previous = set()
    try:
        while not STOP.is_set():
            started = time.monotonic()
            try:
                sample = capture()
            except (OSError, ValueError, subprocess.SubprocessError):
                sample = {"time": time.time(), "source_updated": None}
                logger.warning("Stability source unavailable")
            report = monitor.observe(sample)
            active = {
                row["key"] for row in report["incidents"] if row["resolved"] is None
            }
            for key in active - previous:
                logger.warning("Stability incident opened: %s", key)
            for key in previous - active:
                logger.info("Stability incident resolved: %s", key)
            previous = active
            try:
                publish_snapshot(
                    Path(f"/proc/{init_pid('106')}/root"),
                    report,
                    filename="stability.json",
                )
            except (OSError, ValueError, subprocess.SubprocessError):
                logger.warning("Stability dashboard publication unavailable")
            STOP.wait(max(1, 15 - (time.monotonic() - started)))
    finally:
        monitor.db.close()


if __name__ == "__main__":
    main()
