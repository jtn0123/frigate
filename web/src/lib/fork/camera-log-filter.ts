/** Match a camera identifier without also matching similarly named cameras. */
export function matchesCameraLog(line: string, camera: string): boolean {
  if (!camera) return true;
  const escaped = camera.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  // Camera-specific logger names are authoritative. A different camera's
  // message may mention this camera, which must not bring that line back.
  const section =
    /\]\s+([\w.-]+)\s+(?:DEBUG|INFO|WARNING|ERROR|CRITICAL)\b/.exec(line)?.[1];
  const loggerCamera = section?.match(
    /^(?:ffmpeg|watchdog|frigate\.video)\.([^.]+)/,
  )?.[1];
  if (loggerCamera) return loggerCamera.toLowerCase() === camera.toLowerCase();
  return new RegExp(
    `(^|[^a-zA-Z0-9_-])${escaped}(?=$|[^a-zA-Z0-9_-])`,
    "i",
  ).test(line);
}
