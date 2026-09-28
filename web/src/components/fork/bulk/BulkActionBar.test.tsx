import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BulkSelection } from "@/hooks/fork/use-bulk-selection";
import type { SearchResult } from "@/types/search";
import BulkActionBar from "./BulkActionBar";

const axiosDelete = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const axiosPost = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const toastSuccess = vi.fn<(...args: unknown[]) => void>();
const toastError = vi.fn<(...args: unknown[]) => void>();
let isAdmin = true;
let plusEnabled = true;

vi.mock("axios", () => ({
  default: {
    delete: (...args: unknown[]) => axiosDelete(...args),
    post: (...args: unknown[]) => axiosPost(...args),
  },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));
vi.mock("@/api/fork/client", () => ({
  useApi: () => ({ data: { plus: { enabled: plusEnabled } } }),
}));
vi.mock("@/hooks/use-is-admin", () => ({ useIsAdmin: () => isAdmin }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function item(id: string, eligible = true): SearchResult {
  return {
    id,
    has_snapshot: eligible,
    plus_id: eligible ? undefined : "already-submitted",
    data: { type: "object" },
  } as SearchResult;
}

function bulk(overrides: Partial<BulkSelection<SearchResult>> = {}) {
  const items = [item("one"), item("two"), item("three", false)];
  return {
    enabled: true,
    active: true,
    setActive: vi.fn(),
    items,
    selectedIds: ["one", "two", "three"],
    selectedItems: items,
    setSelectedIds: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    onItemClick: vi.fn(),
    ...overrides,
  } satisfies BulkSelection<SearchResult>;
}

describe("BulkActionBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdmin = true;
    plusEnabled = true;
  });

  it("hides when disabled, and starts selection mode from the idle button", () => {
    const disabled = bulk({ enabled: false });
    const { rerender } = render(
      <BulkActionBar bulk={disabled} onChanged={vi.fn()} />,
    );
    expect(screen.queryByTestId("bulk-action-bar")).not.toBeInTheDocument();
    const idle = bulk({ active: false, selectedIds: [], selectedItems: [] });
    rerender(<BulkActionBar bulk={idle} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId("bulk-select"));
    expect(idle.setActive).toHaveBeenCalledWith(true);
  });

  it("shows only eligible Plus items and reports mixed submit outcomes", async () => {
    axiosPost.mockResolvedValueOnce({ status: 200, data: { success: true } });
    axiosPost.mockResolvedValueOnce({ status: 200, data: { success: false } });
    const selection = bulk();
    const onChanged = vi.fn();
    render(<BulkActionBar bulk={selection} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("bulk-plus"));
    fireEvent.click(screen.getByTestId("bulk-confirm"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(axiosPost).toHaveBeenCalledTimes(2);
    expect(axiosPost).toHaveBeenCalledWith("events/one/plus", {
      include_annotation: 1,
    });
    expect(axiosPost).toHaveBeenCalledWith("events/two/plus", {
      include_annotation: 1,
    });
    expect(toastSuccess).toHaveBeenCalledWith("bulk.plus.submitted", {
      position: "top-center",
    });
    expect(toastError).toHaveBeenCalledWith("bulk.plus.failed", {
      position: "top-center",
    });
    expect(selection.clear).toHaveBeenCalledOnce();
    expect(selection.setActive).toHaveBeenCalledWith(false);
  });

  it("deletes selected IDs and keeps the selection on API failure", async () => {
    const selection = bulk();
    const onChanged = vi.fn();
    axiosDelete.mockRejectedValueOnce({
      response: { data: { detail: "denied" } },
    });
    render(<BulkActionBar bulk={selection} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId("bulk-delete"));
    fireEvent.click(screen.getByTestId("bulk-confirm"));
    await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    expect(axiosDelete).toHaveBeenCalledWith("events/", {
      data: { event_ids: ["one", "two", "three"] },
    });
    expect(selection.clear).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not offer privileged actions to a non-admin without Plus", () => {
    isAdmin = false;
    plusEnabled = false;
    const selection = bulk({
      selectedIds: ["one"],
      selectedItems: [item("one")],
    });
    render(<BulkActionBar bulk={selection} onChanged={vi.fn()} />);
    expect(screen.queryByTestId("bulk-delete")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bulk-plus")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("bulk-select-all"));
    expect(selection.selectAll).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("bulk-cancel"));
    expect(selection.clear).toHaveBeenCalledOnce();
  });
});
