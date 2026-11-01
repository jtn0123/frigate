import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BirdseyeConfig } from "@/types/frigateConfig";
import BirdseyeLivePlayer from "../BirdseyeLivePlayer";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../lazyPlayers", () => ({
  JSMpegPlayer: () => <div data-testid="jsmpeg" />,
  MSEPlayer: () => <div data-testid="mse" />,
  WebRtcPlayer: () => <div data-testid="webrtc" />,
}));

const birdseye = { width: 1280, height: 720 } as BirdseyeConfig;

function renderPlayer(onClick?: () => void) {
  return render(
    <BirdseyeLivePlayer
      birdseyeConfig={birdseye}
      liveMode="webrtc"
      containerRef={{ current: null }}
      {...(onClick ? { onClick } : {})}
    />,
  );
}

describe("BirdseyeLivePlayer (fork UI155)", () => {
  it("names the tile when it opens Birdseye", () => {
    const onClick = vi.fn();
    renderPlayer(onClick);
    const tile = screen.getByRole("button", { name: "a11yLabels.birdseye" });
    fireEvent.keyDown(tile, { key: "Enter" });
    expect(onClick).toHaveBeenCalled();
  });

  it("is neither a button nor named when it does nothing", () => {
    const { container } = renderPlayer();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("[aria-label]")).toBeNull();
  });
});
