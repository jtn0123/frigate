#!/usr/bin/env bash
# Download looping demo clips. Media is gitignored and never taken from the
# live server.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
dest="${root}/.data/samples"
base="https://github.com/intel-iot-devkit/sample-videos/raw/master"
mkdir -p "$dest"

files=(
  person-bicycle-car-detection.mp4
  head-pose-face-detection-female.mp4
  car-detection.mp4
)

for name in "${files[@]}"; do
  if [[ -s "${dest}/${name}" ]]; then
    echo "have  ${name}"
    continue
  fi
  echo "fetch ${name}"
  # HTTPS only, redirects included (GitHub redirects raw/ to its CDN).
  curl --proto '=https' -fsSL -o "${dest}/${name}.part" "${base}/${name}"
  mv "${dest}/${name}.part" "${dest}/${name}"
done
