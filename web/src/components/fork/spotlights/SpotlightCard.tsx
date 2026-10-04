/**
 * One Spotlights card (fork, UI144): the review thumbnail with its hover
 * preview, what happened, where, the chips that say why it ranks where it
 * does, and the actions that matter from here. A card stands for a group of
 * repeats of one subject: it shows the best one and lists the rest on demand.
 */

import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  LuCheck,
  LuChevronDown,
  LuHistory,
  LuSearch,
  LuVideo,
} from "react-icons/lu";
import PreviewThumbnailPlayer from "@/components/player/PreviewThumbnailPlayer";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { resolveCameraName } from "@/hooks/use-camera-friendly-name";
import { useDateLocale } from "@/hooks/use-date-locale";
import { use24HourTime } from "@/hooks/use-date-utils";
import { resolveZoneName } from "@/hooks/use-zone-friendly-name";
import {
  cardReasons,
  groupMembers,
  isUnreviewed,
  type SpotlightGroup,
  type SpotlightItem,
} from "@/lib/fork/spotlights";
import { cn } from "@/lib/utils";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { Preview } from "@/types/preview";
import type { ReviewSegment } from "@/types/review";
import type { TimeRange } from "@/types/timeline";
import { formatUnixTimestampToDateTime } from "@/utils/dateUtil";
import { formatList } from "@/utils/stringUtil";
import {
  findSimilarPath,
  itemTitle,
  reasonLook,
  type ChipLook,
  type Translate,
} from "./spotlight-look";

function ReasonChip({ look }: Readonly<{ look: ChipLook }>) {
  const Icon = look.icon;
  return (
    <li
      data-testid="spotlight-reason"
      title={look.title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        look.tone,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{look.text}</span>
    </li>
  );
}

/** A small mark for an item nobody has reviewed yet, colored by severity. */
function UnreviewedDot({ item }: Readonly<{ item: SpotlightItem }>) {
  const { t } = useTranslation(["fork"]);
  return (
    <span
      data-testid="spotlight-unreviewed"
      title={t("spotlights.reasons.unreviewed")}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        item.review.severity === "alert"
          ? "bg-severity_alert"
          : "bg-severity_detection",
      )}
    >
      <span className="sr-only">{t("spotlights.reasons.unreviewed")}</span>
    </span>
  );
}

type RepeatsProps = {
  others: readonly SpotlightItem[];
  config: FrigateConfig | undefined;
  onOpen: (review: ReviewSegment) => void;
};

/**
 * The other members of a group, newest first, one line each. They open in a
 * popover rather than in the card: an open list in the card stretched every
 * card in its row. It stays in the card's DOM (no portal), so the list reads
 * as part of the card.
 */
function Repeats({ others, config, onOpen }: Readonly<RepeatsProps>) {
  const { t } = useTranslation(["fork", "common"]);
  const locale = useDateLocale();
  const timezone = config?.ui.timezone;
  const zone = timezone ? { timezone } : {};
  const format = use24HourTime(config)
    ? t("time.formattedTimestampMonthDayHourMinute.24hour", { ns: "common" })
    : t("time.formattedTimestampMonthDayHourMinute.12hour", { ns: "common" });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="spotlight-repeats"
          className="group flex min-h-9 items-center gap-1 self-start rounded-md text-xs font-medium text-secondary-foreground hover:text-primary"
        >
          <LuChevronDown
            className="size-4 transition-transform group-data-[state=open]:rotate-180"
            aria-hidden
          />
          {t("spotlights.card.repeats", { count: others.length })}
        </button>
      </PopoverTrigger>
      <PopoverContent
        disablePortal
        align="start"
        className="flex w-72 flex-col gap-2 p-2"
      >
        <p className="px-1 text-xs text-muted-foreground">
          {t("spotlights.card.repeatsHint")}
        </p>
        <ul className="scrollbar-container flex max-h-56 flex-col overflow-y-auto">
          {others.map((other) => {
            const time = formatUnixTimestampToDateTime(
              other.review.start_time,
              { ...zone, date_format: format, locale },
            );
            return (
              <li key={other.review.id}>
                <button
                  type="button"
                  data-testid="spotlight-repeat"
                  data-review-id={other.review.id}
                  aria-label={t("spotlights.card.openRepeat", { time })}
                  onClick={() => onOpen(other.review)}
                  className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-secondary"
                >
                  {isUnreviewed(other) ? (
                    <UnreviewedDot item={other} />
                  ) : (
                    <span className="size-2 shrink-0" aria-hidden />
                  )}
                  <span className="tabular-nums">{time}</span>
                  <LuHistory
                    className="ml-auto size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

type SpotlightCardProps = {
  group: SpotlightGroup;
  config: FrigateConfig | undefined;
  previews: Preview[] | undefined;
  timeRange: TimeRange;
  onOpen: (review: ReviewSegment) => void;
  /** Every unreviewed, finished item in the group. */
  onMarkReviewed: (reviews: ReviewSegment[]) => void;
  /** The hover preview played to the end, as on the Review page. */
  onPreviewWatched: (review: ReviewSegment) => void;
  /** It holds an item the last "N new items" click brought in. */
  arrived?: boolean;
};

export default function SpotlightCard({
  group,
  config,
  previews,
  timeRange,
  onOpen,
  onMarkReviewed,
  onPreviewWatched,
  arrived = false,
}: Readonly<SpotlightCardProps>) {
  const { t } = useTranslation(["fork", "views/events"]);
  const translate: Translate = (key, options) => t(key, options ?? {});
  const { lead, others } = group;
  const { review } = lead;
  const titleId = `spotlight-${review.id}-title`;
  const camera = resolveCameraName(config, review.camera);
  const zoneName = (zone: string) =>
    resolveZoneName(config, zone, review.camera);
  const zones = review.data.zones.map(zoneName);
  const description = review.data.metadata?.scene;
  const similarPath = findSimilarPath(
    review,
    config?.semantic_search.enabled === true,
  );
  // the "unreviewed" reason, not `has_been_reviewed`: the preview player
  // flips that flag on the shared object before the page has posted it
  const members = groupMembers(group);
  const unreviewed = members.some(isUnreviewed);
  const toMark = members
    .filter((member) => isUnreviewed(member) && member.review.end_time != null)
    .map((member) => member.review);

  return (
    <article
      data-testid="spotlight-card"
      data-review-id={review.id}
      data-arrived={arrived ? "true" : undefined}
      aria-labelledby={titleId}
      className={cn(
        "flex scroll-my-4 flex-col overflow-hidden rounded-lg border border-secondary-foreground/10 bg-background_alt",
        review.severity === "alert" && unreviewed && "border-severity_alert/50",
        arrived && "ring-2 ring-selected",
      )}
    >
      <div className="relative aspect-video overflow-hidden">
        <PreviewThumbnailPlayer
          review={review}
          allPreviews={previews ?? []}
          timeRange={timeRange}
          setReviewed={onPreviewWatched}
          onClick={(clicked) => onOpen(clicked)}
        />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              {isUnreviewed(lead) && <UnreviewedDot item={lead} />}
              <h3 id={titleId} className="truncate text-sm font-medium">
                {itemTitle(review)}
              </h3>
              {arrived && (
                <span
                  data-testid="spotlight-new"
                  className="shrink-0 rounded-full bg-selected/15 px-2 text-xs font-medium text-selected"
                >
                  {t("spotlights.card.new")}
                </span>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <LuVideo className="size-3 shrink-0" aria-hidden />
              {/* only the camera is capitalized: "and" in a zone list stays lower case */}
              <span className="truncate">
                {zones.length > 0 ? (
                  <Trans
                    ns="fork"
                    i18nKey="spotlights.card.where"
                    values={{ camera, zones: formatList(zones) }}
                    components={{
                      camera: <span className="smart-capitalize" />,
                    }}
                  />
                ) : (
                  <span className="smart-capitalize">{camera}</span>
                )}
              </span>
            </div>
          </div>
          {!unreviewed && (
            <span
              data-testid="spotlight-reviewed"
              className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
            >
              <LuCheck className="size-3" aria-hidden />
              {t("spotlights.card.reviewed")}
            </span>
          )}
        </div>
        {description && (
          <p className="line-clamp-2 text-xs text-secondary-foreground">
            {description}
          </p>
        )}
        <ul
          aria-label={t("spotlights.card.reasons")}
          className="flex flex-wrap gap-1.5"
        >
          {cardReasons(lead.reasons).map((reason, index) => (
            <ReasonChip
              key={`${reason.kind}-${index}`}
              look={reasonLook(translate, reason, zoneName)}
            />
          ))}
        </ul>
        {others.length > 0 && (
          <Repeats others={others} config={config} onOpen={onOpen} />
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="select"
            className="gap-1.5"
            onClick={() => onOpen(review)}
          >
            <LuHistory className="size-4" aria-hidden />
            {t("spotlights.card.open")}
          </Button>
          {toMark.length > 0 && (
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => onMarkReviewed(toMark)}
            >
              <LuCheck className="size-4" aria-hidden />
              {t("spotlights.card.markReviewed", { count: toMark.length })}
            </Button>
          )}
          {similarPath && (
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="ml-auto size-9 p-0"
            >
              <Link
                to={similarPath}
                aria-label={t("spotlights.card.findSimilar")}
                title={t("spotlights.card.findSimilar")}
              >
                <LuSearch className="size-4" aria-hidden />
              </Link>
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
