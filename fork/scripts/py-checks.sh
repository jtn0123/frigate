#!/usr/bin/env bash
# Runs the backend gates in the thin test image (fork/Dockerfile.test) at the
# same time: mypy, the API spec drift check and the unit tests. They share
# nothing, so the wall time is the slowest one instead of the sum. Each log is
# printed in full once all three finish; the exit code is non-zero if any fail.
#
#   fork/scripts/py-checks.sh [unittest args]    # image: $FORK_TEST_IMAGE
#
# With COVERAGE_XML=<path> (CI), unittest runs under coverage and the XML
# report is copied out to that path. The frigate suite is then split across
# PY_TEST_SHARDS containers (default: the Docker host's CPU count), one process
# each, by fork/scripts/unittest_shard.py: one process spent about 11 of the
# backend job's 16 minutes mostly waiting (I69). The coverage files are only
# combined once the shards' manifests prove every test module ran exactly once.
#
# Either way the fork's own test roots (fork/scripts/targets.sh py-test-dirs)
# run alongside the frigate suite, so `make check` covers what CI covers (D25).
# Passing unittest args runs only the targeted frigate tests.
set -uo pipefail

image="${FORK_TEST_IMAGE:-frigate-fork-test}"
# Discovery roots outside frigate/, shared with CI and the Makefile.
fork_test_dirs="$(fork/scripts/targets.sh py-test-dirs)"
# fork/scripts tests that run inside the image, so their coverage reaches Sonar.
fork_script_tests="$(fork/scripts/targets.sh py-script-tests)"
logs="$(mktemp -d)"
trap 'rm -rf "$logs"' EXIT

start() {
  local name="$1"
  shift
  ("$@" >"$logs/$name.log" 2>&1; echo $? >"$logs/$name.rc") &
  return 0
}

# The frigate suite plus the fork's own roots, in one container. Unittest args
# (make test-py TESTS=...) target the frigate suite only.
# Invoked through start(), which executes the function passed as an argument.
# shellcheck disable=SC2329
unittest_plain() {
  if (($#)); then
    docker run --rm "$image" "$@"
    return $?
  fi
  docker run --rm --entrypoint python3 "$image" -c "
import subprocess, sys
r = subprocess.call([sys.executable, '-m', 'unittest'])
for directory in '${fork_test_dirs}'.split():
    result = subprocess.call([sys.executable, '-m', 'unittest', 'discover', '-s', directory])
    r = r or result
sys.exit(r)
"
  return $?
}

# unittest under coverage, the frigate suite split into shards with one
# container each (their tests write fixed paths such as /tmp/exp1.jpg, so they
# do not share a filesystem), plus one container for the fork's own roots. The
# data files and shard manifests are copied out, checked and combined in a
# fresh container, and the XML report is copied out of that one.
unittest_with_coverage() {
  local count="$1" rc=0 i name
  local data="$logs/coverage-data" combine="fork-py-cov-$$-combine"
  local names=() pids=()
  mkdir -p "$data"
  for ((i = 0; i < count; i++)); do
    name="fork-py-cov-$$-$i"
    names+=("$name")
    docker run --name "$name" -e COVERAGE_FILE=/tmp/cov/.coverage --entrypoint sh "$image" -c "
mkdir -p /tmp/cov && exec python3 -m coverage run --parallel-mode fork/scripts/unittest_shard.py \
  run --index $i --count $count --manifest /tmp/cov/manifest-$i.json" >"$logs/shard-$i.log" 2>&1 &
    pids+=("$!")
  done
  name="fork-py-cov-$$-fork"
  names+=("$name")
  docker run --name "$name" -e COVERAGE_FILE=/tmp/cov/.coverage --entrypoint python3 "$image" -c "
import os, subprocess, sys
os.makedirs('/tmp/cov', exist_ok=True)
run = [sys.executable, '-m', 'coverage', 'run', '--parallel-mode', '-m', 'unittest', 'discover']
r = 0
for pattern in '${fork_script_tests}'.split():
    r = subprocess.call([*run, '-s', 'fork/scripts', '-p', pattern]) or r
for directory in '${fork_test_dirs}'.split():
    r = subprocess.call([*run, '-s', directory]) or r
sys.exit(r)
" >"$logs/shard-fork.log" 2>&1 &
  pids+=("$!")
  for i in "${!pids[@]}"; do
    wait "${pids[i]}" || rc=1
  done
  for i in "${!names[@]}"; do
    echo "--- ${names[i]}"
    cat "$logs/shard-${names[i]##*-}.log"
    docker cp "${names[i]}:/tmp/cov/." "$data/" || rc=1
    docker rm "${names[i]}" >/dev/null
  done
  # The report's exit code is not checked, as before: the floors are held by
  # fork/scripts/sonar-coverage-check.py in the Sonar job.
  docker create --name "$combine" -e COVERAGE_FILE=/tmp/combined/.coverage --entrypoint sh "$image" -c "
python3 fork/scripts/unittest_shard.py check /tmp/in/manifest-*.json || exit 1
mkdir -p /tmp/combined
python3 -m coverage combine --keep /tmp/in || exit 1
python3 -m coverage report
python3 -m coverage xml -o /tmp/combined/coverage.xml" >/dev/null
  docker cp "$data/." "$combine:/tmp/in" || rc=1
  docker start -a "$combine" || rc=1
  mkdir -p "$(dirname "$COVERAGE_XML")"
  docker cp "$combine:/tmp/combined/coverage.xml" "$COVERAGE_XML" || rc=1
  docker rm "$combine" >/dev/null
  return "$rc"
}

start mypy docker run --rm --entrypoint python3 "$image" -u -m mypy --config-file frigate/mypy.ini frigate
start api-spec docker run --rm --entrypoint python3 "$image" generate_api_auth_spec.py --check
if [[ -n "${COVERAGE_XML:-}" ]]; then
  shards="${PY_TEST_SHARDS:-$(docker info --format '{{.NCPU}}' 2>/dev/null)}"
  [[ "$shards" =~ ^[1-9][0-9]*$ ]] || shards=1
  (unittest_with_coverage "$shards" >"$logs/unittest.log" 2>&1; echo $? >"$logs/unittest.rc") &
else
  start unittest unittest_plain "$@"
fi
wait

failed=0
for name in mypy api-spec unittest; do
  rc="$(cat "$logs/$name.rc")"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::group::$name (exit $rc)"; else echo "== $name (exit $rc)"; fi
  cat "$logs/$name.log"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::endgroup::"; fi
  if [[ "$rc" != 0 ]]; then
    failed=1
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::error title=$name::$name failed (exit $rc)" >&2; fi
  fi
done
exit "$failed"
