import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ShareClipPage from "./ShareClipPage";

const axiosGet = vi.fn<(url: string) => Promise<unknown>>();

vi.mock("axios", () => ({
  default: { get: (url: string) => axiosGet(url) },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

const TOKEN = "e2eShareToken123456789012345678";
const SHARE = {
  token: TOKEN,
  url: `/share/${TOKEN}`,
  expires_at: 1,
  event_id: "event-1",
  camera: "front_door",
  label: "person",
  start_time: 1,
  end_time: 2,
  has_clip: true,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/share/:token" element={<ShareClipPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ShareClipPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    "short",
    "bad%20token%20value",
    "dots..in..the..token",
    "a".repeat(65),
  ])("shows the missing state without a request for the token %s", (token) => {
    renderAt(`/share/${token}`);

    expect(screen.getByText("clipShare.missing")).toBeInTheDocument();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it("requests a well-formed token and labels the QR code as an image", async () => {
    axiosGet.mockResolvedValue({
      data: {
        token: "e2eShareToken123456789012345678",
        url: "/share/e2eShareToken123456789012345678",
        expires_at: 1,
        event_id: "event-1",
        camera: "front_door",
        label: "person",
        start_time: 1,
        end_time: 2,
        has_clip: false,
      },
    });
    renderAt("/share/e2eShareToken123456789012345678");

    expect(
      await screen.findByRole("img", { name: "clipShare.qr" }),
    ).toBeInTheDocument();
    expect(axiosGet).toHaveBeenCalledWith(
      "fork/share/e2eShareToken123456789012345678",
    );
  });

  it("shows the expired state for a 410", async () => {
    axiosGet.mockRejectedValue({ response: { status: 410 } });
    renderAt("/share/e2eShareToken123456789012345678");

    expect(await screen.findByText("clipShare.expired")).toHaveRole("status");
    expect(
      screen.queryByRole("button", { name: "clipShare.retry" }),
    ).not.toBeInTheDocument();
  });

  it("shows the missing state for a 404, with no retry", async () => {
    axiosGet.mockRejectedValue({ response: { status: 404 } });
    renderAt(`/share/${TOKEN}`);

    expect(await screen.findByText("clipShare.missing")).toHaveRole("status");
    expect(
      screen.queryByRole("button", { name: "clipShare.retry" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["a network error", new Error("offline")],
    ["a 500", { response: { status: 500 } }],
    ["a 429", { response: { status: 429 } }],
  ])(
    "shows a retryable error, not 'not found', for %s",
    async (_name, error) => {
      axiosGet.mockRejectedValueOnce(error);
      axiosGet.mockResolvedValueOnce({ data: SHARE });
      renderAt(`/share/${TOKEN}`);

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "clipShare.loadFailed",
      );
      expect(screen.queryByText("clipShare.missing")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "clipShare.retry" }));
      expect(
        await screen.findByLabelText("clipShare.play"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(axiosGet).toHaveBeenCalledTimes(2);
    },
  );

  it("formats the camera name like the active links list", async () => {
    axiosGet.mockResolvedValue({ data: SHARE });
    renderAt(`/share/${TOKEN}`);

    expect(await screen.findByText("person · front door")).toBeInTheDocument();
  });

  it("says so when the clip fails to play, and retrying finds an expired link", async () => {
    axiosGet.mockResolvedValueOnce({ data: SHARE });
    axiosGet.mockRejectedValueOnce({ response: { status: 410 } });
    renderAt(`/share/${TOKEN}`);

    fireEvent.error(await screen.findByLabelText("clipShare.play"));
    expect(screen.getByRole("alert")).toHaveTextContent("clipShare.playFailed");
    expect(screen.queryByLabelText("clipShare.play")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "clipShare.retry" }));
    expect(await screen.findByText("clipShare.expired")).toHaveRole("status");
  });

  it("marks the no-clip notice as a status", async () => {
    axiosGet.mockResolvedValue({ data: { ...SHARE, has_clip: false } });
    renderAt(`/share/${TOKEN}`);

    expect(await screen.findByText("clipShare.noClip")).toHaveRole("status");
  });
});
