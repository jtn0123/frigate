/**
 * Fork (D75, D76): every line zone on the zone editor canvas, the one being
 * edited drawn last so its ends stay on top. Polygon zones and masks are
 * still drawn by `PolygonDrawer`.
 */

import { RefObject } from "react";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { Polygon, PolygonType } from "@/types/canvas";
import { snapPointToLines } from "@/utils/canvasUtil";
import { isLineZonePolygon } from "@/lib/fork/line-zones";
import LineZoneDrawer from "./LineZoneDrawer";

type LineZoneLayerProps = {
  stageRef: RefObject<Konva.Stage | null>;
  polygons: Polygon[];
  setPolygons: React.Dispatch<React.SetStateAction<Polygon[]>>;
  activePolygonIndex: number | undefined;
  hoveredPolygonIndex: number | null;
  selectedZoneMask: PolygonType[] | undefined;
  isEnabled: (polygon: Polygon) => boolean;
  handleGroupDragEnd: (e: KonvaEventObject<MouseEvent | TouchEvent>) => void;
  snapPoints: boolean;
};

export default function LineZoneLayer({
  stageRef,
  polygons,
  setPolygons,
  activePolygonIndex,
  hoveredPolygonIndex,
  selectedZoneMask,
  isEnabled,
  handleGroupDragEnd,
  snapPoints,
}: Readonly<LineZoneLayerProps>) {
  const lines = polygons
    .map((polygon, index) => ({ polygon, index }))
    .filter(
      ({ polygon }) =>
        isLineZonePolygon(polygon) &&
        (selectedZoneMask === undefined ||
          selectedZoneMask.includes(polygon.type)),
    )
    .sort(
      (a, b) =>
        Number(a.index === activePolygonIndex) -
        Number(b.index === activePolygonIndex),
    );

  return (
    <>
      {lines.map(({ polygon, index }) => (
        <LineZoneDrawer
          key={`line-${index}`}
          stageRef={stageRef}
          points={polygon.points}
          direction={polygon.direction ?? "both"}
          isActive={index === activePolygonIndex}
          isHovered={index === hoveredPolygonIndex}
          enabled={isEnabled(polygon)}
          color={polygon.color}
          onPointsChange={(points) =>
            setPolygons((current) =>
              current.map((item, i) =>
                i === index ? { ...item, points } : item,
              ),
            )
          }
          handleGroupDragEnd={handleGroupDragEnd}
          snapPoints={snapPoints}
          snapToLines={(point) =>
            snapPointToLines(
              point,
              polygons.filter((_, i) => i !== index),
              10,
            )
          }
        />
      ))}
    </>
  );
}
