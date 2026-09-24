# Classification suggestions (I41)

Frigate's custom object models learn from images you sort by hand on the
model's train grid. The description model has usually already described the
same event in words. This feature reads those words and drafts one of the
model's classes on each card, so most cards become one click.

## What you see

On the train grid of a custom object model, cards whose event description
supports one of the model's classes get a badge in the top left corner: the
class, a percentage when Jev answered, and a Confirm button. Hover the badge
for the source and the sentence that matched. Confirm files every image of
that event under the class. The existing class picker still works for edits,
and cards with no badge are labeled exactly as before.

A question mark badge means the two sources disagreed. Label that card by
hand.

## How a draft is made

1. **Local text match, always on.** `classification.suggestions.enabled`
   (default true). Each class's name, or its known synonyms for vehicle
   types, colors and carriers, is looked for in the description. The match
   abstains on hedged text (maybe, probably), on negation, on more than one
   subject, on colors and carriers not tied to a vehicle noun, and whenever
   two classes of the same kind are named. Nothing leaves Frigate.
2. **Jev, opt-in.** With `classification.suggestions.jev.enabled: true` and
   `FRIGATE_JEV_API_KEY` (or `OPENROUTER_API_KEY`) in the environment, the
   description text is sent to the OpenRouter Decisions API as one choice
   question over the model's classes plus `unknown`. Only the text is sent.
   The answer is shown when the winning class has at least 0.9 probability
   and leads the runner-up by 0.2; otherwise the card shows no draft. Answers
   are cached in `classification-suggestions.sqlite` beside the Frigate
   database, keyed by the exact text and question set, so a description is
   sent once. `daily_request_limit` (default 200) caps requests per UTC day
   in `classification-suggestions-usage.json`. `cameras` restricts which
   cameras' descriptions may be sent; empty means all. `url` can point at a
   gateway.
3. **Picking one.** Jev wins when both agree or only Jev answered. When they
   name different classes the card shows the disagreement instead.

Classes are the model's dataset folders. Create the classes first, then the
drafts can name them. `none` is never suggested.

## What is recorded

Every Confirm appends one line to `clips/<model>/.fork_provenance.jsonl`:
event id, camera, the class chosen, the class suggested, the source and
score, whether the suggestion was accepted unchanged, the SHA-256 of the
description, and the new dataset file names. Dataset files themselves keep
upstream's `{class}-{timestamp}-{random}.png` names, so this file is the
only link from a training image back to the event and text it came from.
That is what a later accuracy report reads.

## Endpoints

- `GET /classification/{name}/suggestions?ids=a,b` (admin): drafts for up to
  100 events, plus whether Jev is enabled, configured, and how much of the
  day's budget is used.
- `POST /classification/{name}/suggestions/confirm` (admin): body
  `{event_id, category, training_files, source?, score?, suggested_category?}`.
  Moves the files the same way upstream's categorize endpoint does and
  records the confirmation.

## Flag

`classificationSuggestions` in `web/src/fork/flags.ts`. Off, the grid makes
no suggestions request and renders exactly as upstream.

## Not in this change

Suggestions in Explore's detail dialog, a structured pass through the
configured description provider instead of Jev, and the accuracy report over
the provenance file. Those build on the same endpoint and file.
