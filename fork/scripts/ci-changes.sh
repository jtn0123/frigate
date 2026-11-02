#!/usr/bin/env bash
# Decides which "Fork - Checks" jobs a push or pull request needs, so docs-only
# commits (PLAN.md, the grade report) skip the web and Python suites. Writes to
# $GITHUB_OUTPUT (stdout when run by hand):
#
#   web=       the web lint and E2E jobs
#   python=    the light Python job: ruff, fork mypy and the fork/scripts tests
#   backend=   the jobs that build backend images beside the coverage suite:
#              the non-root NVR runtime check and the audio companion
#   coverage=  the two coverage suites (web unit tests; the test image's mypy,
#              API spec and unittest job) and the Sonar scan they feed. True
#              whenever web or backend is, since Sonar needs both reports.
#
# Anything it cannot diff runs everything.
#
#   fork/scripts/ci-changes.sh [base-sha]    # default base: origin/next
set -euo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
base="${1:-${BASE_SHA:-origin/next}}"

emit() {
  {
    echo "web=$1"
    echo "python=$2"
    echo "backend=$3"
    echo "coverage=$4"
  } >>"$out"
}

if [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]]; then
  echo "workflow_dispatch: running everything" >&2
  emit true true true true
  exit 0
fi
# A new branch reports an all-zero "before"; a force push may name a commit
# that is no longer in the history.
if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "no usable base (${base:-empty}): running everything" >&2
  emit true true true true
  exit 0
fi

files="$(git diff --name-only --no-renames "$base" HEAD)"
echo "changed since ${base}:" >&2
echo "  ${files//$'\n'/$'\n'  }" >&2

# The workflow and the shell scripts behind the gates affect every job: a pull
# request that breaks check.sh or the Sonar expiry file must not go green by
# skipping the suites (I37). The Python scripts only need the Python jobs.
shared='^(\.coveragerc$|sonar-project\.properties$|fork/requirements-(sonar|audit)\.txt$|fork/audit-exceptions\.json$|fork/coverage-floor\.json$|fork/sonar-token\.env$|\.github/workflows/fork-checks\.yml|\.github/actions/fork-web-setup/|fork/scripts/[^/]+\.sh$)'
# The web jobs read the ratchet and bundle budget baselines under fork/.
web_re="${shared}|^web/|^docs/static/frigate-api\.yaml$|^fork/(type-ratchet|bundle-budget)\.json$"
# Everything fork/Dockerfile.test and fork/Dockerfile.rootless-test build from,
# and every source .coveragerc measures. The fork/scripts tests run in the
# image under coverage too, so a script change needs this suite for Sonar.
backend_re="${shared}|^fork/(audio_trial|monitoring|benchmarks)/|^(frigate|migrations|docker|testing-scripts)/|^[^/]+\.py$|^(pyproject\.toml|Makefile|\.dockerignore)$|^fork/(Dockerfile\.(test|rootless-test)|runtime-base\.env|requirements-dev\.lock|requirements-runtime-[a-z0-9]+\.lock)$|^fork/scripts/[^/]+\.py$|^docs/static/frigate-api\.yaml$|^\.github/workflows/fork-(build|concurrency)-benchmark\.yml$"
# The light job also checks the ledger: test_ledger.py validates the row files
# against FORK.md's table, so a row or a FORK.md edit needs it, and only it (I69).
py_re="${backend_re}|^fork/ledger/|^FORK\.md$|^fork/mypy\.ini$"
# Sonar reads every file except its exclusions (fork/android/**, images) and
# has no Markdown analyzer, so a change made only of those gives the scan, and
# the coverage it needs, nothing to judge (I69).
sonar_blind='^fork/android/|\.md$|\.(png|jpg|webp|gif|ico|woff2)$'

has() {
  local pattern="$1"
  grep -Eq "$pattern" <<<"$files"
  return $?
}
web="$(has "$web_re" && echo true || echo false)"
backend="$(has "$backend_re" && echo true || echo false)"
python="$(has "$py_re" && echo true || echo false)"
sonar_sees="$(grep -Evq "$sonar_blind" <<<"$files" && echo true || echo false)"
coverage=false
if [[ "$web" == true || "$backend" == true || "$sonar_sees" == true ]]; then
  coverage=true
fi
if [[ "${GITHUB_EVENT_NAME:-}" == "push" ]]; then
  # A push keeps the coverage suites and the backend jobs it always had: every
  # commit on next, main and sync/** gets a full backend run, and on next the
  # Sonar scan judges the whole branch, which needs the Python coverage of
  # every file, not only the changed ones.
  backend=true
  coverage=true
  python=true
fi
# Sonar judges next on the whole branch (every line inside its new-code
# period), and most web coverage is measured by the E2E suite. The scan runs on
# every push to next, so a push that skipped E2E, whether Python-only or
# docs-only, would report the web code as untested and fail the coverage
# condition (58.5% instead of 83.5% on 2026-09-17). There the web jobs always
# run. A pull request is judged on its own lines, so it keeps the filter.
if [[ "${GITHUB_EVENT_NAME:-}" == "push" && "${GITHUB_REF:-}" == "refs/heads/next" ]]; then
  web=true
fi
emit "$web" "$python" "$backend" "$coverage"
