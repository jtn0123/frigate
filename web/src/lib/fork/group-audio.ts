/**
 * Fork: a live dashboard's starting audio and volume per camera (UI155).
 *
 * Upstream merged every camera group's saved streaming settings into one
 * camera-keyed map, so whichever group came last decided, and a camera
 * unmuted in one group played with sound in the others. Only the settings of
 * the group on screen count here; a group without saved settings (the
 * default one included) starts muted at full volume.
 */

import type { CameraStreamingSettings } from "@/types/frigateConfig";
import type { AudioState, VolumeState } from "@/types/live";

// Saved in the browser, so an older entry can lack a field.
type SavedGroupSettings = Record<string, Partial<CameraStreamingSettings>>;

export function groupAudioStates(settings: SavedGroupSettings | undefined): {
  audio: AudioState;
  volume: VolumeState;
} {
  const audio: AudioState = {};
  const volume: VolumeState = {};

  Object.entries(settings ?? {}).forEach(([camera, cameraSettings]) => {
    audio[camera] = cameraSettings.playAudio ?? false;
    volume[camera] = cameraSettings.volume ?? 1;
  });

  return { audio, volume };
}
