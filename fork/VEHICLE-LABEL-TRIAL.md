# Vehicle label trial (I40)

Turn existing image descriptions into draft vehicle details and send uncertain
examples to human review. This trial runs independently of the older, unmerged
review lab code and does not change the production application.

For the completed research findings, integration plan and reviewer checklist,
see [Vehicle label findings](VEHICLE-LABEL-FINDINGS.md).

## Template

- `experiments/vehicle-labels/vision-prompt.md` asks the image model for type,
  color, carrier, subject scope and visible evidence in one response.
- `experiments/vehicle-labels/jev-request.json` asks Jev to extract the same
  fields from an existing description. Its state contains only the description,
  not camera names, event IDs, timestamps, images or human answers.
- `scripts/vehicle_label_trial.py` provides a conservative local text baseline
  and compares it with current saved Jev results and human reviews.

The image model sees pixels. Jev reads text. Agreement between them is
consistency, not independent verification. Neither result becomes a training
label. A carrier of `none` requires explicit evidence of absent visible
branding; a carrier of `unknown` includes missing, obscured and ambiguous
evidence. A white van alone supports neither a carrier name nor `none`.

The new Jev request uses explicit choices including unknown. The trial can replay
raw probability distributions, with provisional probability and margin gates
of 0.9 and 0.2. Existing saved lab refinements use the older
contract with thresholded suggestions. Do not use those older results to claim
that the new prompt or its thresholds have been validated.

## Try existing data without rebuilding or changing the lab

From this worktree, with the existing isolated lab running:

```bash
docker exec -i frigate-findings-lab python3 - \
  --events-db /config/frigate.db \
  --reviews-db /config/classification-review.sqlite \
  < fork/scripts/vehicle_label_trial.py
```

The command opens SQLite read-only and prints aggregate JSON. It does not
install code, read image payloads, call a provider, write labels or change
retention. Use `--details` only for a private local preview; it includes source
descriptions and event identifiers. Do not commit that output.

For a private, repeatable snapshot, add `--export-snapshot`. It includes the
description, human review and original-crop binding metadata, but no images.
On the host, replay it with `--snapshot PATH`. The runner removes attributes
without their matching original crop hash and core label. Records with a
`wrong` decision are human corrections whose `label` is the corrected label.

New Jev results can be replayed with `--jev-results PATH --contract-hash HASH`.
The file is a JSON list of records with local `event_id`, `camera`,
`description_sha256`, `contract_hash`, `status: received`, and the raw `answers`
object. These identifiers join the local result only; they are not sent to Jev.
The expected contract hash is SHA-256 of the request's `questions` object
serialized with Python `json.dumps(..., sort_keys=True)`. Duplicate, orphan,
stale and malformed records are rejected. A new-response replay never silently
substitutes legacy results. Missing results are not counted as abstentions.

`proposal_ready` means at least one usable draft field is available for review,
not that all fields are filled or verified. Uncertain fields stay unknown.

## Proposed application behavior after the trial

1. Collect distinct, good crops automatically while respecting camera opt-in.
2. Use an existing object description before requesting another image-model
   call. Review-level scene descriptions must not be silently assigned to one
   object.
3. Extract suggested fields and show the evidence beside the crop. A complete
   suggestion is ready for confirmation, not automatically correct.
4. Route missing or ambiguous details to a capped sharper-crop retry, then to
   the human exception queue. Do not retry every frame or create a model loop.
5. Keep confirmed labels in the permanent training collection. Use existing
   `testing-scripts/object_dataset.py` for trained-model dataset diagnostics.

Before enabling this flow, compare direct structured image output, the local
baseline, and Jev on the same examples. Report coverage and mistakes per field,
cost and latency, and how many human actions were avoided. Keep a separate
event/day split and collect reviews without showing suggestions for a useful
independent evaluation. Historical review agreement alone is not such a test.

## September 24 trial

The current isolated lab contained 32 vehicle descriptions. Ten distinct
descriptions, selected by description-hash order, were sent to Jev using the new
template. No images or human labels were sent, and no database was modified.

| Same 10 descriptions | Local lexical baseline | Jev after provisional gates |
| --- | ---: | ---: |
| Vehicle type drafts | 4 | 6 |
| Color drafts | 2 | 5 |
| Carrier drafts | 0 | 0 |

Six examples had a draft ready for review; four stayed in the exception queue.
The provider returned 10 responses in 2.1 seconds of total request time and
reported $0.00050001 usage. These are one-run observations, not latency or cost
guarantees. No accuracy percentage is available: none of the ten currently
joins a human-confirmed vehicle attribute. The broader lab has 103 approved
vehicle reviews whose source events are missing. Approved crops remain, but
the stored review metadata does not preserve their source descriptions.

This establishes extraction coverage, not correctness or improvement over
direct structured vision-model output. The vision prompt template has not
been exercised. One Jev response suggested box_truck from a description that
only said UPS delivery truck; its 0.62 probability and uncertain subject scope
held it out of the proposal queue. Text alone cannot resolve that visual fact.

Next: preserve source description and its fingerprint beside approved crop
reviews; retain provider raw scores with their question contract; then compare
all three approaches on a paired set with independent human review. Reuse the
saved responses to tune the trial without repeated provider calls. The live
transport for this run was a bounded local script, not a production worker.

Opus 5.5, invoked through the Claude CLI subscription, supplied the design and
reviewed the implementation. Regression tests cover generic second vehicles,
unknown versus none, crop binding, stale and duplicate results, contested
human labels and read-only database access.

Validation: 20 focused unittest cases pass, including fail-before/pass-after
regressions from the Opus review and CLI/lab-marker checks. Focused coverage
measures 91% with branch coverage enabled. Ruff and the fork's mypy check pass
(31 source files). The tests are registered in the Docker coverage lane, with
request templates copied into its image. The full `make check` run is in
progress; its first Ruff run caught test import ordering, now corrected and
rechecked. A complete aggregate pass is not claimed. Consult this PR's checks
for current CI status; none of these checks establish camera-label accuracy.

## Source

The request format follows the [OpenRouter Jev Decisions guide](https://openrouter.ai/blog/tutorials/how-to-use-jev/),
checked September 24, 2026. Jev scores describe its answer distribution; choose
action thresholds using human-labeled examples rather than treating scores as
measured camera accuracy.
