import Heading from "@/components/ui/heading";
import { wrapAsync } from "@/utils/promise";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CONTROL_COLUMN_CLASS_NAME,
  SettingsGroupCard,
  SPLIT_ROW_CLASS_NAME,
} from "@/components/card/SettingsGroupCard";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import useSWR from "swr";
import { FrigateConfig } from "@/types/frigateConfig";
import { useTranslation, Trans } from "react-i18next";
import CameraWizardDialog from "@/components/settings/CameraWizardDialog";
import DeleteCameraDialog from "@/components/overlay/dialog/DeleteCameraDialog";
import {
  LuCheck,
  LuCopy,
  LuExternalLink,
  LuGripVertical,
  LuPencil,
  LuPlus,
  LuRefreshCcw,
} from "react-icons/lu";
import CloneCameraDialog from "@/components/settings/CloneCameraDialog";
import { Reorder, useDragControls } from "framer-motion";
import { Link } from "react-router-dom";
import { useDocDomain } from "@/hooks/use-doc-domain";
import { CameraNameLabel } from "@/components/camera/FriendlyNameLabel";

import { useEnabledState, useRestart } from "@/api/ws";
import { Label } from "@/components/ui/label";
import axios from "axios";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import RestartDialog from "@/components/overlay/dialog/RestartDialog";
import RestartRequiredIndicator from "@/components/indicators/RestartRequiredIndicator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ProfileState } from "@/types/profile";
import { getProfileColor } from "@/utils/profileColors";
import { isReplayCamera } from "@/utils/cameraUtil";
import { StatusBarMessagesContext } from "@/context/statusbar-context";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import CameraStateLegend from "@/components/fork/settings/CameraStateLegend";
import DeleteCameraRowButton from "@/components/fork/settings/DeleteCameraRowButton";

// fork: camera state table rows and cells: name, state select, row actions
// (UI111)
const CAMERA_ROW_CLASS_NAME = "border-b border-secondary/60 last:border-b-0";
const CAMERA_CELL_CLASS_NAME = "py-1.5 pr-3 align-middle";

const REORDER_SAVED_INDICATOR_MS = 1500;

type ReorderSaveStatus = "idle" | "saving" | "saved";

type CameraManagementViewProps = {
  profileState?: ProfileState;
};

export default function CameraManagementView({
  profileState,
}: Readonly<CameraManagementViewProps>) {
  const { t } = useTranslation(["views/settings", "common"]);

  const { data: config, mutate: updateConfig } =
    useSWR<FrigateConfig>("config");

  const [showWizard, setShowWizard] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  // fork: the camera a row's delete action picked (UI111)
  const [cameraToDelete, setCameraToDelete] = useState<string>();
  const openDeleteDialog = useCallback((camera: string) => {
    setCameraToDelete(camera);
    setShowDeleteDialog(true);
  }, []);
  const [showCloneDialog, setShowCloneDialog] = useState(false);

  // State for restart dialog when enabling a disabled camera
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const { send: sendRestart } = useRestart();

  const enabledCameras = useMemo(() => {
    if (config) {
      return Object.keys(config.cameras)
        .filter(
          (camera) =>
            config.cameras[camera].enabled_in_config && !isReplayCamera(camera),
        )
        .sort((a, b) => {
          const orderA = config.cameras[a].ui?.order ?? 0;
          const orderB = config.cameras[b].ui?.order ?? 0;
          if (orderA !== orderB) return orderA - orderB;
          return a.localeCompare(b);
        });
    }
    return [];
  }, [config]);

  // Diverges from config during a drag and while the save is in flight.
  const [orderedCameras, setOrderedCameras] =
    useState<string[]>(enabledCameras);
  const orderedCamerasRef = useRef(orderedCameras);
  useEffect(() => {
    orderedCamerasRef.current = orderedCameras;
  }, [orderedCameras]);

  useEffect(() => {
    setOrderedCameras((prev) => {
      if (
        prev.length === enabledCameras.length &&
        prev.every((cam, i) => cam === enabledCameras[i])
      ) {
        return prev;
      }
      return enabledCameras;
    });
  }, [enabledCameras]);

  const [reorderSaveStatus, setReorderSaveStatus] =
    useState<ReorderSaveStatus>("idle");
  const reorderSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(() => {
    return () => {
      if (reorderSavedTimerRef.current) {
        clearTimeout(reorderSavedTimerRef.current);
      }
    };
  }, []);

  const handleReorderDragEnd = useCallback(async () => {
    const current = orderedCamerasRef.current;
    if (
      current.length === enabledCameras.length &&
      current.every((cam, i) => cam === enabledCameras[i])
    ) {
      return;
    }

    const cameraUpdates: Record<string, { ui: { order: number } }> = {};
    current.forEach((cam, i) => {
      cameraUpdates[cam] = { ui: { order: i * 10 } };
    });

    if (reorderSavedTimerRef.current) {
      clearTimeout(reorderSavedTimerRef.current);
      reorderSavedTimerRef.current = null;
    }
    setReorderSaveStatus("saving");

    try {
      await axios.put("config/set", {
        requires_restart: 0,
        config_data: { cameras: cameraUpdates },
      });
      await updateConfig();
      setReorderSaveStatus("saved");
      reorderSavedTimerRef.current = setTimeout(() => {
        setReorderSaveStatus("idle");
        reorderSavedTimerRef.current = null;
      }, REORDER_SAVED_INDICATOR_MS);
    } catch (error) {
      setOrderedCameras(enabledCameras);
      setReorderSaveStatus("idle");
      const errorMessage =
        axios.isAxiosError(error) &&
        (error.response?.data?.message || error.response?.data?.detail)
          ? error.response?.data?.message || error.response?.data?.detail
          : t("toast.save.error.noMessage", { ns: "common" });

      toast.error(t("toast.save.error.title", { errorMessage, ns: "common" }), {
        position: "top-center",
      });
    }
  }, [enabledCameras, updateConfig, t]);

  const disabledCameras = useMemo(() => {
    if (config) {
      return Object.keys(config.cameras)
        .filter(
          (camera) =>
            !config.cameras[camera].enabled_in_config &&
            !isReplayCamera(camera),
        )
        .sort((a, b) => {
          const orderA = config.cameras[a].ui?.order ?? 0;
          const orderB = config.cameras[b].ui?.order ?? 0;
          if (orderA !== orderB) return orderA - orderB;
          return a.localeCompare(b);
        });
    }
    return [];
  }, [config]);

  const allCameras = useMemo(() => {
    if (config) {
      return Object.keys(config.cameras)
        .filter((camera) => !isReplayCamera(camera))
        .sort((a, b) => {
          const orderA = config.cameras[a].ui?.order ?? 0;
          const orderB = config.cameras[b].ui?.order ?? 0;
          if (orderA !== orderB) return orderA - orderB;
          return a.localeCompare(b);
        });
    }
    return [];
  }, [config]);

  useEffect(() => {
    document.title = t("documentTitle.cameraManagement");
  }, [t]);

  return (
    <>
      <div className="flex size-full space-y-6">
        <div className="scrollbar-container flex-1 overflow-y-auto pb-2">
          <Heading as="h4" className="mb-2">
            {t("cameraManagement.title")}
          </Heading>
          <p className="mb-6 max-w-5xl text-sm text-muted-foreground">
            {t("cameraManagement.description")}
          </p>

          <div className="w-full max-w-5xl space-y-6">
            {/* fork: Add stays primary, Clone is secondary and Delete moved
                into each camera's row (UI111) */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="select"
                onClick={() => setShowWizard(true)}
                className="flex items-center gap-2"
              >
                <LuPlus className="h-4 w-4" />
                {t("cameraManagement.addCamera")}
              </Button>
              {enabledCameras.length + disabledCameras.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => setShowCloneDialog(true)}
                  className="flex items-center gap-2"
                  title={t("cameraManagement.clone.sectionDescription")}
                >
                  <LuCopy className="h-4 w-4" />
                  {t("cameraManagement.clone.button")}
                </Button>
              )}
            </div>

            {(enabledCameras.length > 0 || disabledCameras.length > 0) && (
              <SettingsGroupCard
                title={
                  <Trans ns="views/settings">
                    cameraManagement.streams.title
                  </Trans>
                }
              >
                {/* fork: a table of name, state and row actions with a
                    short legend under it (UI111) */}
                <div className="space-y-3">
                  <table
                    aria-label={t("cameraManagement.streams.label")}
                    data-testid="camera-state-table"
                    className="w-full table-fixed border-collapse"
                  >
                    <colgroup>
                      <col />
                      <col className="w-[8.25rem]" />
                      <col className="w-10" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-secondary text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        <th scope="col" className="pb-2 pl-7 font-medium">
                          {t("cameraTable.camera", { ns: "fork" })}
                        </th>
                        <th scope="col" className="pb-2 font-medium">
                          {t("cameraTable.state", { ns: "fork" })}
                        </th>
                        <th scope="col" className="pb-2">
                          <span className="sr-only">
                            {t("cameraTable.actions", { ns: "fork" })}
                          </span>
                        </th>
                      </tr>
                    </thead>
                    {orderedCameras.length > 0 && (
                      <Reorder.Group
                        as="tbody"
                        axis="y"
                        values={orderedCameras}
                        onReorder={setOrderedCameras}
                      >
                        {orderedCameras.map((camera) => (
                          <ActiveCameraRow
                            key={camera}
                            camera={camera}
                            onConfigChanged={updateConfig}
                            onDragEnd={wrapAsync(handleReorderDragEnd)}
                            setRestartDialogOpen={setRestartDialogOpen}
                            onDelete={openDeleteDialog}
                          />
                        ))}
                      </Reorder.Group>
                    )}
                    {disabledCameras.length > 0 && (
                      <tbody>
                        <tr>
                          <th
                            scope="colgroup"
                            colSpan={3}
                            className="pb-1 pt-4 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
                          >
                            {t("cameraManagement.streams.disabledSubheading")}
                          </th>
                        </tr>
                        {disabledCameras.map((camera) => (
                          <DisabledCameraRow
                            key={camera}
                            camera={camera}
                            onConfigChanged={updateConfig}
                            setRestartDialogOpen={setRestartDialogOpen}
                            onDelete={openDeleteDialog}
                          />
                        ))}
                      </tbody>
                    )}
                  </table>
                  <ReorderSaveStatusIndicator status={reorderSaveStatus} />
                  <CameraStateLegend />
                </div>
              </SettingsGroupCard>
            )}

            {profileState &&
              profileState.allProfileNames.length > 0 &&
              enabledCameras.length > 0 && (
                <ProfileCameraEnableSection
                  profileState={profileState}
                  cameras={enabledCameras}
                  config={config}
                  onConfigChanged={updateConfig}
                />
              )}

            {config?.lpr?.enabled && allCameras.length > 0 && (
              <CameraTypeSection
                cameras={allCameras}
                config={config}
                onConfigChanged={updateConfig}
                setRestartDialogOpen={setRestartDialogOpen}
              />
            )}
          </div>
        </div>
      </div>

      <CameraWizardDialog
        open={showWizard}
        onClose={() => setShowWizard(false)}
      />
      <DeleteCameraDialog
        show={showDeleteDialog}
        cameras={[...enabledCameras, ...disabledCameras]}
        camera={cameraToDelete}
        onClose={() => setShowDeleteDialog(false)}
        onDeleted={() => {
          setShowDeleteDialog(false);
          void updateConfig();
        }}
      />
      <RestartDialog
        isOpen={restartDialogOpen}
        onClose={() => setRestartDialogOpen(false)}
        onRestart={() => sendRestart("restart")}
      />
      <CloneCameraDialog
        open={showCloneDialog}
        onClose={() => setShowCloneDialog(false)}
      />
    </>
  );
}

type ReorderSaveStatusIndicatorProps = {
  status: ReorderSaveStatus;
};

function ReorderSaveStatusIndicator({
  status,
}: Readonly<ReorderSaveStatusIndicatorProps>) {
  const { t } = useTranslation(["views/settings"]);
  return (
    <div
      aria-live="polite"
      className={cn(
        "flex h-4 items-center justify-start gap-1 text-xs transition-opacity duration-200",
        status === "idle" ? "opacity-0" : "opacity-100",
      )}
    >
      {status === "saving" && (
        <span className="text-muted-foreground">
          {t("cameraManagement.streams.saving")}
        </span>
      )}
      {status === "saved" && (
        <span className="flex items-center gap-1 text-success">
          <LuCheck className="size-3.5" />
          {t("cameraManagement.streams.saved")}
        </span>
      )}
    </div>
  );
}

type ActiveCameraRowProps = {
  camera: string;
  onConfigChanged: () => Promise<unknown>;
  onDragEnd: () => void;
  setRestartDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onDelete: (camera: string) => void;
};

function ActiveCameraRow({
  camera,
  onConfigChanged,
  onDragEnd,
  setRestartDialogOpen,
  onDelete,
}: Readonly<ActiveCameraRowProps>) {
  const { t } = useTranslation(["views/settings"]);
  const controls = useDragControls();

  return (
    <Reorder.Item
      as="tr"
      value={camera}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragEnd}
      className={CAMERA_ROW_CLASS_NAME}
    >
      <CameraNameCell>
        <button
          type="button"
          onPointerDown={(e) => controls.start(e)}
          className="-ml-1 cursor-grab touch-none rounded p-1 text-muted-foreground hover:text-primary active:cursor-grabbing"
          aria-label={t("cameraManagement.streams.reorderHandle")}
        >
          <LuGripVertical className="size-4" />
        </button>
        <CameraNameLabel camera={camera} />
        <CameraDetailsEditor
          cameraName={camera}
          onConfigChanged={onConfigChanged}
        />
      </CameraNameCell>
      <CameraRowControls
        camera={camera}
        isDisabledInConfig={false}
        onConfigChanged={onConfigChanged}
        setRestartDialogOpen={setRestartDialogOpen}
        onDelete={onDelete}
      />
    </Reorder.Item>
  );
}

type DisabledCameraRowProps = {
  camera: string;
  onConfigChanged: () => Promise<unknown>;
  setRestartDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onDelete: (camera: string) => void;
};

function DisabledCameraRow({
  camera,
  onConfigChanged,
  setRestartDialogOpen,
  onDelete,
}: Readonly<DisabledCameraRowProps>) {
  return (
    <tr className={CAMERA_ROW_CLASS_NAME}>
      <CameraNameCell className="pl-7">
        <CameraNameLabel camera={camera} className="text-muted-foreground" />
        <CameraDetailsEditor
          cameraName={camera}
          onConfigChanged={onConfigChanged}
        />
      </CameraNameCell>
      <CameraRowControls
        camera={camera}
        isDisabledInConfig={true}
        onConfigChanged={onConfigChanged}
        setRestartDialogOpen={setRestartDialogOpen}
        onDelete={onDelete}
      />
    </tr>
  );
}

function CameraNameCell({
  className,
  children,
}: Readonly<{ className?: string; children: React.ReactNode }>) {
  return (
    <td className={cn(CAMERA_CELL_CLASS_NAME, className)}>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </td>
  );
}

type CameraRowControlsProps = {
  camera: string;
  isDisabledInConfig: boolean;
  onConfigChanged: () => Promise<unknown>;
  setRestartDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onDelete: (camera: string) => void;
};

/** The state and delete cells, the same for active and disabled rows. */
function CameraRowControls({
  camera,
  isDisabledInConfig,
  onConfigChanged,
  setRestartDialogOpen,
  onDelete,
}: Readonly<CameraRowControlsProps>) {
  return (
    <>
      <td className={CAMERA_CELL_CLASS_NAME}>
        <CameraStatusSelect
          cameraName={camera}
          isDisabledInConfig={isDisabledInConfig}
          onConfigChanged={onConfigChanged}
          setRestartDialogOpen={setRestartDialogOpen}
        />
      </td>
      <td className="py-1.5 align-middle">
        <DeleteCameraRowButton camera={camera} onDelete={onDelete} />
      </td>
    </>
  );
}

type CameraStatus = "on" | "off" | "disabled";

type CameraStatusSelectProps = {
  cameraName: string;
  isDisabledInConfig: boolean;
  onConfigChanged: () => Promise<unknown>;
  setRestartDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

function CameraStatusSelect({
  cameraName,
  isDisabledInConfig,
  onConfigChanged,
  setRestartDialogOpen,
}: Readonly<CameraStatusSelectProps>) {
  const { t } = useTranslation([
    "views/settings",
    "components/dialog",
    "common",
  ]);
  const { payload: enabledState, send: sendEnabled } =
    useEnabledState(cameraName);
  const statusBar = useContext(StatusBarMessagesContext);
  const [isSaving, setIsSaving] = useState(false);

  const currentStatus: CameraStatus = isDisabledInConfig
    ? "disabled"
    : enabledState === "OFF"
      ? "off"
      : "on";

  const restartLabel = t("configForm.restartRequiredField", {
    ns: "views/settings",
    defaultValue: "Restart required",
  });

  const handleChange = useCallback(
    async (newStatus: string) => {
      if (newStatus === currentStatus || isSaving) {
        return;
      }

      if (newStatus === "on" && !isDisabledInConfig) {
        sendEnabled("ON");
        return;
      }

      if (newStatus === "off" && !isDisabledInConfig) {
        sendEnabled("OFF");
        return;
      }

      if (newStatus === "on" && isDisabledInConfig) {
        setIsSaving(true);
        try {
          await axios.put("config/set", {
            requires_restart: 1,
            config_data: {
              cameras: { [cameraName]: { enabled: true } },
            },
          });
          await onConfigChanged();
          toast.success(
            t("cameraManagement.streams.enableSuccess", {
              ns: "views/settings",
              cameraName,
            }),
            {
              position: "top-center",
              action: (
                <Button onClick={() => setRestartDialogOpen(true)}>
                  {t("restart.button", { ns: "components/dialog" })}
                </Button>
              ),
            },
          );
        } catch (error) {
          const errorMessage =
            axios.isAxiosError(error) &&
            (error.response?.data?.message || error.response?.data?.detail)
              ? error.response?.data?.message || error.response?.data?.detail
              : t("toast.save.error.noMessage", { ns: "common" });
          toast.error(
            t("toast.save.error.title", { errorMessage, ns: "common" }),
            { position: "top-center" },
          );
        } finally {
          setIsSaving(false);
        }
        return;
      }

      if (newStatus === "disabled" && !isDisabledInConfig) {
        setIsSaving(true);
        try {
          // Stop runtime processing immediately before persisting the
          // disable so the camera stops working without waiting for
          // a restart. The config write below makes the change durable.
          sendEnabled("OFF");
          await axios.put("config/set", {
            requires_restart: 0,
            config_data: {
              cameras: { [cameraName]: { enabled: false } },
            },
          });
          await onConfigChanged();
          statusBar?.addMessage(
            "config_restart_required",
            t("configForm.restartRequiredFooter", { ns: "views/settings" }),
            undefined,
            "config_restart_required",
          );
          toast.success(
            t("cameraManagement.streams.disableSuccess", {
              ns: "views/settings",
              cameraName,
            }),
            { position: "top-center" },
          );
        } catch (error) {
          const errorMessage =
            axios.isAxiosError(error) &&
            (error.response?.data?.message || error.response?.data?.detail)
              ? error.response?.data?.message || error.response?.data?.detail
              : t("toast.save.error.noMessage", { ns: "common" });
          toast.error(
            t("toast.save.error.title", { errorMessage, ns: "common" }),
            { position: "top-center" },
          );
        } finally {
          setIsSaving(false);
        }
        return;
      }
    },
    [
      cameraName,
      currentStatus,
      isDisabledInConfig,
      isSaving,
      onConfigChanged,
      sendEnabled,
      setRestartDialogOpen,
      statusBar,
      t,
    ],
  );

  if (isSaving) {
    return (
      <div className="flex h-7 w-[110px] flex-row items-center justify-end">
        <ActivityIndicator className="size-4" size={16} />
      </div>
    );
  }

  return (
    <Select value={currentStatus} onValueChange={wrapAsync(handleChange)}>
      <SelectTrigger className="h-7 w-[110px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="on">
          <div className="flex items-center gap-1.5">
            {t("cameraManagement.streams.status.on")}
            {isDisabledInConfig && (
              <LuRefreshCcw
                className="size-3 text-muted-foreground"
                aria-label={restartLabel}
              />
            )}
          </div>
        </SelectItem>
        {!isDisabledInConfig && (
          <SelectItem value="off">
            {t("cameraManagement.streams.status.off")}
          </SelectItem>
        )}
        <SelectItem value="disabled">
          {t("cameraManagement.streams.status.disabled")}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

type CameraDetailsEditorProps = {
  cameraName: string;
  onConfigChanged: () => Promise<unknown>;
};

type CameraDetailsFormValues = {
  friendlyName: string;
  webuiUrl: string;
  dashboard: boolean;
  review: boolean;
};

function CameraDetailsEditor({
  cameraName,
  onConfigChanged,
}: Readonly<CameraDetailsEditorProps>) {
  const { t } = useTranslation(["views/settings", "common"]);
  const { data: config } = useSWR<FrigateConfig>("config");
  const [open, setOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const currentFriendlyName = config?.cameras?.[cameraName]?.friendly_name;
  const currentWebuiUrl = config?.cameras?.[cameraName]?.webui_url;
  const currentDashboard = config?.cameras?.[cameraName]?.ui?.dashboard ?? true;
  const currentReview = config?.cameras?.[cameraName]?.ui?.review ?? true;

  const formSchema = useMemo(
    () =>
      z.object({
        friendlyName: z.string(),
        dashboard: z.boolean(),
        review: z.boolean(),
        webuiUrl: z.string().refine(
          (val) => {
            const trimmed = val.trim();
            if (!trimmed) return true;
            try {
              new URL(trimmed);
              return true;
            } catch {
              return false;
            }
          },
          {
            message: t("cameraManagement.streams.details.webuiUrlInvalid", {
              ns: "views/settings",
            }),
          },
        ),
      }),
    [t],
  );

  const form = useForm<CameraDetailsFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      friendlyName: currentFriendlyName ?? "",
      webuiUrl: currentWebuiUrl ?? "",
      dashboard: currentDashboard,
      review: currentReview,
    },
  });

  // Reset form values from config whenever the dialog is opened.
  useEffect(() => {
    if (open) {
      form.reset({
        friendlyName: currentFriendlyName ?? "",
        webuiUrl: currentWebuiUrl ?? "",
        dashboard: currentDashboard,
        review: currentReview,
      });
    }
  }, [
    open,
    currentFriendlyName,
    currentWebuiUrl,
    currentDashboard,
    currentReview,
    form,
  ]);

  const onSubmit = useCallback(
    async (values: CameraDetailsFormValues) => {
      if (isSaving) return;

      // only send fields the user actually changed
      const newFriendly = values.friendlyName.trim() || null;
      const newWebui = values.webuiUrl.trim() || null;
      const cameraUpdate: Record<string, unknown> = {};
      if (newFriendly !== (currentFriendlyName ?? null)) {
        cameraUpdate.friendly_name = newFriendly;
      }
      if (newWebui !== (currentWebuiUrl ?? null)) {
        cameraUpdate.webui_url = newWebui;
      }

      const uiUpdate: Record<string, boolean> = {};
      if (values.dashboard !== currentDashboard) {
        uiUpdate.dashboard = values.dashboard;
      }
      if (values.review !== currentReview) {
        uiUpdate.review = values.review;
      }
      if (Object.keys(uiUpdate).length > 0) {
        cameraUpdate.ui = uiUpdate;
      }

      if (Object.keys(cameraUpdate).length === 0) {
        setOpen(false);
        return;
      }

      setIsSaving(true);

      try {
        await axios.put("config/set", {
          requires_restart: 0,
          config_data: {
            cameras: {
              [cameraName]: cameraUpdate,
            },
          },
        });

        await onConfigChanged();
        setOpen(false);

        toast.success(t("toast.save.success", { ns: "common" }), {
          position: "top-center",
        });
      } catch (error) {
        const errorMessage =
          axios.isAxiosError(error) &&
          (error.response?.data?.message || error.response?.data?.detail)
            ? error.response?.data?.message || error.response?.data?.detail
            : t("toast.save.error.noMessage", { ns: "common" });

        toast.error(
          t("toast.save.error.title", { errorMessage, ns: "common" }),
          { position: "top-center" },
        );
      } finally {
        setIsSaving(false);
      }
    },
    [
      cameraName,
      currentFriendlyName,
      currentWebuiUrl,
      currentDashboard,
      currentReview,
      isSaving,
      onConfigChanged,
      t,
    ],
  );

  const editLabel = t("cameraManagement.streams.details.edit", {
    ns: "views/settings",
  });

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={editLabel}
            onClick={() => setOpen(true)}
            disabled={isSaving}
          >
            <LuPencil className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{editLabel}</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("cameraManagement.streams.details.title", {
                ns: "views/settings",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("cameraManagement.streams.details.description", {
                ns: "views/settings",
              })}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={wrapAsync(form.handleSubmit(onSubmit))}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="friendlyName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t("cameraManagement.streams.details.friendlyNameLabel", {
                        ns: "views/settings",
                      })}
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={cameraName}
                        disabled={isSaving}
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      {t("cameraManagement.streams.details.friendlyNameHelp", {
                        ns: "views/settings",
                      })}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="webuiUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t("cameraManagement.streams.details.webuiUrlLabel", {
                        ns: "views/settings",
                      })}
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="https://"
                        disabled={isSaving}
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      {t("cameraManagement.streams.details.webuiUrlHelp", {
                        ns: "views/settings",
                      })}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="dashboard"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <FormLabel>
                        {t("cameraManagement.streams.details.dashboardLabel", {
                          ns: "views/settings",
                        })}
                      </FormLabel>
                      <p className="text-xs text-muted-foreground">
                        {t("cameraManagement.streams.details.dashboardHelp", {
                          ns: "views/settings",
                        })}
                      </p>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={isSaving}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="review"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <FormLabel>
                        {t("cameraManagement.streams.details.reviewLabel", {
                          ns: "views/settings",
                        })}
                      </FormLabel>
                      <p className="text-xs text-muted-foreground">
                        {t("cameraManagement.streams.details.reviewHelp", {
                          ns: "views/settings",
                        })}
                      </p>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={isSaving}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <DialogFooter className="pt-2">
                <Button
                  type="button"
                  disabled={isSaving}
                  onClick={() => setOpen(false)}
                >
                  {t("button.cancel", { ns: "common" })}
                </Button>
                <Button variant="select" type="submit" disabled={isSaving}>
                  {isSaving ? (
                    <div className="flex flex-row items-center gap-2">
                      <ActivityIndicator className="size-4" />
                      <span>{t("button.saving", { ns: "common" })}</span>
                    </div>
                  ) : (
                    t("button.save", { ns: "common" })
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}

type CameraTypeSectionProps = {
  cameras: string[];
  config: FrigateConfig | undefined;
  onConfigChanged: () => Promise<unknown>;
  setRestartDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

function CameraTypeSection({
  cameras,
  config,
  onConfigChanged,
  setRestartDialogOpen,
}: Readonly<CameraTypeSectionProps>) {
  const { t } = useTranslation([
    "views/settings",
    "common",
    "components/dialog",
  ]);
  const { getLocaleDocUrl } = useDocDomain();
  const [savingCamera, setSavingCamera] = useState<string | null>(null);
  // Optimistic local state: the parsed config API doesn't reflect type
  // changes until Frigate restarts, so we track saved values locally.
  const [localOverrides, setLocalOverrides] = useState<Record<string, string>>(
    {},
  );

  const handleTypeChange = useCallback(
    async (camera: string, value: string) => {
      setSavingCamera(camera);
      try {
        const typeValue = value === "lpr" ? "lpr" : null;
        await axios.put("config/set", {
          requires_restart: 1,
          config_data: {
            cameras: {
              [camera]: {
                type: typeValue,
              },
            },
          },
        });
        await onConfigChanged();

        setLocalOverrides((prev) => ({
          ...prev,
          [camera]: value,
        }));

        toast.success(
          t("cameraManagement.cameraType.saveSuccess", {
            ns: "views/settings",
            cameraName: camera,
          }),
          {
            position: "top-center",
            action: (
              <Button onClick={() => setRestartDialogOpen(true)}>
                {t("restart.button", { ns: "components/dialog" })}
              </Button>
            ),
          },
        );
      } catch (error) {
        const errorMessage =
          axios.isAxiosError(error) &&
          (error.response?.data?.message || error.response?.data?.detail)
            ? error.response?.data?.message || error.response?.data?.detail
            : t("toast.save.error.noMessage", { ns: "common" });

        toast.error(
          t("toast.save.error.title", { errorMessage, ns: "common" }),
          { position: "top-center" },
        );
      } finally {
        setSavingCamera(null);
      }
    },
    [onConfigChanged, setRestartDialogOpen, t],
  );

  const getCameraType = useCallback(
    (camera: string): string => {
      const localValue = localOverrides[camera];
      if (localValue) return localValue;

      const type = config?.cameras?.[camera]?.type;
      return type === "lpr" ? "lpr" : "normal";
    },
    [config, localOverrides],
  );

  return (
    <SettingsGroupCard
      title={t("cameraManagement.cameraType.title", {
        ns: "views/settings",
      })}
    >
      <div className={SPLIT_ROW_CLASS_NAME}>
        <div className="space-y-1.5">
          <Label>
            {t("cameraManagement.cameraType.label", {
              ns: "views/settings",
            })}
            <RestartRequiredIndicator className="ml-1" />
          </Label>
          <p className="hidden text-sm text-muted-foreground md:block">
            {t("cameraManagement.cameraType.description", {
              ns: "views/settings",
            })}
          </p>
          <div className="hidden items-center text-sm text-primary md:flex">
            <Link
              to={getLocaleDocUrl(
                "configuration/license_plate_recognition#dedicated-lpr-cameras",
              )}
              target="_blank"
              rel="noopener noreferrer"
              className="inline"
            >
              {t("readTheDocumentation", { ns: "common" })}
              <LuExternalLink className="ml-2 inline-flex size-3" />
            </Link>
          </div>
        </div>
        <div className={`${CONTROL_COLUMN_CLASS_NAME} space-y-1.5`}>
          <div className="max-w-md space-y-2 rounded-lg bg-secondary p-4">
            {cameras.map((camera) => {
              const currentType = getCameraType(camera);
              const isSaving = savingCamera === camera;

              return (
                <div
                  key={camera}
                  className="flex flex-row items-center justify-between"
                >
                  <CameraNameLabel camera={camera} />
                  {isSaving ? (
                    <ActivityIndicator className="h-5 w-20" size={16} />
                  ) : (
                    <Select
                      value={currentType}
                      onValueChange={wrapAsync((v) =>
                        handleTypeChange(camera, v),
                      )}
                    >
                      <SelectTrigger className="h-7 w-full max-w-[140px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="normal">
                          {t("cameraManagement.cameraType.normal", {
                            ns: "views/settings",
                          })}
                        </SelectItem>
                        <SelectItem value="lpr">
                          {t("cameraManagement.cameraType.dedicatedLpr", {
                            ns: "views/settings",
                          })}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-sm text-muted-foreground md:hidden">
            {t("cameraManagement.cameraType.description", {
              ns: "views/settings",
            })}
          </p>
          <div className="flex items-center text-sm text-primary md:hidden">
            <Link
              to={getLocaleDocUrl(
                "configuration/license_plate_recognition#dedicated-lpr-cameras",
              )}
              target="_blank"
              rel="noopener noreferrer"
              className="inline"
            >
              {t("readTheDocumentation", { ns: "common" })}
              <LuExternalLink className="ml-2 inline-flex size-3" />
            </Link>
          </div>
        </div>
      </div>
    </SettingsGroupCard>
  );
}

type ProfileCameraEnableSectionProps = {
  profileState: ProfileState;
  cameras: string[];
  config: FrigateConfig | undefined;
  onConfigChanged: () => Promise<unknown>;
};

function ProfileCameraEnableSection({
  profileState,
  cameras,
  config,
  onConfigChanged,
}: Readonly<ProfileCameraEnableSectionProps>) {
  const { t } = useTranslation(["views/settings", "common"]);
  const [selectedProfile, setSelectedProfile] = useState<string>(
    profileState.allProfileNames[0] ?? "",
  );
  const [savingCamera, setSavingCamera] = useState<string | null>(null);
  // Optimistic local state: the parsed config API doesn't reflect profile
  // enabled changes until Frigate restarts, so we track saved values locally.
  const [localOverrides, setLocalOverrides] = useState<
    Record<string, Record<string, string>>
  >({});

  const handleEnabledChange = useCallback(
    async (camera: string, value: string) => {
      setSavingCamera(camera);
      try {
        const enabledValue =
          value === "enabled" ? true : value === "disabled" ? false : null;
        const configData =
          enabledValue === null
            ? {
                cameras: {
                  [camera]: {
                    profiles: { [selectedProfile]: { enabled: "" } },
                  },
                },
              }
            : {
                cameras: {
                  [camera]: {
                    profiles: { [selectedProfile]: { enabled: enabledValue } },
                  },
                },
              };

        await axios.put("config/set", {
          requires_restart: 0,
          config_data: configData,
        });
        await onConfigChanged();

        setLocalOverrides((prev) => ({
          ...prev,
          [selectedProfile]: {
            ...prev[selectedProfile],
            [camera]: value,
          },
        }));

        toast.success(t("toast.save.success", { ns: "common" }), {
          position: "top-center",
        });
      } catch {
        toast.error(t("toast.save.error.title", { ns: "common" }), {
          position: "top-center",
        });
      } finally {
        setSavingCamera(null);
      }
    },
    [selectedProfile, onConfigChanged, t],
  );

  const getEnabledState = useCallback(
    (camera: string): string => {
      // Check optimistic local state first
      const localValue = localOverrides[selectedProfile]?.[camera];
      if (localValue) return localValue;

      const profileData =
        config?.cameras?.[camera]?.profiles?.[selectedProfile];
      if (profileData?.enabled === undefined) return "inherit";
      return profileData.enabled ? "enabled" : "disabled";
    },
    [config, selectedProfile, localOverrides],
  );

  if (!selectedProfile) return null;

  return (
    <SettingsGroupCard
      title={t("cameraManagement.profiles.title", {
        ns: "views/settings",
      })}
    >
      <div className={SPLIT_ROW_CLASS_NAME}>
        <div className="space-y-1.5">
          <Label>
            {t("cameraManagement.profiles.selectLabel", {
              ns: "views/settings",
            })}
          </Label>
          <p className="text-sm text-muted-foreground">
            {t("cameraManagement.profiles.description", {
              ns: "views/settings",
            })}
          </p>
        </div>
        <div className={`${CONTROL_COLUMN_CLASS_NAME} space-y-4`}>
          <Select value={selectedProfile} onValueChange={setSelectedProfile}>
            <SelectTrigger className="w-full max-w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {profileState.allProfileNames.map((profile) => {
                const color = getProfileColor(
                  profile,
                  profileState.allProfileNames,
                );
                return (
                  <SelectItem key={profile} value={profile}>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "h-2 w-2 shrink-0 rounded-full",
                          color.dot,
                        )}
                      />
                      {profileState.profileFriendlyNames.get(profile) ??
                        profile}
                    </div>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          <div className="max-w-md space-y-2 rounded-lg bg-secondary p-4">
            {cameras.map((camera) => {
              const state = getEnabledState(camera);
              const isSaving = savingCamera === camera;

              return (
                <div
                  key={camera}
                  className="flex flex-row items-center justify-between"
                >
                  <CameraNameLabel camera={camera} />
                  {isSaving ? (
                    <ActivityIndicator className="h-5 w-20" size={16} />
                  ) : (
                    <Select
                      value={state}
                      onValueChange={wrapAsync((v) =>
                        handleEnabledChange(camera, v),
                      )}
                    >
                      <SelectTrigger className="h-7 w-[120px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">
                          {t("cameraManagement.profiles.inherit", {
                            ns: "views/settings",
                          })}
                        </SelectItem>
                        <SelectItem value="enabled">
                          {t("cameraManagement.profiles.on", {
                            ns: "views/settings",
                          })}
                        </SelectItem>
                        <SelectItem value="disabled">
                          {t("cameraManagement.profiles.off", {
                            ns: "views/settings",
                          })}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </SettingsGroupCard>
  );
}
