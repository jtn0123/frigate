import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
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

    expect(await screen.findByText("clipShare.expired")).toBeInTheDocument();
  });
});
