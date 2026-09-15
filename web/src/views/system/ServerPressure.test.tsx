import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AIModelsResponse } from "@/types/aiModels";
import ServerPressure from "./ServerPressure";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));
vi.mock("swr", () => ({ default: () => ({ data: undefined }) }));

function server(status: string): AIModelsResponse["server"] {
  return {
    status,
    scopes: [{ scope: "host", id: "pve", cpu_percent: 42 }],
  };
}

describe("ServerPressure", () => {
  it("shows a partial snapshot's values without the unavailable warning", () => {
    render(<ServerPressure server={server("partial")} />);

    expect(screen.getByText("42 %")).toBeInTheDocument();
    expect(screen.getByText("models.server.partial")).toBeInTheDocument();
    expect(
      screen.queryByText("models.server.unavailable"),
    ).not.toBeInTheDocument();
  });

  it.each(["stale", "invalid", "not_connected"])(
    "warns that telemetry is unavailable when the status is %s",
    (status) => {
      render(<ServerPressure server={server(status)} />);

      expect(screen.getByText("models.server.unavailable")).toBeInTheDocument();
      expect(
        screen.queryByText("models.server.partial"),
      ).not.toBeInTheDocument();
    },
  );

  it("shows no warning for a connected snapshot", () => {
    render(<ServerPressure server={server("connected")} />);

    expect(
      screen.queryByText("models.server.unavailable"),
    ).not.toBeInTheDocument();
  });
});
