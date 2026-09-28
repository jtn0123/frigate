import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { StreamCheckResults } from "@/hooks/use-health-checks";
import type { TestResult } from "@/types/cameraWizard";
import type { FrigateConfig } from "@/types/frigateConfig";
import { streamHealth } from "../streamHealth";

// echoes the key and its interpolation values so assertions can read them
const t = ((key: string, options?: Record<string, unknown>) => {
  const { ns: _ns, ...values } = options ?? {};
  return `${key} ${JSON.stringify(values)}`;
}) as TFunction;

const cfg = (value: unknown) => value as FrigateConfig;

type Input = { path: string; roles: string[] };

function camera(
  inputs: Input[],
  record: string | string[] = "preset-record-generic-audio",
  enabled = true,
) {
  return { enabled, ffmpeg: { inputs, output_args: { record } } };
}

function config(
  cameras: Record<string, ReturnType<typeof camera>>,
  streams?: Record<string, string | string[]>,
): FrigateConfig {
  return cfg({ cameras, go2rtc: { streams } });
}

function results(
  byCamera: Record<string, { error?: string; streams?: TestResult[] }>,
): StreamCheckResults {
  return {
    checkedAt: 0,
    byCamera: Object.fromEntries(
      Object.entries(byCamera).map(([name, check]) => [
        name,
        { streams: [], ...check },
      ]),
    ),
  };
}

const aac: TestResult = {
  success: true,
  videoCodec: "h264",
  audioCodec: "aac",
  resolution: "1280x720",
};

describe("stream health summary", () => {
  it("reports nothing before a check has run", () => {
    expect(streamHealth(config({}), undefined, t)).toEqual({
      problems: [],
      checked: 0,
      clean: 0,
    });
  });

  it("skips results for unknown and disabled cameras", () => {
    const health = streamHealth(
      config({ off: camera([], undefined, false) }),
      results({ gone: {}, off: {} }),
      t,
    );
    expect(health).toEqual({ problems: [], checked: 0, clean: 0 });
  });

  it("counts a camera whose streams pass every health rule as clean", () => {
    const health = streamHealth(
      config({
        front: camera([
          { path: "rtsp://camera/main", roles: ["record", "detect"] },
        ]),
      }),
      results({ front: { streams: [aac] } }),
      t,
    );
    expect(health).toEqual({ problems: [], checked: 1, clean: 1 });
  });

  it("reports a whole-camera failure once and skips its streams", () => {
    const health = streamHealth(
      config({
        "back yard": camera([{ path: "rtsp://camera/a", roles: ["detect"] }]),
      }),
      results({ "back yard": { error: "timed out" } }),
      t,
    );
    expect(health.checked).toBe(1);
    expect(health.clean).toBe(0);
    expect(health.problems).toEqual([
      {
        id: "stream:back yard:error",
        source: "stream",
        severity: "error",
        scope: "back yard",
        scopeIsCamera: true,
        text: 'health.notices.cameraProbeFailed {"error":"timed out"}',
        link: "/settings?page=cameraFfmpeg&camera=back%20yard",
      },
    ]);
  });

  it("flags failed and missing stream probes with the last error line", () => {
    const health = streamHealth(
      config({
        front: camera([
          { path: "rtsp://camera/a", roles: ["detect"] },
          { path: "rtsp://camera/b", roles: ["record"] },
        ]),
      }),
      results({
        front: {
          streams: [{ success: false, error: "intro\nconnection refused\n" }],
        },
      }),
      t,
    );
    expect(health.clean).toBe(0);
    expect(
      health.problems.map(({ id, severity, text }) => [id, severity, text]),
    ).toEqual([
      [
        "stream:front:0:probe",
        "error",
        'health.notices.streamProbeFailed {"index":1,"error":"connection refused"}',
      ],
      [
        "stream:front:1:probe",
        "error",
        'health.notices.streamProbeFailed {"index":2,"error":""}',
      ],
    ]);
  });

  it("keeps rule severities and drops wizard-only brand advice", () => {
    const health = streamHealth(
      config({
        porch: camera([
          {
            path: "rtsp://camera/cam/realmonitor?subtype=1&app=bcs",
            roles: ["detect", "record"],
          },
        ]),
      }),
      results({
        porch: {
          streams: [
            { success: true, videoCodec: "h264", resolution: "320x240" },
          ],
        },
      }),
      t,
    );
    expect(health.problems.map(({ id, severity }) => [id, severity])).toEqual([
      ["stream:porch:0:no-audio", "warning"],
      ["stream:porch:0:resolution-low", "error"],
    ]);
    expect(health.problems[0]?.text).toMatch(
      /^health\.notices\.streamPrefix \{"index":1,"message":/,
    );
    expect(health.problems[0]?.link).toBe(
      "/settings?page=cameraFfmpeg&camera=porch",
    );
  });

  it.each([
    ["the default preset", "preset-record-generic-audio", false],
    ["the audio copy preset", "preset-record-generic-audio-copy", true],
    ["a -c:a copy argument", ["-f", "segment", "-c:a", "copy"], true],
    ["an -acodec copy argument", "-f segment -acodec copy", true],
    ["a copy-like codec name", "-c:a copyright", false],
  ] as const)(
    "reports a non-AAC recording track only with %s",
    (_label, record, reported) => {
      const health = streamHealth(
        config({
          front: camera(
            [{ path: "rtsp://camera/main", roles: ["record"] }],
            typeof record === "string" ? record : [...record],
          ),
        }),
        results({ front: { streams: [{ ...aac, audioCodec: "pcm_alaw" }] } }),
        t,
      );
      expect(health.problems.map(({ id }) => id)).toEqual(
        reported ? ["stream:front:0:audio-codec-record"] : [],
      );
      expect(health.clean).toBe(reported ? 0 : 1);
    },
  );

  it("points restreamed issues at the go2rtc stream settings", () => {
    const health = streamHealth(
      config(
        {
          garage: camera(
            [{ path: "rtsp://127.0.0.1:8554/garage", roles: ["record"] }],
            "preset-record-generic-audio-copy",
          ),
        },
        { garage: "ffmpeg:rtsp://camera/main#audio=opus" },
      ),
      results({ garage: { streams: [{ ...aac, audioCodec: "opus" }] } }),
      t,
    );
    // the restream rule is wizard-only, so only the codec problem remains
    expect(health.problems).toHaveLength(1);
    expect(health.problems[0]).toMatchObject({
      id: "stream:garage:0:audio-codec-record",
      severity: "error",
      link: "/settings?page=systemGo2rtcStreams",
    });
    expect(health.problems[0]?.text).toMatch(
      /^health\.notices\.streamPrefixRestream \{"index":1,/,
    );
  });

  it("treats a restream path without a go2rtc entry as a direct input", () => {
    const health = streamHealth(
      config({
        garage: camera([
          { path: "rtsp://127.0.0.1:8554/garage", roles: ["record"] },
        ]),
      }),
      results({ garage: { streams: [{ success: true }] } }),
      t,
    );
    expect(health.problems).toHaveLength(1);
    expect(health.problems[0]).toMatchObject({
      id: "stream:garage:0:no-audio",
      link: "/settings?page=cameraFfmpeg&camera=garage",
    });
  });

  it("counts only cameras without problems as clean", () => {
    const health = streamHealth(
      config({
        a: camera([{ path: "rtsp://camera/a", roles: ["detect"] }]),
        b: camera([{ path: "rtsp://camera/b", roles: ["detect"] }]),
        c: camera([{ path: "rtsp://camera/c", roles: ["detect"] }]),
      }),
      results({
        a: { streams: [aac] },
        b: { streams: [{ ...aac, resolution: "3840x2160" }] },
        c: { error: "unreachable" },
      }),
      t,
    );
    expect(health.checked).toBe(3);
    expect(health.clean).toBe(1);
    expect(health.problems.map(({ id }) => id)).toEqual([
      "stream:b:0:resolution-high",
      "stream:c:error",
    ]);
  });
});
