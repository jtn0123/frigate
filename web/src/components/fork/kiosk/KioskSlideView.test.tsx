import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKioskLiveModes } from "@/hooks/fork/use-kiosk-live-modes";
import type { KioskSlide, KioskTileStream } from "@/lib/fork/kiosk";
import type { CameraConfig, FrigateConfig } from "@/types/frigateConfig";
import type { LivePlayerError, LivePlayerMode } from "@/types/live";
import KioskSlideView from "./KioskSlideView";

// Every mode each camera's tile was allowed to stream with, in order. Until
// the mode is worked out a tile shows its still and opens no stream.
const rendered = new Map<string, LivePlayerMode[]>();

vi.mock("@/components/fork/kiosk/KioskTile", () => ({
  default: ({
    camera,
    stream,
    preferredLiveMode,
    onError,
  }: {
    camera: CameraConfig;
    stream: KioskTileStream;
    preferredLiveMode: LivePlayerMode;
    onError: (error: LivePlayerError) => void;
  }) => {
    const modes = rendered.get(camera.name) ?? [];
    if (stream.autoLive && modes.at(-1) !== preferredLiveMode) {
      modes.push(preferredLiveMode);
    }
    rendered.set(camera.name, modes);
    return (
      <button
        type="button"
        data-testid={`tile-${camera.name}`}
        data-mode={preferredLiveMode}
        onClick={() => onError("mse-decode")}
      >
        {camera.name}
      </button>
    );
  },
}));
// Hooks return stable values, as the real ones do: a new object on every
// render would make the live mode hook recompute forever.
const stable = vi.hoisted(() => ({
  streaming: { allGroupsStreamingSettings: {} },
  layout: [undefined, () => {}, true],
  size: [() => {}, { width: 1920, height: 1080 }],
  persistence: [true, () => {}, true],
  metadata: {},
}));
vi.mock("@/context/streaming-settings-provider", () => ({
  useStreamingSettings: () => stable.streaming,
}));
vi.mock("@/hooks/fork/use-live-grid-layout", () => ({
  useLiveGridLayout: () => stable.layout,
}));
vi.mock("@/hooks/fork/use-element-size", () => ({
  useElementSize: () => stable.size,
}));
vi.mock("@/hooks/use-user-persistence", () => ({
  useUserPersistence: () => stable.persistence,
}));
vi.mock("@/hooks/use-deferred-stream-metadata", () => ({
  default: () => stable.metadata,
}));
vi.mock("@/hooks/use-webrtc-availability", () => ({
  useWebRTCGloballyAvailable: () => ({
    globallyAvailable: true,
    globalReason: null,
  }),
  evaluateStreamWebRTCAvailability: () => ({ available: true }),
}));

function camera(name: string) {
  return { name, live: { streams: { Main: name } } };
}

const cfg = (value: unknown) => value as FrigateConfig;

const config = cfg({
  cameras: { street: camera("street"), lot: camera("lot") },
  go2rtc: { streams: { street: ["rtsp://street"], lot: ["rtsp://lot"] } },
});

const grid: KioskSlide = {
  source: "default",
  cameras: ["street", "lot"],
  page: 0,
  pages: 2,
};
const other: KioskSlide = {
  source: "default",
  cameras: ["lot"],
  page: 1,
  pages: 2,
};

function Display({ slide }: Readonly<{ slide: KioskSlide }>) {
  const { learnedModes, learnMode } = useKioskLiveModes();
  // keyed like the page: every visit mounts the slide again
  return (
    <KioskSlideView
      key={`${slide.source}-${slide.page}`}
      slide={slide}
      single={false}
      savedLayout={false}
      windowVisible
      learnedModes={learnedModes}
      onLearnMode={learnMode}
    />
  );
}

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: { config },
        fetcher: () => Promise.resolve(config),
        revalidateOnMount: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}

function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  rendered.clear();
  // jsdom has no MediaSource; Live picks MSE first where it exists
  vi.stubGlobal("MediaSource", class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("KioskSlideView live mode fallback", () => {
  it("starts a camera with the fallback it needed on an earlier visit", () => {
    const { rerender } = render(<Display slide={grid} />, { wrapper });
    expect(screen.getByTestId("tile-street")).toHaveAttribute(
      "data-mode",
      "mse",
    );

    fireEvent.click(screen.getByTestId("tile-street"));
    expect(screen.getByTestId("tile-street")).toHaveAttribute(
      "data-mode",
      "webrtc",
    );
    // other cameras keep their own mode
    expect(screen.getByTestId("tile-lot")).toHaveAttribute("data-mode", "mse");

    rerender(<Display slide={other} />);
    expect(screen.queryByTestId("tile-street")).not.toBeInTheDocument();

    rendered.clear();
    rerender(<Display slide={grid} />);
    expect(screen.getByTestId("tile-street")).toHaveAttribute(
      "data-mode",
      "webrtc",
    );
    // no new MSE attempt on the return visit
    expect(rendered.get("street")).toEqual(["webrtc"]);
  });

  it("tries the camera's own mode again once the page is back in view", () => {
    const { rerender } = render(<Display slide={grid} />, { wrapper });
    fireEvent.click(screen.getByTestId("tile-street"));
    rerender(<Display slide={other} />);

    setVisibility("hidden");
    setVisibility("visible");
    rerender(<Display slide={grid} />);
    expect(screen.getByTestId("tile-street")).toHaveAttribute(
      "data-mode",
      "mse",
    );
  });
});
