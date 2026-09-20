/**
 * Fork (UI131): the Health tab's window controls, beside the page title.
 *
 * The range picks the window every number on the tab is measured over, so it
 * belongs with the page header next to "last refreshed" rather than above the
 * table it happens to scale. It reads and writes the same `range` search
 * param the view does, and shares the view's SWR entry, so the refresh here
 * refetches the table under it without a second request.
 */

import { useTranslation } from "react-i18next";
import { LuRefreshCw } from "react-icons/lu";

import TimeAgo from "@/components/dynamic/TimeAgo";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCameraHistory } from "@/hooks/fork/use-camera-history";
import { useViewQuery } from "@/hooks/use-view-query";
import {
  DEFAULT_HISTORY_RANGE,
  HISTORY_RANGES,
  isHistoryRange,
} from "@/lib/fork/camera-history";
import { phoneTouch } from "@/lib/fork/phone";
import { cn } from "@/lib/utils";

export default function CameraHealthToolbar() {
  const { t } = useTranslation(["fork", "views/system"]);
  const [params, updateView] = useViewQuery();

  const rangeParam = params.get("range") ?? "";
  const range = isHistoryRange(rangeParam) ? rangeParam : DEFAULT_HISTORY_RANGE;
  const history = useCameraHistory(range);
  const refreshed = history.data?.end;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="camera-health-toolbar"
    >
      <ToggleGroup
        type="single"
        size="sm"
        value={range}
        aria-label={t("cameraHealth.rangeLabel")}
        className={cn("gap-1 *:rounded-md *:px-3", phoneTouch && "*:min-h-11")}
        onValueChange={(value) => {
          if (isHistoryRange(value)) updateView({ range: value });
        }}
      >
        {HISTORY_RANGES.map((option) => (
          <ToggleGroupItem
            key={option}
            value={option}
            className={option === range ? "" : "text-muted-foreground"}
          >
            {t(`cameraHealth.range.${option}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <button
        type="button"
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground",
          "transition-colors hover:bg-secondary hover:text-primary",
          phoneTouch && "min-h-11",
        )}
        onClick={history.refresh}
      >
        <LuRefreshCw
          className={cn("size-3.5", history.isLoading && "animate-spin")}
        />
        {refreshed === undefined ? (
          t("cameraHealth.refresh")
        ) : (
          <>
            {t("lastRefreshed", { ns: "views/system" })}
            <TimeAgo time={refreshed * 1000} dense />
          </>
        )}
      </button>
    </div>
  );
}
