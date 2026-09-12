# Sonar blocker review and targeted fixes

Baseline: next at 22223af07, after PR 38.

Five findings are addressed in source, awaiting scan confirmation:

| Rule | Count | Change |
| --- | ---: | --- |
| javascript:S1082 | 2 | Native buttons make documentation model selection keyboard-operable. |
| typescript:S2999 | 1 | Type and validate the optional ManagedMediaSource constructor. |
| pythonsecurity:S8707 | 1 | Encode model labels as single export-folder components. |
| typescript:S2699 | 1 | Use a direct auto-retrying locator assertion for timeline markers. |

The dataset regression test demonstrates that a ../escaped label previously
wrote outside the selected export directory. Percent-encoding label components
preserves ordinary names and stops labels from supplying path separators.
The output directory and existing filesystem remain controlled by the CLI user.

ManagedMediaSource detection now tolerates missing and non-callable properties,
while preserving Safari's static codec API. Two type suppressions and two unsafe
operations are removed, and the type ratchet is tightened accordingly.

## Remaining blocker review

- The go2rtc test already asserts the saved configuration through expect.poll.
  No behavior change or duplicate assertion was added solely for the analyzer.
- Three keyboard callbacks intentionally return the event-consumption flag.
  They are not demonstrated unconditional-success bugs.
- RKNN conversion has explicit True and False returns. The always-same-return
  finding does not reflect its source behavior.

No findings were suppressed or marked false positive in Sonar.

## Validation

- 1,097 backend unittest tests passed; mypy passed for 369 source files.
- 258 frontend unit tests, TypeScript, lint, and both production builds passed.
- Keyboard-only documentation check: Space opens the model picker; Tab and Enter
  select SSDLite MobileNet v2, update the selected label, and close the picker.
- The dataset traversal test fails on the original implementation and passes
  after encoding label components. Normal bucket names remain unchanged.
