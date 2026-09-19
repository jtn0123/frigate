import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SectionConfig } from "@/components/config-form/sections";
import { ConfigSectionTemplate } from "@/components/config-form/sections";
// fork (UI117): the badge row lives in one component now
import SectionOverrideBadges from "@/components/fork/settings/SectionOverrideBadges";
import type { PolygonType } from "@/types/canvas";
import type { ConfigSectionData } from "@/types/configForm";
import type { ProfileState } from "@/types/profile";
import { getSectionConfig } from "@/utils/configUtil";
import { getProfileColor } from "@/utils/profileColors";
import { useDocDomain } from "@/hooks/use-doc-domain";
import { Link } from "react-router-dom";
import { LuExternalLink } from "react-icons/lu";
import Heading from "@/components/ui/heading";

export type SettingsPageProps = {
  selectedCamera?: string;
  setUnsavedChanges?: React.Dispatch<React.SetStateAction<boolean>>;
  selectedZoneMask?: PolygonType[];
  onSectionStatusChange?: (
    sectionKey: string,
    level: "global" | "camera",
    status: SectionStatus,
  ) => void;
  pendingDataBySection?: Record<string, ConfigSectionData>;
  onPendingDataChange?: (
    sectionKey: string,
    cameraName: string | undefined,
    data: ConfigSectionData | null,
  ) => void;
  profileState?: ProfileState;
  /** Callback to delete the current profile's overrides for the current section */
  onDeleteProfileSection?: (profileName: string) => void;
  profilesUIEnabled?: boolean;
  setProfilesUIEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
  /** Whether a SaveAll operation is in progress */
  isSavingAll?: boolean;
  /** Callback when a section's saving state changes */
  onSectionSavingChange?: (isSaving: boolean) => void;
};

export type SectionStatus = {
  hasChanges: boolean;
  isOverridden: boolean;
  /** Where the override comes from: "global" = camera overrides global, "profile" = profile overrides base */
  overrideSource?: "global" | "profile";
  hasValidationErrors: boolean;
};

export type SingleSectionPageOptions = {
  sectionKey: string;
  level: "global" | "camera";
  sectionConfig?: SectionConfig;
  requiresRestart?: boolean;
  showOverrideIndicator?: boolean;
};

export type SingleSectionPageProps = SettingsPageProps &
  SingleSectionPageOptions;

export function SingleSectionPage({
  sectionKey,
  level,
  sectionConfig,
  requiresRestart,
  showOverrideIndicator = true,
  selectedCamera,
  setUnsavedChanges,
  onSectionStatusChange,
  pendingDataBySection,
  onPendingDataChange,
  profileState,
  onDeleteProfileSection,
  isSavingAll,
  onSectionSavingChange,
}: SingleSectionPageProps) {
  const sectionNamespace =
    level === "camera" ? "config/cameras" : "config/global";
  const { t, i18n } = useTranslation([
    sectionNamespace,
    "views/settings",
    "common",
  ]);
  const { getLocaleDocUrl } = useDocDomain();
  const [sectionStatus, setSectionStatus] = useState<SectionStatus>({
    hasChanges: false,
    isOverridden: false,
    hasValidationErrors: false,
  });
  const resolvedSectionConfig = useMemo(
    () => sectionConfig ?? getSectionConfig(sectionKey, level),
    [level, sectionConfig, sectionKey],
  );
  const sectionDocsUrl = resolvedSectionConfig.sectionDocs
    ? getLocaleDocUrl(resolvedSectionConfig.sectionDocs)
    : undefined;

  const currentEditingProfile =
    level === "camera" && selectedCamera
      ? (profileState?.editingProfile[selectedCamera] ?? null)
      : null;

  const profileColor = useMemo(
    () =>
      currentEditingProfile && profileState?.allProfileNames
        ? getProfileColor(currentEditingProfile, profileState.allProfileNames)
        : undefined,
    [currentEditingProfile, profileState?.allProfileNames],
  );

  const handleDeleteProfileSection = useCallback(() => {
    if (currentEditingProfile && onDeleteProfileSection) {
      onDeleteProfileSection(currentEditingProfile);
    }
  }, [currentEditingProfile, onDeleteProfileSection]);

  const handleSectionStatusChange = useCallback(
    (status: SectionStatus) => {
      setSectionStatus(status);
      onSectionStatusChange?.(sectionKey, level, status);
    },
    [level, onSectionStatusChange, sectionKey],
  );

  if (level === "camera" && !selectedCamera) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t("configForm.camera.noCameras", { ns: "views/settings" })}
      </div>
    );
  }

  return (
    <div className="flex size-full flex-col lg:pr-2">
      <div className="mb-5 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col">
            <Heading as="h4">
              {t(`${sectionKey}.label`, { ns: sectionNamespace })}
            </Heading>
            {i18n.exists(`${sectionKey}.description`, {
              ns: sectionNamespace,
            }) && (
              <div className="my-1 text-sm text-muted-foreground">
                {t(`${sectionKey}.description`, { ns: sectionNamespace })}
              </div>
            )}
            {sectionDocsUrl && (
              <div className="flex items-center text-sm text-primary-variant">
                <Link
                  to={sectionDocsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline"
                >
                  {t("readTheDocumentation", { ns: "common" })}
                  <LuExternalLink className="ml-2 inline-flex size-3" />
                </Link>
              </div>
            )}
          </div>
        </div>
        {/* fork (UI117): one badge row, under the title it describes, in
            place of the desktop copy pinned to the far right and the phone
            copy below */}
        <SectionOverrideBadges
          sectionKey={sectionKey}
          level={level}
          showOverrideIndicator={showOverrideIndicator}
          isOverridden={sectionStatus.isOverridden}
          overrideSource={sectionStatus.overrideSource}
          hasChanges={sectionStatus.hasChanges}
          selectedCamera={selectedCamera}
          currentEditingProfile={currentEditingProfile}
          profileFriendlyName={
            currentEditingProfile
              ? profileState?.profileFriendlyNames.get(currentEditingProfile)
              : undefined
          }
          profileBorderColor={profileColor?.border}
        />
      </div>
      <ConfigSectionTemplate
        sectionKey={sectionKey}
        level={level}
        cameraName={level === "camera" ? selectedCamera : undefined}
        showOverrideIndicator={showOverrideIndicator}
        onSave={() => setUnsavedChanges?.(false)}
        showTitle={false}
        sectionConfig={resolvedSectionConfig}
        pendingDataBySection={pendingDataBySection}
        onPendingDataChange={onPendingDataChange}
        requiresRestart={requiresRestart}
        onStatusChange={handleSectionStatusChange}
        profileName={currentEditingProfile ?? undefined}
        profileFriendlyName={
          currentEditingProfile
            ? (profileState?.profileFriendlyNames.get(currentEditingProfile) ??
              currentEditingProfile)
            : undefined
        }
        profileBorderColor={profileColor?.border}
        onDeleteProfileSection={
          currentEditingProfile ? handleDeleteProfileSection : undefined
        }
        isSavingAll={isSavingAll}
        onSavingChange={onSectionSavingChange}
      />
    </div>
  );
}
