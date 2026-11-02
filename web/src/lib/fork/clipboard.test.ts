import { describe, expect, it, vi } from "vitest";

const copy = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
vi.mock("copy-to-clipboard", () => ({ default: copy }));

import { copyThen } from "./clipboard";

describe("copyThen", () => {
  it("runs onCopied after a copy that worked", async () => {
    copy.mockResolvedValue(true);
    const onCopied = vi.fn();
    const onRefused = vi.fn();
    await copyThen("abc", onCopied, onRefused);
    expect(copy).toHaveBeenCalledWith("abc");
    expect(onCopied).toHaveBeenCalledTimes(1);
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("runs onRefused when the browser refused", async () => {
    copy.mockResolvedValue(false);
    const onCopied = vi.fn();
    const onRefused = vi.fn();
    await copyThen("abc", onCopied, onRefused);
    expect(onCopied).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledTimes(1);
  });

  it("stays quiet on a refusal without a handler", async () => {
    copy.mockResolvedValue(false);
    const onCopied = vi.fn();
    await expect(copyThen("abc", onCopied)).resolves.toBeUndefined();
    expect(onCopied).not.toHaveBeenCalled();
  });
});
