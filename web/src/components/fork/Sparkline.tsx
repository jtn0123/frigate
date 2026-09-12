import { useMemo } from "react";
import { cn } from "@/lib/utils";

type SparklineProps = {
  values: number[];
  /** Sample times (any unit); the points are spaced evenly without them. */
  times: number[] | undefined;
  /** Dashed target line, e.g. the expected fps (none while it is unknown). */
  reference: number | undefined;
  className?: string;
  /** Accessible description of the series. */
  label: string;
  strokeClassName?: string;
};

const WIDTH = 100;
const HEIGHT = 32;
const PAD = 2;
/** Room above the highest value or the target, so a steady line does not hug the edge. */
const HEADROOM = 1.25;

/**
 * Dependency-free inline SVG sparkline. Scaled from zero, so a steady rate sits
 * at its level rather than filling the box, with an optional dashed target
 * line. It needs two points to draw a line; until then only the target shows.
 */
export default function Sparkline({
  values,
  times,
  reference,
  className,
  label,
  strokeClassName,
}: Readonly<SparklineProps>) {
  const geometry = useMemo(() => {
    const top = Math.max(...values, reference ?? 0) * HEADROOM || 1;
    const inner = WIDTH - PAD * 2;
    const y = (value: number) =>
      HEIGHT - PAD - (value / top) * (HEIGHT - PAD * 2);
    const first = times?.at(0) ?? 0;
    const span = (times?.at(-1) ?? 0) - first;
    const x = (index: number) => {
      if (times && span > 0) {
        return PAD + (((times.at(index) ?? first) - first) / span) * inner;
      }
      return values.length > 1
        ? PAD + (index * inner) / (values.length - 1)
        : PAD;
    };

    const line = values
      .map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
      .join(" ");
    const floor = HEIGHT - PAD;
    const area = `${x(0).toFixed(1)},${floor} ${line} ${x(values.length - 1).toFixed(1)},${floor}`;
    return { line, area, referenceY: reference ? y(reference) : undefined };
  }, [values, times, reference]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={cn("h-10 w-full", className)}
      data-testid="sparkline"
      data-points={values.length}
    >
      {geometry.referenceY !== undefined && (
        <line
          x1={0}
          x2={WIDTH}
          y1={geometry.referenceY}
          y2={geometry.referenceY}
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          className="stroke-muted-foreground opacity-50"
          data-testid="sparkline-reference"
        />
      )}
      {values.length > 1 && (
        <>
          <polygon
            points={geometry.area}
            className={cn("fill-current opacity-15", strokeClassName)}
          />
          <polyline
            points={geometry.line}
            fill="none"
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className={cn("stroke-current", strokeClassName)}
          />
        </>
      )}
    </svg>
  );
}
