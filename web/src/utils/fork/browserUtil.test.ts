import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copy = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("copy-to-clipboard", () => ({ default: copy }));
vi.mock("sonner", () => ({ toast: { success: toastSuccess } }));

import { shareOrCopy } from "../browserUtil";

// copy-to-clipboard 4 resolves to whether the copy worked (F18).
describe("shareOrCopy without the share sheet", () => {
  beforeEach(() => {
    vi.stubGlobal("isSecureContext", false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("confirms a copy that worked", async () => {
    copy.mockResolvedValue(true);
    shareOrCopy("https://nvr.example/export/1", "Export");
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(copy).toHaveBeenCalledWith("https://nvr.example/export/1");
  });

  it("stays quiet when the browser refused the copy", async () => {
    copy.mockResolvedValue(false);
    shareOrCopy("https://nvr.example/export/2");
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("shareOrCopy with the share sheet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shares instead of copying", () => {
    const share = vi.fn(() => Promise.resolve());
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { ...navigator, share });
    shareOrCopy("https://nvr.example/export/3", "Export");
    expect(share).toHaveBeenCalledWith({
      url: "https://nvr.example/export/3",
      title: "Export",
    });
    expect(copy).not.toHaveBeenCalled();
  });
});
