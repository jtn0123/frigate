import { describe, expect, it, vi } from "vitest";
import type { RJSFSchema } from "@rjsf/utils";
import type { ConfigSectionData } from "@/types/configForm";
import type { FrigateConfig } from "@/types/frigateConfig";
import { savePendingSettings } from "./settings-save";

const cfg = (value: unknown) => value as FrigateConfig;

const config = cfg({
  detectors: { coral: { type: "edgetpu", device: "usb" } },
  go2rtc: { streams: { old: "rtsp://old", front: "rtsp://front" } },
  detect: { enabled: true, fps: 5, width: 1280, height: 720 },
  cameras: {},
});

const schema: RJSFSchema = {
  $defs: {
    DetectConfig: {
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
        fps: { type: "integer", default: 5 },
        width: { type: "integer", default: 1280 },
        height: { type: "integer", default: 720 },
      },
    },
  },
  properties: { detect: { $ref: "#/$defs/DetectConfig" } },
};

function api() {
  return {
    put: vi.fn(async (_url: string, _data?: unknown) => {}),
    remove: vi.fn(async (_url: string) => {}),
  };
}

describe("savePendingSettings", () => {
  it("saves detector/model before streams and sections, then reports restart and cleared keys", async () => {
    const client = api();
    const pending: Record<string, ConfigSectionData> = {
      detectors: { coral: { type: "edgetpu", device: "pci" } },
      go2rtc_streams: { front: ["rtsp://new"] },
      detect: { enabled: true, fps: 10, width: 1280, height: 720 },
    };
    const result = await savePendingSettings({
      config,
      fullSchema: schema,
      pendingDataBySection: pending,
      api: client,
    });

    expect(client.put.mock.calls.map(([url]) => url)).toEqual([
      "config/set",
      "config/set",
      "go2rtc/streams/front?src=rtsp%3A%2F%2Fnew",
      "config/set",
    ]);
    expect(client.put.mock.calls[1]?.[1]).toMatchObject({
      config_data: { go2rtc: { streams: { front: ["rtsp://new"], old: "" } } },
    });
    expect(client.remove).toHaveBeenCalledWith("go2rtc/streams/old");
    expect(result).toMatchObject({
      successCount: 3,
      failCount: 0,
      anyNeedsRestart: true,
      savedKeys: ["detectors", "go2rtc_streams", "detect"],
      keysToClear: ["detectors", "go2rtc_streams", "detect"],
    });
  });

  it("retains a failed section for retry while reporting successful sections", async () => {
    const client = api();
    client.put.mockImplementation(async (_url, data) => {
      if (
        (data as { config_data?: { detect?: unknown } } | undefined)
          ?.config_data?.detect
      ) {
        throw new Error("rejected");
      }
    });
    const result = await savePendingSettings({
      config,
      fullSchema: schema,
      pendingDataBySection: {
        go2rtc_streams: { front: ["rtsp://new"] },
        detect: { enabled: true, fps: 10, width: 1280, height: 720 },
      },
      api: client,
    });
    expect(result).toMatchObject({
      successCount: 1,
      failCount: 1,
      savedKeys: ["go2rtc_streams"],
      keysToClear: ["go2rtc_streams"],
    });
    expect(result.failures[0]?.key).toBe("detect");
  });

  it("pre-clears detector/model keys before a changed detector set", async () => {
    const client = api();
    const result = await savePendingSettings({
      config,
      fullSchema: schema,
      pendingDataBySection: { detectors: { new_detector: { type: "cpu" } } },
      api: client,
    });
    expect(client.put.mock.calls[0]?.[1]).toMatchObject({
      config_data: { detectors: null, model: null },
    });
    expect(result.savedKeys).toEqual(["detectors"]);
    expect(result.anyNeedsRestart).toBe(true);
  });
});
