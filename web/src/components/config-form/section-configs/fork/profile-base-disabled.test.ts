import { describe, expect, it } from "vitest";
import type { CameraConfig, FrigateConfig } from "@/types/frigateConfig";
import type { ConfigSectionData } from "@/types/configForm";
import notifications from "../notifications";
import record from "../record";
import type { MessageConditionContext } from "../types";

// B33 (upstream #24272): recording and notifications only start when they are
// enabled in the base config, so enabling them in a profile has no effect

function camera(record: boolean, notifications: boolean, enabled = true) {
  return {
    enabled_in_config: enabled,
    record: { enabled_in_config: record },
    notifications: { enabled_in_config: notifications },
  } as unknown as CameraConfig;
}

function ctx(
  overrides: Partial<MessageConditionContext> & {
    cameras?: Record<string, CameraConfig>;
  },
): MessageConditionContext {
  const { cameras, ...rest } = overrides;
  const cams = cameras ?? { front: camera(false, false) };
  return {
    fullConfig: { cameras: cams } as unknown as FrigateConfig,
    fullCameraConfig: cams.front,
    level: "camera",
    cameraName: "front",
    formData: { enabled: true } as ConfigSectionData,
    ...rest,
  };
}

function message(section: typeof record, key: string) {
  const found = section.base?.fieldMessages?.find((m) => m.key === key);
  expect(found).toBeDefined();
  return found!;
}

describe("record profileBaseDisabled field message", () => {
  const msg = message(record, "profile-base-record-disabled");

  it("warns when a profile enables recording disabled in the base config", () => {
    expect(msg.field).toBe("enabled");
    expect(msg.condition(ctx({ profileName: "away" }))).toBe(true);
  });

  it("stays hidden outside a profile", () => {
    expect(msg.condition(ctx({}))).toBe(false);
  });

  it("stays hidden when the base config enables recording", () => {
    expect(
      msg.condition(
        ctx({ profileName: "away", cameras: { front: camera(true, false) } }),
      ),
    ).toBe(false);
  });

  it("stays hidden when the profile disables recording", () => {
    expect(
      msg.condition(
        ctx({
          profileName: "away",
          formData: { enabled: false } as ConfigSectionData,
        }),
      ),
    ).toBe(false);
  });
});

describe("notifications profileBaseDisabled field message", () => {
  const msg = message(notifications, "profile-base-notifications-disabled");

  it("warns when no enabled camera has notifications in its base config", () => {
    expect(
      msg.condition(
        ctx({
          profileName: "away",
          // a disabled camera with notifications on does not count
          cameras: {
            front: camera(false, false),
            back: camera(false, true, false),
          },
        }),
      ),
    ).toBe(true);
  });

  it("stays hidden when one enabled camera has notifications in its base config", () => {
    expect(
      msg.condition(
        ctx({
          profileName: "away",
          cameras: { front: camera(false, false), back: camera(false, true) },
        }),
      ),
    ).toBe(false);
  });

  it("stays hidden outside a profile", () => {
    expect(msg.condition(ctx({}))).toBe(false);
  });
});
