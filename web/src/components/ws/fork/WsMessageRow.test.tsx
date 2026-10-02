import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsFeedMessage } from "@/api/ws";
import WsMessageRow from "../WsMessageRow";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string) => key,
  }),
}));

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function message(overrides: Partial<WsFeedMessage> = {}): WsFeedMessage {
  return {
    id: "m1",
    topic: "events",
    payload: null,
    // 2026-01-02 03:04:05.006 local time
    timestamp: new Date(2026, 0, 2, 3, 4, 5, 6).getTime(),
    ...overrides,
  };
}

function header(): HTMLElement {
  return screen.getByRole("button", { expanded: false });
}

function topicBadge(topic: string): HTMLElement {
  return screen.getByText(topic, { selector: "span.font-mono" });
}

function expand() {
  fireEvent.click(screen.getByRole("button", { expanded: false }));
}

function payloadPre(container: HTMLElement): HTMLPreElement {
  const pre = container.querySelector("pre");
  if (!pre) throw new Error("payload is not expanded");
  return pre;
}

describe("WsMessageRow header", () => {
  it("formats the timestamp as zero padded local time with milliseconds", () => {
    render(<WsMessageRow message={message()} />);
    expect(screen.getByText("03:04:05.006")).toBeInTheDocument();
  });

  it.each([
    ["events", "bg-blue-500/20"],
    ["reviews", "bg-blue-500/20"],
    ["tracked_object_update", "bg-blue-500/20"],
    ["triggers", "bg-blue-500/20"],
    ["stats", "bg-purple-500/20"],
    ["model_state", "bg-purple-500/20"],
    ["birdseye_layout", "bg-purple-500/20"],
    ["camera_activity", "bg-green-500/20"],
    ["audio_detections", "bg-green-500/20"],
    ["front/motion", "bg-green-500/20"],
    ["front/audio/rms", "bg-green-500/20"],
    ["front/detect/state", "bg-green-500/20"],
    ["front/recordings/state", "bg-green-500/20"],
    ["front/enabled/state", "bg-green-500/20"],
    ["front/snapshots/state", "bg-green-500/20"],
    ["front/ptz", "bg-green-500/20"],
    ["restart", "bg-gray-500/20"],
    ["front/notifications", "bg-gray-500/20"],
  ])("colors the %s topic badge by category", (topic, colorClass) => {
    render(<WsMessageRow message={message({ topic })} />);
    expect(topicBadge(topic)).toHaveClass(colorClass);
  });

  it("shows the camera taken from a camera topic", () => {
    render(<WsMessageRow message={message({ topic: "garage/motion" })} />);
    expect(screen.getByText("garage")).toHaveClass("bg-secondary");
  });

  it("hides the camera badge when showCameraBadge is false", () => {
    render(
      <WsMessageRow
        message={message({ topic: "garage/motion" })}
        showCameraBadge={false}
      />,
    );
    expect(screen.queryByText("garage")).toBeNull();
  });

  it("shows the camera taken from an event payload", () => {
    render(
      <WsMessageRow
        message={message({
          payload: { type: "new", after: { label: "car", camera: "drive" } },
        })}
      />,
    );
    expect(screen.getByText("drive")).toBeInTheDocument();
  });

  it("toggles the expanded payload on click and keyboard activation", () => {
    const { container } = render(
      <WsMessageRow message={message({ payload: { a: 1 } })} />,
    );
    expect(container.querySelector("pre")).toBeNull();

    const row = header();
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("logs.websocket.expanded.payload"),
    ).toBeInTheDocument();
    expect(container.querySelector("svg.rotate-90")).not.toBeNull();

    fireEvent.keyDown(row, { key: "Enter" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("pre")).toBeNull();

    fireEvent.keyDown(row, { key: " " });
    expect(row).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(row, { key: "a" });
    expect(row).toHaveAttribute("aria-expanded", "true");
  });
});

describe("WsMessageRow type badge", () => {
  it.each([
    ["new", "bg-orange-500/20"],
    ["start", "bg-green-500/20"],
    ["update", "bg-cyan-500/20"],
    ["end", "bg-red-500/20"],
  ])("colors the %s event type", (type, colorClass) => {
    render(
      <WsMessageRow
        message={message({
          topic: "reviews",
          payload: JSON.stringify({ type, after: { camera: "cam" } }),
        })}
      />,
    );
    expect(screen.getByText(type)).toHaveClass(colorClass);
  });

  it.each([
    ["description", "bg-amber-500/20"],
    ["face", "bg-pink-500/20"],
    ["lpr", "bg-yellow-500/20"],
    ["classification", "bg-violet-500/20"],
    ["mystery", "bg-orange-500/20"],
  ])("colors the %s tracked object update type", (type, colorClass) => {
    render(
      <WsMessageRow
        message={message({ topic: "tracked_object_update", payload: { type } })}
      />,
    );
    expect(screen.getAllByText(type)[0]).toHaveClass(colorClass);
  });

  it("has no type badge when the payload has no type", () => {
    render(
      <WsMessageRow message={message({ topic: "stats", payload: "{}" })} />,
    );
    expect(document.querySelectorAll("span.rounded.border")).toHaveLength(1);
  });

  it("has no type badge for a payload that is not JSON", () => {
    render(
      <WsMessageRow
        message={message({ topic: "front/motion", payload: "ON" })}
      />,
    );
    expect(document.querySelectorAll("span.rounded.border")).toHaveLength(1);
    expect(screen.getByText("ON")).toBeInTheDocument();
  });
});

describe("WsMessageRow summary", () => {
  function summaryText(payload: unknown, topic = "events"): string | null {
    const { container } = render(
      <WsMessageRow message={message({ topic, payload })} />,
    );
    return container.querySelector("span.truncate")?.textContent ?? null;
  }

  it("is empty for a null payload", () => {
    expect(summaryText(null)).toBe("");
  });

  it("summarizes an event with type, label and sub label", () => {
    expect(
      summaryText({
        type: "update",
        after: { label: "person", sub_label: "bob", camera: "front" },
      }),
    ).toBe("type: update, label: person, sub_label: bob");
  });

  it("omits the sub label outside the events topic", () => {
    expect(
      summaryText({ type: "new", label: "dog", sub_label: "rex" }, "triggers"),
    ).toBe("type: new, label: dog");
  });

  it("uses a question mark for an empty label", () => {
    expect(summaryText({ type: "end", after: { label: "" } })).toBe(
      "type: end, label: ?",
    );
  });

  it("summarizes a typed camera payload", () => {
    expect(summaryText({ type: "alert", camera: "back" }, "triggers")).toBe(
      "type: alert, camera: back",
    );
  });

  it("lists up to three keys with scalar values inline", () => {
    expect(summaryText({ a: 1, b: "two", c: { nested: true } }, "stats")).toBe(
      "a: 1, b: two, c",
    );
  });

  it("counts keys when there are more than three", () => {
    expect(summaryText({ a: 1, b: 2, c: 3, d: 4 }, "stats")).toBe("{4 keys}");
  });

  it("stringifies a scalar JSON payload", () => {
    expect(summaryText("42", "front/motion")).toBe("42");
  });

  it("truncates a long scalar payload to 80 characters", () => {
    const long = 1234567890.123;
    expect(summaryText(long, "front/motion")).toBe(String(long));
    const text = "x".repeat(100);
    expect(summaryText(text, "front/motion")).toBe(`${"x".repeat(80)}…`);
  });

  it("truncates a long scalar after parsing JSON", () => {
    const json = JSON.stringify("y".repeat(90));
    expect(summaryText(json, "front/motion")).toBe(`${"y".repeat(80)}…`);
  });

  it("is hidden for the reviews topic", () => {
    expect(
      summaryText({ type: "new", after: { label: "car" } }, "reviews"),
    ).toBeNull();
  });

  describe("tracked object updates", () => {
    const topic = "tracked_object_update";

    it.each([
      [{ type: "description", description: "A red car" }, "A red car"],
      [{ type: "description" }, "no description"],
      [{ type: "face", name: "alice" }, "alice"],
      [{ type: "face" }, "unknown"],
      [{ type: "lpr", name: "Dad", plate: "ABC123" }, "Dad"],
      [{ type: "lpr", plate: "ABC123" }, "ABC123"],
      [{ type: "lpr" }, "unknown"],
      [
        {
          type: "classification",
          model: "birds",
          sub_label: "robin",
          attribute: "flying",
        },
        "model: birds, sub_label: robin, attribute: flying",
      ],
      [{ type: "classification" }, "classification"],
      [{ type: "other" }, "other"],
      [{ id: "no-type" }, "unknown"],
    ])("summarizes %j as %s", (payload, expected) => {
      expect(summaryText(payload, topic)).toBe(expected);
    });
  });
});

describe("WsMessageRow label icon", () => {
  it("renders an icon for the label in the payload", () => {
    const { container } = render(
      <WsMessageRow
        message={message({
          payload: { type: "new", after: { label: "person" } },
        })}
      />,
    );
    expect(container.querySelector("span.shrink-0 > svg")).not.toBeNull();
  });

  it("renders no icon without a label", () => {
    const { container } = render(
      <WsMessageRow message={message({ topic: "stats", payload: "oops{" })} />,
    );
    expect(container.querySelector("span.shrink-0 > svg")).toBeNull();
  });
});

describe("WsMessageRow expanded payload", () => {
  it("highlights keys, strings, keywords and numbers", () => {
    const { container } = render(
      <WsMessageRow
        message={message({
          topic: "stats",
          payload: JSON.stringify({
            name: "<b>&",
            on: true,
            off: false,
            none: null,
            n: -1.5e3,
          }),
        })}
      />,
    );
    expand();
    const pre = payloadPre(container);
    expect(
      pre.querySelectorAll("span.text-indigo-400").length,
    ).toBeGreaterThanOrEqual(5);
    expect(pre.querySelector("span.text-green-500")?.textContent).toBe(
      '"<b>&"',
    );
    expect(pre.innerHTML).toContain("&lt;b&gt;&amp;");
    const keywords = Array.from(
      pre.querySelectorAll("span.text-orange-500"),
      (el) => el.textContent,
    );
    expect(keywords).toEqual(["true", "false", "null"]);
    expect(pre.querySelector("span.text-cyan-500")?.textContent).toBe("-1500");
  });

  it("shows a non JSON string payload as a quoted string", () => {
    const { container } = render(
      <WsMessageRow
        message={message({ topic: "front/motion", payload: "ON" })}
      />,
    );
    expand();
    expect(payloadPre(container).textContent).toBe('"ON"');
  });

  it("copies an object payload as pretty JSON and shows a check briefly", async () => {
    vi.useFakeTimers();
    const payload = { type: "new", after: { label: "cat" } };
    const { container } = render(
      <WsMessageRow message={message({ payload })} />,
    );
    expand();

    const copy = screen.getByRole("button", { name: "a11yLabels.copyJson" });
    await act(async () => {
      fireEvent.click(copy);
    });

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(payload, null, 2));
    // The click on the copy button does not collapse the row.
    expect(container.querySelector("pre")).not.toBeNull();
    expect(copy.querySelector("svg.text-green-500")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(copy.querySelector("svg.text-green-500")).toBeNull();
  });

  it("copies a string payload verbatim", async () => {
    render(
      <WsMessageRow
        message={message({ topic: "front/motion", payload: "OFF" })}
      />,
    );
    expand();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "a11yLabels.copyJson" }),
      );
    });
    expect(writeText).toHaveBeenCalledWith("OFF");
  });
});
