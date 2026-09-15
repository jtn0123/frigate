#!/usr/bin/env bash
# Promotes next to main. main is the release branch the server pulls: pushing
# it makes "Fork - Build image" publish ghcr.io/jtn0123/frigate:main plus a
# versioned tag, and a GitHub Release with notes from release_notes.py.
#
#   fork/scripts/promote.sh [--yes] [--drop-main-commits]    # make promote
#
# Refuses when "Fork - Checks" is not green on next's tip, or when main has
# commits next lacks (someone pushed main directly; merge them into next
# first). A commit is on next when next has a patch-equivalent of it or a
# rebased copy (same author, author date and subject): rebasing next onto
# upstream with conflict edits changes the patch. --drop-main-commits lists
# the commits still missing and promotes over them once you type "drop"
# (--yes does not skip that); use it only when next has their change in
# another form, such as upstream's version of a backport. main is moved with
# --force-with-lease because next is rebased onto upstream from time to time,
# so the move is not always a fast-forward.
set -euo pipefail

yes=""
drop=""
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    --drop-main-commits) drop=1 ;;
    *)
      echo "usage: fork/scripts/promote.sh [--yes] [--drop-main-commits]" >&2
      exit 2
      ;;
  esac
done
repo="jtn0123/frigate"
cd "$(git rev-parse --show-toplevel)"

git fetch -q --tags origin main next dev
next="$(git rev-parse origin/next)"
main="$(git rev-parse origin/main)"
if [[ "$next" == "$main" ]]; then
  echo "main is already at next (${next:0:9}); nothing to promote"
  exit 0
fi

# Commits on main with no patch-equivalent on next would be lost by the move,
# unless next has a rebased copy: a rebase or cherry-pick keeps the author,
# author date and subject even when conflict edits change the patch.
key='%ae%x09%at%x09%s'
cherry="$(git cherry origin/next origin/main)"
rebased="$(git log --no-merges --format="$key" origin/main..origin/next)"
missing=""
while read -r mark sha; do
  [[ "$mark" == "+" ]] || continue
  commit_key="$(git log -1 --format="$key" "$sha")"
  grep -qxF -- "$commit_key" <<<"$rebased" || missing+="$sha"$'\n'
done <<<"$cherry"
if [[ -n "$missing" ]]; then
  echo "main has commits that next lacks:" >&2
  for sha in $missing; do git log -1 --format='  %h %s' "$sha" >&2; done
  if [[ -z "$drop" ]]; then
    echo "Merge or cherry-pick them into next, then promote again. If next has" >&2
    echo "their change in another form (upstream's version of a backport, say)," >&2
    echo "fork/scripts/promote.sh --drop-main-commits drops them from main." >&2
    exit 1
  fi
  read -r -p "Promoting drops these commits from main. Type drop to go on: " answer || answer=""
  [[ "$answer" == "drop" ]] || { echo "Not promoted." >&2; exit 1; }
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
