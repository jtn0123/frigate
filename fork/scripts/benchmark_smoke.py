"""Check benchmark image contents and runtime permissions on disposable CI."""

import os

if (
    os.environ.get("GITHUB_ACTIONS") != "true"
    or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted"
):
    raise RuntimeError("Requires a disposable GitHub-hosted runner")
import json
import pathlib
import subprocess
import sys

# The case names the images to pull and run, so the docker command line is built
# from the matching constant, never from the command line text itself.
case = next(
    (known for known in ("shared-zstd", "dependency-images") if known == sys.argv[2]),
    None,
)
if case is None:
    sys.exit(f"unknown benchmark case: {sys.argv[2]}")
root = pathlib.Path(sys.argv[1])
base = ["docker", "--context", "frigate-github-bench"]
images = []
for arch in ["amd64", "rocm"]:
    image = f"localhost:5007/{case}:app-change-{arch}"
    subprocess.run(base + ["pull", "--platform", "linux/amd64", image], check=True)
    meta = json.loads(subprocess.check_output(base + ["image", "inspect", image]))[0]
    images.append(image)
    (root / f"{arch}-config.json").write_text(
        json.dumps(
            {k: meta[k] for k in ["Architecture", "Os", "Config", "Size"]}, indent=2
        )
    )
    checks = r"""
set -eu
python3 - <<'CHECK'
import hashlib,json,pathlib,subprocess
from frigate.version import VERSION
import frigate.config
import cv2
import onnxruntime
paths=[pathlib.Path('/opt/frigate/frigate'),pathlib.Path('/opt/frigate/migrations'),pathlib.Path('/opt/frigate/web')]
hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for root in paths for p in sorted(root.rglob('*')) if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc'}
print(json.dumps({'runtime_paths':{name:({'mode':p.lstat().st_mode,'uid':p.lstat().st_uid,'gid':p.lstat().st_gid} if p.exists() else None) for name in ['/run','/config','/media/frigate','/home/frigate','/etc/letsencrypt','/usr/local/nginx/conf','/usr/local/nginx/logs'] for p in [pathlib.Path(name)]},'setuid_files':sorted(str(p) for p in pathlib.Path('/package').rglob('*') if p.is_file() and p.stat().st_mode & 0o6000),'nginx_config_hash':hashlib.sha256(pathlib.Path('/usr/local/nginx/conf/nginx.conf').read_bytes()).hexdigest(),'version':VERSION,'opencv':cv2.__version__,'onnxruntime':onnxruntime.__version__,'providers':onnxruntime.get_available_providers(),'packages':json.loads(subprocess.check_output(['python3','-m','pip','list','--format=json'])),'app_hashes':hashes,'directories':{str(p):{'mode':p.lstat().st_mode,'uid':p.lstat().st_uid,'gid':p.lstat().st_gid} for p in [pathlib.Path('/opt'),pathlib.Path('/opt/frigate'),*paths]},'binary_hashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [pathlib.Path('/usr/local/go2rtc/bin/go2rtc'),pathlib.Path('/usr/local/nginx/sbin/nginx'),pathlib.Path('/usr/lib/ffmpeg/8.0/bin/ffmpeg')]} },sort_keys=True))
CHECK
/usr/local/nginx/sbin/nginx -v
/usr/local/go2rtc/bin/go2rtc -version
/usr/lib/ffmpeg/8.0/bin/ffmpeg -version
test -s /opt/frigate/web/index.html
"""
    if arch == "amd64":
        checks += '\ntest "$(id -u)" = 65534\nfor directory in /run /config /media/frigate /home/frigate /etc/letsencrypt /usr/local/nginx/conf /usr/local/nginx/logs; do test -w "$directory"; done\ntest -r /opt/frigate/web/index.html\n'
    with (root / f"{arch}-smoke.log").open("w") as f:
        subprocess.run(
            base
            + [
                "run",
                "--rm",
                "--platform",
                "linux/amd64",
                "--entrypoint",
                "/bin/sh",
                image,
                "-c",
                checks,
            ],
            stdout=f,
            stderr=subprocess.STDOUT,
            check=True,
            timeout=300,
        )
(root / "smoke-passed.json").write_text(json.dumps(images))

for image in images:
    subprocess.run(base + ["image", "rm", image], check=True)
