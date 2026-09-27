import type {
  FrigateConfig,
  CameraConfig,
  DetectionModelConfig,
} from "@/types/frigateConfig";
import snapshot from "../../../e2e/fixtures/mock-data/config-snapshot.json";

// These utility tests only consume models, camera identity/decoding, and
// enrichment settings. Keep unrelated legacy config fields out of the fixture.
export const createConfigFixture = () =>
  ({
    models: structuredClone<DetectionModelConfig[]>(snapshot.models),
    cameras: Object.fromEntries(
      Object.entries(snapshot.cameras).map(([name, camera]) => [
        name,
        {
          name,
          enabled: camera.enabled,
          detect: { scene: camera.detect.scene },
          ui: { order: camera.ui.order },
          ffmpeg: {
            hwaccel_args: "auto",
            inputs: [] as CameraConfig["ffmpeg"]["inputs"],
          },
          audio_transcription: { enabled: false },
        },
      ]),
    ),
    semantic_search: { enabled: false, model: "jinav1", model_size: "small" },
    face_recognition: { enabled: false },
    lpr: { enabled: false },
    audio_transcription: { enabled: false, device: "CPU" },
  }) as FrigateConfig;
