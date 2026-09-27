import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type {
  CameraConfig,
  DetectionModelConfig,
  FrigateConfig,
} from "@/types/frigateConfig";
import type {
  DetectionHardware,
  HwaccelRecommendation,
} from "@/types/hardware";
import type {
  CameraStats,
  DetectorStats,
  EmbeddingsStats,
  FrigateStats,
} from "@/types/stats";
import { createConfigFixture } from "./config.test-fixture";
import { BASE_STATS } from "../../../e2e/fixtures/mock-data/stats";
import {
  activeCameras,
  cameraConnectionCells,
  detectionRows,
  devicePresence,
  enrichmentRows,
  hwaccelRows,
} from "../health";

// Interpolated values are appended so tests can assert what reached t().
const INTERPOLATED = ["devices", "speed", "family", "device", "usage"];
const t = ((key: string, options?: Record<string, unknown>) => {
  const values = INTERPOLATED.filter((name) => options?.[name] !== undefined)
    .map((name) => String(options?.[name]))
    .join(",");
  return values ? `${key}(${values})` : key;
}) as TFunction;

function hardware(key: string, units: string[] = [key]): DetectionHardware {
  return {
    key,
    detector: key.replace(/:.*/, ""),
    name: key,
    units: units.map((device) => ({ device, label: device })),
    count: units.length,
    unlimited: false,
  };
}

function model(devices: string[], scene?: string): DetectionModelConfig {
  const base = createConfigFixture().models.at(0);
  if (!base) {
    throw new Error("config fixture has no model");
  }
  if (scene === undefined) {
    const { scene: _scene, ...rest } = base;
    return { ...rest, devices } as DetectionModelConfig;
  }
  return { ...base, devices, scene };
}

function detector(speed: number): DetectorStats {
  return { detection_start: 0, inference_speed: speed, pid: 1 };
}

function statsWith(overrides: Partial<FrigateStats> = {}): FrigateStats {
  return { ...structuredClone(BASE_STATS), ...overrides };
}

function camera(name: string, order: number): CameraConfig {
  const base = Object.values(createConfigFixture().cameras).find(
    (entry) => entry.name === "front_door",
  );
  if (!base) {
    throw new Error("config fixture has no front_door camera");
  }
  return {
    ...structuredClone(base),
    name,
    ui: { ...base.ui, order },
  };
}

function config(...cameras: CameraConfig[]): FrigateConfig {
  const cfg = createConfigFixture();
  cfg.cameras = Object.fromEntries(cameras.map((cam) => [cam.name, cam]));
  return cfg;
}

describe("devicePresence branches", () => {
  it("matches enumerated units exactly, by colon suffix and by dot suffix", () => {
    const found = [hardware("edgetpu", ["edgetpu:usb:0", "edgetpu:pci.1"])];
    expect(devicePresence("edgetpu:usb", found)).toBe("present");
    expect(devicePresence("edgetpu:pci", found)).toBe("present");
    expect(devicePresence("edgetpu:usb:0", found)).toBe("present");
    // a prefix that is not followed by a separator is a different device
    expect(devicePresence("edgetpu:us", found)).toBe("unverified");
  });

  it("treats a CPU device part as present for any detector", () => {
    expect(devicePresence("openvino:cpu", [])).toBe("present");
    expect(devicePresence("onnx:CPU", [])).toBe("present");
  });

  it("only lets generic onnx and openvino devices fall back to the CPU", () => {
    expect(devicePresence("onnx", [])).toBe("unverified");
    expect(devicePresence("openvino:auto", [])).toBe("unverified");
    // an explicit accelerator on a fallback detector is still missing
    expect(devicePresence("onnx:GPU", [])).toBe("absent");
    // a generic device on a detector without a CPU fallback is missing
    expect(devicePresence("edgetpu", [])).toBe("absent");
    expect(devicePresence("hailo:AUTO", [hardware("hailo")])).toBe("present");
  });

  it("ignores hardware from other detectors", () => {
    expect(devicePresence("rknn:0", [hardware("hailo")])).toBe("absent");
  });
});

describe("detectionRows branches", () => {
  const base = {
    hardware: [] as DetectionHardware[] | undefined,
    probeFailed: false,
    startup: false,
    t,
  };

  it("labels models by scene and falls back to all when the scene is empty", () => {
    const rows = detectionRows({
      ...base,
      models: [model(["cpu"], "night"), model(["cpu"], ""), model(["cpu"])],
      stats: statsWith(),
    });
    expect(rows.map((row) => [row.id, row.label])).toEqual([
      ["detection:0", "detectionModels.scenes.night"],
      ["detection:1", "detectionModels.scenes.all"],
      ["detection:2", "detectionModels.scenes.all"],
    ]);
  });

  it("skips the presence rule when the probe has not answered yet", () => {
    const rows = detectionRows({
      ...base,
      hardware: undefined,
      models: [model(["hailo"])],
      stats: statsWith({ detectors: { hailo: detector(10) } }),
    });
    expect(rows).toEqual([
      {
        id: "detection:0",
        state: "ok",
        label: "detectionModels.scenes.all",
        detail: "hailo · health.hardware.inferenceMs(10)",
      },
    ]);
  });

  it("lists every missing device and keeps unverified ones out of the error", () => {
    const rows = detectionRows({
      ...base,
      models: [model(["hailo", "custom:x", "edgetpu"])],
      stats: statsWith(),
    });
    expect(rows).toMatchObject([
      {
        state: "error",
        message: "health.hardware.deviceNotFound(hailo, edgetpu)",
      },
    ]);
  });

  it("reports the slowest runner of a multi-device model with suffixed names", () => {
    const st = statsWith({
      detectors: { cpu: detector(20), "cpu#2": detector(60) },
    });
    expect(
      detectionRows({ ...base, models: [model(["cpu", "cpu"])], stats: st }),
    ).toMatchObject([
      { state: "warning", message: "health.hardware.inferenceSlow(60)" },
    ]);

    // the second model's runner names continue the count from the first
    expect(
      detectionRows({
        ...base,
        models: [model(["cpu"]), model(["cpu", "cpu"])],
        stats: st,
      }),
    ).toMatchObject([
      { state: "ok" },
      { state: "error", message: "health.hardware.detectorNotRunning" },
    ]);
  });

  it("shows only the inference time when a model has no devices to summarize", () => {
    const rows = detectionRows({
      ...base,
      models: [model([])],
      stats: statsWith(),
    });
    // Math.max of no runners is -Infinity, which is under every threshold
    expect(rows).toMatchObject([
      { state: "ok", detail: "health.hardware.inferenceMs(-Infinity)" },
    ]);
  });
});

describe("hwaccelRows branches", () => {
  const vaapi: HwaccelRecommendation = {
    recommended: "vaapi",
    available: [{ key: "vaapi", presets: {} }],
  };

  function setup(value: string | string[] = "preset-vaapi") {
    const frontDoor = camera("front_door", 1);
    const backyard = camera("backyard", 2);
    const garage = camera("garage", 3);
    const cameras = [frontDoor, backyard, garage];
    cameras.forEach((cam) => {
      cam.ffmpeg.hwaccel_args = value;
    });
    const args = {
      config: config(...cameras),
      hwaccel: vaapi as HwaccelRecommendation | undefined,
      hwaccelFailed: false,
      stats: statsWith() as FrigateStats | undefined,
      t,
    };
    return { frontDoor, backyard, garage, args };
  }

  it("groups cameras by value and names them when not every camera shares it", () => {
    const { backyard, garage, args } = setup();
    backyard.ffmpeg.hwaccel_args = "preset-nvidia";
    garage.friendly_name = "Side Garage";
    expect(hwaccelRows(args).map((row) => [row.id, row.detail])).toEqual([
      ["hwaccel:preset-vaapi", "front door, Side Garage"],
      ["hwaccel:preset-nvidia", "backyard"],
    ]);
  });

  it("ignores empty per-input overrides and does not count a camera twice", () => {
    const { frontDoor, args } = setup(["-hwaccel", "vaapi"]);
    const input: CameraConfig["ffmpeg"]["inputs"][number] = {
      path: "rtsp://camera",
      roles: ["detect"],
      global_args: [],
      hwaccel_args: [],
      input_args: "",
    };
    const { hwaccel_args: _unset, ...noArgs } = input;
    frontDoor.ffmpeg.inputs = [
      input,
      { ...input, hwaccel_args: "" },
      noArgs as typeof input,
      // repeats the camera-level value, so the camera stays listed once
      { ...input, hwaccel_args: ["-hwaccel", "vaapi"] },
    ];
    expect(hwaccelRows(args)).toEqual([
      {
        id: 'hwaccel:["-hwaccel","vaapi"]',
        state: "unknown",
        label: "health.hardware.customArgs",
        detail: "health.hardware.allCameras",
        message: "health.hardware.customArgsNotVerified",
      },
    ]);
  });

  it("labels rows by family or raw value when the probe failed", () => {
    const custom = setup(["-hwaccel", "qsv"]).args;
    expect(hwaccelRows({ ...custom, hwaccelFailed: true })).toEqual([
      {
        id: 'hwaccel:["-hwaccel","qsv"]',
        state: "unknown",
        label: '["-hwaccel","qsv"]',
        detail: "health.hardware.allCameras",
        message: "health.hardware.probeUnavailable",
      },
    ]);

    const preset = setup().args;
    expect(hwaccelRows({ ...preset, hwaccelFailed: true })).toMatchObject([
      { state: "unknown", label: "setupWizard.hwaccel.families.vaapi" },
    ]);
  });

  it("only warns about missing acceleration when hardware and a recommendation exist", () => {
    const { args } = setup("");
    expect(hwaccelRows(args)).toMatchObject([
      {
        state: "warning",
        label: "setupWizard.hwaccel.families.none",
        message:
          "health.hardware.hwaccelNotConfigured(setupWizard.hwaccel.families.vaapi)",
      },
    ]);
    expect(
      hwaccelRows({ ...args, hwaccel: { ...vaapi, recommended: "" } }),
    ).toMatchObject([{ state: "ok" }]);
    expect(
      hwaccelRows({ ...args, hwaccel: { ...vaapi, available: [] } }),
    ).toMatchObject([{ state: "ok" }]);
  });

  it("warns when the preset's hardware family was not detected", () => {
    const { args } = setup();
    expect(hwaccelRows({ ...args, hwaccel: undefined })).toMatchObject([
      {
        state: "warning",
        message:
          "health.hardware.hwaccelHardwareMissing(setupWizard.hwaccel.families.vaapi)",
      },
    ]);
  });

  it("reads decoder usage only from a GPU of the preset's vendor that reports it", () => {
    const { args } = setup();
    const amd = { vendor: "amd" as const, gpu: "1%", mem: "1%" };
    const gpus = {
      unknown: { gpu: "1%", mem: "1%", dec: "90%" },
      nvidia: { vendor: "nvidia" as const, gpu: "1%", mem: "1%", dec: "80%" },
    };
    const detail = (stats: FrigateStats) =>
      hwaccelRows({ ...args, stats }).map((row) => row.detail);

    expect(detail(statsWith({ gpu_usages: { ...gpus, amd } }))).toEqual([
      "health.hardware.allCameras",
    ]);
    expect(
      detail(
        statsWith({ gpu_usages: { ...gpus, amd: { ...amd, dec: "40%" } } }),
      ),
    ).toEqual([
      "health.hardware.allCameras · health.hardware.decoderUsage(40%)",
    ]);

    const { gpu_usages: _gpus, ...noGpus } = statsWith();
    expect(detail(noGpus as FrigateStats)).toEqual([
      "health.hardware.allCameras",
    ]);
  });
});

describe("enrichmentRows branches", () => {
  function setup() {
    const cfg = config(camera("front_door", 1), camera("backyard", 2));
    const emb = { devices: {} } as EmbeddingsStats;
    return {
      cfg,
      emb,
      args: {
        config: cfg,
        hardware: [hardware("onnx:nvidia")] as DetectionHardware[] | undefined,
        probeFailed: false,
        stats: statsWith({ embeddings: emb }) as FrigateStats | undefined,
        startup: false,
        t,
      },
    };
  }
  const row = (rows: ReturnType<typeof enrichmentRows>, id: string) =>
    rows.find((r) => r.id === `enrichment:${id}`);

  it("returns no rows when every enrichment is disabled", () => {
    expect(enrichmentRows(setup().args)).toEqual([]);
  });

  it("treats jinav2 as local and an explicit semantic search device as explicit", () => {
    const { cfg, emb, args } = setup();
    cfg.semantic_search = {
      ...cfg.semantic_search,
      enabled: true,
      model: "jinav2",
      device: "NPU",
    };
    // the probe found only an nvidia GPU, so the NPU request is missing
    expect(row(enrichmentRows(args), "semantic_search")).toMatchObject({
      state: "error",
      message: "health.hardware.acceleratorMissing(NPU)",
    });

    // a runtime accelerator report wins over the probe
    emb.devices = { semantic_search: "NPU" };
    expect(row(enrichmentRows(args), "semantic_search")).toMatchObject({
      state: "ok",
      detail: "NPU",
    });
  });

  it("does not call an explicit device missing before the probe answers or for AUTO", () => {
    const { cfg, emb, args } = setup();
    cfg.lpr = { ...cfg.lpr, enabled: true, device: "GPU" };
    emb.devices = { lpr: "CPU" };
    // no probe data: the CPU runtime is reported as a plain ok
    expect(
      row(enrichmentRows({ ...args, hardware: undefined }), "lpr"),
    ).toMatchObject({ state: "ok", detail: "CPU" });

    cfg.lpr.device = "auto";
    expect(row(enrichmentRows({ ...args, hardware: [] }), "lpr")).toMatchObject(
      { state: "ok", detail: "CPU" },
    );
  });

  it("flags an explicit device that fell back to the CPU even when inference is fast", () => {
    const { cfg, emb, args } = setup();
    cfg.lpr = { ...cfg.lpr, enabled: true, device: "CUDA" };
    emb.devices = { lpr: "cpu" };
    expect(row(enrichmentRows(args), "lpr")).toMatchObject({
      state: "error",
      detail: "CPU",
      message: "health.hardware.fellBackToCpu(CUDA)",
    });
  });

  it("warns about a slow CPU model on any of its timed stats and ignores missing ones", () => {
    const { cfg, emb, args } = setup();
    cfg.lpr = { ...cfg.lpr, enabled: true };
    emb.devices = { lpr: "CPU" };
    // no speed stats yet: counted as zero, so the model is keeping up
    expect(row(enrichmentRows(args), "lpr")).toMatchObject({
      state: "ok",
      detail: "CPU",
    });

    emb.yolov9_plate_detection_speed = 700;
    expect(row(enrichmentRows(args), "lpr")).toMatchObject({
      state: "warning",
      message: "health.hardware.cpuDespiteAccelerator",
    });

    // a slow CPU model with no accelerator to move to is fine
    expect(
      row(enrichmentRows({ ...args, hardware: [hardware("hailo")] }), "lpr"),
    ).toMatchObject({ state: "ok" });
  });

  it("explains an unreported runtime by startup, missing stats or an idle model", () => {
    const { cfg, args } = setup();
    cfg.face_recognition = { ...cfg.face_recognition, enabled: true };
    const message = (overrides: Partial<typeof args>) =>
      row(enrichmentRows({ ...args, ...overrides }), "face_recognition")
        ?.message;
    expect(message({})).toBe("health.hardware.modelNotRunYet");
    expect(message({ startup: true })).toBe("health.hardware.justStarted");
    expect(message({ stats: undefined })).toBe("health.hardware.justStarted");
  });

  it("ignores a runtime device report during startup", () => {
    const { cfg, emb, args } = setup();
    cfg.face_recognition = { ...cfg.face_recognition, enabled: true };
    emb.devices = { face_recognition: "CUDA" };
    expect(
      row(enrichmentRows({ ...args, startup: true }), "face_recognition"),
    ).toMatchObject({ state: "unknown" });
    expect(row(enrichmentRows(args), "face_recognition")).toMatchObject({
      state: "ok",
      detail: "CUDA",
    });
  });

  it("checks audio transcription against nvidia only, from global or camera config", () => {
    const { cfg, args } = setup();
    const backyard = camera("backyard", 2);
    backyard.audio_transcription.enabled = true;
    cfg.cameras = { ...cfg.cameras, backyard };
    cfg.audio_transcription.device = "GPU";
    expect(row(enrichmentRows(args), "audio_transcription")).toMatchObject({
      state: "ok",
      detail: "GPU",
    });
    expect(
      row(
        enrichmentRows({ ...args, hardware: [hardware("openvino:GPU")] }),
        "audio_transcription",
      ),
    ).toMatchObject({
      state: "error",
      message: "health.hardware.acceleratorMissing(GPU)",
    });
    expect(
      row(
        enrichmentRows({ ...args, probeFailed: true }),
        "audio_transcription",
      ),
    ).toMatchObject({ state: "unknown" });
  });

  it("lets an implicit default accept any accelerator", () => {
    const { cfg, emb, args } = setup();
    cfg.face_recognition = { ...cfg.face_recognition, enabled: true };
    emb.devices = { face_recognition: "CPU" };
    emb.face_recognition_speed = 900;
    for (const key of ["openvino:NPU", "rknn", "onnx:amd"]) {
      expect(
        row(
          enrichmentRows({ ...args, hardware: [hardware(key)] }),
          "face_recognition",
        ),
      ).toMatchObject({ state: "warning" });
    }
    // implicit defaults never raise a missing accelerator error
    expect(
      row(enrichmentRows({ ...args, hardware: [] }), "face_recognition"),
    ).toMatchObject({ state: "ok", detail: "CPU" });
  });
});

describe("camera helpers branches", () => {
  it("drops disabled and replay cameras and sorts by UI order", () => {
    const cfg = config(
      camera("front_door", 3),
      camera("backyard", 1),
      camera("garage", 2),
      camera("_replay_front", 0),
      { ...camera("attic", 0), enabled: false },
    );
    expect(activeCameras(cfg).map((cam) => cam.name)).toEqual([
      "backyard",
      "garage",
      "front_door",
    ]);
  });

  it("skips cameras with no stats, no quality yet or an excellent connection", () => {
    const cfg = config(
      camera("front_door", 1),
      camera("backyard", 2),
      camera("garage", 3),
      camera("porch", 4),
    );
    const base = Object.values(BASE_STATS.cameras).at(0);
    if (!base) {
      throw new Error("stats fixture has no camera");
    }
    const fair: CameraStats = {
      ...base,
      connection_quality: "fair",
      camera_fps: 3,
      expected_fps: 5,
      reconnects_last_hour: 2,
      stalls_last_hour: 4,
    };
    const { connection_quality: _quality, ...noQuality } = base;
    const st = statsWith({
      cameras: {
        front_door: fair,
        backyard: noQuality as CameraStats,
        porch: { ...base, connection_quality: "excellent" },
      },
    });
    expect(cameraConnectionCells(cfg, st)).toEqual([
      {
        camera: "front_door",
        quality: "fair",
        cameraFps: 3,
        expectedFps: 5,
        reconnects: 2,
        stalls: 4,
      },
    ]);
  });
});
