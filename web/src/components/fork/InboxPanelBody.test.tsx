import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrigateReview } from "@/types/ws";
import type { ReviewSegment } from "@/types/review";
import {
  getInboxState,
  ingestReview,
  reloadInboxFromStorage,
} from "@/lib/fork/inbox-store";
import InboxPanelBody from "./InboxPanelBody";

vi.mock("@/api/fork/client", () => ({
  useApi: () => ({ data: { cameras: { front_door: {} } } }),
}));
vi.mock("@/hooks/use-allowed-cameras", () => ({
  useAllowedCameras: () => ["front_door"],
}));
vi.mock("@/components/dynamic/TimeAgo", () => ({
  default: () => <span>recently</span>,
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

function addReview(id: string, severity: "alert" | "detection" = "alert") {
  const segment: ReviewSegment = {
    id,
    camera: "front_door",
    severity,
    start_time: 1_000,
    thumb_path: `/media/frigate/clips/review/thumb-${id}.webp`,
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: [],
      objects: id === "empty-labels" ? [] : ["person"],
      sub_labels: [],
      significant_motion_areas: [],
      zones: [],
    },
  };
  ingestReview({
    type: "new",
    before: segment,
    after: segment,
  } as FrigateReview);
}

function renderPanel(onNavigate = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <InboxPanelBody onNavigate={onNavigate} />
    </MemoryRouter>,
  );
}

describe("InboxPanelBody", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadInboxFromStorage();
  });

  it("shows an empty inbox and disables bulk actions", () => {
    renderPanel();
    expect(screen.getByText("inbox.empty")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "inbox.markAllRead" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "inbox.clear" })).toBeDisabled();
  });

  it("opens a review, marks it read, and notifies the shell", () => {
    addReview("r1");
    const onNavigate = vi.fn();
    renderPanel(onNavigate);
    expect(screen.getByText("inbox.unreadCount:1")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-item")).toHaveAttribute(
      "data-read",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: /inbox.openItem/ }));
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(getInboxState().items[0]?.read).toBe(true);
    expect(screen.getByTestId("inbox-item")).toHaveAttribute(
      "data-read",
      "true",
    );
  });

  it("marks all read, dismisses an item, and clears the rest", () => {
    addReview("r1");
    addReview("empty-labels", "detection");
    renderPanel();
    expect(screen.getByText("inbox.noLabels")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "inbox.markAllRead" }));
    expect(getInboxState().items.every((item) => item.read)).toBe(true);
    fireEvent.click(
      screen.getAllByRole("button", { name: "inbox.dismiss" })[0]!,
    );
    expect(getInboxState().items).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "inbox.clear" }));
    expect(getInboxState().items).toHaveLength(0);
  });

  it("changes quiet hours and camera mute in the settings panel", () => {
    renderPanel();
    const settings = screen.getByRole("button", {
      name: "inbox.settings.title",
    });
    fireEvent.click(settings);
    expect(settings).toHaveAttribute("aria-pressed", "true");
    const quiet = screen.getByRole("switch", {
      name: "inbox.quietHours.title",
    });
    fireEvent.click(quiet);
    expect(getInboxState().settings.quietHours.enabled).toBe(true);
    fireEvent.change(screen.getByLabelText("inbox.quietHours.start"), {
      target: { value: "21:00" },
    });
    expect(getInboxState().settings.quietHours.start).toBe("21:00");
    fireEvent.click(screen.getByRole("switch", { name: /inbox.mute.camera/ }));
    expect(getInboxState().settings.mutedCameras).toEqual(["front_door"]);
    expect(screen.getByText("inbox.quietHours.active")).toBeInTheDocument();
  });
});
