/**
 * Fork (D75, D76): draws a line zone on the zone editor canvas.
 *
 * The line has two draggable ends, an arrow across its middle showing which
 * crossings count, and "A" and "B" beside it marking the sides the direction
 * setting names. Dragging the line itself moves both ends.
 */

import { RefObject, useState } from "react";
import { Arrow, Circle, Group, Label, Line, Tag, Text } from "react-konva";
import Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { Vector2d } from "konva/lib/types";
import {
  dragBoundFunc,
  flattenPoints,
  toRGBColorString,
} from "@/utils/canvasUtil";
import { phoneTouch } from "@/lib/fork/phone";
import {
  directionArrow,
  lineEnds,
  sideLabelPositions,
  type LineDirection,
} from "@/lib/fork/line-zones";

const VERTEX_RADIUS = 6;
// a line has two ends, so each handle is named by its place on the line
const END_HANDLES = [
  { key: "start", index: 0 },
  { key: "end", index: 1 },
] as const;
const ARROW_HALF_LENGTH = 22;
const LABEL_OFFSET = 20;

type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
const NO_BOUNDS: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

function boundsOf(points: number[][]): Bounds {
  const xs = points.map((p) => p[0] ?? 0);
  const ys = points.map((p) => p[1] ?? 0);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

type LineZoneDrawerProps = {
  stageRef: RefObject<Konva.Stage | null>;
  points: number[][];
  direction: LineDirection;
  isActive: boolean;
  isHovered: boolean;
  enabled?: boolean;
  color: number[];
  onPointsChange: (points: number[][]) => void;
  handleGroupDragEnd: (e: KonvaEventObject<MouseEvent | TouchEvent>) => void;
  snapToLines: (point: number[]) => number[] | null;
  snapPoints: boolean;
};

function SideLabel({
  x,
  y,
  text,
}: Readonly<{ x: number; y: number; text: string }>) {
  return (
    <Label x={x} y={y} offsetX={8} offsetY={9} listening={false}>
      <Tag fill="rgba(0,0,0,0.65)" cornerRadius={4} />
      <Text
        text={text}
        name={`line-side-${text}`}
        fontSize={14}
        fontStyle="bold"
        fontFamily="Arial"
        fill="white"
        padding={3}
      />
    </Label>
  );
}

export default function LineZoneDrawer({
  stageRef,
  points,
  direction,
  isActive,
  isHovered,
  enabled = true,
  color,
  onPointsChange,
  handleGroupDragEnd,
  snapToLines,
  snapPoints,
}: Readonly<LineZoneDrawerProps>) {
  const [bounds, setBounds] = useState<Bounds>(NO_BOUNDS);
  const stroke = toRGBColorString(color, true);
  // undefined until the line's second click
  const ends = lineEnds(points);
  const arrow = ends
    ? directionArrow(...ends, direction, ARROW_HALF_LENGTH)
    : undefined;
  const labels = ends ? sideLabelPositions(...ends, LABEL_OFFSET) : undefined;

  const groupDragBound = (pos: Vector2d) => {
    const stage = stageRef.current;
    if (!stage) return pos;
    let { x, y } = pos;
    if (bounds.minX + x < 0) x = -bounds.minX;
    if (bounds.minY + y < 0) y = -bounds.minY;
    if (bounds.maxX + x > stage.width()) x = stage.width() - bounds.maxX;
    if (bounds.maxY + y > stage.height()) y = stage.height() - bounds.maxY;
    return { x, y };
  };

  const pointDragBound = (pos: Vector2d) => {
    const stage = stageRef.current;
    if (!stage) return pos;
    const bound = dragBoundFunc(
      stage.width(),
      stage.height(),
      VERTEX_RADIUS,
      pos,
    );
    const snapped = snapPoints ? snapToLines([bound.x, bound.y]) : null;
    return snapped
      ? { x: snapped[0] ?? bound.x, y: snapped[1] ?? bound.y }
      : bound;
  };

  return (
    <Group
      name="polygon"
      draggable={isActive && ends !== undefined}
      onDragStart={() => setBounds(boundsOf(points))}
      {...(isActive && {
        onDragEnd: handleGroupDragEnd,
        dragBoundFunc: groupDragBound,
      })}
    >
      <Line
        name="line-zone"
        points={flattenPoints(points)}
        stroke={stroke}
        strokeWidth={isActive || isHovered ? 5 : 4}
        hitStrokeWidth={16}
        lineCap="round"
        {...(!enabled && { dash: [10, 5] })}
        opacity={enabled ? 1 : 0.85}
      />
      {arrow && (
        <Arrow
          name="line-direction"
          points={arrow.points}
          pointerAtBeginning={arrow.bothWays}
          pointerLength={9}
          pointerWidth={10}
          stroke="white"
          fill="white"
          strokeWidth={3}
          shadowColor="black"
          shadowBlur={3}
          shadowOpacity={0.8}
          listening={false}
        />
      )}
      {labels && (
        <>
          <SideLabel x={labels.a[0]} y={labels.a[1]} text="A" />
          <SideLabel x={labels.b[0]} y={labels.b[1]} text="B" />
        </>
      )}
      {isActive &&
        END_HANDLES.map(({ key, index }) => {
          // undefined until the line's second click places that end
          const point = points.at(index);
          return (
            point && (
              <Circle
                key={key}
                name={`point-${index}`}
                x={point[0] ?? 0}
                y={point[1] ?? 0}
                radius={VERTEX_RADIUS}
                stroke={stroke}
                fill="#ffffff"
                strokeWidth={3}
                // the same 44 px grab area on a phone as polygon points
                hitStrokeWidth={phoneTouch ? 32 : 9}
                draggable
                dragBoundFunc={pointDragBound}
                onDragMove={(e) => {
                  const next = points.map((p) => [...p]);
                  next[index] = [e.target.x(), e.target.y()];
                  onPointsChange(next);
                }}
              />
            )
          );
        })}
    </Group>
  );
}
