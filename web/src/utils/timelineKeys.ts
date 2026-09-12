/** Return a clamped value for standard range-control navigation keys. */
export function timelineKeyValue(
  key: string,
  current: number,
  min: number,
  max: number,
  step: number,
): number | undefined {
  let next: number;
  switch (key) {
    case "Home":
      next = min;
      break;
    case "End":
      next = max;
      break;
    case "ArrowUp":
    case "ArrowRight":
      next = current + step;
      break;
    case "ArrowDown":
    case "ArrowLeft":
      next = current - step;
      break;
    case "PageUp":
      next = current + step * 10;
      break;
    case "PageDown":
      next = current - step * 10;
      break;
    default:
      return undefined;
  }
  return Math.min(max, Math.max(min, next));
}
