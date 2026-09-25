import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSuggestionHint } from "./use-suggestion-hint";

const stored: Record<string, unknown> = {};
vi.mock("idb-keyval", () => ({
  get: (key: string) => Promise.resolve(stored[key]),
  set: (key: string, value: unknown) => {
    stored[key] = value;
    return Promise.resolve();
  },
  del: (key: string) => {
    delete stored[key];
    return Promise.resolve();
  },
}));

describe("useSuggestionHint", () => {
  it("shows the hint until it is dismissed, then remembers that", async () => {
    const { result } = renderHook(() => useSuggestionHint());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    await waitFor(() => expect(stored["fork.suggestionHintSeen"]).toBe(true));
  });
});
