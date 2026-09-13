"""Exercise real runtime imports and worker startup using a local synthetic API."""

import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    """Verify offline imports, writable state, telemetry, polling, and clean stop."""
    import infer  # noqa: F401
    from transformers import ClapModel, ClapProcessor  # noqa: F401

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/review"):
                value = []
            elif self.path == "/config":
                value = {
                    "cameras": {"doorbell": {"audio_transcription": {"enabled": False}}}
                }
            else:
                value = {
                    "service": {"last_updated": time.time()},
                    "cameras": {"doorbell": {"skipped_fps": 0}},
                    "detectors": {"onnx": {"inference_speed": 10}},
                }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(value).encode())

        def log_message(self, *_):
            # The synthetic API emits no request logs during this smoke check.
            pass

    cgroup = Path("/host-cgroup")
    for name, value in {
        "memory.max": "21474836480",
        "memory.current": "1073741824",
        "memory.stat": "inactive_file 0\n",
    }.items():
        (cgroup / name).write_text(value)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = {
        **os.environ,
        "FRIGATE_API": f"http://127.0.0.1:{server.server_port}",
        "PARENT_MEMORY_LIMIT_BYTES": "21474836480",
    }
    process = subprocess.Popen([sys.executable, "worker.py"], env=env)
    try:
        deadline = time.monotonic() + 30
        status = Path("/state/status.json")
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("Worker exited before becoming ready")
            if status.exists():
                data = json.loads(status.read_text())
                assert data["status"] == "listening", data["status"]
                assert Path("/telemetry/models.json").is_file()
                assert Path("/state/queue.sqlite").is_file()
                print("Offline runtime startup, polling, and publication passed")
                break
            time.sleep(0.1)
        else:
            raise TimeoutError("Worker startup timed out")
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        server.shutdown()
        thread.join(timeout=2)
    assert process.returncode == 0, process.returncode


if __name__ == "__main__":
    main()
