import { useSearchParams } from "react-router-dom";
import { isForkEnabled } from "@/fork/flags";
import type { LogType } from "@/types/log";

/** Share the camera restriction through navigation and browser history. */
export function useCameraLogFilter(service: LogType) {
  const [params, setParams] = useSearchParams();
  const cameraFilter =
    isForkEnabled("cameraHealth") && service === "frigate"
      ? (params.get("camera") ?? "")
      : "";
  const clearCameraFilter = () => {
    const next = new URLSearchParams(params);
    next.delete("camera");
    setParams(next);
  };
  return { cameraFilter, clearCameraFilter };
}
