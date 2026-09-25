/**
 * Suggested dataset classes for a custom model's train images (fork I41).
 *
 * The backend reads each event's description, locally and optionally through
 * Jev, and drafts one of the model's classes. These helpers shape the SWR key
 * and the confirm request; the badge component renders them.
 */

export type SuggestionSource = "text" | "jev";

export type Suggestion = {
  category: string;
  source: SuggestionSource;
  score: number | null;
  evidence: string;
};

export type EventSuggestion = {
  text: Suggestion | null;
  jev: Suggestion | null;
  jev_status: string;
  suggestion: Suggestion | null;
  conflict: boolean;
};

export type JevState = {
  enabled: boolean;
  configured: boolean;
  used_today: number;
  daily_request_limit: number;
};

export type ClassificationSuggestionsResponse = {
  model: string;
  classes: string[];
  jev: JevState;
  suggestions: Record<string, EventSuggestion>;
  /** Train images under 100 px on a side, keyed by event (fork I50). */
  too_small?: Record<string, string[]>;
  /** Ids past the server's cap, left without a draft this time. */
  omitted?: number;
};

export type Acceptance = {
  total: number;
  accepted: number;
  rate: number | null;
};

export type ClassAcceptance = Acceptance & {
  corrected_to: Record<string, number>;
  /** Images filed without review (fork I44), kept out of the rate. */
  auto_filed?: number;
  /** Drafts accepted through Accept all. */
  bulk_accepted?: number;
};

export type Disagreement = {
  time: number | null;
  event_id: string | null;
  camera: string | null;
  model_said: string;
  draft: string;
};

/** The trained model's verdicts against the drafts (fork I45). */
export type ModelCheck = Acceptance & {
  classes: Record<string, ClassAcceptance>;
  recent_disagreements: Disagreement[];
};

/** Images per dataset class and whether one dwarfs another (fork I51). */
export type DatasetBalance = {
  classes: Record<string, number>;
  empty: string[];
  largest: string | null;
  smallest: string | null;
  ratio: number | null;
  lopsided: boolean;
};

/** Images added since the model was last trained (fork I54). */
export type TrainingGap = {
  has_trained: boolean;
  last_training_date: string | null;
  current_images: number;
  new_images: number;
};

/** One event's images filed without review, for a spot check (fork I52). */
export type AutoFiledGroup = {
  time: number | null;
  event_id: string | null;
  camera: string | null;
  category: string;
  source: string | null;
  score: number | null;
  files: string[];
};

/** The acceptance report over the provenance file (fork I42). */
export type SuggestionReport = Acceptance & {
  model_check?: ModelCheck;
  dataset?: DatasetBalance;
  training?: TrainingGap;
  recent_auto_filed?: AutoFiledGroup[];
  model: string;
  /** Images filed without review (fork I44), kept out of the rate. */
  auto_filed?: number;
  /** Drafts accepted through Accept all. */
  bulk_accepted?: number;
  sources: Record<string, Acceptance>;
  classes: Record<string, ClassAcceptance>;
  cameras: Record<string, Acceptance>;
  first_time: number | null;
  last_time: number | null;
};

export type ConfirmSuggestionBody = {
  event_id: string;
  category: string;
  training_files: string[];
  source: SuggestionSource | null;
  score: number | null;
  suggested_category: string | null;
  /** Sent by Accept all, so the report can tell bulk accepts apart. */
  bulk?: boolean;
};

/** Moves an accepted group's dataset files back to the train folder. */
export type UndoSuggestionBody = {
  event_id: string;
  category: string;
  files: string[];
};

/** The SWR key for one page of the grid, or null when there is nothing to ask. */
export function suggestionsKey(
  modelName: string,
  eventIds: string,
): [string, { ids: string }] | null {
  if (!modelName || !eventIds) {
    return null;
  }
  return [`classification/${modelName}/suggestions`, { ids: eventIds }];
}

/**
 * The confirm request for filing images of an event that had a draft. With
 * no category the draft is accepted as-is; with one, the person overrode it
 * and the record shows the draft next to what they chose.
 */
export function confirmBody(
  eventId: string,
  files: string[],
  suggestion: Suggestion,
  category: string = suggestion.category,
  bulk = false,
): ConfirmSuggestionBody {
  return {
    event_id: eventId,
    category,
    training_files: files,
    source: suggestion.source,
    score: suggestion.score,
    suggested_category: suggestion.category,
    ...(bulk ? { bulk: true } : {}),
  };
}

/**
 * Whether a failed confirm only means the group was filed already, by
 * another tab, a double tap or the background worker. The server answers
 * 404 with this message; callers count it as done.
 */
export function isAlreadyAccepted(status: number | undefined, data: unknown) {
  return (
    status === 404 &&
    typeof data === "object" &&
    data != null &&
    (data as { message?: unknown }).message === "already accepted"
  );
}

/** The server's own message from an error response, when it sent one. */
export function serverMessage(data: unknown): string | undefined {
  if (typeof data !== "object" || data == null) {
    return undefined;
  }
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" && message ? message : undefined;
}

/** A whole-percent score for display, or null when the source has none. */
export function percent(suggestion: Suggestion): number | null {
  return suggestion.score == null ? null : Math.round(suggestion.score * 100);
}

/**
 * Props that route the class picker through the confirm endpoint when the
 * event has a draft, so a hand-picked class is recorded as a correction.
 * Without a draft the picker keeps upstream's categorize call.
 */
export function pickerProps(
  entry: EventSuggestion | undefined,
  run: (suggestion: Suggestion, category: string) => void,
): { onCategorize?: (category: string) => void } {
  const suggestion = entry?.suggestion;
  if (!suggestion) {
    return {};
  }
  return { onCategorize: (category: string) => run(suggestion, category) };
}

/** The SWR key of the acceptance report, or null without a model. */
export function reportKey(modelName: string): string | null {
  return modelName ? `classification/${modelName}/suggestions/report` : null;
}

/** How many events on the page have a draft to confirm. */
export function draftCount(
  suggestions: Record<string, EventSuggestion> | undefined,
): number {
  return Object.values(suggestions ?? {}).filter((entry) => entry.suggestion)
    .length;
}

export type DraftToFile = {
  eventId: string;
  files: string[];
  suggestion: Suggestion;
};

/**
 * Whether every train image of an event is under 100 px on a side (fork
 * I50). A warning for the person filing, never a block: upstream saves
 * these crops at the detect stream's size, so on a sub stream most cars
 * are that small.
 */
export function allTooSmall(
  files: string[],
  tooSmall: string[] | undefined,
): boolean {
  return (
    files.length > 0 &&
    tooSmall != null &&
    files.every((file) => tooSmall.includes(file))
  );
}

/** Every event on the page with a draft and its train images, for file-all. */
export function draftsToFile(
  suggestions: Record<string, EventSuggestion> | undefined,
  groups: Record<string, { filename: string }[]>,
): DraftToFile[] {
  const drafts: DraftToFile[] = [];
  for (const [eventId, items] of Object.entries(groups)) {
    const suggestion = suggestions?.[eventId]?.suggestion;
    const files = items.map((item) => item.filename);
    if (suggestion && files.length > 0) {
      drafts.push({ eventId, files, suggestion });
    }
  }
  return drafts;
}

/** How many images the drafts cover (fork I50: counts read in photos). */
export function draftImageCount(drafts: DraftToFile[]): number {
  return drafts.reduce((sum, draft) => sum + draft.files.length, 0);
}

/** The images of the drafts whose every crop is tiny (fork I50). */
export function tinyImageCount(
  drafts: DraftToFile[],
  tooSmall: Record<string, string[]> | undefined,
): number {
  return draftImageCount(
    drafts.filter((draft) =>
      allTooSmall(draft.files, tooSmall?.[draft.eventId]),
    ),
  );
}

/**
 * The drafts Accept all files: every one, or with skipTiny those that have
 * at least one image big enough to teach the model something (fork I50).
 */
export function draftsToRun(
  drafts: DraftToFile[],
  tooSmall: Record<string, string[]> | undefined,
  skipTiny: boolean,
): DraftToFile[] {
  if (!skipTiny) {
    return drafts;
  }
  return drafts.filter(
    (draft) => !allTooSmall(draft.files, tooSmall?.[draft.eventId]),
  );
}

/** Drafts per suggested class, largest first, for Accept all's preview. */
export function draftsPerClass(drafts: DraftToFile[]): [string, number][] {
  const counts: Record<string, number> = {};
  for (const draft of drafts) {
    const category = draft.suggestion.category;
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}

/**
 * Images on the page, and how many of them the server answered for: ids
 * past its cap come back without an entry (fork I41).
 */
export function answeredImageCount(
  suggestions: Record<string, EventSuggestion> | undefined,
  groups: Record<string, { filename: string }[]>,
): { answered: number; total: number } {
  let answered = 0;
  let total = 0;
  for (const [eventId, items] of Object.entries(groups)) {
    total += items.length;
    if (suggestions?.[eventId]) {
      answered += items.length;
    }
  }
  return { answered, total };
}

/**
 * The model's confidence in an event: the best score among its train
 * images, which upstream writes into each file name (fork I49).
 */
export function groupScore(group: { score?: number }[]): number {
  let best = 0;
  for (const item of group) {
    if (
      item.score != null &&
      Number.isFinite(item.score) &&
      item.score > best
    ) {
      best = item.score;
    }
  }
  return best;
}

/**
 * The grid's groups in display order. Upstream lists newest first; with
 * unsureFirst the events the model was least sure about come first, since
 * those teach it the most, and ties keep the newest-first order (fork I49).
 */
export function orderGroups<T extends { score?: number }>(
  groups: Record<string, T[]>,
  unsureFirst: boolean,
): [string, T[]][] {
  const entries = Object.entries(groups);
  if (!unsureFirst) {
    return entries;
  }
  return entries
    .map((entry, index) => ({ entry, index, score: groupScore(entry[1]) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.entry);
}

/** Where a dataset image is served from (fork I52). */
export function datasetImagePath(
  model: string,
  category: string,
  file: string,
): string {
  return `clips/${model}/dataset/${encodeURIComponent(category)}/${encodeURIComponent(file)}`;
}

/** What an event's train images were filed as (fork I46). */
export type FiledEntry = { category: string; auto: boolean };

/** One custom model's view of one event (fork I46). */
export type EventModelSuggestion = {
  model: string;
  classes: string[];
  suggestion: EventSuggestion;
  training_files: string[];
  model_said: string | null;
  filed: FiledEntry | null;
  /** Train images under 100 px on a side (fork I50). */
  too_small?: string[];
};

export type EventSuggestionsResponse = {
  event_id: string;
  models: EventModelSuggestion[];
};

/** SWR key of the per-event drafts, for the Explore detail dialog. */
export function eventSuggestionsKey(eventId: string) {
  return `classification/suggestions/event/${encodeURIComponent(eventId)}`;
}

/** "vehicle_type" reads as "Vehicle type"; the raw id means nothing to people. */
export function modelLabel(model: string): string {
  const words = model.replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
