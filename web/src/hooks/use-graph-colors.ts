import { useEffect, useState } from "react";

/** Resolve shared theme colors after root theme classes have been applied. */
export function useGraphColors() {
  const [colors, setColors] = useState<string[]>([]);
  useEffect(() => {
    const update = () => {
      const style = getComputedStyle(document.documentElement);
      setColors(
        ["--selected", "--foreground", "--muted-foreground", "--border"].map(
          (token) => `hsl(${style.getPropertyValue(token).trim()})`,
        ),
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, []);
  return colors;
}
