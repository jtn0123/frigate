import { useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import useSWR from "swr";
import { LuExternalLink } from "react-icons/lu";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { Button } from "@/components/ui/button";
import Heading from "@/components/ui/heading";
import {
  SettingsGroupCard,
  SplitCardRow,
} from "@/components/card/SettingsGroupCard";
import FrigatePlusCurrentModelSummary from "@/views/settings/components/FrigatePlusCurrentModelSummary";
import { useDocDomain } from "@/hooks/use-doc-domain";
import { CameraNameLabel } from "@/components/camera/FriendlyNameLabel";
import { FrigateConfig } from "@/types/frigateConfig";
import { isReplayCamera } from "@/utils/cameraUtil";
import type { SettingsPageProps } from "@/views/settings/SingleSectionPage";
import PlusKeyStatus from "@/components/fork/settings/PlusKeyStatus";
import StatusPill from "@/components/fork/settings/StatusPill";

export default function FrigatePlusSettingsView(
  _props: Readonly<SettingsPageProps>,
) {
  const { t } = useTranslation("views/settings");
  const { getLocaleDocUrl } = useDocDomain();
  const { data: config } = useSWR<FrigateConfig>("config");
  const navigate = useNavigate();

  useEffect(() => {
    document.title = t("documentTitle.frigatePlus");
  }, [t]);

  if (!config) {
    return <ActivityIndicator />;
  }

  return (
    <div className="flex size-full flex-col md:pr-2">
      <div className="w-full max-w-5xl space-y-6">
        <div className="flex flex-col gap-0">
          <Heading as="h4" className="mb-2">
            {t("frigatePlus.title")}
          </Heading>
          <p className="text-sm text-muted-foreground">
            {t("frigatePlus.description")}
          </p>
        </div>

        <div className="space-y-6">
          <SettingsGroupCard title={t("frigatePlus.cardTitles.api")}>
            <SplitCardRow
              label={t("frigatePlus.apiKey.title")}
              description={
                <>
                  <p>{t("frigatePlus.apiKey.desc")}</p>
                  {!config?.model.plus && (
                    <div className="mt-2 flex items-center text-primary-variant">
                      <Link
                        to="https://frigate.video/plus"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline"
                      >
                        {t("frigatePlus.apiKey.plusLink")}
                        <LuExternalLink className="ml-2 inline-flex size-3" />
                      </Link>
                    </div>
                  )}
                </>
              }
              content={
                // fork: a neutral status and how to connect (UI113)
                <PlusKeyStatus connected={Boolean(config?.plus?.enabled)} />
              }
            />
          </SettingsGroupCard>

          {config?.plus?.enabled && (
            <FrigatePlusCurrentModelSummary
              plusModel={config.model.plus}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void navigate("/settings?page=systemDetectorsAndModel")
                  }
                >
                  {t("frigatePlus.changeInDetectorsAndModel")}
                </Button>
              }
            />
          )}

          <SettingsGroupCard title={t("frigatePlus.cardTitles.configuration")}>
            <SplitCardRow
              label={t("frigatePlus.snapshotConfig.title")}
              description={
                <>
                  <p>
                    <Trans ns="views/settings">
                      frigatePlus.snapshotConfig.desc
                    </Trans>
                  </p>
                  <div className="mt-2 flex items-center text-primary-variant">
                    <Link
                      to={getLocaleDocUrl("plus/faq")}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline"
                    >
                      {t("readTheDocumentation", { ns: "common" })}
                      <LuExternalLink className="ml-2 inline-flex size-3" />
                    </Link>
                  </div>
                </>
              }
              content={
                <div className="space-y-3">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-secondary">
                          <th className="px-4 py-2 text-left">
                            {t("frigatePlus.snapshotConfig.table.camera")}
                          </th>
                          <th className="px-4 py-2 text-center">
                            {t("frigatePlus.snapshotConfig.table.snapshots")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(config.cameras)
                          .filter(([name]) => !isReplayCamera(name))
                          .sort(([, a], [, b]) => a.ui.order - b.ui.order)
                          .map(([name, camera]) => (
                            <tr
                              key={name}
                              className="border-b border-secondary"
                            >
                              <td className="px-4 py-2">
                                <CameraNameLabel camera={name} />
                              </td>
                              <td className="px-4 py-2 text-center">
                                <StatusPill
                                  active={camera.snapshots.enabled}
                                  label={
                                    camera.snapshots.enabled
                                      ? t("statusPill.on", { ns: "fork" })
                                      : t("statusPill.off", { ns: "fork" })
                                  }
                                />
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void navigate("/settings?page=globalSnapshots")
                    }
                  >
                    {t("plusKeyStatus.openSnapshots", { ns: "fork" })}
                  </Button>
                </div>
              }
            />
          </SettingsGroupCard>
        </div>
      </div>
    </div>
  );
}
