import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import StepIndicator from "../StepIndicator";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` }),
}));

const STEPS = ["steps.one", "steps.two", "steps.three"];

it("numbers and labels every step in the default variant", () => {
  render(<StepIndicator steps={STEPS} currentStep={1} />);

  for (const [index, step] of STEPS.entries()) {
    expect(screen.getByText(`${index + 1}`)).toBeTruthy();
    expect(screen.getByText(`t:${step}`)).toBeTruthy();
  }
});

it("draws one dot per step in the dots variant", () => {
  const { container } = render(
    <StepIndicator steps={STEPS} currentStep={1} variant="dots" />,
  );

  const fills = Array.from(container.querySelectorAll(".rounded-full"), (dot) =>
    dot.className.split(" ").find((name) => name.startsWith("bg-")),
  );
  expect(fills).toEqual(["bg-muted-foreground", "bg-selected", "bg-muted"]);
});
