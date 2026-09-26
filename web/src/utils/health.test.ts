import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type {
  FrigateConfig,
  DetectionModelConfig,
} from "@/types/frigateConfig";
import type {
  DetectionHardware,
  HwaccelRecommendation,
} from "@/types/hardware";
import type { EmbeddingsStats, FrigateStats } from "@/types/stats";
import snapshot from "../../e2e/fixtures/mock-data/config-snapshot.json";
import { BASE_STATS } from "../../e2e/fixtures/mock-data/stats";
import {
  acceleratorKeysFor,
  activeCameras,
  cameraConnectionCells,
  detectionRows,
  devicePresence,
  enrichmentRows,
  hwaccelFamily,
  hwaccelRows,
  isStartupWindow,
  runnerNames,
} from "./health";

const t = ((key: string) => key) as TFunction;
const config = () => structuredClone(snapshot) as FrigateConfig;
const stats = () => structuredClone(BASE_STATS);
const hardware = (device: string): DetectionHardware => ({
  key: device,
  detector: device.split(":")[0],
  name: device,
  units: [{ device, label: device }],
  count: 1,
  unlimited: false,
});
const model = (devices: string[]): DetectionModelConfig => ({
  ...config().models[0],
  devices,
});

describe("detector health", () => {
  it("matches enumerated, generic and unsupported devices", () => {
    const found = [hardware("openvino:GPU.0"), hardware("edgetpu:usb:0")];
    for (const [device, expected] of [
      ["cpu", "present"],
      ["onnx:CPU", "present"],
      ["custom:device", "unverified"],
      ["hailo", "absent"],
      ["onnx", "unverified"],
      ["openvino:AUTO", "present"],
      ["openvino:GPU", "present"],
      ["openvino:GPU.0", "present"],
      ["edgetpu:usb", "present"],
      ["openvino:NPU", "unverified"],
    ] as const)
      expect(devicePresence(device, found)).toBe(expected);
    expect(devicePresence("openvino:AUTO", [])).toBe("unverified");
    expect(
      runnerNames([model(["cpu", "onnx"]), model(["cpu", "cpu"])]),
    ).toEqual(["cpu", "onnx", "cpu#2", "cpu#3"]);
  });
  it("distinguishes missing devices, startup, dead runners and slow inference", () => {
    const args = {
      models: [model(["cpu"])],
      hardware: [],
      probeFailed: false,
      stats: stats(),
      startup: false,
      t,
    };
    expect(
      detectionRows({ ...args, models: [model(["hailo"])] })[0].state,
    ).toBe("error");
    expect(detectionRows({ ...args, startup: true })[0].state).toBe("unknown");
    expect(detectionRows({ ...args, stats: undefined })[0].state).toBe(
      "unknown",
    );
    expect(
      detectionRows({ ...args, models: [model(["custom"])] })[0].message,
    ).toContain("detectorNotRunning");
    for (const [speed, state] of [
      [101, "error"],
      [51, "warning"],
      [50, "ok"],
      [0, "ok"],
    ] as const) {
      args.stats.detectors.cpu.inference_speed = speed;
      expect(detectionRows(args)[0].state).toBe(state);
      expect(
        detectionRows({ ...args, probeFailed: true, hardware: undefined })[0]
          .state,
      ).toBe(state);
    }
  });
});

describe("decoder health", () => {
  const available: HwaccelRecommendation = {
    recommended: "vaapi",
    available: [{ key: "vaapi", presets: {} }],
  };
  it("classifies presets, disabled acceleration and custom commands", () => {
    for (const value of [[], "", "auto"])
      expect(hwaccelFamily(value)).toEqual({ kind: "none" });
    for (const value of [["-hwaccel", "custom"], "custom"])
      expect(hwaccelFamily(value)).toEqual({ kind: "custom" });
    for (const [prefix, family] of [
      ["nvidia", "nvidia"],
      ["vaapi", "vaapi"],
      ["intel-qsv", "intel-qsv"],
      ["rk", "rkmpp"],
      ["jetson", "jetson"],
      ["rpi", "rpi"],
      ["apple-silicon", "apple-silicon"],
    ])
      expect(hwaccelFamily(`preset-${prefix}-h264`)).toEqual({
        kind: "preset",
        family,
      });
  });
  it("reports all decoder outcomes without hiding per-input overrides", () => {
    const cfg = config();
    cfg.cameras = { front_door: cfg.cameras.front_door };
    const camera = cfg.cameras.front_door;
    camera.ffmpeg.inputs = [];
    const args = {
      config: cfg,
      hwaccel: available,
      hwaccelFailed: false,
      stats: stats(),
      t,
    };
    for (const [value, state] of [
      ["auto", "warning"],
      ["preset-vaapi", "ok"],
      ["preset-nvidia", "warning"],
      ["custom", "unknown"],
    ] as const) {
      camera.ffmpeg.hwaccel_args = value;
      expect(hwaccelRows(args)[0].state).toBe(state);
      expect(hwaccelRows({ ...args, hwaccelFailed: true })[0].state).toBe(
        "unknown",
      );
    }
    camera.ffmpeg.hwaccel_args = [];
    expect(hwaccelRows({ ...args, hwaccel: undefined })[0].state).toBe("ok");
    camera.ffmpeg.hwaccel_args = "preset-vaapi";
    args.stats.gpu_usages = {
      intel: { vendor: "intel", dec: "30%", gpu: "1%", mem: "2%" },
    };
    expect(hwaccelRows(args)[0].detail).toContain("decoderUsage");
    expect(hwaccelRows({ ...args, stats: undefined })[0].state).toBe("ok");
    camera.ffmpeg.inputs = [
      {
        path: "rtsp://camera",
        roles: ["detect"],
        global_args: [],
        hwaccel_args: ["-custom"],
        input_args: "",
      },
    ];
    cfg.cameras.backyard = {
      ...structuredClone(camera),
      name: "backyard",
      ffmpeg: { ...camera.ffmpeg, hwaccel_args: "preset-nvidia", inputs: [] },
    };
    expect(hwaccelRows(args)).toHaveLength(3);
  });
});

describe("enrichment health", () => {
  it.each([
    ["AUTO", false, "rknn"],
    ["GPU", false, "onnx:amd"],
    ["GPU.1", false, "openvino:GPU"],
    ["NPU", false, "openvino:NPU"],
    ["CUDA:0", false, "onnx:nvidia"],
    ["TENSORRT", false, "onnx:nvidia"],
    ["ROCM", false, "onnx:amd"],
    ["MIGRAPHX", false, "onnx:amd"],
    ["unknown", true, "onnx:nvidia"],
  ] as const)("matches %s accelerator keys", (requested, nvidiaOnly, key) =>
    expect(acceleratorKeysFor(requested, nvidiaOnly)).toContain(key),
  );
  it("leaves unknown device strings unverified", () =>
    expect(acceleratorKeysFor("mystery", false)).toBeUndefined());
  it("evaluates explicit, implicit, remote and runtime device combinations", () => {
    const cfg = config();
    cfg.semantic_search.enabled =
      cfg.lpr.enabled =
      cfg.audio_transcription.enabled =
        false;
    Object.values(cfg.cameras).forEach((camera) => {
      camera.audio_transcription.enabled = false;
    });
    cfg.face_recognition.enabled = true;
    const st = stats();
    st.embeddings = {
      devices: {},
      face_recognition_speed: 0,
    } as EmbeddingsStats;
    const args = {
      config: cfg,
      hardware: [hardware("onnx:nvidia")],
      probeFailed: false,
      stats: st as FrigateStats | undefined,
      startup: false,
      t,
    };
    const row = () =>
      enrichmentRows(args).find((r) => r.id === "enrichment:face_recognition");
    for (const [request, runtime, speed, expected] of [
      ["CPU", undefined, 0, "ok"],
      ["unknown", undefined, 0, "unknown"],
      ["GPU", "CUDA", 0, "ok"],
      ["GPU", "CPU", 0, "error"],
      ["AUTO", "CPU", 600, "warning"],
      ["AUTO", "CPU", 10, "ok"],
      [undefined, "CPU", 600, "warning"],
      [undefined, undefined, 0, "unknown"],
    ] as const) {
      cfg.face_recognition.device = request;
      st.embeddings.devices = runtime ? { face_recognition: runtime } : {};
      st.embeddings.face_recognition_speed = speed;
      expect(row()?.state).toBe(expected);
    }
    cfg.face_recognition.device = "GPU";
    args.hardware = [];
    expect(row()?.state).toBe("error");
    args.probeFailed = true;
    expect(row()?.state).toBe("unknown");
    args.probeFailed = false;
    cfg.face_recognition.device = "AUTO";
    args.startup = true;
    expect(row()?.message).toContain("justStarted");
    args.startup = false;
    args.stats = undefined;
    expect(row()?.message).toContain("justStarted");
    cfg.face_recognition.enabled = false;
    cfg.semantic_search.enabled = true;
    cfg.semantic_search.model = "remote";
    expect(enrichmentRows(args)[0].state).toBe("ok");
    cfg.semantic_search.model = "jinav1";
    cfg.semantic_search.model_size = "small";
    expect(enrichmentRows(args)[0].detail).toBe("CPU");
    cfg.semantic_search.model_size = "large";
    expect(enrichmentRows(args)[0].state).toBe("unknown");
    cfg.semantic_search.enabled = false;
    cfg.lpr.enabled = true;
    expect(enrichmentRows(args)[0].state).toBe("unknown");
    cfg.lpr.enabled = false;
    cfg.audio_transcription.enabled = true;
    cfg.audio_transcription.device = "GPU";
    args.hardware = [hardware("onnx:nvidia")];
    expect(enrichmentRows(args)[0].state).toBe("ok");
    cfg.audio_transcription.enabled = false;
    cfg.cameras.front_door.audio_transcription.enabled = true;
    expect(enrichmentRows(args)).toHaveLength(1);
  });
});

it("reports connection problems and startup boundaries with incomplete telemetry", () => {
  const cfg = config();
  const st = stats();
  cfg.cameras.garage.enabled = false;
  expect(activeCameras(cfg).map((c) => c.name)).not.toContain("garage");
  expect(cameraConnectionCells(cfg, undefined)).toEqual([]);
  expect(cameraConnectionCells(cfg, st)).toEqual([]);
  st.cameras.front_door.connection_quality = "poor";
  expect(cameraConnectionCells(cfg, st)[0]).toMatchObject({
    camera: "front_door",
    quality: "poor",
    cameraFps: 5,
  });
  st.cameras.front_door = {
    connection_quality: "unusable",
  } as typeof st.cameras.front_door;
  delete st.cameras.backyard;
  expect(cameraConnectionCells(cfg, st)[0]).toMatchObject({
    cameraFps: 0,
    expectedFps: 0,
    reconnects: 0,
    stalls: 0,
  });
  expect(isStartupWindow(undefined)).toBe(false);
  st.service.uptime = 119;
  expect(isStartupWindow(st)).toBe(true);
  st.service.uptime = 120;
  expect(isStartupWindow(st)).toBe(false);
});
