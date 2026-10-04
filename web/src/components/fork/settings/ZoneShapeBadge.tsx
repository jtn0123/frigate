/**
 * Fork (D75, D77): marks line and exclusion zones in the zone list, and shows
 * how many tracked objects crossed each line since midnight in the UI's time
 * zone.
 */

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "react-i18next";
import { TbLine } from "react-icons/tb";
import type { IconType } from "react-icons";
import { isForkEnabled } from "@/fork/flags";
import { useTimezone } from "@/hooks/use-date-utils";
import type { Polygon } from "@/types/canvas";
import type { FrigateConfig } from "@/types/frigateConfig";
import {
  crossingCount,
  isExclusionPolygon,
  isLineZonePolygon,
  startOfDay,
  type LineCrossingsResponse,
} from "@/lib/fork/line-zones";

const REFRESH_MS = 30_000;

/** The list icon for a line zone, or undefined to keep the usual one. */
// eslint-disable-next-line react-refresh/only-export-components
export function forkZoneIcon(
  polygon: Polygon | undefined,
): IconType | undefined {
  return isLineZonePolygon(polygon) ? TbLine : undefined;
}

/** Today's midnight in the UI's time zone, moving on when a new day starts. */
function useStartOfDay(timezone: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // checked as often as the count refreshes, so a page left open past
    // midnight counts the new day within one refresh (also after a sleep)
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  return startOfDay(now, timezone);
}

function CrossingCount({ polygon }: Readonly<{ polygon: Polygon }>) {
  const { t } = useTranslation(["fork"]);
  const { data: config } = useSWR<FrigateConfig>("config");
  const timezone = useTimezone(config);
  const after = useStartOfDay(timezone);
  const { data } = useSWR<LineCrossingsResponse>(
    // wait for the config, so the first count is for the right day
    polygon.name && timezone
      ? ["fork/line_crossings", { camera: polygon.camera, after }]
      : null,
    { refreshInterval: REFRESH_MS },
  );
  const count = crossingCount(data, polygon.camera, polygon.name);

  if (!count) return null;

  // the spaces between the name and each badge are where the row may wrap
  return (
    <>
      {" "}
      <span
        className="ml-0.5 whitespace-nowrap text-xs text-muted-foreground"
        data-testid={`line-crossings-${polygon.name}`}
      >
        {t("lineZones.count", { count: count.total })}
      </span>
    </>
  );
}

export default function ZoneShapeBadge({
  polygon,
}: Readonly<{ polygon: Polygon }>) {
  const { t } = useTranslation(["fork"]);

  if (!isForkEnabled("lineZones") || polygon.type !== "zone") return null;

  if (isLineZonePolygon(polygon)) {
    return (
      <>
        {" "}
        <span className="ml-0.5 whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
          {t(`lineZones.badge.${polygon.direction ?? "both"}`)}
        </span>
        <CrossingCount polygon={polygon} />
      </>
    );
  }

  if (isExclusionPolygon(polygon)) {
    return (
      <>
        {" "}
        <span
          className="ml-0.5 whitespace-nowrap rounded bg-red-600/15 px-1.5 py-0.5 text-xs text-red-600 dark:text-red-400"
          data-testid={`exclusion-badge-${polygon.name}`}
        >
          {t("lineZones.badge.exclusion")}
        </span>
      </>
    );
  }

  return null;
}
