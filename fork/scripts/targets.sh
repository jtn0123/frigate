#!/usr/bin/env bash
# The one list of paths the fork's Python gates cover. CI (fork-checks.yml),
# the Makefile and fork/scripts/{check,py-checks}.sh all read it from here, so
# a directory added to the fork cannot be linted in one place and skipped in
# another (that drift is what I17 and D25 in fork/GRADE-REPORT.md fixed).
#
#   fork/scripts/targets.sh py-lint       # ruff format/check arguments
#   fork/scripts/targets.sh py-test-dirs     # unittest discovery roots outside frigate/
#   fork/scripts/targets.sh py-script-tests  # fork/scripts tests the image can run
#
# Paths are printed space separated, relative to the repository root.
set -euo pipefail

# The globs below are relative to the repository root, so resolve them there
# no matter where a caller runs this from.
cd "$(git rev-parse --show-toplevel)" || exit 1

# Everything ruff formats and lints. `./*.py` is the repository's root scripts
# (generate_api_auth_spec.py and friends).
py_lint=(frigate migrations docker fork/scripts fork/audio_trial fork/monitoring ./*.py)

# Test roots that `python3 -m unittest` does not reach on its own. The main
# frigate/ suite is discovered by unittest itself, so it is not listed.
py_test_dirs=(fork/audio_trial fork/audio_trial/benchmarks fork/monitoring)

# fork/scripts tests the coverage run can execute inside the thin test image.
# test_download_security.py is not here: it reads docker/ build scripts, which
# the image does not carry. It still runs in the Python - Lint job, which has
# the whole checkout.
py_script_tests=(
  test_sonar_coverage.py
  test_release_notes.py
  test_lock_audit.py
  test_audio_lock.py
  test_benchmark_guards.py
  test_sonar_token_expiry.py
)

main() {
  local what="${1:-}"
  case "$what" in
    py-lint) echo "${py_lint[*]}" ;;
    py-test-dirs) echo "${py_test_dirs[*]}" ;;
    py-script-tests) echo "${py_script_tests[*]}" ;;
    *)
      echo "usage: ${0##*/} {py-lint|py-test-dirs|py-script-tests}" >&2
      return 2
      ;;
  esac
  return 0
}

main "$@"
