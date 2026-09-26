import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportMode } from "@/types/filter";
import { RecordingView } from "../RecordingView";

const controller = vi.hoisted(() => ({
  playing: false,
  isPlaying: () => controller.playing,
  pause: vi.fn(() => {
    controller.playing = false;
  }),
  play: vi.fn(() => {
    controller.playing = true;
  }),
  seekToTimestamp: vi.fn(),
  scrubToTimestamp: vi.fn(),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));
vi.mock("react-device-detect", () => ({
  isDesktop: true,
  isMobile: false,
  isMobileOnly: false,
  isTablet: false,
  isIOS: false,
  isSafari: false,
}));

const CONFIG = vi.hoisted(() => ({
  cameras: {
    front: {
      ui: { review: true },
      record: { enabled: true, sub: { enabled: false } },
      detect: { width: 1280, height: 720 },
      review: { genai: { enabled_in_config: false } },
    },
  },
  ui: { timezone: "UTC" },
}));
vi.mock("swr", () => ({
  default: (key: unknown) => ({
    data: key === "config" ? CONFIG : undefined,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-persistence", () => ({
  usePersistence: <S,>(_key: string, defaultValue?: S) => {
    const [value, setValue] = useState<S | undefined>(defaultValue);
    return [value, setValue, true, () => setValue(defaultValue)];
  },
}));

vi.mock("@/hooks/use-overlay-state", () => ({
  useOverlayState: <S,>(_key: string, defaultValue?: S) =>
    useState<S | undefined>(defaultValue),
}));
vi.mock("@/hooks/use-is-admin", () => ({ useIsAdmin: () => true }));
vi.mock("@/hooks/use-allowed-cameras", () => ({
  useAllowedCameras: () => ["front"],
}));

// The view is the unit under test: its children are reduced to the props the
// range selection drives.
type ModeProps = { setMode: (mode: ExportMode) => void };

vi.mock("@/components/overlay/ExportDialog", () => ({
  default: ({ setMode }: ModeProps) => (
    <div>
      <button type="button" onClick={() => setMode("timeline")}>
        export range
      </button>
      <button type="button" onClick={() => setMode("timeline_multi")}>
        export multi range
      </button>
      <button type="button" onClick={() => setMode("none")}>
        export done
      </button>
    </div>
  ),
}));
vi.mock("@/components/overlay/DebugReplayDialog", () => ({
  default: ({ setMode }: ModeProps) => (
    <div>
      <button type="button" onClick={() => setMode("timeline")}>
        replay range
      </button>
      <button type="button" onClick={() => setMode("none")}>
        replay done
      </button>
    </div>
  ),
}));
vi.mock("@/components/player/dynamic/DynamicVideoPlayer", () => ({
  default: ({
    onControllerReady,
  }: {
    onControllerReady: (c: typeof controller) => void;
  }) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => onControllerReady(controller), [onControllerReady]);
    return null;
  },
}));

const { nothing, passthrough } = vi.hoisted(() => ({
  nothing: () => null,
  passthrough: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/card/ReviewCard", () => ({ default: nothing }));
vi.mock("@/components/filter/ReviewFilterGroup", () => ({ default: nothing }));
vi.mock("@/components/overlay/ActionsDropdown", () => ({ default: nothing }));
vi.mock("@/components/player/PreviewPlayer", () => ({ default: nothing }));
vi.mock("@/components/timeline/MotionReviewTimeline", () => ({
  default: nothing,
}));
vi.mock("@/components/timeline/DetailStream", () => ({ default: nothing }));
vi.mock("@/components/overlay/MobileCameraDrawer", () => ({
  default: nothing,
}));
vi.mock("@/components/overlay/MobileTimelineDrawer", () => ({
  default: nothing,
}));
vi.mock("@/components/overlay/MobileReviewSettingsDrawer", () => ({
  default: nothing,
}));
vi.mock("@/components/overlay/ShareTimestampDialog", () => ({
  default: nothing,
}));
vi.mock("@/components/fork/PhoneTimelineTabs", () => ({ default: nothing }));
vi.mock("@/components/Logo", () => ({ default: nothing }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: nothing }));
vi.mock("@/components/camera/FriendlyNameLabel", () => ({
  CameraNameLabel: nothing,
}));
vi.mock("@/components/overlay/chip/GenAISummaryChip", () => ({
  GenAISummaryDialog: passthrough,
  GenAISummaryChip: nothing,
}));
vi.mock("@/context/detail-stream-context", () => ({
  DetailStreamProvider: passthrough,
}));

const NOW = 1_700_000_000;

function renderView() {
  render(
    <MemoryRouter>
      <RecordingView
        startCamera="front"
        startTime={NOW - 600}
        timeRange={{ after: NOW - 3600, before: NOW }}
        allCameras={["front"]}
        updateFilter={vi.fn()}
      />
    </MemoryRouter>,
  );
}

const click = (name: string) =>
  act(() => {
    fireEvent.click(screen.getByRole("button", { name }));
  });

describe("RecordingView range selection (D58)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    // jsdom has no IntersectionObserver; the preview row observes visibility
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.clearAllMocks();
    controller.playing = false;
  });

  it("pauses a playing video while the export range is picked, then resumes", () => {
    renderView();
    controller.playing = true;

    click("export range");
    expect(controller.pause).toHaveBeenCalled();
    expect(controller.playing).toBe(false);

    // switching between range modes keeps the player paused
    click("export multi range");
    expect(controller.play).not.toHaveBeenCalled();

    click("export done");
    expect(controller.play).toHaveBeenCalled();
    expect(controller.playing).toBe(true);
  });

  it("leaves a paused video paused after the selection", () => {
    renderView();

    click("export range");
    click("export done");

    expect(controller.play).not.toHaveBeenCalled();
    expect(controller.playing).toBe(false);
  });

  it("debug replay range selection also holds the player", () => {
    renderView();
    controller.playing = true;

    click("replay range");
    expect(controller.pause).toHaveBeenCalled();

    click("replay done");
    expect(controller.playing).toBe(true);
  });
});
