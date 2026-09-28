import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUndoSuggestion } from "./use-undo-suggestion";

const post = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("axios", () => ({
  default: { post: (...args: unknown[]) => post(...args) },
}));
const toastSuccess = vi.fn<(...args: unknown[]) => void>();
const toastError = vi.fn<(...args: unknown[]) => void>();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));
const swrMutate = vi.fn((_key: unknown) => Promise.resolve());
vi.mock("swr", () => ({ mutate: (key: unknown) => swrMutate(key) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const BODY = { event_id: "evt-1", category: "van", files: ["a.png", "b.png"] };

describe("useUndoSuggestion", () => {
  beforeEach(() => {
    post.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    swrMutate.mockClear();
  });

  it("moves the files back and refreshes the grid and the report", async () => {
    post.mockResolvedValueOnce({
      data: { success: true, message: "ok", restored: ["x.webp", "y.webp"] },
    });
    const onRefresh = vi.fn();
    const { result } = renderHook(() =>
      useUndoSuggestion("vehicle_type", onRefresh),
    );
    await expect(result.current(BODY)).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith(
      "classification/vehicle_type/suggestions/undo",
      BODY,
    );
    expect(toastSuccess).toHaveBeenCalledWith(
      'classificationSuggestions.undone:{"count":2}',
      { position: "top-center" },
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(swrMutate).toHaveBeenCalledWith(
      "classification/vehicle_type/suggestions/report",
    );
  });

  it("reads a restored count, or falls back to the files sent", async () => {
    post.mockResolvedValueOnce({ data: { restored: 1 } });
    post.mockResolvedValueOnce({ data: { success: true } });
    const { result } = renderHook(() =>
      useUndoSuggestion("vehicle_type", vi.fn()),
    );
    await result.current(BODY);
    await result.current(BODY);
    expect(toastSuccess.mock.calls.map((call) => call[0])).toEqual([
      'classificationSuggestions.undone:{"count":1}',
      'classificationSuggestions.undone:{"count":2}',
    ]);
  });

  it("says so when the undo fails and still refreshes", async () => {
    post.mockRejectedValueOnce(new Error("offline"));
    const onRefresh = vi.fn();
    const { result } = renderHook(() =>
      useUndoSuggestion("vehicle_type", onRefresh),
    );
    await expect(result.current(BODY)).resolves.toBe(false);
    expect(toastError).toHaveBeenCalledWith(
      "classificationSuggestions.undoFailed",
      { position: "top-center" },
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
