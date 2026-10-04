/**
 * "Seen on other cameras" in the tracked object detail (fork UI145).
 *
 * For an object with a recognized face (sub label) or plate, the same name
 * or plate on the other cameras within a window around its time, drawn as a
 * strip with one lane per camera and as thumbnails that open the sighting.
 * With semantic search on, CLIP look-alikes from the same window follow,
 * labelled approximate since they match by appearance, not identity.
 * With nothing to look for, admins get a line naming the setting that
 * would change that. Flag `seenElsewhere`.
 */

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LuInfo, LuScanBarcode, LuScanFace } from "react-icons/lu";
import { baseUrl } from "@/api/baseUrl";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isForkEnabled } from "@/fork/flags";
import { useDateLocale } from "@/hooks/use-date-locale";
import { use24HourTime } from "@/hooks/use-date-utils";
import { resolveCameraName } from "@/hooks/use-camera-friendly-name";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useSeenElsewhere } from "@/hooks/fork/use-seen-elsewhere";
import { readJson, writeJson } from "@/lib/fork/local-storage";
import { phoneTouch } from "@/lib/fork/phone";
import {
  DEFAULT_SEEN_WINDOW,
  EXPLORE_SELECTED_KEY,
  SEEN_WINDOWS,
  SEEN_WINDOW_STORAGE_KEY,
  axisPercent,
  axisRange,
  cameraLanes,
  gapOf,
  isSeenWindow,
  sightingLink,
  type AxisRange,
  type CameraLane,
  type LaneMark,
  type SeenIdentity,
  type SeenSetup,
  type SeenWindow,
  type Sighting,
} from "@/lib/fork/seen-elsewhere";
import { cn } from "@/lib/utils";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { SearchResult } from "@/types/search";
import { formatUnixTimestampToDateTime } from "@/utils/dateUtil";

/** Width of the camera name column; the strip's guide line offsets by it. */
const LANE_LABEL = "6rem";

/** The settings page behind each feature the setup line names. */
const SETUP_PAGES = {
  face: "/settings?page=integrationFaceRecognition",
  plate: "/settings?page=integrationLpr",
  similar: "/settings?page=integrationSemanticSearch",
} as const;

type SeenElsewhereProps = {
  search: SearchResult;
};

export default function SeenElsewhere({
  search,
}: Readonly<SeenElsewhereProps>) {
  if (!isForkEnabled("seenElsewhere")) {
    return null;
  }
  // keyed by object, so another object never shows this one's answers while
  // its own load (the reads keep an earlier window's answer on screen)
  return <SeenElsewherePanel key={search.id} search={search} />;
}

function storedWindow(): SeenWindow {
  const stored = readJson<unknown>(
    SEEN_WINDOW_STORAGE_KEY,
    DEFAULT_SEEN_WINDOW,
  );
  return isSeenWindow(stored) ? stored : DEFAULT_SEEN_WINDOW;
}

/** Formats a time and an offset the way every part of the panel shows them. */
function useSightingText(config: FrigateConfig | undefined) {
  const { t } = useTranslation(["fork", "common"]);
  const locale = useDateLocale();
  const is24Hour = use24HourTime(config);
  const timeFormat = is24Hour
    ? t("time.formattedTimestampHourMinute.24hour", { ns: "common" })
    : t("time.formattedTimestampHourMinute.12hour", { ns: "common" });

  const timezone = config?.ui.timezone;
  const clock = useCallback(
    (timestamp: number) =>
      formatUnixTimestampToDateTime(timestamp, {
        ...(timezone ? { timezone } : {}),
        date_format: timeFormat,
        locale,
      }),
    [timezone, timeFormat, locale],
  );

  const when = useCallback(
    (offset: number) => {
      const gap = gapOf(offset);
      if (gap.direction === "same") {
        return t("seenElsewhere.gap.same");
      }
      let span: string;
      if (gap.hours === 0) {
        span = t("seenElsewhere.gap.minutes", { minutes: gap.minutes });
      } else if (gap.minutes === 0) {
        span = t("seenElsewhere.gap.hours", { hours: gap.hours });
      } else {
        span = t("seenElsewhere.gap.hoursMinutes", {
          hours: gap.hours,
          minutes: gap.minutes,
        });
      }
      return gap.direction === "earlier"
        ? t("seenElsewhere.gap.earlier", { gap: span })
        : t("seenElsewhere.gap.later", { gap: span });
    },
    [t],
  );

  const cameraName = useCallback(
    (camera: string) => resolveCameraName(config, camera),
    [config],
  );

  return { clock, when, cameraName };
}

type SightingText = ReturnType<typeof useSightingText>;

function SeenElsewherePanel({ search }: Readonly<SeenElsewhereProps>) {
  const { t } = useTranslation(["fork"]);
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = useIsAdmin();
  const [choice, setChoice] = useState<SeenWindow>(storedWindow);
  const seen = useSeenElsewhere(search, choice);
  const text = useSightingText(seen.config);

  const pickWindow = useCallback((value: string) => {
    if (isSeenWindow(value)) {
      setChoice(value);
      writeJson(SEEN_WINDOW_STORAGE_KEY, value);
    }
  }, []);

  const openSighting = useCallback(
    (id: string) => {
      const link = sightingLink(id);
      // Inside Explore the open object already owns a history entry, so the
      // jump takes its place and closing returns to the results. Elsewhere a
      // new entry keeps the page the dialog was opened from.
      const inExplore =
        (location.state as Record<string, unknown> | null)?.[
          EXPLORE_SELECTED_KEY
        ] !== undefined;
      void navigate(link.to, { state: link.state, replace: inExplore });
    },
    [location.state, navigate],
  );

  const { current, matched, similar, now } = seen;
  const lanes = useMemo(
    () => cameraLanes(current, matched, similar, now),
    [current, matched, similar, now],
  );
  const axis = useMemo(() => axisRange(lanes, seen.range), [lanes, seen.range]);

  if (!seen.active) {
    // viewers cannot change settings, so the line would only be noise
    return isAdmin && seen.setup ? <SetupLine setup={seen.setup} /> : null;
  }

  const windowPhrase = windowPhraseFor(choice, t);
  const hasIdentity = seen.identities.length > 0;
  const nothing = seen.matched.length === 0 && seen.similar.length === 0;
  // an empty last answer is not kept: its text would name the old window
  const loading =
    (hasIdentity && seen.loadingMatched) ||
    (!hasIdentity && seen.canSimilar && seen.loadingSimilar) ||
    (seen.refreshing && nothing);

  return (
    <section
      data-testid="seen-elsewhere"
      aria-labelledby="seen-elsewhere-title"
      aria-busy={loading || seen.refreshing}
      className="flex flex-col gap-3 rounded-lg border border-secondary-highlight/60 bg-background_alt/40 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id="seen-elsewhere-title"
          className="text-sm font-medium text-primary"
        >
          {t("seenElsewhere.title")}
        </h3>
        <ToggleGroup
          type="single"
          size="sm"
          value={choice}
          onValueChange={pickWindow}
          aria-label={t("seenElsewhere.windowLabel")}
          data-testid="seen-elsewhere-window"
          className="gap-0.5 rounded-md bg-secondary/60 p-0.5"
        >
          {SEEN_WINDOWS.map((option) => (
            <ToggleGroupItem
              key={option}
              value={option}
              aria-label={windowAriaFor(option, t)}
              className={cn(
                "h-7 px-2 text-xs data-[state=on]:bg-background data-[state=on]:text-primary data-[state=on]:shadow-sm focus-visible:ring-selected",
                phoneTouch && "h-11 min-w-11 px-2.5",
              )}
            >
              {windowShortFor(option, t)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {hasIdentity && (
        <IdentityChips identities={seen.identities} label={search.label} />
      )}

      {/* a new window keeps the last answer in place, dimmed, instead of
          collapsing to the placeholder and jumping the dialog's scroll */}
      <div
        className={cn(
          "flex flex-col gap-3 transition-opacity",
          seen.refreshing && "opacity-60",
        )}
      >
        {loading && <PanelSkeleton />}

        {!loading && seen.failed && (
          <p className="text-sm text-danger">{t("seenElsewhere.failed")}</p>
        )}

        {!loading && !seen.failed && nothing && (
          <div
            data-testid="seen-elsewhere-empty"
            className="rounded-md border border-dashed border-secondary-highlight px-3 py-4 text-center text-sm text-muted-foreground"
          >
            <p>
              {hasIdentity
                ? t("seenElsewhere.empty", { window: windowPhrase })
                : t("seenElsewhere.emptySimilar", { window: windowPhrase })}
            </p>
            {choice !== "day" && (
              <p className="mt-1 text-xs">{t("seenElsewhere.emptyHint")}</p>
            )}
          </div>
        )}

        {!loading && !nothing && (
          <CameraStrip
            lanes={lanes}
            axis={axis}
            text={text}
            onOpen={openSighting}
          />
        )}

        {!loading && seen.matched.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p
              className="text-xs text-muted-foreground"
              data-testid="seen-elsewhere-summary"
            >
              {/* a side came back full: say the list is the nearest part */}
              {seen.capped
                ? t("seenElsewhere.capped", { count: seen.matched.length })
                : t("seenElsewhere.summary", { count: seen.matched.length })}
            </p>
            <SightingCards
              testId="seen-elsewhere-matched"
              sightings={seen.matched}
              text={text}
              onOpen={openSighting}
            />
          </div>
        )}

        {seen.canSimilar && (hasIdentity ? !seen.loadingMatched : !loading) && (
          <SimilarSection
            sightings={seen.similar}
            loading={seen.loadingSimilar}
            showEmpty={hasIdentity}
            windowPhrase={windowPhrase}
            text={text}
            onOpen={openSighting}
          />
        )}
      </div>
    </section>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

const SETUP_LINK =
  "font-medium text-primary underline underline-offset-2 hover:text-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected";

/**
 * In the panel's place when it has nothing to look for: one line naming the
 * features that would let it follow this object, each linking to its page.
 */
function SetupLine({ setup }: Readonly<{ setup: SeenSetup }>) {
  return (
    <p
      data-testid="seen-elsewhere-setup"
      data-setup={setup}
      className="flex items-start gap-2 rounded-lg border border-dashed border-secondary-highlight/60 px-3 py-2 text-xs text-muted-foreground"
    >
      <LuInfo className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>{setupText(setup)}</span>
    </p>
  );
}

function setupText(setup: SeenSetup): ReactElement {
  const similar = <Link to={SETUP_PAGES.similar} className={SETUP_LINK} />;
  switch (setup) {
    case "face":
      return (
        <Trans
          ns="fork"
          i18nKey="seenElsewhere.setup.face"
          components={{
            face: <Link to={SETUP_PAGES.face} className={SETUP_LINK} />,
            similar,
          }}
        />
      );
    case "plate":
      return (
        <Trans
          ns="fork"
          i18nKey="seenElsewhere.setup.plate"
          components={{
            plate: <Link to={SETUP_PAGES.plate} className={SETUP_LINK} />,
            similar,
          }}
        />
      );
    case "similar":
      return (
        <Trans
          ns="fork"
          i18nKey="seenElsewhere.setup.similar"
          components={{ similar }}
        />
      );
  }
}

function windowShortFor(choice: SeenWindow, t: Translate): string {
  switch (choice) {
    case "15m":
      return t("seenElsewhere.window.15m");
    case "30m":
      return t("seenElsewhere.window.30m");
    case "1h":
      return t("seenElsewhere.window.1h");
    case "6h":
      return t("seenElsewhere.window.6h");
    case "day":
      return t("seenElsewhere.window.day");
  }
}

function windowAriaFor(choice: SeenWindow, t: Translate): string {
  switch (choice) {
    case "15m":
      return t("seenElsewhere.windowAria.15m");
    case "30m":
      return t("seenElsewhere.windowAria.30m");
    case "1h":
      return t("seenElsewhere.windowAria.1h");
    case "6h":
      return t("seenElsewhere.windowAria.6h");
    case "day":
      return t("seenElsewhere.windowAria.day");
  }
}

function windowPhraseFor(choice: SeenWindow, t: Translate): string {
  switch (choice) {
    case "15m":
      return t("seenElsewhere.windowPhrase.15m");
    case "30m":
      return t("seenElsewhere.windowPhrase.30m");
    case "1h":
      return t("seenElsewhere.windowPhrase.1h");
    case "6h":
      return t("seenElsewhere.windowPhrase.6h");
    case "day":
      return t("seenElsewhere.windowPhrase.day");
  }
}

type IdentityChipsProps = {
  identities: SeenIdentity[];
  label: string;
};

function IdentityChips({ identities, label }: Readonly<IdentityChipsProps>) {
  const { t } = useTranslation(["fork"]);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">
        {t("seenElsewhere.matchingOn")}
      </span>
      {identities.map((identity) => (
        <span
          key={identity.kind}
          data-testid={`seen-elsewhere-identity-${identity.kind}`}
          className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground"
        >
          {identity.kind === "plate" ? (
            <LuScanBarcode className="size-3.5" aria-hidden="true" />
          ) : (
            <LuScanFace className="size-3.5" aria-hidden="true" />
          )}
          <span className="sr-only">
            {identityKindLabel(identity, label, t)}
          </span>
          <span
            className={cn(
              "font-medium text-primary",
              identity.kind === "plate" && "font-mono tracking-wide",
            )}
          >
            {identity.value}
          </span>
        </span>
      ))}
    </div>
  );
}

function identityKindLabel(
  identity: SeenIdentity,
  label: string,
  t: Translate,
): string {
  if (identity.kind === "plate") {
    return t("seenElsewhere.identity.plate");
  }
  return label === "person"
    ? t("seenElsewhere.identity.face")
    : t("seenElsewhere.identity.name");
}

function PanelSkeleton() {
  const { t } = useTranslation(["fork"]);
  return (
    <output
      className="flex flex-col gap-2"
      aria-label={t("seenElsewhere.loading")}
      data-testid="seen-elsewhere-loading"
    >
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-2 flex-1" />
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <Skeleton className="aspect-square w-24" />
        <Skeleton className="aspect-square w-24" />
      </div>
    </output>
  );
}

type CameraStripProps = {
  lanes: CameraLane[];
  axis: AxisRange;
  text: SightingText;
  onOpen: (id: string) => void;
};

function CameraStrip({
  lanes,
  axis,
  text,
  onOpen,
}: Readonly<CameraStripProps>) {
  const { t } = useTranslation(["fork"]);
  // The sighting under the pointer or the keyboard focus is described in a
  // row under the strip. A floating tooltip opened over the panel's own
  // window picker, "Matching on" chips and lanes, and past the dialog edge.
  const [hovered, setHovered] = useState<LaneMark>();
  const [focused, setFocused] = useState<LaneMark>();
  const pointed = hovered ?? focused;
  // Once shown, the readout stays in the page, hidden, until another mark
  // replaces it. Removing it on blur, while focus was between two marks,
  // read to the dialog's focus trap as focus lost: it pulled focus back to
  // the top of the dialog, so Tab never got past the first mark.
  const [last, setLast] = useState<LaneMark>();
  const described = pointed ?? last;
  const hoverMark = useCallback((mark: LaneMark | undefined) => {
    setHovered(mark);
    if (mark) setLast(mark);
  }, []);
  const focusMark = useCallback((mark: LaneMark | undefined) => {
    setFocused(mark);
    if (mark) setLast(mark);
  }, []);
  const current = lanes
    .flatMap((lane) => lane.marks)
    .find((mark) => mark.kind === "current");
  const guide = current ? axisPercent(current.start, axis) / 100 : undefined;
  const kinds = new Set(lanes.flatMap((lane) => lane.marks.map((m) => m.kind)));
  const middle = (axis.start + axis.end) / 2;

  return (
    <div className="flex flex-col gap-1.5">
      <fieldset
        aria-label={t("seenElsewhere.timeline")}
        data-testid="seen-elsewhere-strip"
        // on a phone the lanes sit 44 px apart, so the marks' fingertip hit
        // areas meet without overlapping the next lane's
        className={cn(
          "relative m-0 flex min-w-0 flex-col border-0 p-0",
          phoneTouch ? "gap-4" : "gap-1",
        )}
      >
        {guide !== undefined && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-px bg-selected/50"
            style={{
              left: `calc(${LANE_LABEL} + 0.5rem + (100% - ${LANE_LABEL} - 0.5rem) * ${guide})`,
            }}
          />
        )}
        {lanes.map((lane) => (
          <div
            key={lane.camera}
            data-testid="seen-elsewhere-lane"
            data-camera={lane.camera}
            className="grid items-center gap-2"
            style={{ gridTemplateColumns: `${LANE_LABEL} 1fr` }}
          >
            <span
              className={cn(
                "truncate text-xs smart-capitalize",
                lane.current
                  ? "font-medium text-primary"
                  : "text-secondary-foreground",
              )}
              title={text.cameraName(lane.camera)}
            >
              {text.cameraName(lane.camera)}
            </span>
            <div
              className={cn(
                "relative rounded-full bg-secondary",
                phoneTouch ? "h-7" : "h-5",
              )}
            >
              {lane.marks.map((mark) => (
                <StripMark
                  key={mark.id}
                  mark={mark}
                  axis={axis}
                  camera={lane.camera}
                  text={text}
                  onOpen={onOpen}
                  onHover={hoverMark}
                  onFocusMark={focusMark}
                />
              ))}
            </div>
          </div>
        ))}
      </fieldset>
      <div
        aria-hidden="true"
        data-testid="seen-elsewhere-axis"
        className={cn(
          "flex justify-between tabular-nums text-muted-foreground",
          phoneTouch ? "text-xs" : "text-[10px]",
        )}
        style={{ marginLeft: `calc(${LANE_LABEL} + 0.5rem)` }}
      >
        <span>{text.clock(axis.start)}</span>
        <span>{text.clock(middle)}</span>
        <span>{text.clock(axis.end)}</span>
      </div>
      {/* one fixed-height row: the legend, or the sighting pointed at,
          stacked in one cell and swapped by visibility (see `last`) */}
      <div
        className={cn(
          "grid h-8 grid-cols-1 items-center text-muted-foreground",
          phoneTouch ? "text-xs" : "text-[11px]",
        )}
      >
        {described?.sighting && (
          <SightingReadout
            mark={described}
            sighting={described.sighting}
            camera={described.sighting.event.camera}
            text={text}
            shown={!!pointed}
          />
        )}
        <div
          data-testid="seen-elsewhere-legend"
          className={cn(
            "col-start-1 row-start-1 flex flex-wrap gap-x-3 gap-y-1",
            pointed && "invisible",
          )}
        >
          <LegendSwatch kind="current" label={t("seenElsewhere.legend.this")} />
          {kinds.has("matched") && (
            <LegendSwatch
              kind="matched"
              label={t("seenElsewhere.legend.matched")}
            />
          )}
          {kinds.has("similar") && (
            <LegendSwatch
              kind="similar"
              label={t("seenElsewhere.legend.similar")}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const MARK_CLASS: Record<LaneMark["kind"], string> = {
  current:
    "bg-selected ring-2 ring-selected/40 ring-offset-1 ring-offset-background",
  matched: "bg-primary/85 hover:bg-primary",
  similar:
    "border-2 border-dashed border-muted-foreground bg-background/60 hover:border-primary",
};

function LegendSwatch({
  kind,
  label,
}: Readonly<{ kind: LaneMark["kind"]; label: string }>) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn("inline-block size-2.5 rounded-full", MARK_CLASS[kind])}
      />
      {label}
    </span>
  );
}

type SightingReadoutProps = {
  mark: LaneMark;
  sighting: Sighting;
  camera: string;
  text: SightingText;
  /** Off once the pointer and focus leave; it stays mounted, invisible. */
  shown: boolean;
};

/**
 * The pointed-at sighting under the strip. Hidden from assistive tech: the
 * mark's own label already says the same when it takes focus.
 */
function SightingReadout({
  mark,
  sighting,
  camera,
  text,
  shown,
}: Readonly<SightingReadoutProps>) {
  const { t } = useTranslation(["fork"]);
  return (
    <div
      aria-hidden="true"
      data-testid="seen-elsewhere-readout"
      className={cn(
        "col-start-1 row-start-1 flex min-w-0 items-center gap-2",
        !shown && "invisible",
      )}
    >
      <span
        className={cn(
          "inline-block size-2.5 shrink-0 rounded-full",
          MARK_CLASS[mark.kind],
        )}
      />
      <img
        src={`${baseUrl}api/events/${sighting.event.id}/thumbnail.webp`}
        alt=""
        className="size-8 shrink-0 rounded object-cover"
      />
      <span className="truncate">
        <span className="font-medium text-primary smart-capitalize">
          {text.cameraName(camera)}
        </span>
        {" · "}
        {text.when(sighting.offset)} · {text.clock(sighting.event.start_time)}
        {sighting.similarity !== undefined &&
          ` · ${t("seenElsewhere.similar.match", {
            percent: Math.round(sighting.similarity * 100),
          })}`}
      </span>
    </div>
  );
}

type StripMarkProps = {
  mark: LaneMark;
  axis: AxisRange;
  camera: string;
  text: SightingText;
  onOpen: (id: string) => void;
  onHover: (mark: LaneMark | undefined) => void;
  onFocusMark: (mark: LaneMark | undefined) => void;
};

function StripMark({
  mark,
  axis,
  camera,
  text,
  onOpen,
  onHover,
  onFocusMark,
}: Readonly<StripMarkProps>) {
  const { t } = useTranslation(["fork"]);
  const left = axisPercent(mark.start, axis);
  const width = Math.max(axisPercent(mark.end, axis) - left, 0);
  const style = {
    // keep a short mark inside the track at the right edge
    left: `min(${left}%, calc(100% - 0.75rem))`,
    width: `${width}%`,
  };
  const className = cn(
    "absolute top-1/2 h-3 min-w-3 -translate-y-1/2 rounded-full transition-colors",
    MARK_CLASS[mark.kind],
  );

  if (mark.kind === "current" || !mark.sighting) {
    return (
      <span
        className={cn(className, "z-10")}
        style={style}
        data-testid="seen-elsewhere-mark-current"
      >
        <span className="sr-only">{t("seenElsewhere.legend.this")}</span>
      </span>
    );
  }

  const sighting = mark.sighting;
  return (
    <button
      type="button"
      className={cn(
        className,
        // ring-selected: the default theme's ring color is transparent
        "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        // a hit area around the dot that does not change how it looks:
        // 28 px tall with a mouse, 44 px for a fingertip
        "after:absolute after:content-['']",
        phoneTouch ? "after:-inset-4" : "after:-inset-2",
      )}
      style={style}
      aria-label={sightingLabel(sighting, camera, text, t)}
      data-testid="seen-elsewhere-mark"
      data-kind={mark.kind}
      onClick={() => onOpen(sighting.event.id)}
      onMouseEnter={() => onHover(mark)}
      onMouseLeave={() => onHover(undefined)}
      onFocus={() => onFocusMark(mark)}
      onBlur={() => onFocusMark(undefined)}
    />
  );
}

function sightingLabel(
  sighting: Sighting,
  camera: string,
  text: SightingText,
  t: Translate,
): string {
  return t("seenElsewhere.sightingAria", {
    when: text.when(sighting.offset),
    camera: text.cameraName(camera),
    time: text.clock(sighting.event.start_time),
  });
}

type SightingCardsProps = {
  testId: string;
  sightings: Sighting[];
  text: SightingText;
  onOpen: (id: string) => void;
};

function SightingCards({
  testId,
  sightings,
  text,
  onOpen,
}: Readonly<SightingCardsProps>) {
  const { t } = useTranslation(["fork"]);
  return (
    <ul
      data-testid={testId}
      className="scrollbar-container -mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
    >
      {sightings.map((sighting) => (
        <li key={sighting.event.id} className="shrink-0">
          <button
            type="button"
            data-testid="seen-elsewhere-card"
            aria-label={sightingLabel(sighting, sighting.event.camera, text, t)}
            onClick={() => onOpen(sighting.event.id)}
            className="group flex w-24 flex-col gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected"
          >
            <span className="relative block">
              <img
                src={`${baseUrl}api/events/${sighting.event.id}/thumbnail.webp`}
                alt=""
                loading="lazy"
                className={cn(
                  "aspect-square w-full rounded-md bg-secondary object-cover transition-opacity group-hover:opacity-90",
                  sighting.reasons.includes("similar") &&
                    "outline-dashed outline-2 -outline-offset-2 outline-muted-foreground/70",
                )}
              />
              {sighting.similarity !== undefined && (
                <span
                  className={cn(
                    "absolute bottom-1 right-1 rounded bg-background/85 px-1 font-medium tabular-nums text-primary",
                    phoneTouch ? "text-xs" : "text-[10px]",
                  )}
                >
                  {t("seenElsewhere.similar.match", {
                    percent: Math.round(sighting.similarity * 100),
                  })}
                </span>
              )}
            </span>
            <span className="truncate text-xs font-medium text-primary smart-capitalize">
              {text.cameraName(sighting.event.camera)}
            </span>
            <span
              className={cn(
                "truncate leading-tight text-muted-foreground",
                phoneTouch ? "text-xs" : "text-[11px]",
              )}
            >
              {text.when(sighting.offset)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

type SimilarSectionProps = {
  sightings: Sighting[];
  loading: boolean;
  /** Whether an empty answer is worth a line; alone, the panel says it. */
  showEmpty: boolean;
  windowPhrase: string;
  text: SightingText;
  onOpen: (id: string) => void;
};

function SimilarSection({
  sightings,
  loading,
  showEmpty,
  windowPhrase,
  text,
  onOpen,
}: Readonly<SimilarSectionProps>) {
  const { t } = useTranslation(["fork"]);
  if (!loading && sightings.length === 0 && !showEmpty) {
    return null;
  }
  return (
    <div
      className="flex flex-col gap-1.5 border-t border-secondary-highlight/60 pt-3"
      data-testid="seen-elsewhere-similar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-primary">
          {t("seenElsewhere.similar.title")}
        </span>
        <span
          className={cn(
            "rounded-full border border-dashed border-muted-foreground/70 px-1.5 uppercase tracking-wide text-muted-foreground",
            phoneTouch ? "text-xs" : "text-[10px]",
          )}
        >
          {t("seenElsewhere.similar.approximate")}
        </span>
      </div>
      <p
        className={cn(
          "text-muted-foreground",
          phoneTouch ? "text-xs" : "text-[11px]",
        )}
      >
        {t("seenElsewhere.similar.note")}
      </p>
      {loading && (
        <div className="flex gap-2">
          <Skeleton className="aspect-square w-24" />
          <Skeleton className="aspect-square w-24" />
        </div>
      )}
      {!loading && sightings.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("seenElsewhere.similar.empty", { window: windowPhrase })}
        </p>
      )}
      {!loading && sightings.length > 0 && (
        <SightingCards
          testId="seen-elsewhere-similar-cards"
          sightings={sightings}
          text={text}
          onOpen={onOpen}
        />
      )}
    </div>
  );
}
