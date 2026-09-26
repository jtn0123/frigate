import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import VideoControls from "../VideoControls";

vi.mock("react-device-detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-device-detect")>()),
  isSafari: true,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it.each([undefined, [1, 3]])(
  "selects the offered playback rates on Safari (%s)",
  async (rates) => {
    const setRate = vi.fn();
    render(
      <VideoControls
        show
        isPlaying={false}
        hotKeys={false}
        features={{ playbackRate: true }}
        playbackRate={1}
        {...(rates ? { playbackRates: rates } : {})}
        onPlayPause={vi.fn()}
        onSeek={vi.fn()}
        onSetPlaybackRate={setRate}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "1x" }), {
      key: "ArrowDown",
    });
    const expectedRates = rates ?? [0.5, 1, 2, 4, 8, 16];
    for (const rate of expectedRates) {
      expect(
        await screen.findByRole("menuitemradio", { name: `${rate}x` }),
      ).toBeVisible();
    }
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(
      expectedRates.length,
    );
    const lastRate = expectedRates[expectedRates.length - 1];
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: `${lastRate}x` }),
    );
    expect(setRate).toHaveBeenCalledWith(lastRate);
  },
);
