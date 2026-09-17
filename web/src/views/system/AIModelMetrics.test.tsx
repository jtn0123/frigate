import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ApexOptions } from "apexcharts";
import { AIModelsResponse } from "@/types/aiModels";
import AIModelMetrics from "./AIModelMetrics";

// 2026-01-01 00:00:00 UTC is 14:00:00 in the configured zone (UTC+14), which
// no test machine uses, so a browser-zone time cannot match by accident.
const TIME = 1767225600;
const LOCAL = "14:00:00";

const charts: ApexOptions[] = [];

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));
vi.mock("@/context/theme-provider", () => ({
  useTheme: () => ({ theme: "dark", systemTheme: "dark" }),
}));
vi.mock("react-apexcharts", () => ({
  default: ({ options }: { options: ApexOptions }) => {
    charts.push(options);
    return null;
  },
}));

function sample(updated: number): AIModelsResponse {
  return {
    updated,
    telemetry_status: "connected",
    models: [
      {
        id: "m1",
        name: "Model One",
        role: "chat",
        location: "local",
        device: "cpu",
        status: "ready",
        resource_scope: "process",
        disk_bytes: 1024 ** 3,
        ram_bytes: 1024 ** 3,
        peak_ram_bytes: 1024 ** 3,
        cpu_percent: 5,
        gpu_memory_bytes: 1024 ** 3,
        latency_ms: 10,
        load_ms: 10,
        last_used: TIME,
        context_length: null,
      },
    ],
    audio: { status: "connected", pending: 0 },
    shared_gpus: {},
    server: {
      status: "connected",
      scopes: [],
      stability: {
        status: "connected",
        incidents: [],
        samples: [
          {
            time: TIME,
            detector_ms: 5,
            skipped_fps: 0,
            ollama_requests: 1,
          },
        ],
      },
    },
  };
}

// built once: a new object per call would change `data` on every render and
// the history effects would re-render forever
const RESPONSES: Record<string, unknown> = {
  config: {
    data: { ui: { timezone: "Pacific/Kiritimati", time_format: "24hour" } },
  },
  "ai/models": { data: sample(TIME), isValidating: false, mutate: vi.fn() },
  "ai/models/history": {
    data: { samples: [sample(TIME - 10)] },
    mutate: vi.fn(),
  },
};

vi.mock("swr", () => ({
  default: (key: string | null) =>
    (key && RESPONSES[key]) ?? { data: undefined },
}));

describe("AIModelMetrics times", () => {
  it("formats every telemetry time in the configured UI time zone", () => {
    charts.length = 0;
    render(
      <MemoryRouter>
        <AIModelMetrics isActive setLastUpdated={vi.fn()} />
      </MemoryRouter>,
    );

    // the model card's last use
    const card = screen.getByRole("article", { name: "Model One" });
    expect(within(card).getByText(new RegExp(LOCAL))).toBeInTheDocument();

    // the stability evidence table
    const stability = screen.getByRole("region", { name: "stability.title" });
    expect(within(stability).getByText(LOCAL)).toBeInTheDocument();

    // the graph history table
    const ram = screen.getByRole("region", { name: "models.graphs.ram" });
    expect(
      within(ram).getAllByText(new RegExp(LOCAL)).length,
    ).toBeGreaterThanOrEqual(1);

    // the chart axis labels and tooltip
    const options = charts.at(-1);
    expect(options?.tooltip?.x?.formatter?.(TIME * 1000)).toBe(LOCAL);
    const axis = options?.xaxis?.labels?.formatter;
    expect(axis?.("", TIME * 1000)).toBe(LOCAL);
  });

  // fork (UI94): the app spells the month and the full year wherever it puts
  // a date beside a time, so telemetry does too
  it("writes dates the way the rest of the app writes them", () => {
    render(
      <MemoryRouter>
        <AIModelMetrics isActive setLastUpdated={vi.fn()} />
      </MemoryRouter>,
    );

    const card = screen.getByRole("article", { name: "Model One" });
    expect(within(card).getByText(/Jan 1, 2026/)).toBeInTheDocument();
  });
});
