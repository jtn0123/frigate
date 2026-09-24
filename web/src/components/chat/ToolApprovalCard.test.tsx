import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ToolApprovalCard } from "./ToolApprovalCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("shows write arguments and sends the exact call identity for each decision", () => {
  const onApprove = vi.fn(),
    onAlwaysAllow = vi.fn(),
    onReject = vi.fn();
  render(
    <ToolApprovalCard
      toolCall={{
        id: "call1",
        name: "create_export",
        arguments: { camera: "front" },
      }}
      onApprove={onApprove}
      onAlwaysAllow={onAlwaysAllow}
      onReject={onReject}
    />,
  );
  expect(screen.getByRole("group")).toHaveTextContent('"camera": "front"');
  fireEvent.click(screen.getByRole("button", { name: "approval.approve" }));
  fireEvent.click(
    screen.getByRole("button", { name: "approval.always_allow" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "approval.reject" }));
  expect(onApprove).toHaveBeenCalledWith("call1");
  expect(onAlwaysAllow).toHaveBeenCalledWith("call1", "create_export");
  expect(onReject).toHaveBeenCalledWith("call1");
});

it.each(["approve", "reject"] as const)(
  "replaces actions with the %s status",
  (decision) => {
    const { container } = render(
      <ToolApprovalCard
        toolCall={{ id: "call1", name: "create_export", arguments: {} }}
        decision={decision}
        onApprove={vi.fn()}
        onAlwaysAllow={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        decision === "approve" ? "approval.approved" : "approval.rejected",
      ),
    ).toBeVisible();
    expect(container.querySelector("pre")).toBeNull();
  },
);
