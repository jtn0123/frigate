import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enUS } from "date-fns/locale";
import useDraggableElement from "@/hooks/use-draggable-element";

const fx = vi.hoisted(() => ({
  isIOS: false,
  userInteracting: false,
}));

vi.mock("swr", () => ({
  default: () => ({ data: { ui: { timezone: "UTC" } } }),
}));
vi.mock("react-device-detect", () => ({
  get isIOS() {
    return fx.isIOS;
  },
}));
vi.mock("@/hooks/use-date-locale", () => ({ useDateLocale: () => enUS }));
vi.mock("@/hooks/use-date-utils", () => ({ useTimeFormat: () => "24hour" }));
vi.mock("@/hooks/use-user-interaction", () => ({
  default: () => ({ userInteracting: fx.userInteracting }),
}));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t: (key: string) =>
      key.includes("HourMinuteSecond") ? "HH:mm:ss" : "HH:mm",
  }),
}));

// aligned to the 30s segment duration
const T = 1_700_000_100;
const SEGMENTS = Array.from({ length: 100 }, (_, i) => T - i * 30);

let frames: FrameRequestCallback[] = [];
let now = 1000;

function flushFrames() {
  const pending = frames;
  frames = [];
  act(() => pending.forEach((cb) => cb(0)));
}

function element<E extends HTMLElement>(
  tag: string,
  rect: Partial<DOMRect>,
  sizes: Record<string, number> = {},
): E {
  const el = document.createElement(tag) as E;
  el.getBoundingClientRect = () => ({ top: 0, height: 0, ...rect }) as DOMRect;
  for (const [key, value] of Object.entries(sizes)) {
    Object.defineProperty(el, key, { value, writable: true });
  }
  return el;
}

type Options = {
  initialTime?: number;
  segments?: number[];
  timelineCollapsed?: boolean;
  initialScrollIntoViewOnly?: boolean;
  earliest?: number;
  latest?: number;
  dense?: boolean;
  scrollTop?: number;
  withContent?: boolean;
};

function setup(options: Options = {}) {
  const timeline = element<HTMLDivElement>(
    "div",
    { top: 0, height: 400 },
    {
      clientHeight: 400,
      scrollHeight: 800,
      scrollTop: options.scrollTop ?? 0,
    },
  );
  const segmentsEl = element<HTMLDivElement>("div", {}, { scrollHeight: 800 });
  const thumb = element<HTMLDivElement>("div", { top: 20 });
  const timeLabel = document.createElement("div");
  const refs = {
    contentRef: {
      current:
        options.withContent === false ? null : document.createElement("div"),
    } as React.RefObject<HTMLElement | null>,
    timelineRef: { current: timeline },
    segmentsRef: { current: segmentsEl },
    draggableElementRef: { current: thumb },
    draggableElementTimeRef: { current: timeLabel },
  };
  const scrollToSegment = vi.fn();
  const setPosition = vi.fn();
  const setTimeSpy = vi.fn();

  const hook = renderHook(
    ({ collapsed }: { collapsed: boolean | undefined }) => {
      const [isDragging, setIsDragging] = useState(false);
      const [time, setTime] = useState<number | undefined>(options.initialTime);
      const setDraggableElementTime = useCallback(
        (value: React.SetStateAction<number>) => {
          setTimeSpy(value);
          setTime(value as number);
        },
        [],
      );
      const handlers = useDraggableElement({
        ...refs,
        segmentDuration: 30,
        showDraggableElement: true,
        ...(time === undefined ? {} : { draggableElementTime: time }),
        ...(options.earliest === undefined
          ? {}
          : { draggableElementEarliestTime: options.earliest }),
        ...(options.latest === undefined
          ? {}
          : { draggableElementLatestTime: options.latest }),
        setDraggableElementTime,
        ...(options.initialScrollIntoViewOnly === undefined
          ? {}
          : { initialScrollIntoViewOnly: options.initialScrollIntoViewOnly }),
        timelineDuration: 3000,
        ...(collapsed === undefined ? {} : { timelineCollapsed: collapsed }),
        timelineStartAligned: T,
        isDragging,
        setIsDragging,
        setDraggableElementPosition: setPosition,
        dense: options.dense ?? false,
        segments: options.segments ?? SEGMENTS,
        scrollToSegment,
      });
      return { ...handlers, isDragging, time, setTime };
    },
    { initialProps: { collapsed: options.timelineCollapsed } },
  );
  return {
    ...hook,
    timeline,
    thumb,
    timeLabel,
    scrollToSegment,
    setPosition,
    setTimeSpy,
  };
}

// a stand-in for the synthetic event, with only the fields the hook reads
function asEvent<E>(value: unknown): E {
  return value as E;
}

function reactMouse(clientY: number) {
  return asEvent<React.MouseEvent<HTMLDivElement>>({
    nativeEvent: new MouseEvent("mousedown", { clientY }),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
}

beforeEach(() => {
  fx.isIOS = false;
  fx.userInteracting = false;
  frames = [];
  now = 1000;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => vi.unstubAllGlobals());

describe("useDraggableElement", () => {
  it("places the handle at the given time and scrolls it into view", () => {
    const { thumb, timeLabel, scrollToSegment, setPosition, setTimeSpy } =
      setup({ initialTime: T - 75 });

    // the aligned segment is scrolled into view right away
    expect(scrollToSegment).toHaveBeenCalledWith(T - 90);
    expect(setTimeSpy).toHaveBeenCalledWith(T - 75);

    flushFrames();
    // fourth segment (24px) minus half a segment (4px) minus the 2px bar
    expect(thumb.style.top).toBe("18px");
    expect(setPosition).toHaveBeenCalledWith(18);
    expect(timeLabel.textContent).toBe("22:13:45");
    expect(scrollToSegment).toHaveBeenCalledTimes(2);
  });

  it("only scrolls into view once when asked", () => {
    const { result, scrollToSegment, thumb } = setup({
      initialTime: T - 75,
      initialScrollIntoViewOnly: true,
    });
    flushFrames();
    expect(scrollToSegment).toHaveBeenCalledTimes(2);

    act(() => result.current.setTime(T - 135));
    flushFrames();
    expect(thumb.style.top).toBe("34px");
    // only the direct scroll, not the second pass after placing the handle
    expect(scrollToSegment).toHaveBeenCalledTimes(3);
  });

  it("does not scroll while the user is interacting", () => {
    fx.userInteracting = true;
    const { scrollToSegment } = setup({ initialTime: T - 75 });
    flushFrames();
    expect(scrollToSegment).not.toHaveBeenCalled();
  });

  it("ignores a time that is not on the timeline", () => {
    const { thumb, setPosition } = setup({ initialTime: T + 600 });
    flushFrames();
    expect(thumb.style.top).toBe("");
    expect(setPosition).not.toHaveBeenCalled();
  });

  it("uses a minute format for long segments in dense mode", () => {
    const { timeLabel } = setup({ initialTime: T - 75, dense: true });
    flushFrames();
    expect(timeLabel.textContent).toBe("22:13");
  });

  it("drags the handle, throttles commits and flushes the last time on release", () => {
    const { result, thumb, setTimeSpy, scrollToSegment } = setup({
      initialTime: T - 75,
    });
    flushFrames();
    setTimeSpy.mockClear();
    scrollToSegment.mockClear();

    const down = reactMouse(30);
    act(() => result.current.handleMouseDown(down));
    expect(down.preventDefault).toHaveBeenCalled();
    expect(down.stopPropagation).toHaveBeenCalled();
    expect(result.current.isDragging).toBe(true);
    // clicked 10px below the handle top, so it stays at 20px
    expect(setTimeSpy).toHaveBeenLastCalledWith(T - 75);
    flushFrames();
    expect(thumb.style.top).toBe("20px");

    now = 1050;
    act(() =>
      result.current.handleMouseMove(
        new MouseEvent("mousemove", { clientY: 46 }),
      ),
    );
    flushFrames();
    expect(thumb.style.top).toBe("36px");
    // within the commit interval the newest time is held back
    expect(setTimeSpy).toHaveBeenCalledTimes(1);

    const up = new MouseEvent("mouseup", { cancelable: true });
    act(() => result.current.handleMouseUp(up));
    expect(up.defaultPrevented).toBe(true);
    expect(result.current.isDragging).toBe(false);
    expect(setTimeSpy).toHaveBeenLastCalledWith(T - 135);
    expect(result.current.time).toBe(T - 135);

    // once released the handle snaps to the committed time
    expect(scrollToSegment).toHaveBeenCalledWith(T - 150);
    flushFrames();
    expect(thumb.style.top).toBe("34px");
  });

  it("ignores a release when not dragging", () => {
    const { result, setTimeSpy } = setup({ initialTime: T - 75 });
    setTimeSpy.mockClear();
    act(() => result.current.handleMouseUp(new MouseEvent("mouseup")));
    expect(setTimeSpy).not.toHaveBeenCalled();
  });

  it("does not track the pointer without its elements", () => {
    const { result, thumb } = setup({
      initialTime: T - 75,
      withContent: false,
    });
    flushFrames();
    act(() => result.current.handleMouseDown(reactMouse(30)));
    flushFrames();
    act(() =>
      result.current.handleMouseMove(
        new MouseEvent("mousemove", { clientY: 100 }),
      ),
    );
    flushFrames();
    expect(thumb.style.top).toBe("20px");
  });

  it("keeps the handle inside the earliest and latest bounds", () => {
    const { result, setTimeSpy } = setup({
      initialTime: T - 75,
      earliest: T - 300,
      latest: T - 30,
    });
    flushFrames();
    act(() => result.current.handleMouseDown(reactMouse(30)));
    setTimeSpy.mockClear();
    now = 5000;
    act(() =>
      result.current.handleMouseMove(
        new MouseEvent("mousemove", { clientY: 300 }),
      ),
    );
    // 300px is past the earliest time at 80px, so nothing moves
    expect(setTimeSpy).not.toHaveBeenCalled();
  });

  it("scrolls the timeline while dragging at the top edge", () => {
    const { result, timeline, thumb } = setup({
      initialTime: T - 75,
      scrollTop: 200,
    });
    thumb.getBoundingClientRect = () => ({ top: 5 }) as DOMRect;
    flushFrames();
    act(() => result.current.handleMouseDown(reactMouse(5)));
    expect(timeline.scrollTop).toBeLessThan(200);
    const afterFirst = timeline.scrollTop;
    // the edge keeps scrolling on the next frame
    flushFrames();
    expect(timeline.scrollTop).toBeLessThan(afterFirst);
  });

  it("scrolls the timeline while dragging at the bottom edge", () => {
    const { result, timeline, thumb, unmount } = setup({ initialTime: T - 75 });
    thumb.getBoundingClientRect = () => ({ top: 395 }) as DOMRect;
    flushFrames();
    act(() => result.current.handleMouseDown(reactMouse(395)));
    expect(timeline.scrollTop).toBeGreaterThan(0);
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it("swallows the iOS ghost click inside the timeline after a touch drag", () => {
    fx.isIOS = true;
    const { result, timeline } = setup({ initialTime: T - 75 });
    const inside = document.createElement("span");
    timeline.appendChild(inside);
    document.body.appendChild(timeline);
    act(() => result.current.handleMouseDown(reactMouse(30)));

    act(() =>
      result.current.handleMouseUp(
        new TouchEvent("touchend", { cancelable: true }),
      ),
    );
    const ghost = new MouseEvent("click", { bubbles: true, cancelable: true });
    inside.dispatchEvent(ghost);
    expect(ghost.defaultPrevented).toBe(true);

    // the listener is gone after the first click
    const next = new MouseEvent("click", { bubbles: true, cancelable: true });
    inside.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(false);
    timeline.remove();
  });

  it("lets a click outside the timeline through", () => {
    fx.isIOS = true;
    const { result } = setup({ initialTime: T - 75 });
    act(() => result.current.handleMouseDown(reactMouse(30)));
    act(() =>
      result.current.handleMouseUp(
        new TouchEvent("touchend", { cancelable: true }),
      ),
    );
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it("reads the touch position for touch drags", () => {
    const { result, thumb } = setup({ initialTime: T - 75 });
    flushFrames();
    const start = new TouchEvent("touchstart");
    Object.defineProperty(start, "touches", { value: [{ clientY: 30 }] });
    act(() =>
      result.current.handleMouseDown(
        asEvent<React.TouchEvent<HTMLDivElement>>({
          nativeEvent: start,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        }),
      ),
    );
    now = 5000;
    const move = new TouchEvent("touchmove");
    Object.defineProperty(move, "touches", { value: [{ clientY: 46 }] });
    act(() => result.current.handleMouseMove(move));
    flushFrames();
    expect(thumb.style.top).toBe("36px");
  });

  describe("when the timeline collapses", () => {
    // the collapse handling scrolls even while the user interacts, which
    // keeps the regular placement scroll out of these assertions
    beforeEach(() => {
      fx.userInteracting = true;
    });

    it("scrolls to the handle's segment", () => {
      const { scrollToSegment } = setup({
        initialTime: T - 75,
        timelineCollapsed: true,
      });
      expect(scrollToSegment).toHaveBeenCalledWith(T - 90);
    });

    it("moves to the next segment when the handle's one collapsed away", () => {
      const segments = SEGMENTS.filter((s) => s !== T - 90 && s !== T - 60);
      const { scrollToSegment, setTimeSpy } = setup({
        initialTime: T - 75,
        timelineCollapsed: true,
        segments,
      });
      expect(scrollToSegment).toHaveBeenCalledWith(T - 30);
      expect(setTimeSpy).toHaveBeenCalledWith(T - 30);
    });

    it("falls back to the first segment when nothing later exists", () => {
      const segments = [T - 300, T - 330];
      const { scrollToSegment, setTimeSpy } = setup({
        initialTime: T - 75,
        timelineCollapsed: true,
        segments,
      });
      expect(scrollToSegment).toHaveBeenCalledWith(T - 300);
      expect(setTimeSpy).toHaveBeenCalledWith(T - 300);
    });
  });
});
