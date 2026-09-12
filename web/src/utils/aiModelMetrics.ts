import { AIModelsResponse, AIModelStatus } from "@/types/aiModels";

export type MetricField =
  | "ram_bytes"
  | "cpu_percent"
  | "latency_ms"
  | "gpu_memory_bytes"
  | "load_ms"
  | "peak_ram_bytes"
  | "last_used"
  | "disk_bytes";

export function missingReason(
  model: AIModelStatus,
  field: MetricField,
): string {
  if (model.status === "stale") return "stale";
  if (model.status === "unavailable") return "sourceOffline";
  if (model.status === "missing") return "modelMissing";
  if (model.location === "ollama") {
    if (["ram_bytes", "cpu_percent", "peak_ram_bytes"].includes(field))
      return "remoteCollector";
    if (["latency_ms", "load_ms", "last_used"].includes(field))
      return "awaitingRequest";
  }
  if (field === "gpu_memory_bytes")
    return model.device === "CPU" ? "cpuOnly" : "sharedGpu";
  if (field === "disk_bytes") return "fileInventory";
  if (model.location === "audio_worker")
    return audioMissingReason(model, field);
  return "notInstrumented";
}

function audioMissingReason(model: AIModelStatus, field: MetricField): string {
  return model.id === "audio:vad" && field === "load_ms"
    ? "includedInRun"
    : "awaitingRun";
}

export function appendHistory(
  history: AIModelsResponse[],
  sample: AIModelsResponse,
): AIModelsResponse[] {
  if (
    !Number.isFinite(sample.updated) ||
    (history.length > 0 &&
      sample.updated <= history[history.length - 1].updated)
  )
    return history;
  return [
    ...history.filter(
      (point) =>
        point.updated > sample.updated - 1800 && point.updated < sample.updated,
    ),
    sample,
  ].slice(-180);
}

export function graphPoints(
  history: AIModelsResponse[],
  read: (sample: AIModelsResponse) => number | null | undefined,
): { x: number; y: number | null }[] {
  return history.flatMap((sample, index) => {
    const value = read(sample);
    const point = {
      x: sample.updated * 1000,
      y: value != null && Number.isFinite(value) ? value : null,
    };
    return index > 0 && sample.updated - history[index - 1].updated > 25
      ? [{ x: (history[index - 1].updated + 10) * 1000, y: null }, point]
      : [point];
  });
}

export function readMetric(
  sample: AIModelsResponse,
  id: string,
  field: MetricField,
): number | null {
  const model = sample.models.find((item) => item.id === id);
  if (!model || ["stale", "unavailable"].includes(model.status)) return null;
  return model[field] ?? null;
}
