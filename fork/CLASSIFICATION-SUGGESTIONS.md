# Classification suggestions (I41)

Frigate's custom object models learn from images you sort by hand on the
model's train grid. The description model has usually already described the
same event in words. This feature reads those words and drafts one of the
model's classes on each card, so most cards become one click.

## What you see

On the train grid of a custom object model, cards whose event description
supports one of the model's classes get a badge in the top left corner: the
class, a percentage when Jev answered (hidden on narrow cards), and a
Confirm button. Hover the badge
for the source and the sentence that matched. Confirm files every image of
that event under the class. The existing class picker still works for edits:
on a card with a badge it files the image through the same confirm endpoint,
so the draft and the class you chose are recorded together. Cards with no
badge are labeled exactly as before.

A question mark badge means the two sources disagreed. Label that card by
hand.

One line above the grid says how many cards on the page have a draft,
whether Jev is answering (and how much of today's request budget is used,
or that the key is missing), and how often past drafts were kept as filed.
Its "File all" button files every draft on the page after one
confirmation, one event at a time, and reports how many went through. Use
it once the kept rate has earned that trust; the class picker fixes any
single mistake afterwards.

## How a draft is made

1. **Local text match, always on.** `classification.suggestions.enabled`
   (default true). Each class's name, or its known synonyms for vehicle
   types, colors and carriers, is looked for in the description. The match
   abstains on hedged text (maybe, probably) in the sentence that names the
   class, on negation, on more than one
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
   With `jev.background` (default true) the main process also queues each
   description the moment it is saved and a background thread asks Jev
   right away, once per custom model that classifies that object label,
   storing the answer in the same cache. The grid then finds its drafts
   already there and the daily limit is spent evenly over the day. The
   cache and the daily limit are shared, so the two paths never ask twice.

Classes are the model's dataset folders. Create the classes first, then the
drafts can name them. `none` is never suggested.

## Auto-filing (I44)

Off by default. With `classification.suggestions.auto_file.enabled: true`
the background worker files an event's train images on its own when:

- the local text match and Jev name the same class, and
- people have kept that class's drafts at least `min_kept_rate` (0.9) of
  the time over at least `min_drafts` (20) reviews.

Auto-filed images are recorded with `auto: true`. They show as their own
count in the report and the status line and never count toward the kept
rate, so a class can only earn auto-filing from a person's confirmations.

### What auto-filing skips (I48 to I51)

More images only help when they are varied. Upstream's docs put it as
"diversity matters far more than volume", so auto-filing also holds back
when the images would not teach the model anything:

- **Repeats (I48).** The same class from the same camera waits
  `auto_file.camera_cooldown` seconds (2 hours) between groups and files at
  most `auto_file.per_camera_daily_limit` (10) groups a day. The owner's own
  car in the driveway does not fill the class.
- **Sure images (I49).** Train images the trained model already scored at
  or above `auto_file.max_model_score` (0.9) as the drafted class are left
  in the train grid. They confirm what the model knows; the ones it was
  unsure about are the ones worth filing. The train grid has an
  "Unsure first" switch that sorts by the same score.
- **Tiny crops (I50).** Images under 100 px on a side stretch three to
  seven times when trained. They are never auto-filed, the grid shows a
  marker instead of a draft when every image of an event is that small,
  and File-all and the Explore File button leave them out.
- **Lopsided classes (I51).** A class is never auto-filed past three times
  the images of the smallest filled class. The report page lists the
  images per class, and the status line warns when the dataset is already
  past that ratio.

### Spot check (I52)

The report page lists the latest auto-filed groups nobody has looked at,
each with its first image, class, camera and time. Keep records an
accepted draft; Remove deletes the images from the dataset and records a
rejected one. Both count toward the class's kept rate, so a class that
keeps failing spot checks loses auto-filing on its own.

## Model check (I45)

Once the model is trained and applying classes on its own, the background
worker compares its verdict for each described event with the draft and
appends `agree: true|false` to `.fork_model_checks.jsonl` beside the
dataset. The report's `model_check` block gives the agreement rate, per
class what the description said instead, and the latest disagreements,
and the status line shows the rate. A class whose rate keeps falling is
the one to retrain. Only class names, ids and a hash of the text are
stored.

## In Explore (I46)

The tracked object detail dialog shows the same draft above the
description, one line per custom model that classifies the event's label,
with what the trained model said and a File button. It reads
`GET /classification/suggestions/event/{event_id}` (admin), which also
returns the train images still waiting for the event and what it was
already filed as. Filing goes through the confirm endpoint, so the report
sees it.

## Report page (I47)

`/classification/suggestions/{model}` (Report link on the status line)
shows the report as tables: reviewed drafts and kept rate, auto-filed
count, model agreement, images added since the last training (I54), then
images per class (I51), the spot check (I52), by suggested class, camera
and source, the trained model's classes against the descriptions, and the
latest disagreements linked to the event in Explore.

## Attribute verdicts in Explore search (I53)

Upstream's `/events/search` and `/events/explore` copy a fixed list of
`data` keys into their responses, so with a query typed the detail
dialog showed an attribute-type model's verdict as unset even when the
event had one. Both endpoints now pass the attribute-type custom models'
keys through (`frigate/fork/event_data_keys.py`). Filtering by attribute
already worked; only the display was missing.

## Better descriptions

The drafts can only be as good as the descriptions. A camera prompt that
is about packages or people gives thin vehicle text. One line added to
that camera's `objects.genai.object_prompts.car` (or `prompt`) raises the
hit rate for both the text match and Jev:

```
If the object is a vehicle, name its body type (sedan, SUV, pickup, van),
its color, and any company name or logo on it.
```

On one owner's server, whose prompt asks about packages, 45% of car
descriptions got a draft and most of the rest named no body type at all.

## What is recorded

Every Confirm, and every picker choice on a card with a draft, appends one
line to `clips/<model>/.fork_provenance.jsonl`:
event id, camera, the class chosen, the class suggested, the source and
score, whether the suggestion was accepted unchanged, the SHA-256 of the
description, and the new dataset file names. Dataset files themselves keep
upstream's `{class}-{timestamp}-{random}.png` names, so this file is the
only link from a training image back to the event and text it came from.
That is what a later accuracy report reads. Labels made through the
multi-select toolbar go through upstream's categorize endpoint and are not
recorded.

## Endpoints

- `GET /classification/{name}/suggestions?ids=a,b` (admin): drafts for up to
  100 events, plus whether Jev is enabled, configured, and how much of the
  day's budget is used.
- `POST /classification/{name}/suggestions/confirm` (admin): body
  `{event_id, category, training_files, source?, score?, suggested_category?}`.
  Moves the files the same way upstream's categorize endpoint does and
  records the confirmation.
- `POST /classification/{name}/suggestions/spot-check` (admin, I52): body
  `{event_id, category, files, keep}`. Records the verdict and, with
  `keep: false`, deletes the files from the dataset.
- `GET /classification/{name}/suggestions/report` (admin, I42): reads the
  provenance file and returns, overall and per source, suggested class and
  camera, how many drafts were filed unchanged (`total`, `accepted`, `rate`)
  and, per class, `corrected_to` with the classes chosen instead. A class
  whose drafts keep being corrected to the same other class is the first
  thing to look at before training. Example:

  ```bash
  curl -s -H "X-CSRF-TOKEN: 1" -b "frigate_token=$TOKEN" \
    http://frigate:5000/api/classification/vehicle_type/suggestions/report
  ```

## Flag

`classificationSuggestions` in `web/src/fork/flags.ts`. Off, the grid makes
no suggestions request and renders exactly as upstream.

## Not in this change

A structured pass through the configured description provider instead of
Jev. It would build on the same endpoint and file.
