# Frontend warning cleanup

This follows the 415 source findings in the Sonar tracker. Warning resolutions
are counted separately and do not claim additional Sonar closures.

## Warning accounting

The starting lint report contained 85 warnings. The cleanup addresses every
reported location through code changes, corrected lint analysis or explicit
exceptions. It does not represent 85 independent bug fixes.

- Corrected focus behavior, empty tab stops, real missing label associations,
  native thumbnail and URI buttons, timeline keyboard controls and range values.
- Separated authentication and status-bar contexts from provider components.
- Renamed the chat message role prop so it is not confused with an ARIA role.
- Replaced the deprecated label rule with its current equivalent, recognizing
  labelable Radix controls and both wrapping and `htmlFor` associations. Increased
  label-content traversal depth to recognize existing text within nested markup.
- Eight original warning locations have documented local exceptions: three camera
  players without supplied captions, two grid-library drag wrappers, one focusable
  clipboard-paste region, and two warnings on the coordinate-based birdseye map.
  The birdseye map now also exposes camera buttons for keyboard navigation.
  These exceptions are not counted as implemented captioning or keyboard dragging.
- Fixed 18 unresolved public font URLs using Vite public-asset paths, which also
  respect the production base path.

## Validation

- Full frontend suite: 242 tests passed across 23 files.
- Six new regressions cover handlebar navigation with the feature flag disabled,
  export range ordering, overview scrolling with accessible position updates,
  page-step boundary cases and labeled dialog fields through saving.
- Browser suite: 56 passed, 24 skipped, covering configuration editor, timeline,
  review, explore and appearance on desktop and mobile with mocked backend data.
- ESLint: 0 errors, 0 warnings; E2E spec lint passed for 39 files.
- App, E2E and fork TypeScript checks passed; translation extraction check passed.
- CI type ratchet checked without raising any baseline.
- Production build passed, with only the Monaco size advisory described below.
- Initial-load bundle budget passed: 365,016 / 370,844 gzip bytes.

The existing lazy-loaded Monaco bundle still produces Vite's 900 kB chunk-size
advisory (about 4.09 MB uncompressed). The size threshold was not raised. An
experimental partition introduced circular dependencies and was reverted;
editor features and the original bundling strategy are preserved. Node's
experimental localStorage and terminal color notices come from the test runtime.

Prepared for a PR from `fix/sonar-priority` into `next`. No merge or deployment.
