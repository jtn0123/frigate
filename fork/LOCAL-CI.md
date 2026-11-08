# Local CI

`fork/scripts/local_ci.py` runs the fork's CI on this Mac and reports the
result to GitHub as the commit's "Checks passed" status. It exists because
GitHub Actions can stop running for the repository (it did in November 2026),
and `next` only merges a pull request whose head has "Checks passed".

```
make ci PR=252                         # one pull request
make ci-watch                          # every open pull request and next, polled every 5 minutes
python3 fork/scripts/local_ci.py ref next          # a branch head, every job
python3 fork/scripts/local_ci.py pr 252 --no-post  # run without reporting
python3 fork/scripts/local_ci.py pr 252 --device   # also the instrumented Android tests
```

## What a run does

1. Checks the pull request's head out in its own worktree, `frigate-wt/ci`,
   and merges its base into it, as CI tests the merge. A merge conflict fails
   the run right away.
2. Asks `fork/scripts/ci-changes.sh` which areas changed, and runs the gates
   CI would run for them through `fork/scripts/check.sh --gates`:

   | Area | Gates (CI job) |
   |---|---|
   | always | gitleaks (Secrets) |
   | web | lint, typecheck, ratchet, i18n, build, e2e (Web) |
   | coverage | vitest (Web unit), python (Python - mypy, API spec, unittest) |
   | python | ruff, mypy_fork, scripts, locks (Python - Lint) |
   | backend | runtime (non-root NVR runtime), audio (Audio companion) |

   A change under `fork/android` also runs `fork/android/scripts/check.sh`
   (Fork - Android). A `ref` run, like a push, runs everything.
3. Posts "Checks passed" as pending, then success or failure. The full log is
   in `~/.cache/frigate-ci/logs/`.

The Docker gates hold `/tmp/frigate-docker.lock` and the Android gate holds
`/tmp/frigate-android.lock`, so a run waits for other work using them instead
of building beside it. Only one run happens at a time.

Python gates run in a Python 3.11 venv built from the fork's hash-pinned dev,
Sonar and audit locks (`~/.cache/frigate-ci/venv`, rebuilt when a lock
changes), and web gates use the worktree's own `npm ci` install.

Gates run in three lanes: host, Docker and e2e. vitest runs first, and the
Docker lane waits for it, because image builds share the disk with it and can
push its tests past their 5 s timeout. e2e runs last, alone.

## Not covered

- The Sonar quality gate: it needs the owner's `SONAR_TOKEN`. Every success
  description says "Sonar not run".
- The Android release APK and mapping artifacts. The device tests run only with
  `--device`, on a device or emulator that `adb devices` already lists.
- The audio gate builds an amd64 image, which on Apple silicon needs Colima's
  amd64 binfmt registered (it is lost when Colima restarts). The gate checks
  first and prints the command that registers it.
- Publishing. Promoting pushes `main`, and "Fork - Build image" (a GitHub
  Actions workflow) is what builds and pushes `ghcr.io/jtn0123/frigate:main`
  and the GitHub Release. Without Actions, `make promote` moves `main` but no
  image or release follows.

## Trust

The runner executes the code it tests, so it only runs pull requests whose
branch lives in this repository, targeting `next` or `main`. A pull request
from another repository's fork is refused.

## The merge rule

The `next` and `main` rulesets require the "Checks passed" status from any
source, so a status posted by this runner satisfies them, and so does the
GitHub Actions job of the same name when Actions runs. `make promote` checks
the same status on `next`'s tip, so `python3 fork/scripts/local_ci.py ref next`
is what clears it for a promotion.
