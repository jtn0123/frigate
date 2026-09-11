import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AnimatedCircularProgressBar from "./circular-progress-bar";

describe("AnimatedCircularProgressBar", () => {
  it("does not use Tailwind arbitrary delay/duration on the value label", () => {
    const { container } = render(
      <AnimatedCircularProgressBar
        max={100}
        min={0}
        value={40}
        gaugePrimaryColor="red"
        gaugeSecondaryColor="gray"
      />,
    );

    const label = container.querySelector("[data-current-value]");
    expect(label).not.toBeNull();
    expect(label?.className).not.toMatch(/delay-\[/);
    expect(label?.className).not.toMatch(/duration-\[/);
    expect((label as HTMLElement).style.animationDuration).toBe(
      "var(--transition-length)",
    );
    expect((label as HTMLElement).style.animationDelay).toBe("var(--delay)");
  });
});
