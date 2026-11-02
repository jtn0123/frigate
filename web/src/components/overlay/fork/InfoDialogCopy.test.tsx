import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CameraConfig } from "@/types/frigateConfig";
import CameraInfoDialog from "../CameraInfoDialog";
import GPUInfoDialog from "../GPUInfoDialog";

const copy = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
const toastSuccess = vi.hoisted(() => vi.fn());
const vainfo = vi.hoisted(() => ({
  return_code: 0,
  stdout: "VAProfileH264Main",
  stderr: "",
}));
const ffprobe = vi.hoisted(() => [
  { return_code: 0, stdout: { streams: [] }, stderr: "" },
]);

vi.mock("copy-to-clipboard", () => ({ default: copy }));

/** The JSON text of the first copy. */
const copiedJson = (): unknown => JSON.parse(copy.mock.calls[0]?.[0] ?? "");
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: vi.fn() },
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));
vi.mock("swr", () => ({
  default: (key: string | null) => ({
    data: key === "vainfo" ? vainfo : undefined,
  }),
}));
vi.mock("axios", () => ({
  default: { get: () => Promise.resolve({ status: 200, data: ffprobe }) },
}));
vi.mock("../KeyframeAnalysisSection", () => ({ default: () => null }));
vi.mock("@/hooks/use-camera-friendly-name", () => ({
  useCameraFriendlyName: () => "Front Door",
}));

// copy-to-clipboard 4 resolves to whether the copy worked, and the dialogs
// confirm only a copy that did (F18).
describe("GPU info copy", () => {
  const open = () =>
    render(
      <GPUInfoDialog
        showGpuInfo
        gpuType="vainfo"
        setShowGpuInfo={() => undefined}
      />,
    );
  const copyButton = () =>
    screen.getByRole("button", {
      name: "general.hardwareInfo.gpuInfo.copyInfo.label",
    });

  it("copies the vainfo output and confirms it", async () => {
    copy.mockResolvedValue(true);
    open();
    fireEvent.click(copyButton());
    await vi.waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "general.hardwareInfo.gpuInfo.toast.success",
      ),
    );
    expect(copiedJson()).toEqual(vainfo);
  });

  it("does not confirm a refused copy", async () => {
    copy.mockResolvedValue(false);
    open();
    fireEvent.click(copyButton());
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("camera probe info copy", () => {
  const open = () =>
    render(
      <CameraInfoDialog
        camera={{ name: "front_door" } as CameraConfig}
        showCameraInfoDialog
        setShowCameraInfoDialog={() => undefined}
      />,
    );
  const copyButton = () => screen.getByRole("button", { name: "button.copy" });

  it("copies the probe data and confirms it", async () => {
    copy.mockResolvedValue(true);
    open();
    await screen.findByText("cameras.info.stream");
    fireEvent.click(copyButton());
    await vi.waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "cameras.toast.success.copyToClipboard",
      ),
    );
    expect(copiedJson()).toEqual({ ffprobe });
  });

  it("does not confirm a refused copy", async () => {
    copy.mockResolvedValue(false);
    open();
    fireEvent.click(copyButton());
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
