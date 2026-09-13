"""Verify a non-root Frigate runtime with an isolated synthetic camera."""

import argparse
import json
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

CONFIG = """mqtt:
  enabled: false
auth:
  enabled: false
detectors:
  cpu:
    type: cpu
cameras:
  synthetic:
    ffmpeg:
      hwaccel_args: []
      inputs:
        - path: /tmp/synthetic.mp4
          input_args: -re -stream_loop -1
          roles: [detect, record]
      output_args:
        record: preset-record-generic
    detect:
      enabled: true
      width: 640
      height: 360
      fps: 2
    record:
      enabled: true
      continuous:
        days: 1
version: "0.18-0"
"""
FFMPEG = "/usr/lib/ffmpeg/8.0/bin/ffmpeg"


def run(image: str) -> None:
    """Check startup, recording, playback, private files, and clean shutdown."""
    name = "frigate-rootless-check-" + uuid.uuid4().hex[:12]

    def docker(*args: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["docker", *args], capture_output=True, check=check, timeout=180
        )

    def execute(*args: str, check: bool = True) -> subprocess.CompletedProcess:
        return docker("exec", name, *args, check=check)

    try:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.yml"
            config.write_text(CONFIG)
            video = root / "synthetic.mp4"
            video.write_bytes(
                docker(
                    "run",
                    "--rm",
                    "--network",
                    "none",
                    "--entrypoint",
                    FFMPEG,
                    image,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=640x360:rate=5",
                    "-t",
                    "10",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-g",
                    "5",
                    "-f",
                    "mp4",
                    "-movflags",
                    "frag_keyframe+empty_moov",
                    "pipe:1",
                ).stdout
            )
            docker(
                "create",
                "--name",
                name,
                "--network",
                "none",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--shm-size",
                "256m",
                image,
            )
            docker("cp", str(config), f"{name}:/config/config.yml")
            docker("cp", str(video), f"{name}:/tmp/synthetic.mp4")
            docker("start", name)
            print("Checking non-root startup and recording", flush=True)
            deadline = time.monotonic() + 150
            recordings = []
            while time.monotonic() < deadline:
                result = execute(
                    "python3",
                    "-c",
                    """
import json, sqlite3
connection = sqlite3.connect('file:/config/frigate.db?mode=ro', uri=True)
print(json.dumps(connection.execute(
    'select start_time, end_time from recordings where camera=? order by start_time limit 1',
    ('synthetic',)).fetchall()))
""",
                    check=False,
                )
                if result.returncode == 0:
                    recordings = json.loads(result.stdout)
                    if recordings:
                        break
                time.sleep(1)
            if not recordings:
                raise RuntimeError("Synthetic camera did not produce a recording")
            # Exercise the actual CPU backend deterministically. Motion-based
            # scheduling depends on scene thresholds, not runtime privileges.
            execute(
                "python3",
                "-c",
                """
import numpy as np
from frigate.detectors.plugins.cpu_tfl import CpuTfl, CpuDetectorConfig
from frigate.detectors.detector_config import ModelConfig
config = CpuDetectorConfig(type='cpu', model=ModelConfig(
    path='/cpu_model.tflite', width=320, height=320))
detector = CpuTfl(config)
result = detector.detect_raw(np.zeros((1, 320, 320, 3), dtype=np.uint8))
assert result.shape == (20, 6) and np.isfinite(result).all()
""",
            )
            print("CPU inference passed", flush=True)
            start, end = recordings[0]
            execute(
                "curl",
                "--fail",
                "--silent",
                "--max-time",
                "20",
                f"http://127.0.0.1:5000/api/synthetic/start/{start}/end/{end}/clip.mp4",
                "-o",
                "/tmp/playback.mp4",
            )
            execute(
                FFMPEG,
                "-v",
                "error",
                "-i",
                "/tmp/playback.mp4",
                "-frames:v",
                "1",
                "-f",
                "null",
                "-",
            )
            execute(
                "curl",
                "--fail",
                "--silent",
                "--max-time",
                "10",
                "http://127.0.0.1:5000/api/synthetic/latest.jpg",
                "-o",
                "/tmp/latest.jpg",
            )
            execute(
                "python3",
                "-c",
                """
import os, pathlib, stat
assert os.geteuid() == 65534
for status in pathlib.Path('/proc').glob('[0-9]*/status'):
    try:
        lines = status.read_text().splitlines()
    except FileNotFoundError:
        continue
    uid = next(line for line in lines if line.startswith('Uid:')).split()[1:]
    assert set(uid) == {'65534'}, uid
for path, mode in [('/tmp/cache', 0o700), ('/dev/shm/go2rtc.yaml', 0o600)]:
    info = os.stat(path)
    assert info.st_uid == 65534 and stat.S_IMODE(info.st_mode) == mode
assert pathlib.Path('/tmp/latest.jpg').stat().st_size > 1000
""",
            )
            print(
                "Recording, playback, preview, UID and private-file checks passed",
                flush=True,
            )
            docker("stop", "--time", "30", name)
            state = json.loads(
                docker("inspect", "--format", "{{json .State}}", name).stdout
            )
            # The existing certsync finish handler records SIGTERM as 143 even
            # when the NVR and media services finish normally. Verify both.
            logs = docker("logs", name).stdout.decode()
            required_exits = (
                "Service Frigate exited with code 0 (by signal 0)",
                "Service NGINX exited with code 0 (by signal 0)",
                "The go2rtc service exited with code 0 (by signal 0)",
            )
            if (
                state["ExitCode"] not in (0, 143)
                or state["OOMKilled"]
                or not all(message in logs for message in required_exits)
            ):
                raise RuntimeError("Non-root runtime did not shut down cleanly")
            print("Clean non-root shutdown passed", flush=True)
    finally:
        docker("rm", "--force", name, check=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    run(parser.parse_args().image)
