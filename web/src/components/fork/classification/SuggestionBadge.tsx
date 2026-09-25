/**
 * The suggested class on a train grid card, with one-click accept (fork I41).
 *
 * Renders in the card's bottom label row, in place of upstream's "None", so
 * the image stays clear. Four states: a sure guess with an Accept check, a
 * "maybe" (a weaker lean the person confirms by hand), two sources that
 * disagree, and no guess at all. Each opens a popover that says why and
 * lists the model's classes as one-tap buttons, so a wrong or missing guess
 * is fixed without opening the photo. Filing goes through the fork's confirm
 * endpoint, which records which suggestion, if any, led to the label.
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
  noGuessReason,
  percent,
  pickableClasses,
  type EventSuggestion,
  type Suggestion,
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
  /** The model's classes, offered as one-tap picks in the popover. */
  classes?: string[];
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

type ClassPickerProps = {
  classes: string[];
  /** Shown first and highlighted: the guess, or the two disputed classes. */
  preferred: string[];
  disabled: boolean;
  /** No sure guess to offer an alternative to, so the label drops "Or". */
  only: boolean;
  onPick: (category: string) => void;
};

/** The model's classes as buttons; one tap files the event under it. */
function ClassPicker({
  classes,
  preferred,
  disabled,
  only,
  onPick,
}: Readonly<ClassPickerProps>) {
  const { t } = useTranslation(["fork"]);
  if (classes.length === 0) {
    return null;
  }
  const wanted = new Set(preferred.map((name) => name.toLowerCase()));
  const ordered = [
    ...classes.filter((name) => wanted.has(name.toLowerCase())),
    ...classes.filter((name) => !wanted.has(name.toLowerCase())),
  ];
  return (
    <div data-testid="suggestion-picker" className="space-y-1.5 pt-1">
      <div className="text-xs text-secondary-foreground">
        {only
          ? t("classificationSuggestions.pickOnlyLabel")
          : t("classificationSuggestions.pickLabel")}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ordered.map((name) => {
          const label = displayClass(name);
          return (
            <Button
              key={name}
              size="sm"
              variant={wanted.has(name.toLowerCase()) ? "select" : "outline"}
              className={cn("h-8 px-3 smart-capitalize", phoneHitArea)}
              disabled={disabled}
              aria-label={t("classificationSuggestions.pickAria", {
                category: label,
              })}
              onClick={(e) => {
                e.stopPropagation();
                onPick(name);
              }}
            >
              {label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export default function SuggestionBadge({
  modelName,
  eventId,
  files,
  entry,
  onRefresh,
  tooSmall,
  disabled = false,
  classes,
}: Readonly<SuggestionBadgeProps>) {
  const { t } = useTranslation(["fork"]);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const acceptRef = useRef<HTMLButtonElement>(null);

  const suggestion = entry?.suggestion ?? null;
  const tiny = allTooSmall(files, tooSmall);
  const choices = pickableClasses(classes);

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

  // A hand pick from the popover. Only a sure draft is recorded as the
  // suggestion (so an override shows beside it); maybes and blanks are not,
  // which keeps them out of the kept rate.
  const pick = useCallback(
    async (category: string) => {
      if (pending || disabled) {
        return;
      }
      setOpen(false);
      setPending(true);
      try {
        await confirmSuggestion(eventId, files, suggestion, category);
      } finally {
        setPending(false);
      }
    },
    [pending, disabled, confirmSuggestion, eventId, files, suggestion],
  );
  const picker = (preferred: string[], only = false) => (
    <ClassPicker
      classes={choices}
      preferred={preferred}
      disabled={pending || disabled}
      only={only}
      onPick={(category) => void pick(category)}
    />
  );
  const tinyNote = tiny && (
    <div className="flex items-center gap-1 text-warning">
      <LuShrink className="size-3.5 shrink-0" aria-hidden />
      {t("classificationSuggestions.tooSmall")}
    </div>
  );

  if (!entry) {
    return null;
  }

  if (!suggestion && !entry.conflict) {
    const maybe = entry.maybe ?? null;
    return (
      <MaybeOrBlank
        maybe={maybe}
        reason={t(`classificationSuggestions.${noGuessReason(entry)}`)}
        open={open}
        onOpenChange={setOpen}
        pending={pending}
        tinyNote={tinyNote}
        picker={picker(maybe ? [maybe.category] : [], true)}
      />
    );
  }

  if (!suggestion) {
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
        <Popover open={open} onOpenChange={setOpen}>
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
          <PopoverContent
            data-testid="suggestion-why"
            className="w-auto max-w-72 space-y-1 text-sm"
            collisionPadding={8}
            onClick={stop}
          >
            <p>{t("classificationSuggestions.conflict", names)}</p>
            {picker([entry.text?.category ?? "", entry.jev?.category ?? ""])}
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
      <Popover open={open} onOpenChange={setOpen}>
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
          collisionPadding={8}
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
          {tinyNote}
          {picker([suggestion.category])}
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

type MaybeOrBlankProps = {
  maybe: Suggestion | null;
  reason: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  tinyNote: ReactNode;
  picker: ReactNode;
};

/**
 * A card without a sure guess: "Sedan, maybe" when Jev leaned one way, or
 * "Pick a class" when nothing in the description said. Both open the same
 * popover with the reason and the class buttons; neither files on its own.
 */
function MaybeOrBlank({
  maybe,
  reason,
  open,
  onOpenChange,
  pending,
  tinyNote,
  picker,
}: Readonly<MaybeOrBlankProps>) {
  const { t } = useTranslation(["fork"]);
  const category = maybe ? displayClass(maybe.category) : "";
  const score = maybe ? percent(maybe) : null;
  const label = maybe
    ? t("classificationSuggestions.maybeLabel", { category })
    : t("classificationSuggestions.pickClass");
  return (
    <div
      data-testid={maybe ? "suggestion-maybe" : "suggestion-blank"}
      className={cn(
        "flex min-w-0 max-w-full select-none text-sm text-white",
        pending && "opacity-60",
      )}
    >
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={
              maybe
                ? t("classificationSuggestions.why", { category })
                : t("classificationSuggestions.pickClass")
            }
            className="flex min-h-7 min-w-0 items-center gap-1 rounded-md border border-dashed border-white/60 px-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={stop}
          >
            <LuTag
              className="size-3.5 shrink-0 text-white/80 [@container(max-width:11rem)]:hidden"
              aria-hidden
            />
            <span className="truncate first-letter:uppercase" title={label}>
              {label}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          data-testid="suggestion-why"
          className="w-auto max-w-72 space-y-1 text-sm"
          collisionPadding={8}
          onClick={stop}
        >
          {maybe && (
            <div className="font-medium smart-capitalize">
              {score == null
                ? category
                : t("classificationSuggestions.scoreLine", { category, score })}
            </div>
          )}
          <p className="text-secondary-foreground">
            {maybe ? t("classificationSuggestions.maybeWhy") : reason}
          </p>
          {tinyNote}
          {picker}
        </PopoverContent>
      </Popover>
    </div>
  );
}
