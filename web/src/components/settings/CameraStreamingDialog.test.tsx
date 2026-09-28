import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import type { GroupStreamingSettings } from "@/types/frigateConfig";
import { CameraStreamingDialog } from "./CameraStreamingDialog";

let mockConfig: unknown;

vi.mock("swr", () => ({
  default: (key: string | null) => ({
    data: key === "config" ? mockConfig : undefined,
  }),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
  Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/hooks/use-doc-domain", () => ({
  useDocDomain: () => ({ getLocaleDocUrl: (path: string) => path }),
}));
vi.mock("@/hooks/use-camera-friendly-name", () => ({
  useCameraFriendlyName: (camera: string) => camera,
}));
vi.mock("@/hooks/use-webrtc-availability", () => ({
  useWebRTCAvailableForStream: () => ({ available: true, reason: undefined }),
}));
vi.mock("@/components/player/StreamTechnologySelect", () => ({
  default: () => <div data-testid="stream-technology" />,
}));

function configWith(go2rtc: Record<string, unknown>) {
  return {
    go2rtc,
    cameras: {
      front: { live: { streams: { Main: "front_main", Sub: "front_sub" } } },
    },
  };
}

function renderDialog(
  groupStreamingSettings: GroupStreamingSettings | undefined,
) {
  const setGroupStreamingSettings = vi.fn();
  const setIsDialogOpen = vi.fn();
  const onSave = vi.fn();
  render(
    <MemoryRouter>
      <Dialog open>
        <CameraStreamingDialog
          camera="front"
          groupStreamingSettings={groupStreamingSettings}
          setGroupStreamingSettings={setGroupStreamingSettings}
          setIsDialogOpen={setIsDialogOpen}
          onSave={onSave}
        />
      </Dialog>
    </MemoryRouter>,
  );
  return { setGroupStreamingSettings, setIsDialogOpen, onSave };
}

describe("CameraStreamingDialog", () => {
  beforeEach(() => {
    mockConfig = configWith({
      streams: { front_main: "rtsp://main", front_sub: "rtsp://sub" },
    });
  });

  it("renders and saves defaults for a group with no saved streaming settings", () => {
    const { setGroupStreamingSettings, onSave } = renderDialog(undefined);

    fireEvent.click(screen.getByRole("button", { name: "button.save" }));

    const expected = {
      front: {
        streamName: "front_main",
        streamType: "smart",
        playerMode: "mse",
        compatibilityMode: false,
        playAudio: false,
        volume: 1,
      },
    };
    expect(setGroupStreamingSettings).toHaveBeenCalledWith(expected);
    expect(onSave).toHaveBeenCalledWith(expected);
  });

  it("cancels without saved settings for the group", () => {
    const { setIsDialogOpen, setGroupStreamingSettings } =
      renderDialog(undefined);

    fireEvent.click(screen.getByRole("button", { name: "button.cancel" }));

    expect(setIsDialogOpen).toHaveBeenCalledWith(false);
    expect(setGroupStreamingSettings).not.toHaveBeenCalled();
  });

  it("renders when the config has no go2rtc streams", () => {
    // /api/config omits go2rtc.streams when none are configured
    mockConfig = configWith({});
    renderDialog({});

    expect(
      screen.getByText("streaming.restreaming.disabled"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("stream-technology")).not.toBeInTheDocument();
  });

  it("restores the saved settings for the camera", () => {
    const { setGroupStreamingSettings } = renderDialog({
      front: {
        streamName: "front_sub",
        streamType: "continuous",
        playerMode: "jsmpeg",
        compatibilityMode: true,
        playAudio: true,
        volume: 0.5,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "button.cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "button.save" }));

    expect(setGroupStreamingSettings).toHaveBeenLastCalledWith({
      front: {
        streamName: "front_sub",
        streamType: "continuous",
        playerMode: "jsmpeg",
        compatibilityMode: true,
        playAudio: true,
        volume: 0.5,
      },
    });
  });
});
