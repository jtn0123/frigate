import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolApprovalCard } from "../ToolApprovalCard";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

const call = {
  id: "call_1",
  name: "set_camera_state",
  arguments: { camera: "front", feature: "detect", value: "OFF" },
};

describe("ToolApprovalCard (D56)", () => {
  it("shows the arguments and reports each decision with the call id", () => {
    const onApprove = vi.fn();
    const onAlwaysAllow = vi.fn();
    const onReject = vi.fn();
    render(
      <ToolApprovalCard
        toolCall={call}
        onApprove={onApprove}
        onAlwaysAllow={onAlwaysAllow}
        onReject={onReject}
      />,
    );

    expect(screen.getByRole("group")).toHaveAttribute(
      "aria-label",
      "approval.title",
    );
    expect(screen.getByText(/"feature": "detect"/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "approval.approve" }));
    fireEvent.click(
      screen.getByRole("button", { name: "approval.always_allow" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "approval.reject" }));

    expect(onApprove).toHaveBeenCalledWith("call_1");
    expect(onAlwaysAllow).toHaveBeenCalledWith("call_1", "set_camera_state");
    expect(onReject).toHaveBeenCalledWith("call_1");
  });

  it.each([
    ["approve", "approval.approved"],
    ["reject", "approval.rejected"],
  ] as const)(
    "collapses to a status line once %s is chosen",
    (decision, key) => {
      render(
        <ToolApprovalCard
          toolCall={{ ...call, arguments: {} }}
          decision={decision}
          onApprove={vi.fn()}
          onAlwaysAllow={vi.fn()}
          onReject={vi.fn()}
        />,
      );
      expect(screen.getByText(key)).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByText(/\{/)).not.toBeInTheDocument();
    },
  );
});
