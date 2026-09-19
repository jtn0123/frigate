import { describe, expect, it } from "vitest";
import { registerBlocker } from "./notification-register";

const ready = {
  camerasSelected: true,
  enabledInConfig: true,
  hasKey: true,
  keyError: false,
};

describe("registerBlocker", () => {
  it("is null when the device can register", () => {
    expect(registerBlocker(ready)).toBeNull();
  });

  it("asks for a camera first", () => {
    expect(
      registerBlocker({
        ...ready,
        camerasSelected: false,
        enabledInConfig: false,
        hasKey: false,
      }),
    ).toBe("noCameras");
  });

  it("asks to save when notifications are off in the saved config", () => {
    expect(
      registerBlocker({ ...ready, enabledInConfig: false, hasKey: false }),
    ).toBe("notSaved");
  });

  it("tells a loading key from a failed one", () => {
    expect(registerBlocker({ ...ready, hasKey: false })).toBe("keyLoading");
    expect(registerBlocker({ ...ready, hasKey: false, keyError: true })).toBe(
      "keyUnavailable",
    );
  });
});
