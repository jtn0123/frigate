#!/usr/bin/env bash
# Runs the "Fork - Checks" gates locally and prints one line per gate with its
# time; failing logs are printed at the end.
#
#   fork/scripts/check.sh           # every gate CI runs (make check)
#   fork/scripts/check.sh --fast    # changed-only, for the inner loop (make check-fast)
#   fork/scripts/check.sh --gates lint,python,e2e   # exactly these gates
#
# --gates is what the local CI runner (fork/scripts/local_ci.py, I163) uses to
# run the jobs CI would pick for a change. Besides the gates above it can run
# the CI-only jobs: locks (the audio lock and the advisory audit), runtime (the
# non-root NVR startup) and audio (the audio companion image). With
# FORK_DOCKER_LOCK set to a lock directory, every Docker gate holds that lock
# while it runs, so it never builds beside another worktree's images.
#
# --fast compares against the merge base with $FORK_BASE (default origin/next),
# including uncommitted and untracked files: vitest runs only tests affected by
# the change, e2e runs only changed specs, and the Python gates run only when
# Python changed. lint and typecheck always cover the whole tree (their caches
# keep that fast). Run the full check before opening a PR.
#
# Two lanes: the host gates run one after another, the Docker gates beside
# them. Running the Node gates side by side saved ~4s on an idle machine and
# cost 10x under memory pressure (several agents, swap in use), so they queue.
# e2e is the exception to "beside": the whole Playwright suite at 4 workers,
# next to a containerized backend suite in a 4-CPU 6 GiB VM, starved the page
# renders, and the 5 s expect timeout then reported "element(s) not found" in
# whichever spec happened to be running. That is what made two e2e tests look
# flaky (D49). It therefore waits for the build and for the Docker lane and
# has the machine to itself, which costs about the length of one e2e run.
#
# Not mirrored: CI's `vite build --base=/BASE_PATH/`. It is the same bundle as
# the e2e build with a different base path. Nor CI's audio companion job, which
# builds fork/audio_trial's own image; the companion's and fork/monitoring's
# unit tests run in the test image here, as in CI.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1
mode=full
host_gates=" lint typecheck ratchet vitest i18n ruff mypy_fork gitleaks scripts locks build "
docker_gates=" python runtime audio "
wanted=()
case "${1:-}" in
  --fast) mode=fast ;;
  --gates)
    mode=gates
    IFS=, read -r -a wanted <<<"${2:-}"
    ((${#wanted[@]})) || {
      echo "usage: fork/scripts/check.sh --gates <gate>[,<gate>...]" >&2
      exit 2
    }
    for gate in "${wanted[@]}"; do
      if [[ "$host_gates$docker_gates e2e " != *" $gate "* ]]; then
        echo "unknown gate: $gate (gates:$host_gates${docker_gates}e2e)" >&2
        exit 2
      fi
    done
    ;;
esac

base_ref="${FORK_BASE:-origin/next}"
base="$(git merge-base HEAD "$base_ref")" || {
  echo "no merge base with $base_ref (set FORK_BASE)" >&2
  exit 1
}
# A stale checkout is graded against old code without anything saying so. No
# fetch here: the remote-tracking ref is used as it is, and a missing one (or a
# FORK_BASE that is not origin/next) only skips the warning. The ref itself
# goes stale in a clone nobody fetches, which would count 0 behind, so ask the
# remote where next is (read-only, gives up after 5 slow seconds, and offline
# only skips this warning too).
tracked="$(git rev-parse -q --verify refs/remotes/origin/next 2>/dev/null)" || tracked=""
if [[ -n "$tracked" ]]; then
  remote="$(GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=5 \
    ls-remote origin refs/heads/next 2>/dev/null | cut -f1)" || remote=""
  if [[ -n "$remote" && "$remote" != "$tracked" ]]; then
    echo "warning: origin/next has moved since the last fetch; run 'git fetch origin' before trusting this run" >&2
  fi
fi
stale_limit=20
behind="$(git rev-list --count HEAD..refs/remotes/origin/next 2>/dev/null)" || behind=0
if ((behind > stale_limit)); then
  echo "warning: HEAD is $behind commits behind origin/next (as of the last fetch); merge or rebase before trusting this run" >&2
fi
port_args=(--worktree "$PWD")
if [[ -n "${E2E_PORT:-}" ]]; then port_args+=(--requested "$E2E_PORT"); fi
E2E_PORT="$(python3 fork/scripts/e2e-port.py "${port_args[@]}")" || exit 1
export E2E_PORT
logs="$(mktemp -d "${TMPDIR:-/tmp}/fork-check.XXXXXX")"
changed="$({
  git diff --name-only --no-renames "$base"
  git ls-files --others --exclude-standard
} | sort -u)"
touches() {
  local pattern="$1"
  grep -Eq "$pattern" <<<"$changed"
  return $?
}

# CI pins ruff in requirements-dev.txt; a different local version can format
# differently, so run the pinned one through uvx when it is available.
ruff_version="$(sed -n 's/^ruff *== *//p' docker/main/requirements-dev.txt)"
if command -v uvx >/dev/null; then ruff=(uvx -q "ruff@${ruff_version}"); else ruff=(ruff); fi

py_files='^(frigate|migrations|docker|fork/(scripts|audio_trial|monitoring|benchmarks))/.*\.py$|^[^/]+\.py$'
# The same paths CI lints and tests (I17): one list, in fork/scripts/targets.sh.
read -r -a py_lint_targets < <(fork/scripts/targets.sh py-lint)
py_gates='^fork/scripts/[^/]+\.py$|^(frigate|migrations|docker|fork/(audio_trial|monitoring|benchmarks))/|^[^/]+\.py$|^(Makefile|pyproject\.toml)$|^fork/(Dockerfile\.test|runtime-base\.env|requirements-dev\.lock|requirements-runtime-[a-z0-9]+\.lock|scripts/(targets|py-checks)\.sh|scripts/dev-lock-check\.py)$|^docs/static/frigate-api\.yaml$'
# The scripts tests (gate_scripts) cover the shell gates (test_ci_changes.py)
# and the ledger rows (test_ledger.py) as well as the Python scripts.
scripts_gates='^fork/(scripts|ledger)/'
e2e_args=()

# ---- gates: gate_<name> runs one check; its output goes to the gate's log ----
# Node tools run from web/node_modules/.bin rather than through npx, which
# could fetch a missing package from the registry.

gate_lint() { (cd web && npm run -s lint); return $?; }
gate_typecheck() { (cd web && npm run -s typecheck); return $?; }
# The baseline must not rise above the merge base's (an empty
# TYPE_RATCHET_BASE skips that comparison).
gate_ratchet() { (cd web && TYPE_RATCHET_BASE="${TYPE_RATCHET_BASE-$base}" npm run -s type-ratchet); return $?; }
gate_i18n() { (cd web && npm run -s i18n:extract:ci); return $?; }
gate_gitleaks() { gitleaks git --no-banner --redact --log-opts="origin/dev..HEAD" .; return $?; }

gate_vitest() {
  if [[ "$mode" == fast ]]; then
    (cd web && node_modules/.bin/vitest run --changed "$base" --passWithNoTests)
  else
    (cd web && node_modules/.bin/vitest run)
  fi
  return $?
}

gate_ruff() {
  if [[ "$mode" == fast ]]; then
    local files=() f
    while IFS= read -r f; do
      [[ -f "$f" ]] && files+=("$f")
    done < <(grep -E "$py_files" <<<"$changed")
    ((${#files[@]})) || return 0
    "${ruff[@]}" format --check "${files[@]}" && "${ruff[@]}" check "${files[@]}"
  else
    "${ruff[@]}" format --check "${py_lint_targets[@]}" && "${ruff[@]}" check "${py_lint_targets[@]}"
  fi
}

# The fork's own Python (monitoring, audio trial, scripts) under fork/mypy.ini.
# frigate/ is checked in the Docker lane, inside the test image.
gate_mypy_fork() {
  python3 -m mypy --config-file fork/mypy.ini fork/monitoring fork/audio_trial fork/scripts
  return $?
}

# Unit tests for the fork's own scripts (release notes); plain python3, no image.
gate_scripts() {
  python3 -m unittest discover -s fork/scripts -p 'test_*.py'
  return $?
}

# The e2e bundle, checked against CI's eager-bundle budget (fork/bundle-budget.json).
gate_build() { (cd web && node_modules/.bin/vite build --base=/ && npm run -s bundle:budget); return $?; }

gate_e2e() {
  (cd web && node_modules/.bin/playwright test -c e2e/playwright.config.ts "${e2e_args[@]+"${e2e_args[@]}"}")
  return $?
}

# Same per-worktree tag as the Makefile, so parallel worktrees never test each
# other's sources.
test_image() { echo "frigate-fork-test-$(basename "$PWD")"; }

# docker_gate <command...>: runs a Docker gate, holding $FORK_DOCKER_LOCK (a
# directory, created to take it) when one is set. The subshell's trap gives the
# lock back however the command ends.
docker_gate() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running; start it with 'colima start' and re-run."
    return 1
  fi
  local lock="${FORK_DOCKER_LOCK:-}"
  if [[ -z "$lock" ]]; then
    "$@"
    return $?
  fi
  until mkdir "$lock" 2>/dev/null; do sleep 15; done
  (
    trap 'rmdir "$lock"' EXIT
    "$@"
  )
}

python_in_docker() {
  local image
  image="$(test_image)"
  make -s fork-test-image FORK_TEST_IMAGE="$image" && FORK_TEST_IMAGE="$image" fork/scripts/py-checks.sh
}
gate_python() { docker_gate python_in_docker; }

# CI's "Python - non-root NVR runtime" job: nginx built from source, the NVR
# started as a non-root user, then the audio companion's unit tests.
runtime_in_docker() {
  local image tag
  image="$(test_image)"
  tag="$(basename "$PWD")"
  make -s fork-test-image FORK_TEST_IMAGE="$image" &&
    docker build -q --target nginx -f docker/main/Dockerfile -t "frigate-nginx-check-$tag" . &&
    docker build -q -f fork/Dockerfile.rootless-test --build-arg BASE="$image" \
      --build-arg NGINX_IMAGE="frigate-nginx-check-$tag" -t "frigate-rootless-check-$tag" . &&
    python3 fork/scripts/test_rootless_runtime.py "frigate-rootless-check-$tag" &&
    docker run --rm -v "$PWD/fork/audio_trial:/opt/frigate/fork/audio_trial:ro" "$image" \
      discover -s fork/audio_trial -v
}
gate_runtime() { docker_gate runtime_in_docker; }

# CI's "Audio companion" job: the companion's own amd64 image (emulated on an
# arm64 host, which needs Colima's amd64 binfmt), its recovery, regression and
# read-only offline startup checks.
audio_in_docker() {
  local tag base
  tag="frigate-audio-check-$(basename "$PWD")"
  # On Apple silicon the amd64 image runs under emulation, which Colima drops
  # when it restarts. Say so, rather than fail in the build's first RUN.
  base="$(awk '/^FROM /{print $2; exit}' fork/audio_trial/Dockerfile)"
  if ! docker run --rm --platform linux/amd64 --network none "$base" true; then
    echo "amd64 emulation is missing. Register it, then run the gate again:" >&2
    echo "  docker run --privileged --rm tonistiigi/binfmt --install amd64" >&2
    return 1
  fi
  docker build -q --platform linux/amd64 -t "$tag" fork/audio_trial &&
    python3 fork/scripts/audio-recovery-check.py "$tag" &&
    docker run --rm --network none --read-only --tmpfs /tmp \
      -v "$PWD/fork/audio_trial/benchmarks:/benchmarks:ro" \
      "$tag" python -m unittest discover -s /benchmarks -p 'test_*.py' &&
    docker run --rm --network none "$tag" pip check &&
    docker run --rm --network none --read-only --tmpfs /tmp "$tag" \
      python -m unittest discover -s /app -p 'test_*.py' -v &&
    perl -e 'alarm shift; exec @ARGV' 120 docker run --rm --network none --read-only \
      --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
      --tmpfs /state:uid=1000,gid=1000 --tmpfs /telemetry:uid=1000,gid=1000 \
      --tmpfs /host-cgroup:uid=1000,gid=1000 "$tag" python startup_check.py
}
gate_audio() { docker_gate audio_in_docker; }

# The lock checks from CI's "Python - Lint" job: the audio companion's lock
# matches its requirements, and the fork's locks have no unreviewed advisories
# (needs pip-audit, from fork/requirements-audit.txt).
gate_locks() { python3 fork/scripts/audio-lock-check.py && python3 fork/scripts/lock-audit.py; }

# ---- lanes ----

names=()
notes=()

# lane [--after <gate>[,<gate>...]] <name...>: run the named gates one after
# another in the background, held until the gates it is given have finished.
# The hold sits outside the timing, so a gate's reported seconds stay its own.
lane() {
  local hold=()
  local flag="${1:-}"
  if [[ "$flag" == "--after" ]]; then
    local after="$2"
    IFS=, read -r -a hold <<<"$after"
    shift 2
  fi
  names+=("$@")
  (
    for dep in ${hold[@]+"${hold[@]}"}; do
      while [[ ! -f "$logs/$dep.rc" ]]; do sleep 0.5; done
    done
    for name in "$@"; do
      start=$SECONDS
      "gate_$name" >"$logs/$name.log" 2>&1
      rc=$?
      echo $((SECONDS - start)) >"$logs/$name.time"
      echo "$rc" >"$logs/$name.rc"
    done
  ) &
  return 0
}

# skip <name> <reason>: a gate --fast leaves out, reported so it is never silent.
skip() {
  local name="$1" reason="$2"
  notes+=("  -  $(printf '%-10s' "$name") not run: $reason")
  return 0
}

host=(lint typecheck ratchet vitest i18n ruff mypy_fork gitleaks)
docker_lane=()
e2e_lane=()
if [[ "$mode" == fast ]]; then
  if touches "$scripts_gates"; then
    host+=(scripts)
  else
    skip scripts "no fork/scripts or fork/ledger changes"
  fi
  if touches '^web/e2e/'; then
    e2e_args=(--only-changed="$base")
    host+=(build)
    e2e_lane=(e2e)
  else
    skip build "no e2e changes (make check builds and checks the budget)"
    skip e2e "no e2e changes (make check runs the full suite)"
  fi
  if touches "$py_gates"; then
    docker_lane=(python)
  else
    skip python "no backend changes"
  fi
elif [[ "$mode" == gates ]]; then
  host=()
  for gate in "${wanted[@]}"; do
    if [[ "$host_gates" == *" $gate "* ]]; then host+=("$gate"); fi
    if [[ "$docker_gates" == *" $gate "* ]]; then docker_lane+=("$gate"); fi
    if [[ "$gate" == e2e ]]; then e2e_lane=(e2e); fi
  done
  # e2e serves the bundle build writes.
  if ((${#e2e_lane[@]})) && [[ " ${host[*]-} " != *" build "* ]]; then host+=(build); fi
  # vitest goes first, and the Docker lane waits for it (below): its tests
  # time out at 5 s, which image builds on the same disk can push them past.
  if [[ " ${host[*]-} " == *" vitest "* ]]; then
    rest=()
    for gate in "${host[@]}"; do [[ "$gate" == vitest ]] || rest+=("$gate"); done
    host=(vitest ${rest[@]+"${rest[@]}"})
  fi
else
  host+=(scripts build)
  e2e_lane=(e2e)
  docker_lane=(python)
fi

echo "fork check ($mode): base $base_ref @ $(git rev-parse --short "$base"), E2E_PORT $E2E_PORT"
if ((${#host[@]})); then lane "${host[@]}"; fi
if ((${#docker_lane[@]})); then
  if [[ "$mode" == gates && " ${host[*]-} " == *" vitest "* ]]; then
    lane --after vitest "${docker_lane[@]}"
  else
    lane "${docker_lane[@]}"
  fi
fi
if ((${#e2e_lane[@]})); then
  # e2e needs the bundle build has just written, and needs the machine to
  # itself; the wait is announced so a quiet terminal is not a hung one.
  hold=(build)
  if ((${#docker_lane[@]})); then hold+=("${docker_lane[${#docker_lane[@]} - 1]}"); fi
  lane --after "$(
    IFS=,
    echo "${hold[*]}"
  )" "${e2e_lane[@]}"
  echo "  -  $(printf '%-10s' e2e) runs last, alone, after ${hold[*]}"
fi

reported=()
failed=()
while ((${#reported[@]} < ${#names[@]})); do
  for name in "${names[@]}"; do
    [[ -f "$logs/$name.rc" ]] || continue
    [[ " ${reported[*]-} " == *" $name "* ]] && continue
    reported+=("$name")
    rc="$(cat "$logs/$name.rc")"
    secs="$(cat "$logs/$name.time")"
    if [[ "$rc" == 0 ]]; then
      printf '  ✓  %-10s %4ss\n' "$name" "$secs"
    else
      printf '  ✗  %-10s %4ss   %s\n' "$name" "$secs" "$logs/$name.log"
      failed+=("$name")
    fi
  done
  sleep 0.5
done
for note in "${notes[@]+"${notes[@]}"}"; do echo "$note"; done

if ((${#failed[@]})); then
  for name in "${failed[@]}"; do
    echo
    echo "== $name (last 40 lines of $logs/$name.log)"
    tail -40 "$logs/$name.log"
  done
  exit 1
fi
rm -rf "$logs"
