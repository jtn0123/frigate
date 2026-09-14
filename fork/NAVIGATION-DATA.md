# Navigation and data follow-up

Base: PR #51, commit d3c6a4fb1. Work is isolated on codex/navigation-data.

## Delivered scope

1. Exports and case metadata opt into abortable reads. SWR owns cached data and revalidation; a per-SWR-provider coordinator shares in-flight requests and aborts only after the last mounted consumer releases a key. Filters have distinct keys and previous-filter data is not displayed. WebSocket job progress remains active on the Exports page.
2. Export rename and single-export delete have synchronous duplicate-submit guards, pending controls, and inline retry feedback. Rename edits remain open on failure. Delete rolls optimistic cache changes back on failure. A successful write is not reported as failed merely because its subsequent background refresh fails.
3. Case metadata failures now reach the Exports retry panel alongside export-list failures. Both reads are refreshed by Retry; the navigation shell remains available. Existing authentication handling still owns real authorization failures. Cancellation is not reported as a user error.
4. Review camera/date/label filters live in browser history alongside recording selection. Review and Explore list scroll positions are bounded to 60 history/scope entries in memory. Explore details use one router-owned history entry, reuse it for next/previous, and support Back/Forward. Existing dialog history is disabled only for this router-owned viewer.
5. Export-link mouse/focus intent preloads only case metadata, respecting authentication readiness, offline status, data saver, and slow connections. It shares the mounted SWR cache, deduplicates concurrent requests, and has a five-second freshness window. Failed speculation can retry on the actual visit. No video, model, recording, or mutation is prefetched.
6. System > General > Browser performance displays the last 100 browser-local samples: request count, successful-request p95 latency, errors, cancellations, and latest Exports metadata-ready time. It states the scope and has a clear control. No payloads, camera filters, URLs, or credentials are stored in the measurement history. This is not a server CPU/GPU measurement or video-readiness measurement.

## Architecture and limits

This is an incremental use of the current router/history foundation, not a second data cache or a framework-mode rewrite. SWR remains the only response-cache owner. The managed-read pilot covers exports and cases; existing camera streaming, AI inference, and other pages' fetching remain outside its scope. Browser abort does not promise cancellation of work already started by the server. Changes are local and do not deploy to production.

## Validation

- 329 unit tests passed.
- Final strict browser run: 521 passed, 90 existing layout skips, zero retries,
  with browser coverage and two local workers.
- Type checks, lint, translation extraction, fixture validation, and production
  build passed. The type-safety baseline was tightened after violations fell.
- Startup gzip size: 394152 / 412650 bytes. The existing budget is unchanged.
- Local merged coverage: 393 / 397 changed executable lines (99.0%). Including
  changed branch outcomes gives 94.9%. This is local measurement, not a Sonar
  service result or a live-server performance benchmark.
- The export preview fixture now serves a small decodable video, and its mobile
  regression test checks media readiness rather than only video-element presence.
- Earlier four-worker coverage runs each encountered a five-second timeout in
  an existing lazy model-tab or release-notes test. Both passed five isolated
  runs without assertion changes; the final full two-worker run passed. CI's
  configuration and test timeouts were not changed.

No production deployment or new remote PR is included in this change.
