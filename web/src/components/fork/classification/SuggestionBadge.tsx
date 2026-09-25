/**
 * The suggested class on a train grid card, with one-click accept (fork I41).
 *
 * Renders in the card's bottom label row, in place of upstream's "None", so
 * the image stays clear. The class name opens a popover with the score, the
 * source and the sentence that matched. The check files every image of the
 * event under the suggested class through the fork's confirm endpoint, which
 * also records which suggestion led to the label. Editing stays on the
 * card's existing class picker.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuCircleHelp, LuShrink, LuTag } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { phoneTouch } from "@/lib/fork/phone";
import { phoneHitArea } from "@/lib/fork/phone-target";
import { useConfirmSuggestion } from "@/hooks/fork/use-confirm-suggestion";
import {
  allTooSmall,
  percent,
  type EventSuggestion,
} from "@/lib/fork/classification-suggestions";

type SuggestionBadgeProps = {
  modelName: string;
  eventId: string;
  files: string[];
  entry: EventSuggestion | undefined;
  onRefresh: () => void;
  /** Train images under 100 px on a side, flagged on the badge (fork I50). */
  tooSmall?: string[];
  /** Blocks accepting while the page files other cards. */
  disabled?: boolean;
};

const ACCEPT_SELECTOR = '[data-testid="suggestion-accept"]';

/**
 * The next card's Accept check, kept while that card is still disabled by
 * the page-level filing state, so it takes focus once it is enabled again.
 */
let pendingFocus: HTMLButtonElement | null = null;

/** Dataset folder names use underscores for spaces; the case stays as typed. */
function displayClass(name: string): string {
  return name.replace(/_+/g, " ").trim() || name;
}

type Confidence = "high" | "medium" | "low";

function confidence(score: number | null): Confidence | null {
  if (score == null) {
    return null;
  }
  if (score >= 0.85) {
    return "high";
  }
  return score >= 0.6 ? "medium" : "low";
}

/** The Accept check after `current` in the grid, for keyboard review. */
function nextAccept(current: HTMLElement): HTMLButtonElement | null {
  const root = current.closest<HTMLElement>(".grid") ?? current.ownerDocument;
  const all = Array.from(
    root.querySelectorAll<HTMLButtonElement>(ACCEPT_SELECTOR),
  );
  const index = all.indexOf(current as HTMLButtonElement);
  return index < 0 ? null : (all[index + 1] ?? null);
}

function focusWhenReady(button: HTMLButtonElement) {
  if (button.isConnected && !button.disabled) {
    button.focus();
    return;
  }
  pendingFocus = button;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** The evidence sentence with the words of the class name marked. */
function highlight(evidence: string, category: string): ReactNode[] {
  const words = category
    .split(/[\s_-]+/)
    .filter((word) => word.length > 1)
    .map(escapeRegExp);
  if (words.length === 0) {
    return [evidence];
  }
  const pattern = new RegExp(String.raw`\b(${words.join("|")})(e?s)?\b`, "gi");
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of evidence.matchAll(pattern)) {
    const start = match.index;
    if (start > last) {
      parts.push(evidence.slice(last, start));
    }
    parts.push(
      <mark
        key={start}
        className="rounded-sm bg-selected/25 px-0.5 text-primary"
      >
        {match[0]}
      </mark>,
    );
    last = start + match[0].length;
  }
  if (last < evidence.length) {
    parts.push(evidence.slice(last));
  }
  return parts;
}

// The card behind the badge opens its detail view on click; clicks here,
// including those in the portaled popover, are the badge's own.
const stop = (e: MouseEvent) => e.stopPropagation();

export default function SuggestionBadge({
  modelName,
  eventId,
  files,
  entry,
  onRefresh,
  tooSmall,
  disabled = false,
}: Readonly<SuggestionBadgeProps>) {
  const { t } = useTranslation(["fork"]);
  const [pending, setPending] = useState(false);
  const acceptRef = useRef<HTMLButtonElement>(null);

  const suggestion = entry?.suggestion ?? null;
  const tiny = allTooSmall(files, tooSmall);

  useEffect(() => {
    const button = acceptRef.current;
    if (!disabled && button && pendingFocus === button) {
      pendingFocus = null;
      button.focus();
    }
  }, [disabled]);

  const confirmSuggestion = useConfirmSuggestion(modelName, onRefresh);
  const confirm = useCallback(async () => {
    if (!suggestion || pending || disabled) {
      return;
    }
    const current = acceptRef.current;
    const next = current ? nextAccept(current) : null;
    setPending(true);
    let filed = false;
    try {
      filed = await confirmSuggestion(eventId, files, suggestion);
    } finally {
      setPending(false);
    }
    if (filed && next) {
      focusWhenReady(next);
    }
  }, [suggestion, pending, disabled, confirmSuggestion, eventId, files]);

  if (!entry) {
    return null;
  }

  if (!suggestion) {
    if (!entry.conflict) {
      return null;
    }
    const names = {
      text: displayClass(entry.text?.category ?? ""),
      jev: displayClass(entry.jev?.category ?? ""),
    };
    const short = t("classificationSuggestions.conflictShort", names);
    return (
      <div
        data-testid="suggestion-conflict"
        className="flex min-w-0 max-w-full select-none text-sm text-white"
      >
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("classificationSuggestions.conflictWhy", names)}
              className="flex min-w-0 items-center gap-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={stop}
            >
              <LuCircleHelp className="size-4 shrink-0" aria-hidden />
              <span className="truncate smart-capitalize" title={short}>
                {short}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="text-sm" onClick={stop}>
            {t("classificationSuggestions.conflict", names)}
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  const category = displayClass(suggestion.category);
  const score = percent(suggestion);
  const tone = confidence(suggestion.score);
  const toneLabels: Record<Confidence, string> = {
    high: t("classificationSuggestions.confidenceHigh"),
    medium: t("classificationSuggestions.confidenceMedium"),
    low: t("classificationSuggestions.confidenceLow"),
  };
  const sourceLabel = t(
    suggestion.source === "jev"
      ? "classificationSuggestions.fromJev"
      : "classificationSuggestions.fromDescription",
  );

  return (
    <div
      data-testid="suggestion-badge"
      className={cn(
        "flex min-w-0 max-w-full select-none items-center gap-1.5 text-sm text-white",
        phoneTouch && "gap-3",
      )}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("classificationSuggestions.why", { category })}
            className="flex min-w-0 items-center gap-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={stop}
          >
            {/* The class name always wins the space; the tag yields on narrow cards. */}
            <LuTag
              className="size-3.5 shrink-0 text-white/80 [@container(max-width:11rem)]:hidden"
              aria-hidden
            />
            <span className="truncate smart-capitalize" title={category}>
              {category}
            </span>
            <span className="shrink-0 text-white/70" aria-hidden>
              ?
            </span>
            {tone && (
              <span
                data-testid="suggestion-confidence"
                title={toneLabels[tone]}
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  tone === "high" && "bg-green-500",
                  tone === "medium" && "bg-amber-400",
                  tone === "low" && "bg-gray-400",
                )}
              />
            )}
            {tiny && (
              // Always on the photo's dark gradient, so a fixed bright amber
              // reads in every theme.
              <LuShrink
                data-testid="suggestion-too-small"
                aria-label={t("classificationSuggestions.tooSmall")}
                className="size-3.5 shrink-0 text-amber-400"
              />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          data-testid="suggestion-why"
          className="w-auto max-w-72 space-y-1 text-sm"
          onClick={stop}
        >
          <div className="font-medium smart-capitalize">
            {score == null
              ? category
              : t("classificationSuggestions.scoreLine", { category, score })}
          </div>
          <div className="text-secondary-foreground">{sourceLabel}</div>
          {suggestion.evidence && (
            <p>{highlight(suggestion.evidence, suggestion.category)}</p>
          )}
          {tiny && (
            <div className="flex items-center gap-1 text-warning">
              <LuShrink className="size-3.5 shrink-0" aria-hidden />
              {t("classificationSuggestions.tooSmall")}
            </div>
          )}
        </PopoverContent>
      </Popover>
      <Button
        ref={acceptRef}
        data-testid="suggestion-accept"
        size="xs"
        variant="select"
        aria-label={t("classificationSuggestions.confirm", { category })}
        className={cn(
          "size-5 shrink-0 rounded",
          phoneHitArea,
          pending && "opacity-60",
        )}
        disabled={pending || disabled}
        onClick={(e) => {
          e.stopPropagation();
          void confirm();
        }}
      >
        <LuCheck className="size-3.5" />
      </Button>
    </div>
  );
}
