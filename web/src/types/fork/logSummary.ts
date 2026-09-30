/**
 * Fork (I58): the /fork/log_summary response behind the Logs page's
 * "Repeated messages" panel. Hand-written until the path is in api.gen.ts.
 */

export type LogSummaryService = "frigate" | "go2rtc";

export type LogSummaryLevel = "info" | "warning" | "error";

export type LogSummaryGroup = {
  /** Null when no camera could be told from the lines. */
  camera: string | null;
  service: LogSummaryService;
  /** Unix timestamp of the start of the hour the lines fall in. */
  hour: number;
  level: LogSummaryLevel;
  count: number;
  first: number;
  last: number;
  /** One example, already stripped of credentials and query strings. */
  message: string;
  /** The message with its numbers replaced; equal across hours. */
  signature: string;
};

export type LogSummarySource = {
  available: boolean;
  /** Only the end of the file was read because of its size. */
  partial: boolean;
  lines: number;
  covered_from: number | null;
  covered_to: number | null;
};

export type LogSummaryResponse = {
  hours: number;
  start: number;
  end: number;
  /** How far back the logs actually reach inside the window. */
  covered_from: number | null;
  sources: Partial<Record<LogSummaryService, LogSummarySource>>;
  total: number;
  unattributed: number;
  cameras: Record<string, number>;
  truncated: boolean;
  groups: LogSummaryGroup[];
};

/** One message a camera repeated, with its hours added up. */
export type LogSummaryRow = {
  key: string;
  camera: string | null;
  level: LogSummaryLevel;
  count: number;
  first: number;
  last: number;
  message: string;
};
