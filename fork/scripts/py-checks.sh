#!/usr/bin/env bash
# Runs the backend gates in the thin test image (fork/Dockerfile.test) at the
# same time: mypy, the API spec drift check and the unit tests. They share
# nothing, so the wall time is the slowest one instead of the sum. Each log is
# printed in full once all three finish; the exit code is non-zero if any fail.
#
#   fork/scripts/py-checks.sh [unittest args]    # image: $FORK_TEST_IMAGE
#
# With COVERAGE_XML=<path> (CI), unittest runs under coverage and the XML
# report is copied out to that path.
set -uo pipefail

image="${FORK_TEST_IMAGE:-frigate-fork-test}"
logs="$(mktemp -d)"
trap 'rm -rf "$logs"' EXIT

start() {
  local name="$1"
  shift
  ("$@" >"$logs/$name.log" 2>&1; echo $? >"$logs/$name.rc") &
  return 0
}

# unittest under coverage in a named container, so the report can be copied out.
unittest_with_coverage() {
  local container="fork-py-cov-$$" rc
  docker run --name "$container" --entrypoint python3 "$image" -c "
import subprocess, sys
r = subprocess.call([sys.executable, '-m', 'coverage', 'run', '-m', 'unittest'])
script_result = subprocess.call([sys.executable, '-m', 'coverage', 'run', '--append', '-m', 'unittest', 'discover', '-s', 'fork/scripts', '-p', 'test_sonar_coverage.py'])
r = r or script_result
subprocess.call([sys.executable, '-m', 'coverage', 'report'])
subprocess.check_call([sys.executable, '-m', 'coverage', 'xml', '-o', '/tmp/coverage.xml'])
sys.exit(r)
"
  rc=$?
  mkdir -p "$(dirname "$COVERAGE_XML")"
  docker cp "$container:/tmp/coverage.xml" "$COVERAGE_XML" || rc=1
  docker rm "$container" >/dev/null
  return "$rc"
}

start mypy docker run --rm --entrypoint python3 "$image" -u -m mypy --config-file frigate/mypy.ini frigate
start api-spec docker run --rm --entrypoint python3 "$image" generate_api_auth_spec.py --check
if [[ -n "${COVERAGE_XML:-}" ]]; then
  (unittest_with_coverage >"$logs/unittest.log" 2>&1; echo $? >"$logs/unittest.rc") &
else
  start unittest docker run --rm "$image" "$@"
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
