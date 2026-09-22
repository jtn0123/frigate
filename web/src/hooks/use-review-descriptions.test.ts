import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useReviewDescriptions } from "./use-review-descriptions";
import type { ReviewSegment } from "@/types/review";

const state = vi.hoisted(() => ({
  admin: true,
  context: 32000,
  enabled: true,
  put: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("axios", () => ({
  default: { put: state.put, isAxiosError: () => true },
}));
vi.mock("sonner", () => ({
  toast: { success: state.success, error: state.error },
}));
vi.mock("./use-is-admin", () => ({ useIsAdmin: () => state.admin }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("swr", () => ({
  default: (key: string) => ({
    data:
      key === "config"
        ? {
            cameras: {
              front: { review: { genai: { enabled: state.enabled } } },
            },
          }
        : { descriptions: { context_size: state.context } },
  }),
}));

const review = {
  id: "review1",
  camera: "front",
  end_time: 200,
} as ReviewSegment;

beforeEach(() => {
  state.admin = true;
  state.context = 32000;
  state.enabled = true;
  state.put.mockResolvedValue({ status: 202 });
});

it("offers generation only for completed reviews with enabled GenAI and sufficient context", () => {
  const { result, rerender } = renderHook(() => useReviewDescriptions());
  expect(result.current.canGenerateDescription(review)).toBe(true);
  expect(
    result.current.canGenerateDescription({ ...review, end_time: undefined }),
  ).toBe(false);
  expect(
    result.current.canGenerateDescription({ ...review, camera: "removed" }),
  ).toBe(false);
  state.admin = false;
  rerender();
  expect(result.current.canGenerateDescription(review)).toBe(false);
  state.admin = true;
  state.context = 8192;
  rerender();
  expect(result.current.canGenerateDescription(review)).toBe(false);
  state.context = 32000;
  state.enabled = false;
  rerender();
  expect(result.current.canGenerateDescription(review)).toBe(false);
});

it("reports a queued request and surfaces a failed generation request", async () => {
  const { result } = renderHook(() => useReviewDescriptions());
  act(() => result.current.generateDescription(review));
  await waitFor(() => expect(state.success).toHaveBeenCalled());
  expect(state.put).toHaveBeenCalledWith(
    "review/review1/regenerate_description",
  );
  state.put.mockRejectedValue({
    response: { data: { message: "Provider unavailable" } },
  });
  act(() => result.current.generateDescription(review));
  await waitFor(() => expect(state.error).toHaveBeenCalled());
});
