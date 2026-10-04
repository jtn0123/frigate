import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KioskTileStream } from "@/lib/fork/kiosk";
import type { CameraConfig } from "@/types/frigateConfig";
import KioskTile from "./KioskTile";

vi.mock("@/components/player/LivePlayer", () => ({
  default: () => (
    <video data-testid="player-video">
      <track kind="captions" />
    </video>
  ),
}));
vi.mock("@/components/camera/AutoUpdatingCameraImage", () => ({
  default: ({ camera }: { camera: string }) => (
    <img alt={`still of ${camera}`} />
  ),
}));
vi.mock("@/hooks/use-camera-friendly-name", () => ({
  useCameraFriendlyName: (camera: CameraConfig) => camera.name,
}));

function camera(name: string): CameraConfig {
  return { name } as CameraConfig;
}

function stream(patch: Partial<KioskTileStream> = {}): KioskTileStream {
  return {
    streamName: "main",
    autoLive: true,
    showStillWithoutActivity: false,
    useWebGL: false,
    ...patch,
  };
}

function renderTile(name: string, tileStream: KioskTileStream) {
  return (
    <KioskTile
      camera={camera(name)}
      stream={tileStream}
      preferredLiveMode="mse"
      windowVisible
      onError={vi.fn()}
      onResetLiveMode={vi.fn()}
    />
  );
}

describe("KioskTile", () => {
  it("shows the latest still under a continuous stream until it plays", () => {
    render(renderTile("street", stream()));
    expect(screen.getByTestId("kiosk-tile-still")).toBeInTheDocument();
    expect(screen.getByAltText("still of street")).toBeInTheDocument();

    // "playing" does not bubble; the tile catches it while capturing
    fireEvent.playing(screen.getByTestId("player-video"));
    expect(screen.queryByTestId("kiosk-tile-still")).not.toBeInTheDocument();
  });

  it("holds the still again for another camera in the same tile", () => {
    const { rerender } = render(renderTile("street", stream()));
    fireEvent.playing(screen.getByTestId("player-video"));
    rerender(renderTile("walkway", stream()));
    expect(screen.getByAltText("still of walkway")).toBeInTheDocument();
  });

  it("leaves smart streaming tiles to the player's own still", () => {
    render(renderTile("street", stream({ showStillWithoutActivity: true })));
    expect(screen.queryByTestId("kiosk-tile-still")).not.toBeInTheDocument();
  });
});
