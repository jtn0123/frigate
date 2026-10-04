/**
 * Fork (D75, D76, D77): the zone edit pane's shape controls.
 *
 * An area or a line; for a line, which crossings count; for an area, whether
 * it is an exclusion zone. The choices live on the polygon being edited, as
 * its objects do, and `forkZoneQuery` saves them with the rest of the zone.
 */

import { useTranslation } from "react-i18next";
import { LuArrowLeftRight, LuArrowRight, LuArrowLeft } from "react-icons/lu";
import { isForkEnabled } from "@/fork/flags";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { phoneTouch } from "@/lib/fork/phone";
import { cn } from "@/lib/utils";
import type { Polygon } from "@/types/canvas";
import {
  LINE_DIRECTIONS,
  isLineDirection,
  setZoneShape,
  sideAToBTurn,
  type LineDirection,
} from "@/lib/fork/line-zones";

const DIRECTION_ICONS: Record<LineDirection, typeof LuArrowRight> = {
  both: LuArrowLeftRight,
  a_to_b: LuArrowRight,
  b_to_a: LuArrowLeft,
};

type ZoneShapeFieldsProps = {
  polygons: Polygon[];
  setPolygons: React.Dispatch<React.SetStateAction<Polygon[]>>;
  activePolygonIndex: number;
};

export default function ZoneShapeFields({
  polygons,
  setPolygons,
  activePolygonIndex,
}: Readonly<ZoneShapeFieldsProps>) {
  const { t } = useTranslation(["fork"]);
  // the active index can be out of range while the zone list changes
  const polygon =
    activePolygonIndex < polygons.length
      ? polygons[activePolygonIndex]
      : undefined;

  if (polygon?.type !== "zone" || !isForkEnabled("lineZones")) {
    return null;
  }

  const isLine = polygon.zoneType === "line";
  const update = (next: Polygon) => {
    const updated = [...polygons];
    updated[activePolygonIndex] = next;
    setPolygons(updated);
  };
  // ring-selected: the default theme's ring color is transparent, so the
  // toggles' and the switch's own focus ring never showed
  const itemClass = cn(
    "gap-1.5 rounded-md px-3 focus-visible:ring-selected",
    phoneTouch && "min-h-11",
  );
  // the icons turn with the line, so each points the way the arrow on the
  // canvas will for that choice (a line drawn down the frame counts A to B
  // leftward, which a plain right arrow got backward)
  const turn = isLine ? sideAToBTurn(polygon.points) : 0;

  return (
    <div className="my-3 space-y-3 text-sm" data-testid="zone-shape-fields">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>{t("lineZones.shape.label")}</Label>
        <ToggleGroup
          type="single"
          size="sm"
          value={isLine ? "line" : "polygon"}
          aria-label={t("lineZones.shape.label")}
          onValueChange={(value) => {
            if (value === "line" || value === "polygon") {
              update(setZoneShape(polygon, value));
            }
          }}
        >
          <ToggleGroupItem
            value="polygon"
            data-testid="zone-shape-polygon"
            className={cn(itemClass, isLine && "text-muted-foreground")}
          >
            {t("lineZones.shape.polygon")}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="line"
            data-testid="zone-shape-line"
            className={cn(itemClass, !isLine && "text-muted-foreground")}
          >
            {t("lineZones.shape.line")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {isLine ? (
        <>
          <p className="text-muted-foreground" data-testid="line-zone-hint">
            {t("lineZones.line.hint")}
          </p>
          <div className="space-y-2">
            <Label>{t("lineZones.direction.label")}</Label>
            <ToggleGroup
              type="single"
              size="sm"
              className="grid grid-cols-3 gap-1"
              value={polygon.direction ?? "both"}
              aria-label={t("lineZones.direction.label")}
              onValueChange={(value) => {
                if (isLineDirection(value)) {
                  update({ ...polygon, direction: value });
                }
              }}
            >
              {LINE_DIRECTIONS.map((direction) => {
                const Icon = DIRECTION_ICONS[direction];
                const selected = (polygon.direction ?? "both") === direction;
                return (
                  <ToggleGroupItem
                    key={direction}
                    value={direction}
                    data-testid={`line-direction-${direction}`}
                    className={cn(
                      itemClass,
                      "px-1",
                      !selected && "text-muted-foreground",
                    )}
                  >
                    <Icon
                      className="size-4 shrink-0"
                      style={
                        turn ? { transform: `rotate(${turn}deg)` } : undefined
                      }
                    />
                    {t(`lineZones.direction.${direction}`)}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
            <p className="text-muted-foreground">
              {t("lineZones.direction.desc")}
            </p>
            <p
              className="text-muted-foreground"
              data-testid="line-zone-alert-hint"
            >
              {t("lineZones.direction.alert")}
            </p>
          </div>
          <p className="text-muted-foreground">{t("lineZones.line.inertia")}</p>
        </>
      ) : (
        // the switch sits by its label, and the long description runs the
        // full width below them rather than in a narrow column beside it
        <div className="space-y-1">
          <div className="flex flex-row items-center justify-between gap-3">
            <Label htmlFor="zone-exclusion">
              {t("lineZones.exclusion.label")}
            </Label>
            <Switch
              id="zone-exclusion"
              data-testid="zone-exclusion"
              className="focus-visible:ring-selected"
              checked={!!polygon.exclusion}
              onCheckedChange={(checked) =>
                update({ ...polygon, exclusion: checked })
              }
            />
          </div>
          <p className="text-muted-foreground">
            {t("lineZones.exclusion.desc")}
          </p>
        </div>
      )}
      <Separator className="my-3 bg-secondary" />
    </div>
  );
}
