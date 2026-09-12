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

# The workflow and this script affect every job.
shared='^(\.github/workflows/fork-checks\.yml|\.github/actions/fork-web-setup/|fork/scripts/ci-)'
web_re="${shared}|^web/"
py_re="${shared}|^(frigate|migrations|docker)/|^[^/]+\.py$|^(pyproject\.toml|Makefile)$|^fork/(Dockerfile\.test|scripts/py-checks\.sh)$|^fork/scripts/[^/]+\.py$|^docs/static/frigate-api\.yaml$"

has() { grep -Eq "$1" <<<"$files"; }
emit "$(has "$web_re" && echo true || echo false)" "$(has "$py_re" && echo true || echo false)"
