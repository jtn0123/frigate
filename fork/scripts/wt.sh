#!/usr/bin/env bash
# Creates a section worktree ready to work in: branch section/<name> from
# origin/next (where pull requests land), web/node_modules, and its own e2e port.
#
#   fork/scripts/wt.sh <name>    # make wt NAME=<name>
#
# node_modules is an APFS clone of the main clone's copy when both lockfiles
# match (copy-on-write, so it takes almost no disk); otherwise npm ci.
# Ports come from 4190-4299 (PLAN.md hands out 4185-4188 by hand) and are
# written to web/.e2e-port, which `make e2e` and `make check` read.
set -euo pipefail

name="${1:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
  git -C "$main" worktree add -q --no-track -b "$branch" "$dir" origin/next
fi
echo "worktree  $dir on $branch"

# Reserve before dependency setup. Exhaustion must fail without falling back
# to another worktree's preview, and allocation is locked across creators.
if ! port="$(python3 "$script_dir/e2e-port.py" --worktree "$dir")"; then
  git -C "$main" worktree remove "$dir"
  exit 1
fi
echo "e2e port  $port (web/.e2e-port)"

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

echo
echo "next: cd $dir && make check-fast"
