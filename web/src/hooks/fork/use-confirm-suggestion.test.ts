import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Suggestion } from "@/lib/fork/classification-suggestions";
import { useConfirmSuggestion } from "./use-confirm-suggestion";

const post = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("axios", () => ({
  default: {
    post: (...args: unknown[]) => post(...args),
    isAxiosError: (error: unknown) =>
      typeof error === "object" && error != null && "isAxiosError" in error,
  },
}));
const toastSuccess = vi.fn<(...args: unknown[]) => void>();
const toastError = vi.fn<(...args: unknown[]) => void>();
const toastInfo = vi.fn<(...args: unknown[]) => void>();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}));
const swrMutate = vi.fn(() => Promise.resolve());
vi.mock("swr", () => ({ mutate: () => swrMutate() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const VAN: Suggestion = {
  category: "van",
  source: "jev",
  score: 0.9,
  evidence: "",
};

function httpError(status: number, data: unknown) {
  return { isAxiosError: true, response: { status, data } };
}

describe("useConfirmSuggestion", () => {
  beforeEach(() => {
    post.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    toastInfo.mockReset();
    swrMutate.mockClear();
  });

  it("resolves only after the grid has refreshed, then offers Undo", async () => {
    post.mockResolvedValueOnce({ data: { moved: ["van-1.png"] } });
    let finishRefresh: () => void = () => {};
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((done) => {
          finishRefresh = done;
        }),
    );
    const { result } = renderHook(() =>
      useConfirmSuggestion("vehicle_type", onRefresh),
    );

    let settled = false;
    let pending: Promise<boolean> = Promise.resolve(false);
    act(() => {
      pending = result.current("evt-1", ["a.webp"], VAN).then((ok) => {
        settled = true;
        return ok;
      });
    });
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    finishRefresh();
    await expect(pending).resolves.toBe(true);

    expect(post).toHaveBeenCalledWith(
      "classification/vehicle_type/suggestions/confirm",
      expect.not.objectContaining({ bulk: true }),
    );
    const [message, options] = toastSuccess.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe(
      'classificationSuggestions.confirmed:{"category":"van","count":1}',
    );
    expect(options.action.label).toBe("classificationSuggestions.undo");

    post.mockResolvedValueOnce({ data: { success: true, restored: 1 } });
    await act(async () => options.action.onClick());
    expect(post).toHaveBeenLastCalledWith(
      "classification/vehicle_type/suggestions/undo",
      { event_id: "evt-1", category: "van", files: ["van-1.png"] },
    );
    expect(toastSuccess).toHaveBeenLastCalledWith(
      'classificationSuggestions.undone:{"count":1}',
      { position: "top-center" },
    );
  });

  it("sends bulk and stays quiet for Accept all", async () => {
    post.mockResolvedValueOnce({ data: { moved: ["x.png"] } });
    const onRefresh = vi.fn();
    const { result } = renderHook(() =>
      useConfirmSuggestion("vehicle_type", onRefresh),
    );
    await expect(
      result.current("evt-1", ["a.webp"], VAN, undefined, true),
    ).resolves.toBe(true);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ bulk: true });
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("counts a group accepted elsewhere as done and refreshes", async () => {
    post.mockRejectedValue(httpError(404, { message: "already accepted" }));
    const onRefresh = vi.fn();
    const { result } = renderHook(() =>
      useConfirmSuggestion("vehicle_type", onRefresh),
    );
    await expect(result.current("evt-1", ["a.webp"], VAN)).resolves.toBe(true);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith(
      "classificationSuggestions.alreadyAccepted",
      { position: "top-center" },
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await expect(
      result.current("evt-1", ["a.webp"], VAN, undefined, true),
    ).resolves.toBe(true);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes on failure and passes the server's message through", async () => {
    post.mockRejectedValueOnce(httpError(400, { message: "Invalid category" }));
    const onRefresh = vi.fn();
    const { result } = renderHook(() =>
      useConfirmSuggestion("vehicle_type", onRefresh),
    );
    await expect(result.current("evt-1", ["a.webp"], VAN, "suv")).resolves.toBe(
      false,
    );
    expect(toastError).toHaveBeenCalledWith(
      'classificationSuggestions.overrideFailed:{"category":"suv"}',
      { position: "top-center", description: "Invalid category" },
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);

    post.mockRejectedValueOnce(new Error("offline"));
    await expect(result.current("evt-1", ["a.webp"], VAN)).resolves.toBe(false);
    expect(toastError).toHaveBeenLastCalledWith(
      "classificationSuggestions.confirmFailed",
      { position: "top-center" },
    );
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("offers no Undo when the server named no moved files", async () => {
    post.mockResolvedValueOnce({ data: { success: true } });
    const { result } = renderHook(() =>
      useConfirmSuggestion("vehicle_type", vi.fn()),
    );
    await result.current("evt-1", ["a.webp"], VAN);
    expect(toastSuccess.mock.calls[0]?.[1]).toEqual({
      position: "top-center",
    });
  });
});
