# Security policy

This repository is `jtn0123/frigate`, a fork of
[Frigate](https://github.com/blakeblackshear/frigate). Report a problem to
the project that owns the affected code.

## Reporting a vulnerability in this fork

Report privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**. Do not open a public issue, pull request
or discussion for a vulnerability.

Include the affected version or commit, the steps to reproduce, and the
impact you observed. Expect an acknowledgement within a week.

## Reporting a vulnerability in upstream Frigate

If the problem is also present in upstream Frigate (code this fork has not
changed), report it to the upstream project as its maintainers ask, so every
Frigate user gets the fix. `FORK.md` lists the fork's changes if you are not
sure which side owns the code.

## Supported versions

Only the latest build of the `main` branch is supported. Fixes land on
`next` first and reach `main` with the next promotion.

## Known findings

Decisions about scanner findings (accepted risks, mitigations and open
items) are recorded in [`fork/SECURITY-TRIAGE.md`](fork/SECURITY-TRIAGE.md).
