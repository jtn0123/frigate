# Sonar security and maintainability batch

Base: `next` at `90eba818c929117fe63232dcffc4c5763ede9431` (PR 35 merged).
Branch: `fix/sonar-download-security`.

## Count and scan reconciliation

The September 12 scan at 18:56:45 UTC reports 2,218 remaining findings:
62 bugs, 188 vulnerabilities, and 1,968 code smells. It confirmed nine
closures from PR 35, rather than all 30 source changes. The 21 remaining
logging findings are explicitly counted as carryovers here.

This batch addresses **545 distinct baseline issue IDs**, 500 more than the
initial 45-issue scope. There are 524 new fixes and 21 carryovers. Counts are
source changes awaiting confirmation by the merged branch scan.

| Group | Findings |
| --- | ---: |
| HTTPS-only build downloads and redirects | 40 |
| Explicit CR/LF removal in logging (carryovers) | 21 |
| Numeric APIs with numeric argument checks | 96 |
| Readonly component props (web and docs) | 81 |
| Consolidated imports | 58 |
| Safe optional chains | 44 |
| Redundant fragments | 27 |
| Redundant else blocks | 13 |
| Nullish defaults | 12 |
| Boolean array searches | 11 |
| Shared Python string constants | 48 |
| Exception diagnostics with tracebacks | 22 |
| Redundant exception subclasses | 20 |
| Identity comprehensions | 19 |
| Unused local values and counters | 18 |
| Nested Python conditions | 15 |
| **Total** | **545** |

The [generated issue ledger](sonar-september-batch-issues.csv) records every
Sonar ID, rule, original file/line, and carryover status. Multiple findings at
one source construct are counted only when Sonar assigned distinct IDs.
No closures are inferred from line counts or a passing pull-request gate.

## Behavior and scope

Downloads use curl with HTTPS-only initial and redirect protocols. HTTPS
redirects remain supported. HTTP downgrades and HTTP error responses fail.
All 40 URLs, output destinations, versions, and existing FFmpeg checksums are
preserved. Affected scripts install curl and CA certificates in their build
stages. Each script centralizes the transport policy in a download helper.
This does not add signatures or checksums to every downloaded artifact.

The 21 log sites strip raw CR/LF after repr formatting, including unusual
exception classes whose custom repr contains line breaks. Other error paths
use contextual exception logging to retain tracebacks for troubleshooting.

Frontend changes preserve numeric coercion requirements, nullish defaults,
component output, and import bindings. Export and motion-search dialogs share
a tested, labeled clock input, removing their duplicated time-editing code. Python changes preserve exception
coverage, collection copies, message values, and condition evaluation order.

Intentionally deferred: the devcontainer Node installer and final-image root
policy, migration callback signatures, dictionary snapshots
used while mutating entries, coercion-sensitive optional-chain suggestions,
large complexity refactors, and policy-dependent network access restrictions.

## Validation

Local results: 1,077 backend tests, 245 frontend unit tests, and 420 browser
tests passed. The 93 existing browser skips are unchanged. Nine fork-script
tests pass locally, and all four transport tests also pass on Linux.
Documentation and frontend production builds passed. Generated API and config
schemas retain their original values. Full results are recorded in the PR.

Checks cover:

- Real curl transport against local HTTP and HTTPS servers: 40 source command
  prefixes, five transport cases each (200 cases), on macOS and Linux.
- Regression coverage for raw CR/LF in a custom exception repr.
- Exact comparison of all 40 download URLs and output destinations; shell syntax.
- Backend unittest, mypy, API schema consistency, and config translations.
- Frontend type checking, lint, unit tests, production build, and browser tests.
- Documentation build for the readonly prop changes.
- Pinned Ruff formatting/lint and the complete fork-script test suite.

Full platform Docker images and physical camera/GPU behavior are not tested
by this batch.

Transport option reference: https://curl.se/docs/manpage.html#--proto-redir
