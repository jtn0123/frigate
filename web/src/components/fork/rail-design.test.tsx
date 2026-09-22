import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as flags from "@/fork/flags";
import { ID_LIVE } from "@/hooks/use-navigation";
import ForkNavButton from "./ForkNavButton";
import NavSearchButton from "./NavSearchButton";
import RailNavHint from "./RailNavHint";

const device = vi.hoisted(() => ({ desktop: true }));
vi.mock("react-device-detect", () => ({
  get isDesktop() {
    return device.desktop;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  device.desktop = true;
  vi.spyOn(flags, "isForkEnabled").mockReturnValue(true);
});

describe("desktop rail descriptions", () => {
  it("shows a translated description for a supported destination", () => {
    render(<RailNavHint id={ID_LIVE} />);
    expect(screen.getByText("railHints.live")).toBeVisible();
  });

  it("omits destination descriptions when theme controls are disabled", () => {
    vi.mocked(flags.isForkEnabled).mockReturnValue(false);
    const { container } = render(<RailNavHint id={ID_LIVE} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not invent a description for an unknown destination", () => {
    const { container } = render(<RailNavHint id={-1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("includes an optional description in a keyboard-accessible tooltip", async () => {
    render(
      <TooltipProvider>
        <ForkNavButton variant="sidebar" label="Search" hint="Find footage">
          <span>Icon</span>
        </ForkNavButton>
      </TooltipProvider>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Find footage",
    );
  });

  it("keeps existing label-only buttons free of empty hint paragraphs", async () => {
    render(
      <TooltipProvider>
        <ForkNavButton variant="sidebar" label="Search">
          <span>Icon</span>
        </ForkNavButton>
      </TooltipProvider>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "Search" }));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Search");
    expect(tooltip.querySelectorAll("p")).toHaveLength(1);
  });

  it("does not expose hover-only descriptions in the phone navigation", () => {
    device.desktop = false;
    render(
      <ForkNavButton variant="bottombar" label="Search" hint="Find footage">
        <span>Icon</span>
      </ForkNavButton>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "Search" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.queryByText("Find footage")).not.toBeInTheDocument();
  });

  it.each([true, false])(
    "retains the Explore location cue with theme controls %s",
    async (enabled) => {
      vi.mocked(flags.isForkEnabled).mockReturnValue(enabled);
      render(
        <TooltipProvider>
          <MemoryRouter initialEntries={["/explore"]}>
            <NavSearchButton />
          </MemoryRouter>
        </TooltipProvider>,
      );
      const search = screen.getByRole("button", { name: "navSearch.label" });
      expect(search).toHaveAttribute("aria-current", "page");
      fireEvent.focus(search);
      const tooltip = await screen.findByRole("tooltip");
      if (enabled) expect(tooltip).toHaveTextContent("navSearch.hint");
      else expect(tooltip).not.toHaveTextContent("navSearch.hint");
    },
  );
});
