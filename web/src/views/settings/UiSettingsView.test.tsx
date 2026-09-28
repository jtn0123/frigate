import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "@/context/auth-state";
import UiSettingsView from "./UiSettingsView";

const fixture = vi.hoisted(() => ({
  deleteKey: vi.fn(),
  setPreference: vi.fn(),
  buildExport: vi.fn(),
  download: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  config: {
    version: "0.18.0",
    camera_groups: { porch: {}, yard: {} },
    cameras: {},
  },
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-device-detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-device-detect")>()),
  isSafari: true,
}));
vi.mock("swr", () => ({ default: () => ({ data: fixture.config }) }));
vi.mock("sonner", () => ({
  toast: { success: fixture.success, error: fixture.error },
}));
vi.mock("@/hooks/use-user-persistence", () => ({
  useUserPersistence: (_key: string, initial: unknown) => [
    initial,
    fixture.setPreference,
    true,
  ],
  deleteUserNamespacedKey: fixture.deleteKey,
}));
vi.mock("@/utils/uiSettingsTransfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/uiSettingsTransfer")>()),
  buildExportPayload: fixture.buildExport,
  downloadJson: fixture.download,
}));
vi.mock("@/components/fork/settings/ConfirmClearDialog", () => ({
  default: ({
    open,
    onOpenChange,
    onConfirm,
    title,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    title: string;
  }) =>
    open ? (
      <div data-testid="confirm-clear">
        <span>{title}</span>
        <button onClick={() => onOpenChange(false)}>Cancel clear</button>
        <button onClick={onConfirm}>Confirm clear</button>
      </div>
    ) : null,
}));
vi.mock("@/components/overlay/dialog/ImportUiSettingsDialog", () => ({
  default: ({
    fileName,
    onOpenChange,
  }: {
    fileName: string;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-testid="import-dialog">
      <span>{fileName}</span>
      <button onClick={() => onOpenChange(false)}>Cancel import</button>
    </div>
  ),
}));

function mount(isLoading = false) {
  return render(
    <AuthContext.Provider
      value={{
        auth: {
          user: { username: "operator", role: "admin" },
          allowedCameras: [],
          isLoading,
          isAuthenticated: true,
        },
        login: vi.fn(),
        logout: vi.fn(),
      }}
    >
      <UiSettingsView />
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  sessionStorage.clear();
  fixture.deleteKey.mockResolvedValue(undefined);
  fixture.buildExport.mockResolvedValue({ type: "frigate-ui-settings" });
});

describe("UiSettingsView", () => {
  it("offers and saves fast default playback rates on Safari", async () => {
    mount();
    const trigger = document.getElementById("default-playback-rate");
    if (!trigger) throw new Error("Missing playback rate selector");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    for (const rate of [0.5, 1, 2, 4, 8, 16]) {
      expect(
        await screen.findByRole("option", { name: `${rate}x` }),
      ).toBeVisible();
    }
    fireEvent.click(screen.getByRole("option", { name: "16x" }));
    expect(fixture.setPreference).toHaveBeenCalledWith(16);
  });

  it("requires confirmation before clearing layouts and removes each group for the user", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "general.storedLayouts.clearAll" }),
    );
    expect(fixture.deleteKey).not.toHaveBeenCalled();
    expect(screen.getByTestId("confirm-clear")).toHaveTextContent(
      "confirmClear.layouts.title",
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear" }));
    await waitFor(() => expect(fixture.deleteKey).toHaveBeenCalledTimes(8));
    expect(fixture.deleteKey).toHaveBeenCalledWith(
      "porch-draggable-layout",
      "operator",
    );
    expect(fixture.deleteKey).toHaveBeenCalledWith(
      "yard-draggable-layout",
      "operator",
    );
    expect(screen.queryByTestId("confirm-clear")).not.toBeInTheDocument();
  });

  it("cancels a clear and reports a failed streaming settings delete", async () => {
    fixture.deleteKey.mockRejectedValue({
      response: { data: { detail: "storage blocked" } },
    });
    mount();
    fireEvent.click(
      screen.getByRole("button", {
        name: "general.cameraGroupStreaming.clearAll",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel clear" }));
    expect(fixture.deleteKey).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "general.cameraGroupStreaming.clearAll",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear" }));
    await waitFor(() => expect(fixture.error).toHaveBeenCalled());
    expect(fixture.deleteKey).toHaveBeenCalledWith(
      "streaming-settings",
      "operator",
    );
  });

  it("exports the current groups and reports export failures", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", {
        name: "general.backupRestore.transfer.export",
      }),
    );
    await waitFor(() => expect(fixture.download).toHaveBeenCalledTimes(1));
    expect(fixture.buildExport).toHaveBeenCalledWith(
      ["porch", "yard"],
      "0.18.0",
      "operator",
    );
    expect(fixture.success).toHaveBeenCalledWith(
      "general.toast.success.exportUiSettings",
      { position: "top-center" },
    );
  });

  it("reports a rejected export and a malformed imported file", async () => {
    fixture.buildExport.mockRejectedValue(new Error("storage denied"));
    mount();
    fireEvent.click(
      screen.getByRole("button", {
        name: "general.backupRestore.transfer.export",
      }),
    );
    await waitFor(() =>
      expect(fixture.error).toHaveBeenCalledWith(
        "general.toast.error.exportUiSettingsFailed",
        { position: "top-center" },
      ),
    );
    const file = new File(["not json"], "bad.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", { value: async () => "not json" });
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement))
      throw new Error("Expected file input");
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(fixture.error).toHaveBeenCalledWith(
        "general.toast.error.importInvalidJson",
        { position: "top-center" },
      ),
    );
    expect(input.value).toBe("");
  });

  it("opens a valid import for review and dismisses it without applying", async () => {
    mount();
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement))
      throw new Error("Expected file input");
    const click = vi.spyOn(input, "click");
    fireEvent.click(
      screen.getByRole("button", {
        name: "general.backupRestore.transfer.import",
      }),
    );
    expect(click).toHaveBeenCalledTimes(1);

    const file = new File([], "settings.json", { type: "application/json" });
    Object.defineProperty(file, "text", {
      value: async () =>
        JSON.stringify({
          type: "frigate-ui-settings",
          version: 1,
          exported_at: "2026-09-24T00:00:00Z",
          frigate_version: "0.18.0",
          sections: { layouts: { porch: [] }, streaming: {}, preferences: {} },
        }),
    });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByTestId("import-dialog")).toHaveTextContent(
      "settings.json",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(screen.queryByTestId("import-dialog")).not.toBeInTheDocument();
  });

  it("disables transfer actions while authentication is loading", () => {
    mount(true);
    expect(
      screen.getByRole("button", {
        name: "general.backupRestore.transfer.export",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "general.backupRestore.transfer.import",
      }),
    ).toBeDisabled();
  });

  it("shows a pending import failure once when the view next opens", () => {
    sessionStorage.setItem("frigate-ui-settings-import-failed", "1");
    mount();
    expect(fixture.error).toHaveBeenCalledWith(
      "general.toast.error.importUiSettingsFailed",
      { position: "top-center" },
    );
    expect(
      sessionStorage.getItem("frigate-ui-settings-import-failed"),
    ).toBeNull();
  });
});
