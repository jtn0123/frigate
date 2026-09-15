import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLeaveMissingPage } from "./use-leave-missing-page";

type Props = { page: string; pages: Record<string, string[]> | undefined };

function setup(initialProps: Props) {
  const setPage = vi.fn<(page: string) => void>();
  const view = renderHook(
    ({ page, pages }: Props) => useLeaveMissingPage(page, pages, setPage),
    { initialProps },
  );
  return { setPage, rerender: view.rerender };
}

describe("useLeaveMissingPage", () => {
  it("goes back to train when the data no longer has the open page", () => {
    const { setPage, rerender } = setup({
      page: "alice",
      pages: { alice: ["alice-1.webp"], bob: ["bob-1.webp"] },
    });
    expect(setPage).not.toHaveBeenCalled();

    rerender({ page: "alice", pages: { bob: ["bob-1.webp"] } });
    expect(setPage).toHaveBeenCalledWith("train");
  });

  it("waits for the data and leaves train alone", () => {
    const { setPage, rerender } = setup({ page: "alice", pages: undefined });
    rerender({ page: "train", pages: { bob: [] } });
    expect(setPage).not.toHaveBeenCalled();
  });

  it("keeps a renamed page until the data has the new name", () => {
    const pages = { alice: ["alice-1.webp"] };
    const { setPage, rerender } = setup({ page: "alice", pages });

    rerender({ page: "alicia", pages });
    rerender({ page: "alicia", pages: { alicia: ["alice-1.webp"] } });
    expect(setPage).not.toHaveBeenCalled();
  });
});
