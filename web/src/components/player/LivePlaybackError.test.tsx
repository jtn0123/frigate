import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import axios from "axios";
import { LivePlaybackError } from "./LivePlaybackError";

vi.mock("axios", () => ({ default: { post: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
beforeEach(() => {
  vi.mocked(axios.post).mockResolvedValue({
    data: { id: "abc123", status: "decode_error" },
  });
});

it("shows the failure, requests a diagnostic, and retries on demand", async () => {
  const retry = vi.fn();
  render(
    <LivePlaybackError
      streamName="side yard"
      reason="mse-decode"
      mediaErrorCode={3}
      onRetry={retry}
    />,
  );
  expect(screen.getByRole("alert")).toBeVisible();
  expect(
    await screen.findByText("playbackError.diagnostics.decode_error"),
  ).toBeVisible();
  expect(axios.post).toHaveBeenCalledWith(
    "go2rtc/streams/side%20yard/diagnostics",
    { reason: "mse-decode", media_error_code: 3 },
    expect.objectContaining({ timeout: 20_000 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "playbackError.retry" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("keeps Retry available if backend diagnostics fail", async () => {
  vi.mocked(axios.post).mockRejectedValue(new Error("offline"));
  render(
    <LivePlaybackError streamName="side" reason="startup" onRetry={vi.fn()} />,
  );
  expect(
    await screen.findByText("playbackError.diagnostics.unavailable"),
  ).toBeVisible();
  expect(screen.getByRole("button")).toBeEnabled();
});
