# Classification suggestions (I41)

Frigate's custom object models learn from images you sort by hand on the
model's train grid. The description model has usually already described the
same event in words. This feature reads those words and drafts one of the
model's classes on each card, so most cards become one click.

## What you see

On the train grid of a custom object model, cards whose event description
supports one of the model's classes show the guess in the bottom label row,
where upstream shows "None": the class with a question mark (for example
"Sedan?"), then a check that accepts it. The image itself stays clear.
Underscores in class names show as spaces. When Jev answered, a dot shows
its confidence: green at 85% or more, amber at 60% or more, gray below.
Text matches have no score and no dot.

Tap or click the class name for a popover with the class and score, the
source ("read from the description" or "from the AI helper"), the sentence
that matched with the class words marked, and the tiny photo note. The
check files every image of that event under the class, then moves focus to
the next card's check, so a keyboard can work down the grid. On a phone
the check has a 44 px hit area. The existing class picker still works for
edits: on a card with a guess it files the image through the same confirm
endpoint, so the draft and the class you chose are recorded together.
Every popover also ends with one button per class ("Or pick the class:"),
so a wrong guess is fixed in one tap; the pick is recorded with the draft
it replaced.

A card with no guess shows a dashed "Pick a class" button instead of
"None". Its popover says why in plain words (the description doesn't name
one of the classes, the event has no description yet, the AI helper hit its
daily limit, or it could not be reached) and lists the classes as buttons.
A class named "none" is never offered. When Jev leaned toward a class but
below the draft gate (a score of 0.55 or more and a margin of 0.1 or more),
the button reads "Sedan, maybe" and that class comes first in the list. A
maybe is never a guess: it has no accept check, Accept all and auto-filing
skip it, and filing it records no `suggested_category`, so it never moves
the kept rate.

When the two sources disagree, the label row shows both classes with a
question mark icon. Its popover says so and lists the classes to pick from.

The first row of the grid is a status line. It scrolls away with the
cards. It counts in photos: "12 of 30 photos have a guess". It also says
how many of those are tiny photos, warns when one class has far more
photos than another, and links to the Stats page. Jev's budget, the kept
rate and the model check live on the Stats page, not here. When the server
capped the ids, it says "Guesses shown for 400 of 450 photos".

A hint above the row explains the labels until "Got it" is pressed. It
waits for the stored answer, so it never flashes for someone who closed
it. The "Least sure first" order also waits for its stored value, so the
grid does not jump.

After a single accept, the toast has an Undo button. It moves the photos
back to the grid.

"Accept all N guesses" counts events and opens a confirmation. The dialog
lists the guesses per class ("sedan 20, suv 15") and has a "Skip images
too small to train well" box, checked by default, that leaves out events
whose every photo is tiny. The run goes one event at a time and the button
reads "Accepting 3 of 20". The single checks stay disabled until it ends.
An event someone else filed meanwhile (404 "already accepted") counts as
done. The toast says how many went through, or that none did. Leaving the
page stops the run without a toast. Use Accept all once the kept rate has
earned that trust; a wrong photo can be moved later from its class's tab.

On a phone the status line is one row: the count, Accept all and a "More"
menu with "Least sure first", Stats and the notes.

Once 10 or more photos were added since the last training (I54), a "Train
now (N new photos)" bar shows under the status line. It runs the same
action as upstream's Train button and hides while the model cannot train.

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
count in the report and never count toward the kept
rate, so a class can only earn auto-filing from a person's confirmations.
Only confirmations made one card at a time count as reviews. Groups filed
by Accept all (`bulk: true`) and confirmations that were later undone are
left out of both `min_kept_rate` and `min_drafts`.

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
  "Least sure first" switch that sorts by the same score.
- **Tiny crops (I50).** Images under 100 px on a side stretch three to
  seven times when trained, so they are never auto-filed. People still see
  the draft: the card (an amber shrink icon), the Explore row and the
  status line flag events whose every image is that small, and filing
  them stays the person's call, since upstream saves crops at the detect
  stream's size and on a sub stream most cars are under 100 px. Accept
  all skips them unless its "Skip images too small" box is cleared.
- **Lopsided classes (I51).** A class is never auto-filed past three times
  the images of the smallest filled class. The report page lists the
  images per class, and the status line warns when the dataset is already
  past that ratio.

### Spot check (I52)

The report page lists the latest auto-filed groups nobody has looked at
under "Check these automatic additions", each with its first image, class,
camera and time. Keep records an accepted draft. Remove first asks "Remove
this photo from training?" (Cancel or Remove), since there is no undo: it
deletes the images from the dataset and records a rejected draft. Both
count toward the class's kept rate, so a class that keeps failing spot
checks loses auto-filing on its own. Each Keep and Remove button is named
after its class and camera for screen readers.

## Model check (I45)

Once the model is trained and applying classes on its own, the background
worker compares its verdict for each described event with the draft and
appends `agree: true|false` to `.fork_model_checks.jsonl` beside the
dataset. The report's `model_check` block gives the agreement rate, per
class what the description said instead, and the latest disagreements,
and the Stats page shows the rate. A class whose rate keeps falling is
the one to retrain. Only class names, ids and a hash of the text are
stored.

## In Explore (I46)

The tracked object detail dialog shows the same draft above the
description, one line per custom model that classifies the event's label.
The line names the model in plain words ("Vehicle type", not
`vehicle_type`), then "Guess: suv", "97% sure" when Jev gave a score, an
"Add as suv" button (named "Add as suv for Vehicle type" for screen
readers, so two models' buttons differ) and "Your model thinks: sedan"
when the trained model has a verdict. Once filed it reads "In training as
suv", with "(added automatically)" for auto-filed events. With nothing
left to file it reads "Already sorted".

It reads `GET /classification/suggestions/event/{event_id}` (admin),
which also returns the train images still waiting for the event and what
it was already filed as. Adding goes through the confirm endpoint, so the
report sees it. The button stays busy until the line has refreshed. A 404
with the message "already accepted" (someone moved the images first)
reads as "Already sorted"; any other failure shows the server's message in
the error toast. Every outcome refreshes the line, so a stale Add button
never stays.

## Report page (I47)

`/classification/suggestions/{model}` (Stats link on the status line)
shows the report in plain words, with a one-line explanation under every
number and table: "Reviewed", "Guesses you accepted" (the kept rate),
"Added automatically" (auto-filed), "Model agrees with descriptions"
(model agreement) and "New since training" (I54). Accepts made through
"Accept all" (`bulk_accepted`) show as "Accepted in bulk (not counted)",
overall and as a column of the per-class table, since nobody looked at
each one and they never count toward the kept rate. Below come images per
class (I51), the spot check (I52), the tables by guessed class, camera and
source, the trained model's classes against the descriptions, and the
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
score, whether the suggestion was accepted unchanged, whether it came from
Accept all (`bulk`), the SHA-256 of the description, the new dataset file
names and the train file names they came from. Dataset files themselves keep
upstream's `{class}-{timestamp}-{random}.png` names, so this file is the
only link from a training image back to the event and text it came from.
That is what a later accuracy report reads. An undo appends
`{event_id, category, undo: true, files}`, where `files` are the images
moved back. It cancels every earlier line for that event and class, so the
undone confirmation leaves the report and the auto-file gate. A later
confirmation of the same event counts again. Labels made through the
multi-select toolbar go through upstream's categorize endpoint and are not
recorded.

## Endpoints

- `GET /classification/{name}/suggestions?ids=a,b` (admin): drafts for up to
  400 distinct events (each with a `maybe` when Jev leaned without drafting), plus whether Jev is enabled, configured, and how much
  of the day's budget is used. `omitted` counts the ids past 400 that were
  dropped (0 when none were). A longer page cannot spend more Jev requests:
  each answer is cached per description and every request is counted against
  `daily_request_limit` before it is sent.
- `POST /classification/{name}/suggestions/confirm` (admin): body
  `{event_id, category, training_files, source?, score?, suggested_category?,
  bulk?}`. Moves the files the same way upstream's categorize endpoint does
  and records the confirmation. Accept all sends `bulk: true`. When none of
  the files are left in the train folder it returns 404 with the message
  `already accepted`; when only some are missing the 404 says so and nothing
  moves.
- `POST /classification/{name}/suggestions/undo` (admin): body
  `{event_id, category, files}`, where `files` are the dataset names confirm
  returned in `moved` (bare names only; a path or `..` is a 400). Moves them
  back into the train folder under their original train names, skips any
  already gone, records the undo and returns `{success, message, restored}`.
  Confirm, undo and auto-filing hold one lock per model while they move a
  group and write its line, so they never interleave.
- `POST /classification/{name}/suggestions/spot-check` (admin, I52): body
  `{event_id, category, files, keep}`. Records the verdict and, with
  `keep: false`, deletes the files from the dataset.
- `GET /classification/{name}/suggestions/report` (admin, I42): reads the
  provenance file and returns, overall and per source, suggested class and
  camera, how many drafts were filed unchanged (`total`, `accepted`, `rate`)
  and, per class, `corrected_to` with the classes chosen instead.
  `bulk_accepted` (overall and per class) counts groups filed by Accept all
  and `auto_filed` those filed by I44; neither is in the rate. `undone`
  counts confirmations that were undone and left out of every count. A class
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
