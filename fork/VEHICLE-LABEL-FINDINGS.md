# Vehicle labeling: findings and review handoff (I40)

## Decision to review

Use existing image descriptions to prefill vehicle details, let the user confirm
useful suggestions in one action, and reserve manual work for uncertain cases.
Jev is a candidate text extraction step. It cannot verify pixels or recover
visual details absent from a description.

**Status: tested research prototype, not an integrated application feature.**
This PR does not change the review screen, collect new images, train a model,
change retention, or deploy anything. The trial shows promising extraction
coverage; it does not establish better classification accuracy. The next useful
implementation is preserving evidence and connecting suggestions to review,
subject to the evaluation below.

## What is included

| Artifact | Implemented and checked | Remaining work |
| --- | --- | --- |
| Read-only evaluator | Local lexical baseline, legacy result adapter, raw Jev replay, per-field comparisons, explicit missing evidence | Application worker and API integration |
| Evidence checks | Description and question fingerprints, full probability validation, original-crop binding, duplicate and contested-review handling | Durable evidence schema in the actual review store |
| Jev template | Ten real text-only Decisions API responses replayed locally | Production transport, configured budgets, retries, cancellation and status |
| Vision prompt | Structured type/color/carrier/scope template | Exercise against the existing image model on the same examples |
| Review experience | Proposed flow only | Prefill, one-click confirmation, exception queue, mobile and desktop validation |
| Validation | Synthetic regression tests plus a bounded live extraction trial | Independent human labels and an event/day-held-out comparison |

See [trial instructions](VEHICLE-LABEL-TRIAL.md) for commands, contracts and
unknown/none semantics. Private snapshots, camera identifiers, descriptions,
images, raw provider replies and credentials are intentionally outside this PR.
Public synthetic fixtures make code checks repeatable; reproducing the real
sample requires authorized access to the private lab data.

## Observed experiment, September 24, 2026

The isolated lab had 74 events: 32 vehicles with descriptions, 18 people
(17 described), 17 dogs and 7 cats (neither animal group described).
There were 218 review records. Only one current vehicle event joined a human
review, and it had no known vehicle type, color or carrier attribute.
There were also 103 approved vehicle review records without their source event.
Their approved crops remained, but review metadata did not preserve descriptions.
These counts describe a point-in-time sample, not the full camera history.

Ten distinct vehicle descriptions were selected in description-hash order.
Only description text was sent to `typesafe/jev-1.13`; human answers, images,
camera identifiers and timestamps were not sent. Local replay joined responses
using a description hash and the exact question-contract hash. No database was
modified. The provider runner was an ephemeral bounded script, not a committed
or deployed worker.

| Measure on the same ten descriptions | Local baseline | Jev |
| --- | ---: | ---: |
| Usable type suggestions | 4 | 6 |
| Usable color suggestions | 2 | 5 |
| Usable carrier suggestions | 0 | 0 |

The provisional gates require a winning probability of at least 0.9, a margin
of at least 0.2, and a similarly accepted single-subject scope. Jev's raw scope
answers were seven subject, two scene, one ambiguous. After gates, six examples
had at least one draft field and four needed attention. Partial suggestions
are not fully labeled examples.

All ten requests returned. Total request time was 2.1 seconds and reported
usage was $0.00050001. These are single-run measurements. There was no human
ground-truth denominator for these attributes, so accuracy, false-positive
rate and improvement over structured vision output are **unknown**.

One raw response inferred box truck from generic UPS delivery-truck text.
Its type probability was 0.62 and subject scope probability was 0.75; the gates
prevented presenting it as a usable draft. That example demonstrates a guard,
not that these thresholds are calibrated. A provider score is not measured
camera accuracy. Source-model errors can pass through both extractors.

## Findings and recommendations

| ID | Finding | Evidence and consequence | Recommended action |
| --- | --- | --- | --- |
| R1 | Evidence disappears before later evaluation | 103 approved vehicle reviews lack source events; retained crops alone cannot replay text extraction | Preserve the exact description, scope, model/prompt version and hashes beside each retained crop |
| R2 | Jev provides more draft coverage in this sample | Type 6 versus 4, color 5 versus 2; correctness unmeasured | Continue a paired trial, do not enable automatic training labels |
| R3 | Scene text is unsafe as object evidence | Three raw scope answers were scene or ambiguous; multi-vehicle descriptions occur | Bind every suggestion to one source frame/object/crop and abstain otherwise |
| R4 | Current labels cannot establish accuracy | No known human attributes overlap the ten examples | Blindly review an evaluation set before showing suggestions, then freeze those answers |
| R5 | Existing image model might be sufficient | Structured vision prompt is untested; current model already creates useful descriptions | Compare direct structured vision, local parsing and Jev on the same events before adding permanent provider cost |
| R6 | The user-visible flow is still missing | This PR contains no application route, worker or frontend change | Build one narrow vehicle suggestion flow with one-click confirmation and editable fields |
| R7 | Old lab code cannot be transplanted wholesale | Older worktree diverges substantially from current next and its ledger IDs overlap later changes | Inventory current next and port only missing behavior in small, separately reviewed changes |

## Proposed implementation sequence

1. **Preserve evidence.** Add a versioned review evidence record with original
   crop hash, source frame/object identity, source description and scope,
   image-model version, prompt hash and capture time. Preserve approved HQ
   originals and their derived crops. For historical reviews, keep their human
   labels and mark unavailable descriptions missing; never invent replacements
   and present them as the original evidence.
2. **Add one suggestion service.** Normalize the existing model's output into
   type, color and carrier. Use Jev only for an explicit text extraction task
   when useful. Cache by evidence and contract hashes; retain raw scores locally.
   Add a bounded queue, timeout, cancellation, idempotency and visible provider
   status. Offline or failed calls leave human review usable. Treat descriptions
   as untrusted data, never executable instructions.
3. **Connect the vehicle review card.** Show the crop and suggested fields with
   evidence. One Confirm action atomically saves the reviewed labels and keeps
   the authorized training example. Allow per-field edits, unknown and undo.
   Never silently replace a confirmed human label. Separate missing results,
   abstentions, errors and already-reviewed items so the queue always advances
   or shows a clear retry action.
4. **Collect exceptions automatically.** Opt-in cameras, event-level sampling,
   exact hash deduplication and conservative perceptual grouping limit repeated
   frames. Preserve useful viewpoint/lighting variants. Missing visual evidence
   can trigger one capped sharper-crop/image-model retry, then human review.
5. **Measure before expanding.** Start with a proposed 50-100 distinct events,
   spanning vehicle types, day/night and single/multiple subjects. Human labels
   must be recorded without suggestions visible. Keep tuning and held-out
   events/days separate; report results per field and subgroup with counts,
   uncertainty, abstentions, correction rate, clicks, latency and cost. Include
   uncommon classes deliberately and report their sampling separately.

Suggested release criteria: reviewer-approved evidence migrations; no overwrite
of human labels; no duplicate writes after retries; no indefinite loading;
working offline review; an observable budget cap; and actual mobile/desktop
review tests. Choose acceptable error rates before inspecting held-out results.
Automatic training-label acceptance remains a separate decision requiring
stronger evidence. Do not infer privacy-retention policy from these labels.

## Parent repository and scope check

This branch was refreshed to `origin/next` at `4052288cb` on September 24.
At that check, no other PRs were open. Relevant merged work includes
[B14 GenAI backports (#94)](https://github.com/jtn0123/frigate/pull/94),
[upstream backports (#99)](https://github.com/jtn0123/frigate/pull/99), and
[classification navigation (#100)](https://github.com/jtn0123/frigate/pull/100).
These are integration context, not features reimplemented by this PR. Refresh
the base and open PR list again before implementing the application changes.

## Review checklist for the next agent

- Verify `wrong` reviews are retained as human corrections, and that attributes
  join only their exact original crop and corrected core label.
- Challenge single-subject assumptions, scope gating, unknown versus none,
  stale contracts, duplicate responses, contested labels and denominator counts.
- Check whether the proposed evidence schema fits existing next APIs and the
  actual lab store; identify the smallest migration and UI integration.
- Compare direct structured vision with Jev before recommending a provider
  dependency. Do not interpret increased draft coverage as increased accuracy.
- Review the synthetic tests and CI coverage wiring; reproduce offline behavior
  before requesting additional private data or provider calls.
- Propose the first separately testable application PR and explicit acceptance
  criteria. The recommended first slice is durable evidence plus editable
  vehicle prefills, not generalized autonomous labeling.

## Research sources and attribution

The [OpenRouter Jev Decisions guide](https://openrouter.ai/blog/tutorials/how-to-use-jev/)
informed the request template. The capability and accuracy conclusions above
come from local code inspection and the bounded experiment, not vendor accuracy
claims. Opus 5.5 supplied design feedback and code review through Claude CLI
using the existing subscription. Codex implemented the prototype and regression
fixes. No claim is made that Opus implemented or deployed this feature.

Validation details are maintained in [the trial document](VEHICLE-LABEL-TRIAL.md).
The PR checks are the current authority for remote CI status. Local focused
checks are not proof of application integration or camera accuracy.
