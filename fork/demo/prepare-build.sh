#!/usr/bin/env bash
# Assemble fork/demo/.build so the overlay image can COPY sources. The repo
# root .dockerignore excludes web/dist and *.mp4, so the compose context is
# this staging directory instead of the repo root.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
demo="${root}/fork/demo"
build="${demo}/.build"

if [[ ! -f "${demo}/.env" ]]; then
  cp "${demo}/.env.example" "${demo}/.env"
  echo "wrote ${demo}/.env (gitignored). First boot prints the admin password in make demo-logs; paste it into FRIGATE_DEMO_PASSWORD."
fi

"${demo}/fetch-samples.sh"

if [[ ! -f "${root}/web/dist/index.html" ]]; then
  (cd "${root}/web" && npm run e2e:build)
fi

rm -rf "${build}"
mkdir -p "${build}"
cp -R "${root}/frigate" "${build}/frigate"
cp -R "${root}/migrations" "${build}/migrations"
cp -R "${root}/web/dist" "${build}/web"
cp -R "${demo}/.data/samples" "${build}/samples"
cp "${demo}/config/config.yml" "${build}/config.yml"
cp "${demo}/entrypoint.sh" "${build}/entrypoint.sh"
echo "staged ${build}"
