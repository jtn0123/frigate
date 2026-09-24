import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsNav from "./SettingsNav";

const setPage = vi.fn();
const setContentOpen = vi.fn();
const published = {
  page: "general",
  setPage,
  setContentOpen,
  groups: [
    { label: "system", items: [{ key: "general" }, { key: "network" }] },
    { label: "camera", items: [{ key: "recording" }] },
  ],
  visibleKeys: ["general", "network"],
  pendingDataBySection: {},
  sectionStatusByKey: { network: { hasChanges: true } },
  pendingKeyToMenuKey: () => undefined,
  saveAll: vi.fn(),
  saveDisabled: false,
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-device-detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-device-detect")>()),
  isMobile: false,
}));
vi.mock("@/fork/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/fork/flags")>()),
  isForkEnabled: () => true,
}));
vi.mock("@/hooks/fork/use-settings-nav", () => ({
  useSettingsNavStore: () => ({ published }),
}));
vi.mock("./SettingsReviewDialog", () => ({
  default: () => <div data-testid="review-dialog" />,
}));

function mount() {
  render(
    <div data-testid="scroll-container">
      <div data-settings-anchor="video">Video controls</div>
      <div data-field-id="threshold">
        <label htmlFor="threshold">Motion threshold *</label>
        <input id="threshold" />
      </div>
      <label htmlFor="other">Motion threshold *</label>
      <input id="other" />
      <SettingsNav />
    </div>,
  );
  const container = screen.getByTestId("scroll-container");
  container.scrollTo = vi.fn();
}

beforeEach(() => {
  vi.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsNav", () => {
  it("finds visible sections and marks pending changes", () => {
    mount();
    fireEvent.change(screen.getByTestId("settings-nav-search"), {
      target: { value: "network" },
    });
    const result = screen.getByTestId("settings-nav-section");
    expect(result).toHaveAttribute("data-section-key", "network");
    expect(screen.getByLabelText("settingsNav.unsaved")).toBeInTheDocument();
    expect(screen.queryByText("menu.recording")).not.toBeInTheDocument();
    fireEvent.click(result);
    expect(setPage).toHaveBeenCalledWith("network");
    expect(
      screen.getByTestId("scroll-container").scrollTo,
    ).toHaveBeenCalledWith({ top: 0 });
    expect(screen.getByTestId("settings-nav-search")).toHaveValue("");
  });

  it("finds labels, focuses their control, and removes the temporary highlight", () => {
    vi.useFakeTimers();
    try {
      mount();
      fireEvent.change(screen.getByTestId("settings-nav-search"), {
        target: { value: "motion threshold" },
      });
      const fields = screen.getAllByTestId("settings-nav-field");
      expect(fields).toHaveLength(2);
      fireEvent.click(fields[0] as HTMLElement);
      const wrapper = document.querySelector('[data-field-id="threshold"]');
      expect(wrapper).toHaveAttribute("data-settings-nav-highlight", "true");
      expect(document.getElementById("threshold")).toHaveFocus();
      expect(setPage).not.toHaveBeenCalled();
      void act(() => vi.advanceTimersByTime(1600));
      expect(wrapper).not.toHaveAttribute("data-settings-nav-highlight");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the current page anchors and navigates to one", async () => {
    mount();
    const rail = await screen.findByTestId("settings-nav-rail");
    const anchor = screen.getByRole("button", { name: "Video controls" });
    await waitFor(() => expect(anchor).toHaveAttribute("data-active", "true"));
    fireEvent.click(anchor);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      behavior: "smooth",
    });
    expect(rail).toContainElement(anchor);
  });

  it("dismisses search on Escape and outside pointer down", () => {
    mount();
    const input = screen.getByTestId("settings-nav-search");
    fireEvent.change(input, { target: { value: "network" } });
    expect(screen.getByTestId("settings-nav-results")).not.toHaveClass(
      "hidden",
    );
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(screen.getByTestId("settings-nav-results")).toHaveClass("hidden");
    fireEvent.focus(input);
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId("settings-nav-results")).toHaveClass("hidden");
  });
});
