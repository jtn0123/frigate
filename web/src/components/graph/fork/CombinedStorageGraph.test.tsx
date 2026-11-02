import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApexOptions } from "apexcharts";
import { CombinedStorageGraph } from "../CombinedStorageGraph";

const charts = vi.hoisted((): ApexOptions[] => []);

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));
vi.mock("@/context/theme-provider", () => ({
  useTheme: () => ({ theme: "dark", systemTheme: "dark" }),
}));
vi.mock("apexcharts", () => ({ default: { exec: vi.fn() } }));
vi.mock("react-apexcharts", () => ({
  default: ({ options }: { options: ApexOptions }) => {
    charts.push(options);
    return null;
  },
}));

type Formatter = (val: number | undefined, opts?: unknown) => unknown;

/** The tooltip value formatter of the last rendered chart. */
function tooltipFormatter(): Formatter {
  render(
    <CombinedStorageGraph
      graphId="storage"
      cameraStorage={{
        front: { usage: 512, bandwidth: 10, usage_percent: 25 },
      }}
      totalStorage={{ used: 1024, camera: 512, total: 2048 }}
    />,
  );
  const y = charts.at(-1)?.tooltip?.y;
  const formatter = Array.isArray(y) ? undefined : y?.formatter;
  if (!formatter) throw new Error("no tooltip formatter");
  return formatter as Formatter;
}

describe("CombinedStorageGraph tooltip (F18)", () => {
  it("formats the usage and percent of the hovered series", () => {
    expect(tooltipFormatter()(25, { seriesIndex: 0 })).toBe(
      "512.00 MiB (25.00%)",
    );
  });

  it("treats a missing value as zero percent", () => {
    expect(tooltipFormatter()(undefined, { seriesIndex: 2 })).toBe(
      "1.00 GiB (0.00%)",
    );
  });

  it("returns nothing without options or for an unknown series", () => {
    const formatter = tooltipFormatter();
    expect(formatter(25)).toBeUndefined();
    expect(formatter(25, { seriesIndex: 9 })).toBeUndefined();
  });
});
