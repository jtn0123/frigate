/**
 * Fork: the badges that say where a settings section's values come from
 * (UI117).
 *
 * Upstream carried two copies of this row, one pinned to the far right of the
 * title on desktop and one below the title on phones. The desktop copy sat
 * across the page from the section it describes, and the two copies had to be
 * kept in step by hand. This is the row, once, under the title.
 */

import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { CameraOverridesBadge } from "@/components/config-form/sections/CameraOverridesBadge";
import { GlobalOverridesBadge } from "@/components/config-form/sections/GlobalOverridesBadge";
import { ProfileOverridesBadge } from "@/components/config-form/sections/ProfileOverridesBadge";

type SectionOverrideBadgesProps = {
  sectionKey: string;
  level: "global" | "camera";
  showOverrideIndicator: boolean;
  isOverridden: boolean;
  overrideSource?: string;
  hasChanges: boolean;
  selectedCamera?: string;
  currentEditingProfile?: string | null;
  profileFriendlyName?: string;
  profileBorderColor?: string;
};

export default function SectionOverrideBadges({
  sectionKey,
  level,
  showOverrideIndicator,
  isOverridden,
  overrideSource,
  hasChanges,
  selectedCamera,
  currentEditingProfile,
  profileFriendlyName,
  profileBorderColor,
}: Readonly<SectionOverrideBadgesProps>) {
  const { t } = useTranslation(["common"]);

  const cameraBadge =
    level === "camera" &&
    showOverrideIndicator &&
    isOverridden &&
    selectedCamera;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {level === "global" && showOverrideIndicator && (
        <CameraOverridesBadge sectionPath={sectionKey} />
      )}
      {cameraBadge &&
        (overrideSource === "profile" && currentEditingProfile ? (
          <ProfileOverridesBadge
            sectionPath={sectionKey}
            cameraName={selectedCamera}
            profileName={currentEditingProfile}
            // exactOptionalPropertyTypes: an absent prop, not an undefined one
            {...(profileFriendlyName === undefined
              ? {}
              : { profileFriendlyName })}
            {...(profileBorderColor === undefined
              ? {}
              : { profileBorderColor })}
          />
        ) : (
          <GlobalOverridesBadge
            sectionPath={sectionKey}
            cameraName={selectedCamera}
          />
        ))}
      {hasChanges && (
        <Badge
          variant="secondary"
          className="cursor-default bg-unsaved text-xs text-black hover:bg-unsaved"
        >
          {t("button.modified", { ns: "common", defaultValue: "Modified" })}
        </Badge>
      )}
    </div>
  );
}
