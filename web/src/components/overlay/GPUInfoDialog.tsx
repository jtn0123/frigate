import useSWR from "swr";
import { wrapAsync } from "@/utils/promise";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import ActivityIndicator from "../indicators/activity-indicator";
import { GpuInfo, Nvinfo, Vainfo } from "@/types/stats";
import { Button } from "../ui/button";
import copy from "copy-to-clipboard";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

type GPUInfoDialogProps = {
  showGpuInfo: boolean;
  gpuType: GpuInfo;
  setShowGpuInfo: (show: boolean) => void;
};

function VainfoBody({ vainfo }: Readonly<{ vainfo: Vainfo }>) {
  const { t } = useTranslation(["views/system"]);
  return (
    <div className="scrollbar-container mb-2 max-h-96 overflow-y-scroll whitespace-pre-line">
      <div>
        {t("general.hardwareInfo.gpuInfo.vainfoOutput.returnCode", {
          code: vainfo.return_code,
        })}
      </div>
      <br />
      <div>
        {vainfo.return_code == 0
          ? t("general.hardwareInfo.gpuInfo.vainfoOutput.processOutput")
          : t("general.hardwareInfo.gpuInfo.vainfoOutput.processError")}
      </div>
      <br />
      <div>{vainfo.return_code == 0 ? vainfo.stdout : vainfo.stderr}</div>
    </div>
  );
}

function NvinfoBody({ nvinfo }: Readonly<{ nvinfo: Nvinfo }>) {
  const { t } = useTranslation(["views/system"]);
  const gpu = nvinfo["0"];
  return (
    <div className="scrollbar-container mb-2 max-h-96 overflow-y-scroll whitespace-pre-line">
      <div>
        {t("general.hardwareInfo.gpuInfo.nvidiaSMIOutput.name", {
          name: gpu.name,
        })}
      </div>
      <br />
      <div>
        {t("general.hardwareInfo.gpuInfo.nvidiaSMIOutput.driver", {
          driver: gpu.driver,
        })}
      </div>
      <br />
      <div>
        {t(
          "general.hardwareInfo.gpuInfo.nvidiaSMIOutput.cudaComputerCapability",
          {
            cuda_compute: gpu.cuda_compute,
          },
        )}
      </div>
      <br />
      <div>
        {t("general.hardwareInfo.gpuInfo.nvidiaSMIOutput.vbios", {
          vbios: gpu.vbios,
        })}
      </div>
    </div>
  );
}

export default function GPUInfoDialog({
  showGpuInfo,
  gpuType,
  setShowGpuInfo,
}: Readonly<GPUInfoDialogProps>) {
  const { t } = useTranslation(["views/system"]);

  const { data: vainfo } = useSWR<Vainfo>(
    showGpuInfo && gpuType == "vainfo" ? "vainfo" : null,
  );
  const { data: nvinfo } = useSWR<Nvinfo>(
    showGpuInfo && gpuType == "nvinfo" ? "nvinfo" : null,
  );

  const onCopyInfo = wrapAsync(async () => {
    copy(
      JSON.stringify(gpuType == "vainfo" ? vainfo : nvinfo)
        .replace(/\\t/g, "\t")
        .replace(/\\n/g, "\n"),
    );
    toast.success(t("general.hardwareInfo.gpuInfo.toast.success"));
  });

  const title =
    gpuType == "vainfo"
      ? t("general.hardwareInfo.gpuInfo.vainfoOutput.title")
      : t("general.hardwareInfo.gpuInfo.nvidiaSMIOutput.title");

  let body: ReactNode;
  if (gpuType == "vainfo") {
    body = vainfo ? <VainfoBody vainfo={vainfo} /> : <ActivityIndicator />;
  } else {
    body = nvinfo ? <NvinfoBody nvinfo={nvinfo} /> : <ActivityIndicator />;
  }

  return (
    <Dialog open={showGpuInfo} onOpenChange={setShowGpuInfo}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {body}
        <DialogFooter>
          <Button
            aria-label={t("general.hardwareInfo.gpuInfo.closeInfo.label")}
            onClick={() => setShowGpuInfo(false)}
          >
            {t("button.close", { ns: "common" })}
          </Button>
          <Button
            aria-label={t("general.hardwareInfo.gpuInfo.copyInfo.label")}
            variant="select"
            onClick={onCopyInfo}
          >
            {t("button.copy", { ns: "common" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
