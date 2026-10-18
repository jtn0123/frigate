import { describe, expect, it } from "vitest";
import type { CameraConfig, FrigateConfig } from "@/types/frigateConfig";
import type { ConfigSectionData } from "@/types/configForm";
import notifications from "../notifications";
import record from "../record";
import type { MessageConditionContext } from "../types";

// B33 (upstream #24272): recording and notifications only start when they are
// enabled in the base config, so enabling them in a profile has no effect

const asCamera = (value: unknown) => value as CameraConfig;
const asConfig = (value: unknown) => value as FrigateConfig;

function camera(record: boolean, notifications: boolean, enabled = true) {
  return asCamera({
    enabled_in_config: enabled,
    record: { enabled_in_config: record },
    notifications: { enabled_in_config: notifications },
  });
}

function ctx(
  overrides: {
    front?: CameraConfig;
    others?: Record<string, CameraConfig>;
    profileName?: string;
    formData?: ConfigSectionData;
  } = {},
): MessageConditionContext {
  const front = overrides.front ?? camera(false, false);
  const context: MessageConditionContext = {
    fullConfig: asConfig({ cameras: { front, ...overrides.others } }),
    fullCameraConfig: front,
    level: "camera",
    cameraName: "front",
    formData: overrides.formData ?? ({ enabled: true } as ConfigSectionData),
  };
  if (overrides.profileName) context.profileName = overrides.profileName;
  return context;
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
      msg.condition(ctx({ profileName: "away", front: camera(true, false) })),
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
          others: { back: camera(false, true, false) },
        }),
      ),
    ).toBe(true);
  });

  it("stays hidden when one enabled camera has notifications in its base config", () => {
    expect(
      msg.condition(
        ctx({
          profileName: "away",
          others: { back: camera(false, true) },
        }),
      ),
    ).toBe(false);
  });

  it("stays hidden outside a profile", () => {
    expect(msg.condition(ctx({}))).toBe(false);
  });
});
