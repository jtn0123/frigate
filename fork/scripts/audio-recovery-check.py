"""Kill real companion containers at durable queue boundaries and verify recovery."""

import argparse
import subprocess
import time
import uuid


def run(image: str) -> None:
    """Use isolated Docker volumes and synthetic results, never production state."""
    prefix = "audio-recovery-" + uuid.uuid4().hex[:12]
    volume = prefix + "-state"
    names = []

    def docker(*args, check=True):
        return subprocess.run(["docker", *args], check=check)

    try:
        docker("volume", "create", volume)
        docker(
            "run",
            "--rm",
            "--network",
            "none",
            "--user",
            "0",
            "-v",
            f"{volume}:/state",
            image,
            "chown",
            "1000:1000",
            "/state",
        )
        for phase in ("transcription", "translation", "publication"):
            name = prefix + "-" + phase
            names.append(name)
            setup = f"""
import os, signal, time
from queue_store import Queue
q = Queue('/state/{phase}.sqlite')
now = time.time()
q.enqueue([{{'id': '{phase}', 'camera': 'doorbell', 'start_time': now-50,
'end_time': now-30, 'data': {{'audio': ['speech']}}}}], now, ['doorbell'])
job = q.claim(now)
assert job is not None
result = {{'transcript': 'synthetic recovery fixture', 'language': 'ar'}}
if '{phase}' == 'translation':
    q.checkpoint(job, now, result)
if '{phase}' == 'publication':
    import queue_store
    def unavailable(*args):
        raise OSError('synthetic unavailable output mount')
    queue_store.publish = unavailable
    q.finish(job, now, result)
print("READY", flush=True)
signal.pause()
"""
            docker(
                "run",
                "--detach",
                "--name",
                name,
                "--network",
                "none",
                "--read-only",
                "--tmpfs",
                "/tmp",
                "--cpus",
                "1",
                "--memory",
                "256m",
                "-e",
                "TELEMETRY_DIR=/state/telemetry",
                "-v",
                f"{volume}:/state",
                image,
                "python",
                "-c",
                setup,
            )
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                logs = subprocess.run(
                    ["docker", "logs", name],
                    capture_output=True,
                    text=True,
                    check=True,
                ).stdout
                if "READY" in logs:
                    break
                time.sleep(0.2)
            else:
                raise TimeoutError(f"{phase}: container did not reach checkpoint")
            docker("kill", "--signal", "KILL", name)
            code = subprocess.check_output(["docker", "wait", name], text=True).strip()
            if code != "137":
                raise RuntimeError(f"{phase}: expected SIGKILL, got {code}")
            verify = f"""
import json, time
from pathlib import Path
from queue_store import Queue
q = Queue('/state/{phase}.sqlite')
rows = q.recent()
assert len(rows) == 1, rows
row = rows[0]
if '{phase}' == 'transcription':
    assert row['state'] == 'pending', row
    assert q.claim(time.time()) is not None
elif '{phase}' == 'translation':
    assert row['state'] == 'second_opinion', row
    assert json.loads(row['result'])['transcript'] == 'synthetic recovery fixture'
else:
    assert row['state'] == 'done', row
    q.flush_publications()
    assert q.db.execute('SELECT COUNT(*) FROM publications').fetchone()[0] == 0
    files = list(Path('/state/telemetry/results').glob('*.json'))
    assert any(json.loads(p.read_text())['review_id'] == '{phase}' for p in files)
print('{phase}: recovered after container SIGKILL')
"""
            docker(
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--tmpfs",
                "/tmp",
                "-e",
                "TELEMETRY_DIR=/state/telemetry",
                "-v",
                f"{volume}:/state",
                image,
                "python",
                "-c",
                verify,
            )
    finally:
        for name in names:
            docker("rm", "-f", name, check=False)
        docker("volume", "rm", volume, check=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    run(parser.parse_args().image)
