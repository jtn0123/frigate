#!/usr/bin/env bash
# Decides which "Fork - Checks" jobs a push or pull request needs, so docs-only
# commits (PLAN.md, FORK.md, the grade report) skip the web and Python suites.
# Writes web=true|false and python=true|false to $GITHUB_OUTPUT (stdout when
# run by hand). Anything it cannot diff runs everything.
#
#   fork/scripts/ci-changes.sh [base-sha]    # default base: origin/next
set -euo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
base="${1:-${BASE_SHA:-origin/next}}"

emit() {
  echo "web=$1" >>"$out"
  echo "python=$2" >>"$out"
}

if [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]]; then
  echo "workflow_dispatch: running everything" >&2
  emit true true
  exit 0
fi
# A new branch reports an all-zero "before"; a force push may name a commit
# that is no longer in the history.
if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "no usable base (${base:-empty}): running everything" >&2
  emit true true
  exit 0
fi

files="$(git diff --name-only --no-renames "$base" HEAD)"
echo "changed since ${base}:" >&2
echo "  ${files//$'\n'/$'\n'  }" >&2

# The workflow and the shell scripts behind the gates affect every job: a pull
# request that breaks check.sh or the Sonar expiry file must not go green by
# skipping the suites (I37). The Python scripts only need the Python jobs.
shared='^(\.coveragerc$|sonar-project\.properties$|fork/requirements-sonar\.txt$|fork/sonar-token\.env$|\.github/workflows/fork-checks\.yml|\.github/actions/fork-web-setup/|fork/scripts/[^/]+\.sh$)'
# The web jobs read the ratchet and bundle budget baselines under fork/.
web_re="${shared}|^web/|^docs/static/frigate-api\.yaml$|^fork/(type-ratchet|bundle-budget)\.json$"
py_re="${shared}|^fork/(audio_trial|monitoring|ledger)/|^(frigate|migrations|docker)/|^[^/]+\.py$|^(pyproject\.toml|Makefile)$|^fork/(Dockerfile\.test|requirements-dev\.lock)$|^fork/scripts/[^/]+\.py$|^docs/static/frigate-api\.yaml$"

has() {
  local pattern="$1"
  grep -Eq "$pattern" <<<"$files"
  return $?
}
web="$(has "$web_re" && echo true || echo false)"
python="$(has "$py_re" && echo true || echo false)"
# Sonar judges next on the whole branch (every line inside its new-code
# period), and most web coverage is measured by the E2E suite. The scan runs on
# every push to next, so a push that skipped E2E, whether Python-only or
# docs-only, would report the web code as untested and fail the coverage
# condition (58.5% instead of 83.5% on 2026-09-17). There the web jobs always
# run. A pull request is judged on its own lines, so it keeps the filter.
if [[ "${GITHUB_EVENT_NAME:-}" == "push" && "${GITHUB_REF:-}" == "refs/heads/next" ]]; then
  web=true
fi
emit "$web" "$python"
