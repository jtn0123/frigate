#!/usr/bin/env bash
# Promotes next to main. main is the release branch the server pulls: pushing
# it makes "Fork - Build image" publish ghcr.io/jtn0123/frigate:main plus a
# versioned tag, and a GitHub Release with notes from release_notes.py.
#
#   fork/scripts/promote.sh [--yes]    # make promote
#
# Refuses when "Fork - Checks" is not green on next's tip, or when main has
# commits next lacks (someone pushed main directly; merge them into next
# first). main is moved with --force-with-lease because next is rebased onto
# upstream from time to time, so the move is not always a fast-forward.
set -euo pipefail

yes=""
[[ "${1:-}" == "--yes" ]] && yes=1
repo="jtn0123/frigate"
cd "$(git rev-parse --show-toplevel)"

git fetch -q --tags origin main next dev
next="$(git rev-parse origin/next)"
main="$(git rev-parse origin/main)"
if [[ "$next" == "$main" ]]; then
  echo "main is already at next (${next:0:9}); nothing to promote"
  exit 0
fi

# Commits on main with no patch-equivalent on next would be lost by the move.
missing="$(git cherry origin/next origin/main | sed -n 's/^+ //p')"
if [[ -n "$missing" ]]; then
  echo "main has commits that next lacks:" >&2
  for sha in $missing; do git log -1 --format='  %h %s' "$sha" >&2; done
  echo "Merge or cherry-pick them into next, then promote again." >&2
  exit 1
fi

checks="$(gh run list -R "$repo" --workflow "Fork - Checks" --branch next \
  --commit "$next" --limit 1 --json status,conclusion \
  --jq '.[0] // {} | "\(.status // "none")/\(.conclusion // "")"')"
if [[ "$checks" != "completed/success" ]]; then
  echo "Fork - Checks on next (${next:0:9}) is ${checks}, not green." >&2
  echo "Watch it: gh run list -R $repo --branch next --limit 3" >&2
  exit 1
fi

previous="$(gh release list -R "$repo" --exclude-drafts --exclude-pre-releases \
  --limit 1 --json tagName --jq '.[0].tagName // empty')"
echo "Promoting next ${next:0:9} over main ${main:0:9}. Release notes preview:"
echo
python3 fork/scripts/release_notes.py --ref origin/next --upstream origin/dev \
  ${previous:+--previous "$previous"}
echo

if [[ -z "$yes" ]]; then
  read -r -p "Push next to main and publish a release? [y/N] " answer
  [[ "$answer" == [yY] ]] || { echo "Not promoted."; exit 1; }
fi

git push --force-with-lease="main:$main" origin "$next:refs/heads/main"
echo "Pushed. The build and release: gh run list -R $repo --workflow 'Fork - Build image' --limit 1"
