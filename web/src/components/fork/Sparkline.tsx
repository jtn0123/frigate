import { useMemo } from "react";
import { cn } from "@/lib/utils";

type SparklineProps = {
  values: number[];
  className?: string;
  /** Accessible description of the series. */
  label: string;
  strokeClassName?: string;
};

const WIDTH = 100;
const HEIGHT = 28;
const PAD = 2;

/**
 * Dependency-free inline SVG sparkline. Scales to its container width and
 * normalises the series to its own min/max so short series still show shape.
 */
export default function Sparkline({
  values,
  className,
  label,
  strokeClassName,
}: SparklineProps) {
  const points = useMemo(() => {
    if (values.length === 0) return "";
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const stepX =
      values.length > 1 ? (WIDTH - PAD * 2) / (values.length - 1) : 0;
    return values
      .map((value, index) => {
        const x = PAD + index * stepX;
        const y = HEIGHT - PAD - ((value - min) / range) * (HEIGHT - PAD * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [values]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={cn("h-7 w-full", className)}
      data-testid="sparkline"
      data-points={values.length}
    >
      {values.length === 1 ? (
        <circle
          cx={PAD}
          cy={HEIGHT / 2}
          r={1.5}
          className={cn("fill-current", strokeClassName)}
        />
      ) : (
        <polyline
          points={points}
          fill="none"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          className={cn("stroke-current", strokeClassName)}
        />
      )}
    </svg>
  );
}
