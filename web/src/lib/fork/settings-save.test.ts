import { describe, expect, it, vi } from "vitest";
import type { RJSFSchema } from "@rjsf/utils";
import type { ConfigSectionData } from "@/types/configForm";
import type { FrigateConfig } from "@/types/frigateConfig";
import { savePendingSettings } from "./settings-save";

const section = (value: unknown) => value as ConfigSectionData;
const cfg = (value: unknown) => value as FrigateConfig;

const config = cfg({
  models: [{ scene: "all", devices: ["edgetpu:usb"] }],
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
  it("saves models before streams and sections, then reports restart and cleared keys", async () => {
    const client = api();
    const pending: Record<string, ConfigSectionData> = {
      models: section([{ scene: "all", devices: ["edgetpu:pci"] }]),
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
      savedKeys: ["models", "go2rtc_streams", "detect"],
      keysToClear: ["models", "go2rtc_streams", "detect"],
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

  it("replaces the model list in one write and removes runtime-only fields", async () => {
    const client = api();
    const result = await savePendingSettings({
      config,
      fullSchema: schema,
      pendingDataBySection: {
        models: section([
          {
            scene: "all",
            devices: ["cpu"],
            path: "plus://new-model",
            colormap: { car: [1, 2, 3] },
          },
          {
            scene: "night",
            devices: ["onnx"],
            path: "/models/night.onnx",
            all_attributes: ["hat"],
          },
        ]),
      },
      api: client,
    });
    expect(client.put).toHaveBeenCalledExactlyOnceWith("config/set", {
      requires_restart: 0,
      config_data: {
        models: [
          { scene: "all", devices: ["cpu"], path: "plus://new-model" },
          { scene: "night", devices: ["onnx"], path: "/models/night.onnx" },
        ],
      },
    });
    expect(result).toMatchObject({
      successCount: 1,
      failCount: 0,
      savedKeys: ["models"],
      keysToClear: ["models"],
      anyNeedsRestart: true,
    });
  });

  it("writes a saved Frigate+ model back as plus://<id> without the fields Frigate+ supplies", async () => {
    const client = api();
    // /api/config serves a Frigate+ model with its path resolved to the cache
    // file and its input shape filled from the Frigate+ model info
    const resolved = {
      path: "/config/model_cache/abc123",
      width: 640,
      height: 640,
      input_tensor: "nchw",
      input_pixel_format: "bgr",
      input_dtype: "float",
      model_type: "yolo-generic",
    };
    const plusConfig = cfg({
      ...config,
      models: [
        {
          scene: "all",
          devices: ["onnx"],
          ...resolved,
          plus: { id: "abc123", name: "plus" },
        },
        {
          scene: "night",
          devices: ["cpu"],
          path: "/models/night.onnx",
          width: 320,
          height: 320,
          model_type: "ssd",
          plus: null,
        },
      ],
    });

    await savePendingSettings({
      config: plusConfig,
      fullSchema: schema,
      pendingDataBySection: {
        models: section([
          // only the hardware was edited; the form seeds from the resolved values
          { scene: "all", devices: ["onnx", "onnx"], ...resolved },
          {
            scene: "night",
            devices: ["cpu"],
            path: "/models/night.onnx",
            width: 320,
            height: 320,
            model_type: "ssd",
          },
        ]),
      },
      api: client,
    });

    expect(client.put).toHaveBeenCalledExactlyOnceWith("config/set", {
      requires_restart: 0,
      config_data: {
        models: [
          { scene: "all", devices: ["onnx", "onnx"], path: "plus://abc123" },
          {
            scene: "night",
            devices: ["cpu"],
            path: "/models/night.onnx",
            width: 320,
            height: 320,
            model_type: "ssd",
          },
        ],
      },
    });
  });

  it("drops a previous custom model's input fields when a Frigate+ model is picked", async () => {
    const client = api();
    await savePendingSettings({
      config,
      fullSchema: schema,
      pendingDataBySection: {
        models: section([
          {
            scene: "all",
            devices: ["cpu"],
            path: "plus://picked",
            width: 320,
            height: 320,
            input_tensor: "nhwc",
          },
        ]),
      },
      api: client,
    });

    expect(client.put).toHaveBeenCalledExactlyOnceWith("config/set", {
      requires_restart: 0,
      config_data: {
        models: [{ scene: "all", devices: ["cpu"], path: "plus://picked" }],
      },
    });
  });

  it("retains all model edits when the atomic list write fails", async () => {
    const client = api();
    client.put.mockRejectedValue(new Error("offline"));
    const result = await savePendingSettings({
      config,
      fullSchema: schema,
      pendingDataBySection: {
        models: section([{ scene: "all", devices: ["cpu"] }]),
      },
      api: client,
    });
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      successCount: 0,
      failCount: 1,
      savedKeys: [],
      keysToClear: [],
      anyNeedsRestart: false,
    });
    expect(result.failures[0]?.key).toBe("models");
  });

  it("retains streams for retry if their config write fails", async () => {
    const client = api();
    client.put.mockRejectedValue(new Error("offline"));
    const result = await savePendingSettings({
      config,
      fullSchema: schema,
      pendingDataBySection: { go2rtc_streams: { front: ["rtsp://new"] } },
      api: client,
    });
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(client.remove).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      successCount: 0,
      failCount: 1,
      savedKeys: [],
      keysToClear: [],
    });
    expect(result.failures[0]?.key).toBe("go2rtc_streams");
  });

  it("keeps a stream config save after an optional live stream update fails", async () => {
    const client = api();
    client.put.mockImplementation(async (url) => {
      if (url.startsWith("go2rtc/streams/")) throw new Error("offline");
    });
    const result = await savePendingSettings({
      config,
      fullSchema: schema,
      pendingDataBySection: { go2rtc_streams: { front: ["rtsp://new"] } },
      api: client,
    });
    expect(result).toMatchObject({
      successCount: 1,
      failCount: 0,
      savedKeys: ["go2rtc_streams"],
      keysToClear: ["go2rtc_streams"],
    });
  });
});
