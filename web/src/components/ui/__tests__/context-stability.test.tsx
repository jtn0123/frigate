import { memo, Profiler, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MobilePage, MobilePageTrigger } from "@/components/mobile/MobilePage";
import { FormField, FormItem, useFormField } from "../form";
import { ToggleGroup, ToggleGroupItem } from "../toggle-group";

vi.mock("@/hooks/use-history-back", () => ({ useHistoryBack: () => {} }));
vi.mock("react-hook-form", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-hook-form")>()),
  Controller: ({ render: renderField }: { render: () => ReactNode }) =>
    renderField(),
  useFormContext: () => ({ getFieldState: () => ({}), formState: {} }),
}));

it("mobile page avoids unrelated trigger renders and keeps open callbacks current", () => {
  const commits = vi.fn();
  const onOpenChange = vi.fn();
  const Trigger = memo(MobilePageTrigger);
  const child = (
    <Profiler id="mobile" onRender={commits}>
      <Trigger>Open</Trigger>
    </Profiler>
  );
  const view = render(
    <MobilePage open={false} onOpenChange={onOpenChange}>
      {child}
    </MobilePage>,
  );
  const count = commits.mock.calls.length;
  view.rerender(
    <MobilePage open={false} onOpenChange={onOpenChange}>
      {child}
    </MobilePage>,
  );
  expect(commits).toHaveBeenCalledTimes(count);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(onOpenChange).toHaveBeenCalledWith(true);
  const replacement = vi.fn();
  view.rerender(
    <MobilePage open={false} onOpenChange={replacement}>
      {child}
    </MobilePage>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(replacement).toHaveBeenCalledWith(true);
});

it("form field avoids unrelated consumer renders and publishes a changed name", () => {
  const renders = vi.fn();
  const Probe = memo(function Probe() {
    const field = useFormField();
    renders();
    return <span>{field.name}</span>;
  });
  const child = <Probe />;
  const renderField = () => child;
  const view = render(<FormField name="first" render={renderField} />);
  const count = renders.mock.calls.length;
  view.rerender(<FormField name="first" render={renderField} />);
  expect(renders).toHaveBeenCalledTimes(count);
  view.rerender(<FormField name="second" render={renderField} />);
  expect(screen.getByText("second").textContent).toBe("second");
});

it("form item retains its field identity without unrelated consumer renders", () => {
  const renders = vi.fn();
  const Probe = memo(function Probe() {
    const field = useFormField();
    renders();
    return <span data-testid="field-id">{field.formItemId}</span>;
  });
  const child = <Probe />;
  const view = render(<FormItem>{child}</FormItem>);
  const id = screen.getByTestId("field-id").textContent;
  const count = renders.mock.calls.length;
  view.rerender(<FormItem>{child}</FormItem>);
  expect(renders).toHaveBeenCalledTimes(count);
  expect(screen.getByTestId("field-id").textContent).toBe(id);
});

it("toggle groups avoid unrelated item renders and publish size changes", () => {
  const commits = vi.fn();
  const Item = memo(ToggleGroupItem);
  const child = (
    <Profiler id="toggle" onRender={commits}>
      <Item value="front">Front</Item>
    </Profiler>
  );
  const view = render(
    <ToggleGroup type="single" size="sm">
      {child}
    </ToggleGroup>,
  );
  const count = commits.mock.calls.length;
  view.rerender(
    <ToggleGroup type="single" size="sm">
      {child}
    </ToggleGroup>,
  );
  expect(commits).toHaveBeenCalledTimes(count);
  const before = screen.getByRole("radio", { name: "Front" }).className;
  view.rerender(
    <ToggleGroup type="single" size="lg">
      {child}
    </ToggleGroup>,
  );
  expect(screen.getByRole("radio", { name: "Front" }).className).not.toBe(
    before,
  );
});
