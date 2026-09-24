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
};

export type Acceptance = {
  total: number;
  accepted: number;
  rate: number | null;
};

export type ClassAcceptance = Acceptance & {
  corrected_to: Record<string, number>;
};

/** The acceptance report over the provenance file (fork I42). */
export type SuggestionReport = Acceptance & {
  model: string;
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
): ConfirmSuggestionBody {
  return {
    event_id: eventId,
    category,
    training_files: files,
    source: suggestion.source,
    score: suggestion.score,
    suggested_category: suggestion.category,
  };
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
