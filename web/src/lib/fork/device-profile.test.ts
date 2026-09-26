import { afterEach, expect, it, vi } from "vitest";
import { getDeviceId, getDeviceProfile } from "./device-profile";
import { allLayoutKeysForGroup } from "./live-layout";

afterEach(() => vi.restoreAllMocks());

it("keeps a browser ID stable while separating screen sizes", () => {
  localStorage.setItem("frigateDeviceId", "test-device");
  expect(getDeviceId()).toBe("test-device");
  expect(getDeviceProfile("mobile")).toBe("mobile-test-device");
  expect(getDeviceProfile("desktop")).toBe("desktop-test-device");
  expect(allLayoutKeysForGroup("porch")).toEqual([
    "porch-draggable-layout",
    "porch-draggable-layout:mobile-test-device",
    "porch-draggable-layout:tablet-test-device",
    "porch-draggable-layout:desktop-test-device",
  ]);
});

it("uses a stable fallback when browser storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("blocked");
  });
  const id = getDeviceId();
  expect(id).not.toBe("");
  expect(getDeviceId()).toBe(id);
});

it("uses cryptographic random bytes when randomUUID is unavailable over HTTP", async () => {
  vi.resetModules();
  localStorage.removeItem("frigateDeviceId");
  const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(17));
  vi.stubGlobal("crypto", { getRandomValues });
  try {
    const { getDeviceId: freshId } = await import("./device-profile");
    expect(freshId()).toBe("111111111111");
    expect(freshId()).toBe("111111111111");
    expect(getRandomValues).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
