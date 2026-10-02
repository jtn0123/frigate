import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SectionOverrideBadges from "./SectionOverrideBadges";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en" },
    t: (key: string) => key,
  }),
}));

// Each badge shows the props it was given, so the test can read them back.
vi.mock("@/components/config-form/sections/CameraOverridesBadge", () => ({
  CameraOverridesBadge: (props: object) => (
    <div data-testid="camera-badge">{JSON.stringify(props)}</div>
  ),
}));
vi.mock("@/components/config-form/sections/GlobalOverridesBadge", () => ({
  GlobalOverridesBadge: (props: object) => (
    <div data-testid="global-badge">{JSON.stringify(props)}</div>
  ),
}));
vi.mock("@/components/config-form/sections/ProfileOverridesBadge", () => ({
  ProfileOverridesBadge: (props: object) => (
    <div data-testid="profile-badge">{JSON.stringify(props)}</div>
  ),
}));

function badgeProps(testId: string): Record<string, unknown> {
  return JSON.parse(screen.getByTestId(testId).textContent) as Record<
    string,
    unknown
  >;
}

const cameraOverride = {
  sectionKey: "detect",
  level: "camera" as const,
  showOverrideIndicator: true,
  isOverridden: true,
  hasChanges: false,
  selectedCamera: "front_door",
};

describe("SectionOverrideBadges", () => {
  it("shows the camera overrides badge on a global section", () => {
    render(
      <SectionOverrideBadges
        sectionKey="detect"
        level="global"
        showOverrideIndicator
        isOverridden={false}
        hasChanges={false}
      />,
    );
    expect(badgeProps("camera-badge")).toEqual({ sectionPath: "detect" });
    expect(screen.queryByText("button.modified")).toBeNull();
  });

  it("passes a profile's name and color to its badge when they are set", () => {
    render(
      <SectionOverrideBadges
        {...cameraOverride}
        overrideSource="profile"
        currentEditingProfile="night"
        profileFriendlyName="Night"
        profileBorderColor="#123456"
        hasChanges
      />,
    );
    expect(badgeProps("profile-badge")).toEqual({
      sectionPath: "detect",
      cameraName: "front_door",
      profileName: "night",
      profileFriendlyName: "Night",
      profileBorderColor: "#123456",
    });
    expect(screen.getByText("button.modified")).toBeInTheDocument();
  });

  it("leaves a profile's name and color off its badge when they are unset", () => {
    render(
      <SectionOverrideBadges
        {...cameraOverride}
        overrideSource="profile"
        currentEditingProfile="night"
      />,
    );
    expect(badgeProps("profile-badge")).toEqual({
      sectionPath: "detect",
      cameraName: "front_door",
      profileName: "night",
    });
  });

  it("shows the global overrides badge for a camera override", () => {
    render(
      <SectionOverrideBadges {...cameraOverride} overrideSource="global" />,
    );
    expect(badgeProps("global-badge")).toEqual({
      sectionPath: "detect",
      cameraName: "front_door",
    });
    expect(screen.queryByTestId("profile-badge")).toBeNull();
  });
});
