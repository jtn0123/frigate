export type AIModelStatus = {
  id: string;
  name: string;
  role: string;
  location: string;
  device: string;
  status: string;
  resource_scope: string;
  disk_bytes: number | null;
  ram_bytes: number | null;
  peak_ram_bytes: number | null;
  cpu_percent: number | null;
  gpu_memory_bytes: number | null;
  latency_ms: number | null;
  load_ms: number | null;
  last_used: number | null;
  context_length: number | null;
};

export type AIModelsResponse = {
  updated: number;
  source_updated?: number | null;
  telemetry_status?: string;
  history_status?: string;
  server?: {
    status: string;
    updated?: number | null;
    scopes: ({ scope: string; id: string } & Partial<
      Record<
        | "memory_bytes"
        | "memory_limit_bytes"
        | "swap_bytes"
        | "cpu_percent"
        | "cpu_limit"
        | "memory_pressure"
        | "oom_kills"
        | "disk_free_bytes",
        number | null
      >
    >)[];
  };
  models: AIModelStatus[];
  audio: {
    status: string;
    updated?: number | null;
    pending?: number | null;
    failed?: number | null;
    completed?: number | null;
    expired?: number | null;
    oldest_wait_seconds?: number | null;
    pause_reason?: string;
    available_bytes?: number | null;
  };
  shared_gpus: Record<
    string,
    {
      gpu?: string | null;
      mem?: string | null;
      temp?: number | null;
      vendor?: string | null;
    }
  >;
};
