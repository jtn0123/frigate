import {
  Children,
  cloneElement,
  isValidElement,
  ReactElement,
  ReactNode,
  Ref,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { HiDotsHorizontal } from "react-icons/hi";
import { IoClose } from "react-icons/io5";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Fork (UI149, upstream #24543): upstream's mobile OverflowStrip
 * (`components/mobile/OverflowStrip.tsx` on 0.19), with two additions:
 *
 * - `renderRow` lets a caller supply the element each row of items is
 *   rendered into, so the System tabs stay one radio group (a Radix
 *   `ToggleGroup`) in the strip, the measuring row and the panel.
 * - The measuring copy drops each item's `aria-label`, so a label query
 *   finds only the item a person can see.
 */

export type OverflowStripRowProps = {
  ref?: Ref<HTMLDivElement>;
  className: string;
  children: ReactNode;
};

type OverflowStripProps = {
  className?: string | undefined;
  items: ReactNode[];
  activeIndex?: number;
  gapClassName?: string;
  showAllLabel: string;
  showLessLabel: string;
  renderRow?: (props: OverflowStripRowProps) => ReactNode;
};

function defaultRow({ ref, className, children }: OverflowStripRowProps) {
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

function unlabeled(items: ReactNode[]): ReactNode[] {
  return Children.toArray(items).map((item) =>
    isValidElement(item)
      ? cloneElement(
          item as ReactElement<{ "aria-label"?: string | undefined }>,
          {
            "aria-label": undefined,
          },
        )
      : item,
  );
}

/**
 * Renders only the items that fully fit and surfaces a kebab next to the last
 * visible one. The kebab expands a panel over the nearest positioned ancestor
 * that reveals every item.
 */
export default function OverflowStrip({
  className,
  items,
  activeIndex = 0,
  gapClassName = "gap-2",
  showAllLabel,
  showLessLabel,
  renderRow = defaultRow,
}: Readonly<OverflowStripProps>) {
  const [expanded, setExpanded] = useState(false);
  // null => all items fit, render them all with no kebab; a number => only
  // that many fit alongside the kebab
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const measure = measureRef.current;

    if (!wrapper || !measure) {
      return;
    }

    const wrapperGap = 4; // gap-1 between the strip and the kebab
    const kebab = measure.nextElementSibling as HTMLElement | null;

    const compute = () => {
      const children = Array.from(measure.children) as HTMLElement[];
      const first = children[0];

      if (!first || !kebab) {
        return;
      }

      const start = first.offsetLeft;
      const ends = children.map((el) => el.offsetLeft + el.offsetWidth - start);
      const available = wrapper.clientWidth;

      if ((ends.at(-1) ?? 0) <= available) {
        setVisibleCount(null);
        return;
      }

      const budget = available - kebab.offsetWidth - wrapperGap;
      const count = ends.filter((end) => end <= budget).length;

      setVisibleCount(Math.max(count, 1));
    };

    compute();

    const observer = new ResizeObserver(compute);
    observer.observe(wrapper);
    observer.observe(measure);

    return () => observer.disconnect();
  }, [items.length, gapClassName]);

  // a selected item past the cut takes the last visible slot
  let visibleItems = items;
  if (visibleCount != null) {
    visibleItems =
      activeIndex >= visibleCount
        ? [...items.slice(0, visibleCount - 1), items[activeIndex]]
        : items.slice(0, visibleCount);
  }

  return (
    <div
      ref={wrapperRef}
      className={cn("flex min-w-0 items-center gap-1", className)}
    >
      {renderRow({
        className: cn(
          "flex min-w-0 items-center overflow-hidden whitespace-nowrap",
          gapClassName,
        ),
        children: visibleItems,
      })}
      {visibleCount != null && (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2 text-secondary-foreground"
          aria-label={showAllLabel}
          aria-expanded={expanded}
          onClick={() => setExpanded(true)}
        >
          <HiDotsHorizontal className="size-5" />
        </Button>
      )}

      {/* invisible row used only to measure natural item widths so we can
          render exactly the items that fully fit */}
      <div
        className="pointer-events-none absolute left-0 top-0 flex h-0 w-0 overflow-hidden"
        aria-hidden
        inert
      >
        {renderRow({
          ref: measureRef,
          className: cn("flex w-max shrink-0 items-center", gapClassName),
          children: unlabeled(items),
        })}
        <Button variant="ghost" size="sm" className="shrink-0 px-2">
          <HiDotsHorizontal className="size-5" />
        </Button>
      </div>

      {expanded && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setExpanded(false)}
          aria-hidden="true"
        />
      )}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="overflow-overlay"
            className="absolute inset-x-0 top-0 z-30 flex items-center gap-1 bg-background py-1 shadow-lg"
            initial={{ clipPath: "inset(0 100% 0 0)" }}
            animate={{ clipPath: "inset(0 0% 0 0)" }}
            exit={{ clipPath: "inset(0 100% 0 0)" }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
          >
            {/* a tap on any item bubbles up and collapses the panel, and
                Escape closes it from the keyboard */}
            <div
              role="presentation"
              className="flex min-w-0 flex-1"
              onClick={() => setExpanded(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setExpanded(false);
                }
              }}
            >
              {renderRow({
                className: cn("flex flex-wrap items-center", gapClassName),
                children: items,
              })}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto shrink-0 px-2 text-secondary-foreground"
              aria-label={showLessLabel}
              onClick={() => setExpanded(false)}
            >
              <IoClose className="size-5" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
