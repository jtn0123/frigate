#!/usr/bin/env bash
# Runs the "Fork - Checks" gates locally and prints one line per gate with its
# time; failing logs are printed at the end.
#
#   fork/scripts/check.sh           # every gate CI runs (make check)
#   fork/scripts/check.sh --fast    # changed-only, for the inner loop (make check-fast)
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
#
# Not mirrored: CI's `vite build --base=/BASE_PATH/`. It is the same bundle as
# the e2e build with a different base path.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1
mode=full
if [[ "${1:-}" == "--fast" ]]; then mode=fast; fi

base_ref="${FORK_BASE:-origin/next}"
base="$(git merge-base HEAD "$base_ref")" || {
  echo "no merge base with $base_ref (set FORK_BASE)" >&2
  exit 1
}
export E2E_PORT="${E2E_PORT:-$(cat web/.e2e-port 2>/dev/null || echo 4173)}"
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

py_files='^(frigate|migrations|docker|fork/scripts)/.*\.py$|^[^/]+\.py$'
py_gates='^(frigate|migrations|docker)/|^[^/]+\.py$|^(Makefile|pyproject\.toml)$|^fork/(Dockerfile\.test|requirements-dev\.lock|scripts/py-checks\.sh|scripts/dev-lock-check\.py)$|^docs/static/frigate-api\.yaml$'
e2e_args=()

# ---- gates: gate_<name> runs one check; its output goes to the gate's log ----
# Node tools run from web/node_modules/.bin rather than through npx, which
# could fetch a missing package from the registry.

gate_lint() { (cd web && npm run -s lint); return $?; }
gate_typecheck() { (cd web && npm run -s typecheck); return $?; }
gate_ratchet() { (cd web && npm run -s type-ratchet); return $?; }
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
    "${ruff[@]}" format --check frigate migrations docker fork/scripts ./*.py && "${ruff[@]}" check frigate migrations docker fork/scripts ./*.py
  fi
}

# Unit tests for the fork's own scripts (release notes); plain python3, no image.
gate_scripts() { python3 -m unittest discover -s fork/scripts -p 'test_*.py'; }

# The e2e bundle, checked against CI's eager-bundle budget (fork/bundle-budget.json).
gate_build() { (cd web && node_modules/.bin/vite build --base=/ && npm run -s bundle:budget); return $?; }

gate_e2e() {
  (cd web && node_modules/.bin/playwright test -c e2e/playwright.config.ts "${e2e_args[@]+"${e2e_args[@]}"}")
  return $?
}

gate_python() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running; start it with 'colima start' and re-run."
    return 1
  fi
  # Same per-worktree tag as the Makefile, so parallel worktrees never test
  # each other's sources.
  local image
  image="frigate-fork-test-$(basename "$PWD")"
  make -s fork-test-image FORK_TEST_IMAGE="$image" && FORK_TEST_IMAGE="$image" fork/scripts/py-checks.sh
}

# ---- lanes ----

names=()
notes=()

# lane <name...>: run the named gates one after another in the background.
lane() {
  names+=("$@")
  (
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

host=(lint typecheck ratchet vitest i18n ruff gitleaks)
docker_lane=()
if [[ "$mode" == fast ]]; then
  if touches '^fork/scripts/.*\.py$'; then
    host+=(scripts)
  else
    skip scripts "no fork/scripts Python changes"
  fi
  if touches '^web/e2e/'; then
    e2e_args=(--only-changed="$base")
    host+=(build e2e)
  else
    skip build "no e2e changes (make check builds and checks the budget)"
    skip e2e "no e2e changes (make check runs the full suite)"
  fi
  if touches "$py_gates"; then
    docker_lane=(python)
  else
    skip python "no backend changes"
  fi
else
  host+=(scripts build e2e)
  docker_lane=(python)
fi

echo "fork check ($mode): base $base_ref @ $(git rev-parse --short "$base"), E2E_PORT $E2E_PORT"
lane "${host[@]}"
if ((${#docker_lane[@]})); then lane "${docker_lane[@]}"; fi

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
