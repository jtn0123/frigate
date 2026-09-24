import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewSegment } from "@/types/review";
import {
  MIN_REVIEW_DESCRIPTION_CONTEXT,
  useReviewDescriptions,
} from "./use-review-descriptions";

const axiosPut = vi.fn<(url: string) => Promise<unknown>>();
const toastSuccess = vi.fn<(...args: unknown[]) => void>();
const toastError = vi.fn<(...args: unknown[]) => void>();
let isAdmin = true;
let swrData: Record<string, unknown> = {};
const swrKeys: (string | null)[] = [];

vi.mock("axios", () => ({
  default: { put: (url: string) => axiosPut(url) },
}));
vi.mock("swr", () => ({
  default: (key: string | null) => {
    swrKeys.push(key);
    return { data: key ? swrData[key] : undefined };
  },
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));
vi.mock("./use-is-admin", () => ({ useIsAdmin: () => isAdmin }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string, opts?: { error?: string }) =>
      opts?.error ? `${key}:${opts.error}` : key,
  }),
}));

const REVIEW = {
  id: "r1",
  camera: "front_door",
  end_time: 20,
} as ReviewSegment;

function setup(contextSize: number, genaiEnabled = true) {
  swrData = {
    config: {
      cameras: { front_door: { review: { genai: { enabled: genaiEnabled } } } },
    },
    "genai/roles": {
      descriptions: { name: "local", model: "m", context_size: contextSize },
    },
  };
}

describe("useReviewDescriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdmin = true;
    swrKeys.length = 0;
    setup(MIN_REVIEW_DESCRIPTION_CONTEXT);
  });

  it("allows a finished item on a GenAI camera with enough context", () => {
    const { result } = renderHook(() => useReviewDescriptions());
    expect(result.current.canGenerateDescription(REVIEW)).toBe(true);
  });

  it("refuses when the descriptions model has too little context", () => {
    setup(MIN_REVIEW_DESCRIPTION_CONTEXT - 1);
    const { result } = renderHook(() => useReviewDescriptions());
    expect(result.current.canGenerateDescription(REVIEW)).toBe(false);
  });

  it("refuses an item that has not ended", () => {
    const { result } = renderHook(() => useReviewDescriptions());
    expect(
      result.current.canGenerateDescription({
        ...REVIEW,
        end_time: undefined,
      } as ReviewSegment),
    ).toBe(false);
  });

  it("refuses a camera without GenAI review descriptions", () => {
    setup(MIN_REVIEW_DESCRIPTION_CONTEXT, false);
    const { result } = renderHook(() => useReviewDescriptions());
    expect(result.current.canGenerateDescription(REVIEW)).toBe(false);
  });

  it("does not fetch roles or allow generation for non-admins", () => {
    isAdmin = false;
    const { result } = renderHook(() => useReviewDescriptions());
    expect(swrKeys).not.toContain("genai/roles");
    expect(result.current.canGenerateDescription(REVIEW)).toBe(false);
  });

  it("requests generation and toasts success", async () => {
    axiosPut.mockResolvedValue({ status: 202 });
    const { result } = renderHook(() => useReviewDescriptions());
    result.current.generateDescription(REVIEW);

    expect(axiosPut).toHaveBeenCalledWith("review/r1/regenerate_description");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0][0]).toBe(
      "recording.genaiDescription.toast.success",
    );
  });

  it("toasts the server message on failure", async () => {
    axiosPut.mockRejectedValue({
      response: { data: { message: "not enabled" } },
    });
    const { result } = renderHook(() => useReviewDescriptions());
    result.current.generateDescription(REVIEW);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toBe(
      "recording.genaiDescription.toast.error:not enabled",
    );
  });
});
