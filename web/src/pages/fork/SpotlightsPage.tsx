/**
 * Spotlights (fork, UI144): the activity worth a look, best first.
 *
 * A daily landing page on top of `/review`: alerts, known faces and plates,
 * GenAI threat levels, notable sounds and loitering rank above everything
 * else, and each card says why it is there. Ordinary detections stay on the
 * Review page; the footer says how many were left out.
 *
 * Repeats of one subject share a card, the feed renders a page of cards at a
 * time, and new activity waits behind a button instead of reshuffling the
 * cards under the pointer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { LuFlashlight, LuFolderCheck, LuRefreshCcw } from "react-icons/lu";
import { CamerasFilterButton } from "@/components/filter/CamerasFilterButton";
import ErrorState from "@/components/fork/ErrorState";
import SpotlightCard from "@/components/fork/spotlights/SpotlightCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAllowedCameras } from "@/hooks/use-allowed-cameras";
import { useCameraPreviews } from "@/hooks/use-camera-previews";
import { useSpotlights } from "@/hooks/fork/use-spotlights";
import { UNDO_TOAST_MS } from "@/lib/fork/bulk-actions";
import {
  PAGE_SIZE,
  SPOTLIGHT_RANGES,
  countGroups,
  groupMembers,
  groupSpotlights,
  inCategory,
  parseSpotlightCategory,
  parseSpotlightRange,
  shownCategories,
  type SpotlightCategory,
  type SpotlightRange,
} from "@/lib/fork/spotlights";
import { firstArrival } from "@/lib/fork/spotlights-live";
import { cn } from "@/lib/utils";
import type { CameraConfig } from "@/types/frigateConfig";
import type { ReviewSegment } from "@/types/review";

function rangeLabel(t: TFunction<"fork">, range: SpotlightRange): string {
  switch (range) {
    case "24h":
      return t("spotlights.range.day", { ns: "fork" });
    case "3d":
      return t("spotlights.range.threeDays", { ns: "fork" });
    case "7d":
      return t("spotlights.range.week", { ns: "fork" });
  }
}

function categoryLabel(
  t: TFunction<"fork">,
  category: SpotlightCategory,
): string {
  switch (category) {
    case "people":
      return t("spotlights.categories.people", { ns: "fork" });
    case "vehicles":
      return t("spotlights.categories.vehicles", { ns: "fork" });
    case "threats":
      return t("spotlights.categories.threats", { ns: "fork" });
    case "unreviewed":
      return t("spotlights.categories.unreviewed", { ns: "fork" });
  }
}

type CategoryChipProps = {
  label: string;
  count: number;
  selected: boolean;
  testId: string;
  onSelect: () => void;
};

function CategoryChip({
  label,
  count,
  selected,
  testId,
  onSelect,
}: Readonly<CategoryChipProps>) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      disabled={count === 0 && !selected}
      onClick={onSelect}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-50",
        selected
          ? "border-transparent bg-selected text-selected-foreground"
          : "border-secondary-foreground/20 bg-secondary text-primary hover:bg-secondary/70",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 text-xs tabular-nums",
          selected ? "bg-white/20" : "bg-background_alt text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function FeedSkeleton() {
  return (
    <div
      data-testid="spotlights-loading"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 3xl:grid-cols-4"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="flex flex-col gap-2 overflow-hidden rounded-lg border border-secondary-foreground/10 bg-background_alt"
        >
          <Skeleton className="aspect-video w-full rounded-none" />
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
            <div className="flex gap-1.5">
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SpotlightsPage() {
  const { t } = useTranslation(["fork", "common"]);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const range = parseSpotlightRange(searchParams.get("range"));
  const category = parseSpotlightCategory(searchParams.get("group"));
  const cameraParam = searchParams.get("cameras");
  const cameras = useMemo(
    () => cameraParam?.split(",").filter((camera) => camera.length > 0),
    [cameraParam],
  );

  useEffect(() => {
    document.title = t("spotlights.documentTitle");
  }, [t]);

  const updateParams = useCallback(
    (changes: Record<string, string | undefined>) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(changes)) {
            if (value) {
              next.set(key, value);
            } else {
              next.delete(key);
            }
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const {
    config,
    items,
    fresh,
    freshIds,
    showFresh,
    hidden,
    timeRange,
    error,
    retry,
    setReviewed,
  } = useSpotlights({ range, cameras });
  const previews = useCameraPreviews(timeRange, {
    refreshOnHourRollover: true,
  });

  const allowedCameras = useAllowedCameras();
  const filterCameras = useMemo(() => {
    // a custom role can list cameras the config no longer has
    const known: Partial<Record<string, CameraConfig>> = config?.cameras ?? {};
    return allowedCameras
      .filter((camera) => known[camera]?.ui.review !== false)
      .sort((a, b) => (known[a]?.ui.order ?? 0) - (known[b]?.ui.order ?? 0));
  }, [allowedCameras, config]);
  const groups = useMemo(
    () =>
      Object.entries(config?.camera_groups ?? {}).sort(
        (a, b) => a[1].order - b[1].order,
      ),
    [config],
  );

  const counts = useMemo(() => countGroups(items ?? []), [items]);
  const cards = useMemo(
    () => (items ? groupSpotlights(inCategory(items, category)) : undefined),
    [items, category],
  );

  // the items the last "N new items" click brought in. New activity ranks
  // where it ranks, often below the first page, so their cards are marked
  // and the first one is scrolled to, rather than the top
  const queryKey = `${range}|${cameraParam ?? ""}`;
  const [arrived, setArrived] = useState<{
    key: string;
    ids: ReadonlySet<string>;
    seq: number;
  }>();
  const arrivedIds = arrived?.key === queryKey ? arrived.ids : undefined;
  const arrivalIndex = useMemo(
    () => (cards && arrivedIds ? firstArrival(cards, arrivedIds) : -1),
    [cards, arrivedIds],
  );

  // a page of cards at a time; another group, range or camera set starts
  // back at one page, and the pages reach far enough to show what arrived
  const pagingKey = `${queryKey}|${category ?? ""}`;
  const [paging, setPaging] = useState({ key: pagingKey, pages: 1 });
  const pages = Math.max(
    paging.key === pagingKey ? paging.pages : 1,
    Math.ceil((arrivalIndex + 1) / PAGE_SIZE),
  );
  const shownCards = cards?.slice(0, pages * PAGE_SIZE);
  const remaining = (cards?.length ?? 0) - (shownCards?.length ?? 0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const showNew = useCallback(() => {
    setArrived((current) => ({
      key: queryKey,
      ids: new Set(freshIds),
      seq: (current?.seq ?? 0) + 1,
    }));
    showFresh();
    setPaging({ key: pagingKey, pages: 1 });
  }, [showFresh, freshIds, queryKey, pagingKey]);

  // once the new ranking is on screen, bring the first new card into view
  const arrivalSeq = arrived?.seq;
  useEffect(() => {
    if (arrivalSeq === undefined) {
      return;
    }
    const target = scrollRef.current?.querySelector('[data-arrived="true"]');
    if (target) {
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [arrivalSeq]);

  // opening or watching an item counts as reviewing it, as on Review; a
  // failure here only leaves the item unreviewed, so it stays quiet
  const markQuietly = useCallback(
    (review: ReviewSegment) => {
      if (review.end_time == undefined) {
        return;
      }
      setReviewed([review], true).catch(() => undefined);
    },
    [setReviewed],
  );

  const openItem = useCallback(
    (review: ReviewSegment) => {
      markQuietly(review);
      void navigate(`/review?id=${encodeURIComponent(review.id)}`);
    },
    [markQuietly, navigate],
  );

  const markReviewed = useCallback(
    async (reviews: ReviewSegment[]) => {
      try {
        await setReviewed(reviews, true);
      } catch {
        toast.error(t("spotlights.toast.failed"), { position: "top-center" });
        return;
      }
      toast.success(t("spotlights.toast.reviewed", { count: reviews.length }), {
        position: "top-center",
        duration: UNDO_TOAST_MS,
        action: {
          label: t("button.undo", { ns: "common" }),
          onClick: () => {
            // toast action onClick cannot be async
            setReviewed(reviews, false).catch(() =>
              toast.error(t("spotlights.toast.failed"), {
                position: "top-center",
              }),
            );
          },
        },
      });
    },
    [setReviewed, t],
  );

  return (
    <div
      ref={scrollRef}
      data-testid="spotlights-page"
      className="scrollbar-container flex size-full flex-col gap-3 overflow-y-auto p-2 md:p-4"
    >
      <Toaster closeButton={true} />
      {/* shrink-0: in a scrolling flex column the chip row, which scrolls
          sideways, would otherwise be squeezed to nothing */}
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-selected/15 text-selected">
            <LuFlashlight className="size-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold md:text-2xl">
              {t("spotlights.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("spotlights.subtitle")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            data-testid="spotlights-range"
            type="single"
            size="sm"
            value={range}
            aria-label={t("spotlights.range.label")}
            className="rounded-lg bg-secondary p-0.5 *:rounded-md *:px-3"
            onValueChange={(value: string) => {
              if (value) {
                updateParams({ range: value === "24h" ? undefined : value });
              }
            }}
          >
            {SPOTLIGHT_RANGES.map((option) => (
              <ToggleGroupItem
                key={option}
                value={option}
                className={cn(
                  "data-[state=on]:bg-background_alt",
                  option !== range && "text-muted-foreground",
                )}
              >
                {rangeLabel(t, option)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <CamerasFilterButton
            allCameras={filterCameras}
            groups={groups}
            selectedCameras={cameras}
            updateCameraFilter={(selected) =>
              updateParams({ cameras: selected?.join(",") })
            }
          />
        </div>
      </div>

      <div
        role="group"
        aria-label={t("spotlights.categories.label")}
        // on a phone the row scrolls sideways; the fade at the right edge
        // says there is more, and the end padding lets the last chip clear it
        className="scrollbar-hidden -mx-2 flex shrink-0 gap-2 overflow-x-auto px-2 pb-1 pr-10 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] md:mx-0 md:flex-wrap md:px-0 md:[mask-image:none]"
      >
        <CategoryChip
          testId="spotlights-category-all"
          label={t("spotlights.categories.all")}
          count={counts.all}
          selected={category === undefined}
          onSelect={() => updateParams({ group: undefined })}
        />
        {shownCategories(counts, category).map((option) => (
          <CategoryChip
            key={option}
            testId={`spotlights-category-${option}`}
            label={categoryLabel(t, option)}
            count={counts[option]}
            selected={category === option}
            onSelect={() =>
              updateParams({ group: category === option ? undefined : option })
            }
          />
        ))}
      </div>

      {error !== undefined && !items && (
        <ErrorState error={error} onRetry={retry} />
      )}
      {error === undefined && !cards && <FeedSkeleton />}

      {fresh > 0 && (
        // sticky inside the scrolling page, so it is in reach wherever the
        // reader is in the feed; above the thumbnails' overlays, as Review's
        // own new items button is
        <div
          aria-live="polite"
          className="pointer-events-none sticky top-2 z-[49] -mb-3 flex h-0 justify-center overflow-visible"
        >
          <Button
            data-testid="spotlights-fresh"
            size="sm"
            variant="select"
            className="pointer-events-auto gap-1.5 rounded-full shadow-md"
            onClick={showNew}
          >
            <LuRefreshCcw className="size-4" aria-hidden />
            {t("spotlights.fresh", { count: fresh })}
          </Button>
        </div>
      )}

      {cards?.length === 0 && (
        <div
          data-testid="spotlights-empty"
          className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center"
        >
          <LuFolderCheck className="size-14 text-muted-foreground" />
          <div className="text-lg font-medium">
            {category
              ? t("spotlights.empty.groupTitle")
              : t("spotlights.empty.title")}
          </div>
          <p className="max-w-md text-sm text-muted-foreground">
            {category
              ? t("spotlights.empty.groupDescription")
              : t("spotlights.empty.description")}
          </p>
          {category ? (
            <Button
              size="sm"
              onClick={() => updateParams({ group: undefined })}
            >
              {t("spotlights.empty.showAll")}
            </Button>
          ) : (
            <Button asChild size="sm">
              <Link to="/review">{t("spotlights.openReview")}</Link>
            </Button>
          )}
        </div>
      )}

      {shownCards && shownCards.length > 0 && (
        <div
          data-testid="spotlights-feed"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 3xl:grid-cols-4"
        >
          {shownCards.map((group) => (
            <SpotlightCard
              key={group.lead.review.id}
              group={group}
              config={config}
              previews={previews}
              timeRange={timeRange}
              onOpen={openItem}
              onMarkReviewed={(reviews) => void markReviewed(reviews)}
              onPreviewWatched={markQuietly}
              arrived={
                arrivedIds !== undefined &&
                groupMembers(group).some((member) =>
                  arrivedIds.has(member.review.id),
                )
              }
            />
          ))}
        </div>
      )}

      {remaining > 0 && (
        <div className="flex justify-center">
          <Button
            data-testid="spotlights-more"
            onClick={() => setPaging({ key: pagingKey, pages: pages + 1 })}
          >
            {t("spotlights.more", { count: remaining })}
          </Button>
        </div>
      )}

      {items && hidden > 0 && (
        <div
          data-testid="spotlights-hidden"
          className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 py-2 text-sm text-muted-foreground"
        >
          <span>{t("spotlights.hidden", { count: hidden })}</span>
          <Link to="/review" className="text-selected hover:underline">
            {t("spotlights.openReview")}
          </Link>
        </div>
      )}
    </div>
  );
}
