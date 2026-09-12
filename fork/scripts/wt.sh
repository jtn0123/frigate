#!/usr/bin/env bash
# Creates a section worktree ready to work in: branch section/<name> from
# origin/main, web/node_modules, and its own e2e port.
#
#   fork/scripts/wt.sh <name>    # make wt NAME=<name>
#
# node_modules is an APFS clone of the main clone's copy when both lockfiles
# match (copy-on-write, so it takes almost no disk); otherwise npm ci.
# Ports come from 4190-4199 (PLAN.md hands out 4185-4188 by hand) and are
# written to web/.e2e-port, which `make e2e` and `make check` read.
set -euo pipefail

name="${1:-}"
if [[ ! "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "usage: fork/scripts/wt.sh <name>   (lowercase letters, digits, dashes)" >&2
  exit 2
fi

main="$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
root="$(dirname "$main")/frigate-wt"
dir="$root/$name"
branch="section/$name"
[[ -e "$dir" ]] && { echo "$dir already exists" >&2; exit 1; }

git -C "$main" fetch -q origin
if git -C "$main" show-ref -q --verify "refs/heads/$branch"; then
  git -C "$main" worktree add -q "$dir" "$branch"
else
  git -C "$main" worktree add -q --no-track -b "$branch" "$dir" origin/main
fi
echo "worktree  $dir on $branch"

start=$SECONDS
if [[ -d "$main/web/node_modules" ]] && cmp -s "$main/web/package-lock.json" "$dir/web/package-lock.json" \
  && cp -cR "$main/web/node_modules" "$dir/web/node_modules" 2>/dev/null; then
  echo "deps      cloned from $main/web/node_modules in $((SECONDS - start))s"
else
  rm -rf "$dir/web/node_modules"
  # Same install as CI (.github/actions/fork-web-setup): no dependency
  # lifecycle scripts, then the app's own patch-package postinstall.
  (cd "$dir/web" && npm ci --ignore-scripts --no-audit --no-fund && npm run -s postinstall)
  echo "deps      npm ci in $((SECONDS - start))s"
fi

port=""
for p in $(seq 4190 4199); do
  if grep -qx "$p" "$root"/*/web/.e2e-port "$main/web/.e2e-port" 2>/dev/null; then continue; fi
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then continue; fi
  port="$p"
  break
done
if [[ -n "$port" ]]; then
  echo "$port" >"$dir/web/.e2e-port"
  echo "e2e port  $port (web/.e2e-port)"
else
  echo "e2e port  none free in 4190-4199; set E2E_PORT by hand" >&2
fi

echo
echo "next: cd $dir && make check-fast"
