import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ImportUiSettingsDialog from "../ImportUiSettingsDialog";
import type { ImportSummary, UiSettingsFile } from "@/utils/uiSettingsTransfer";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key.endsWith("unknownGroups"))
        return `Groups: ${options?.["groups"]}`;
      if (key.endsWith("unknownCameras"))
        return `Cameras: ${options?.["cameras"]}`;
      if (key.endsWith("exportedFrom")) return `Exported: ${options?.["date"]}`;
      return key;
    },
  }),
}));

const prefix = "general.backupRestore.importDialog.";
const file: UiSettingsFile = {
  type: "frigate-ui-settings",
  version: 1,
  exported_at: "2026-09-23T12:00:00Z",
  frigate_version: "0.18.0",
  sections: { layouts: {}, streaming: {}, preferences: {} },
};
const summary: ImportSummary = {
  layoutGroupCount: 1,
  streamingCameraCount: 1,
  preferenceCount: 1,
  unknownLayoutGroups: ["yard", "shared"],
  unknownStreamingGroups: ["garage", "shared"],
  unknownCameras: ["old-camera"],
};
function props(overrides = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    fileName: "settings.json",
    file,
    summary,
    onConfirm: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
const toggle = (section: string) =>
  screen.getByRole("switch", { name: prefix + section });
const confirm = () => screen.getByRole("button", { name: prefix + "confirm" });

describe("UI settings import selection", () => {
  it("warns only about selected sections, with sorted and deduplicated groups", () => {
    render(<ImportUiSettingsDialog {...props()} />);
    expect(
      screen.getByText("Groups: garage, shared, yard"),
    ).toBeInTheDocument();
    expect(screen.getByText("Cameras: old-camera")).toBeInTheDocument();
    fireEvent.click(toggle("layouts"));
    expect(screen.getByText("Groups: garage, shared")).toBeInTheDocument();
    fireEvent.click(toggle("streaming"));
    expect(screen.queryByText(/^Groups:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Cameras:/)).not.toBeInTheDocument();
    fireEvent.click(toggle("preferences"));
    expect(confirm()).toBeDisabled();
    fireEvent.click(toggle("layouts"));
    expect(confirm()).toBeEnabled();
    expect(screen.getByText("Groups: shared, yard")).toBeInTheDocument();
  });

  it("disables unavailable sections and does not import an empty file", () => {
    render(
      <ImportUiSettingsDialog
        {...props({
          summary: {
            layoutGroupCount: 0,
            streamingCameraCount: 0,
            preferenceCount: 0,
            unknownLayoutGroups: [],
            unknownStreamingGroups: [],
            unknownCameras: [],
          },
        })}
      />,
    );
    for (const section of ["layouts", "streaming", "preferences"]) {
      expect(toggle(section)).toBeDisabled();
      expect(toggle(section)).not.toBeChecked();
    }
    expect(confirm()).toBeDisabled();
  });

  it("resets choices when reopened with a different file", () => {
    const initial = props();
    const { rerender } = render(<ImportUiSettingsDialog {...initial} />);
    fireEvent.click(toggle("preferences"));
    rerender(<ImportUiSettingsDialog {...initial} open={false} />);
    rerender(
      <ImportUiSettingsDialog
        {...initial}
        fileName="preferences.json"
        summary={{
          ...summary,
          layoutGroupCount: 0,
          streamingCameraCount: 0,
          unknownCameras: [],
        }}
      />,
    );
    expect(screen.getByText("preferences.json")).toBeInTheDocument();
    expect(toggle("preferences")).toBeChecked();
    expect(toggle("layouts")).toBeDisabled();
    expect(toggle("streaming")).toBeDisabled();
    expect(screen.queryByText(/^Groups:/)).not.toBeInTheDocument();
    expect(confirm()).toBeEnabled();
  });

  it("submits selected sections once and locks controls until the import completes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onConfirm = vi.fn(() => pending);
    render(<ImportUiSettingsDialog {...props({ onConfirm })} />);
    fireEvent.click(toggle("layouts"));
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
      layouts: false,
      streaming: true,
      preferences: true,
    });
    expect(confirm()).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "button.cancel" }),
    ).toBeDisabled();
    for (const section of ["layouts", "streaming", "preferences"]) {
      expect(toggle(section)).toBeDisabled();
    }
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(confirm()).toBeEnabled());
    expect(toggle("streaming")).toBeEnabled();
  });

  it("keeps an unparseable export date visible and cancels without importing", () => {
    const options = props({ file: { ...file, exported_at: "unknown date" } });
    render(<ImportUiSettingsDialog {...options} />);
    expect(screen.getByText("Exported: unknown date")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "button.cancel" }));
    expect(options.onOpenChange).toHaveBeenCalledWith(false);
    expect(options.onConfirm).not.toHaveBeenCalled();
  });
});
