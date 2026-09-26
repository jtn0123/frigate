import type { TFunction } from "i18next";
import { parseRestreamStreamName } from "@/components/config-form/theme/fields/streamSource";
import type { CameraBrand, StreamRole, TestResult } from "@/types/cameraWizard";

export type StreamIssue = {
  type: "good" | "warning" | "error";
  message: string;
  /** stable key for the rule that fired, for filtering and tests */
  rule: string;
};

export type StreamIssueInput = {
  url: string;
  roles: StreamRole[];
  brand?: CameraBrand;
  useFfmpeg?: boolean;
  restream?: boolean;
  testResult?: TestResult;
};

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
};

export type FfprobeEntry = {
  return_code?: number;
  stdout?: { streams?: ProbeStream[] } | string | null;
  /** the backend sends a list of non-empty lines on failure */
  stderr?: string | string[];
};

function errorText(stderr: string | string[] | undefined): string {
  const text = Array.isArray(stderr) ? stderr.join("\n") : stderr;
  return text?.trim() || "Unknown error";
}

/** The human-readable end of an ffprobe error; the first lines are plumbing. */
export function lastErrorLine(error: string | undefined): string {
  const lines = (error ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** Parse one entry of the ffprobe API response the way the wizard does. */
export function ffprobeToTestResult(
  entry: FfprobeEntry | undefined,
): TestResult {
  if (
    entry?.return_code !== 0 ||
    !entry.stdout ||
    typeof entry.stdout !== "object"
  ) {
    return { success: false, error: errorText(entry?.stderr) };
  }

  const streams = entry.stdout.streams ?? [];
  const videoStream = streams.find(
    (s) =>
      s.codec_type === "video" ||
      s.codec_name?.includes("h264") ||
      s.codec_name?.includes("h265"),
  );
  const audioStream = streams.find(
    (s) =>
      s.codec_type === "audio" ||
      s.codec_name?.includes("aac") ||
      s.codec_name?.includes("mp3"),
  );

  const resolution = videoStream
    ? `${videoStream.width}x${videoStream.height}`
    : undefined;
  const fps = videoStream?.avg_frame_rate
    ? Number.parseFloat(videoStream.avg_frame_rate.split("/")[0]) /
      Number.parseFloat(videoStream.avg_frame_rate.split("/")[1])
    : undefined;

  return {
    success: true,
    resolution,
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    fps: fps && !Number.isNaN(fps) ? fps : undefined,
  };
}

/** Brand-specific warnings about the stream URL (Reolink). */
function reolinkIssues(input: StreamIssueInput, t: TFunction): StreamIssue[] {
  const result: StreamIssue[] = [];
  const streamUrl = input.url.toLowerCase();
  if (streamUrl.startsWith("rtsp://")) {
    result.push({
      type: "warning",
      rule: "reolink-rtsp",
      message: t("cameraWizard.step4.issues.brands.reolink-rtsp", {
        ns: "views/settings",
      }),
    });
  }

  if (streamUrl.startsWith("http://") && !input.useFfmpeg) {
    result.push({
      type: "warning",
      rule: "reolink-http",
      message: t("cameraWizard.step4.issues.brands.reolink-http", {
        ns: "views/settings",
      }),
    });
  }
  return result;
}

/** The audio verdict for a stream that has the record role. */
function recordAudioIssue(
  testResult: TestResult | undefined,
  t: TFunction,
): StreamIssue {
  if (!testResult?.audioCodec) {
    return {
      type: "warning",
      rule: "no-audio",
      message: t("cameraWizard.step4.issues.noAudioWarning", {
        ns: "views/settings",
      }),
    };
  }

  if (testResult.audioCodec.toLowerCase() === "aac") {
    return {
      type: "good",
      rule: "audio-codec",
      message: t("cameraWizard.step4.issues.audioCodecGood", {
        ns: "views/settings",
        codec: testResult.audioCodec,
      }),
    };
  }

  return {
    type: "error",
    rule: "audio-codec-record",
    message: t("cameraWizard.step4.issues.audioCodecRecordError", {
      ns: "views/settings",
    }),
  };
}

/** Probed width and height, or zeros when the resolution is missing. */
function probedDimensions(resolution: string | undefined): [number, number] {
  if (resolution) {
    const [w, h] = resolution.split("x").map(Number);
    if (!Number.isNaN(w) && !Number.isNaN(h)) {
      return [w, h];
    }
  }
  return [0, 0];
}

/** The resolution verdict for a probed stream that has the detect role. */
function detectResolutionIssue(
  testResult: TestResult,
  t: TFunction,
): StreamIssue | undefined {
  const probedResolution = testResult.resolution;
  const [probedWidth, probedHeight] = probedDimensions(probedResolution);

  if (probedWidth <= 0 || probedHeight <= 0) {
    return {
      type: "error",
      rule: "resolution-unknown",
      message: t("cameraWizard.step4.issues.resolutionUnknown", {
        ns: "views/settings",
      }),
    };
  }

  const minDimension = Math.min(probedWidth, probedHeight);
  const maxDimension = Math.max(probedWidth, probedHeight);
  if (minDimension > 1080) {
    return {
      type: "warning",
      rule: "resolution-high",
      message: t("cameraWizard.step4.issues.resolutionHigh", {
        ns: "views/settings",
        resolution: probedResolution,
      }),
    };
  }

  if (maxDimension < 640) {
    return {
      type: "error",
      rule: "resolution-low",
      message: t("cameraWizard.step4.issues.resolutionLow", {
        ns: "views/settings",
        resolution: probedResolution,
      }),
    };
  }
  return undefined;
}

/** Brand-specific warnings about using a substream for detect. */
function substreamIssues(input: StreamIssueInput, t: TFunction): StreamIssue[] {
  const result: StreamIssue[] = [];
  const detects = input.roles.includes("detect");

  if (input.brand === "dahua" && detects && input.url.includes("subtype=1")) {
    result.push({
      type: "warning",
      rule: "dahua-substream",
      message: t("cameraWizard.step4.issues.dahua.substreamWarning", {
        ns: "views/settings",
      }),
    });
  }

  if (input.brand === "hikvision" && detects && input.url.includes("/102")) {
    result.push({
      type: "warning",
      rule: "hikvision-substream",
      message: t("cameraWizard.step4.issues.hikvision.substreamWarning", {
        ns: "views/settings",
      }),
    });
  }
  return result;
}

/** The wizard's Stream Validation rules, unchanged, over plain input. */
export function getStreamIssues(
  input: StreamIssueInput,
  t: TFunction,
): StreamIssue[] {
  const result: StreamIssue[] = [];
  const { roles, testResult } = input;

  if (input.brand === "reolink") {
    result.push(...reolinkIssues(input, t));
  }

  if (testResult?.videoCodec) {
    const videoCodec = testResult.videoCodec.toLowerCase();
    if (["h264", "h265", "hevc"].includes(videoCodec)) {
      result.push({
        type: "good",
        rule: "video-codec",
        message: t("cameraWizard.step4.issues.videoCodecGood", {
          ns: "views/settings",
          codec: testResult.videoCodec,
        }),
      });
    }
  }

  if (roles.includes("record")) {
    result.push(recordAudioIssue(testResult, t));
  }

  if (roles.includes("audio") && !testResult?.audioCodec) {
    result.push({
      type: "error",
      rule: "audio-required",
      message: t("cameraWizard.step4.issues.audioCodecRequired", {
        ns: "views/settings",
      }),
    });
  }

  if (roles.includes("record") && input.restream) {
    result.push({
      type: "warning",
      rule: "restream",
      message: t("cameraWizard.step4.issues.restreamingWarning", {
        ns: "views/settings",
      }),
    });
  }

  if (roles.includes("detect") && testResult) {
    const resolutionIssue = detectResolutionIssue(testResult, t);
    if (resolutionIssue) {
      result.push(resolutionIssue);
    }
  }

  result.push(...substreamIssues(input, t));

  return result;
}

/**
 * For an input that points at a go2rtc restream, find the camera URL behind
 * it. Returns undefined when the path is not a restream or the stream is not
 * in the go2rtc config. The /config response redacts credentials in these
 * sources, so the URL is only good for pattern matching.
 */
export function resolveRestreamSource(
  path: string,
  streams: Record<string, string | string[]> | undefined,
): { url: string; useFfmpeg: boolean } | undefined {
  const name = parseRestreamStreamName(path);

  if (!name || !streams) {
    return undefined;
  }

  const configured = streams[name];
  let sources: string[] = [];
  if (Array.isArray(configured)) {
    sources = configured;
  } else if (configured) {
    sources = [configured];
  }
  const source = sources.find((s) => !s.startsWith(`ffmpeg:${name}`));

  if (!source) {
    return undefined;
  }

  if (source.startsWith("ffmpeg:")) {
    return {
      url: source.slice("ffmpeg:".length).split("#")[0],
      useFfmpeg: true,
    };
  }

  return { url: source, useFfmpeg: false };
}
