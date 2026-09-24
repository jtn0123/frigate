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

/** The confirm request for accepting a draft as-is on every image of an event. */
export function confirmBody(
  eventId: string,
  files: string[],
  suggestion: Suggestion,
): ConfirmSuggestionBody {
  return {
    event_id: eventId,
    category: suggestion.category,
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
