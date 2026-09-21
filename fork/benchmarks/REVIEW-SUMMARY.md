# G11: review-summary baseline and cache decision

Measured 2026-09-21 against the local engineering-followups worktree based on
`d441c9fbb03dbda9fdc981e13f6c6bc4b68cfeff`. The handler was unchanged.
Run from the repository root in the backend test image:

```sh
PYTHONPATH=. python3 fork/benchmarks/review_summary.py > results.json
```

The benchmark uses a disposable, file-backed SQLite database, applies the real
migration chain (including the time index), inserts deterministic synthetic
history anchored at `2026-09-21T12:00:00Z` and calls the actual handler, including JSON serialization. Each case
uses that same fixed handler clock and has two warmups and ten timed requests. SQL query plans are collected afterward,
not during timing. Individual timing samples, aggregates and query plans are in
[the result artifact](results/review-summary-20260921.json).

| Workload | Rows / history | Median | p95 | Response bytes |
|---|---|---|---|---|
| All cameras, UTC | 5,000 / 30 days | 4.66 ms | 4.77 ms | 3,693 |
| Audio and zone filters | 5,000 / 30 days | 7.76 ms | 8.02 ms | 3,663 |
| All cameras, UTC | 50,000 / 365 days | 57.14 ms | 58.20 ms | 42,188 |
| Two authorized cameras, second user | 50,000 / 365 days | 14.91 ms | 28.35 ms | 41,819 |
| Audio and zone filters | 50,000 / 365 days | 86.96 ms | 104.45 ms | 42,188 |
| Los Angeles DST periods | 50,000 / 365 days | 76.60 ms | 92.94 ms | 42,188 |

Also measured person filtering, no matching labels and Kathmandu's fractional
UTC offset. Queries use the migrated camera/time indexes where applicable;
JSON label and zone predicates still require evaluating candidate rows.
UTC needs three queries; the year-long DST case needs five.

## Decision

Complete the measurement portion of G11 without adding a cache. This local
baseline identifies a cost at larger histories, but does not establish repeat
request rate, unchanged-response frequency or a production latency problem.
A body-hash ETag could avoid resending about 42 KB in the large case, but would
still run the expensive queries. It would not deliver the proposed CPU saving.

The audit's proposed newest-row timestamp is not a valid cache revision:
review status changes per user without inserting a new review, segments can
change in place or be deleted, camera permissions can change, and events move
out of the rolling 24-hour window with no database write. A stale shared cache
could show incorrect counts or leak camera information. Any future cache must
include user, authorized-camera set, filters/timezone and a revision covering
all mutations, plus time-window expiry; authorization must happen before 304.

Keep caching open pending live request-frequency and latency evidence and a
complete invalidation design. The larger G16 indexing work remains a separate
item. No server, browser polling interval or summary behavior was changed.

## Limits

This was a single-client ARM64 Linux test container on the development Mac,
with SQLite files on tmpfs and a warm OS cache. It excludes network, ASGI/auth,
concurrent writers, cold disk and camera load. Data is synthetic (eight cameras,
two users, mixed severity/labels/audio/zones); it is not a live-demo or production
benchmark. Re-run on representative storage and traffic before promising a
speedup or adopting a cache. The script never opens the production database.
