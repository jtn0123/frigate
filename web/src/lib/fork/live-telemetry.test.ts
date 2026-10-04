import { describe, expect, it } from "vitest";

import type { Go2rtcStateResponse } from "@/types/fork/go2rtcState";
import type {
  Go2rtcConsumer,
  Go2rtcStreamsResponse,
} from "@/types/fork/go2rtcStreams";

import {
  appendSample,
  buildCameraRows,
  clientAddress,
  clientKey,
  consumerKind,
  countConsumers,
  detectorLatencies,
  isInternalConsumer,
  isRestreamInput,
  isUnconnectedConsumer,
  latencyLevel,
  mergeCounts,
  remoteHost,
  sampleSeries,
  telemetryCameras,
  telemetrySample,
  telemetryTotals,
  viewerKinds,
  worstLatencyLevel,
  type CameraTelemetry,
  type LatencyStatsSample,
  type TelemetryCamera,
  type TelemetryConfig,
  type TelemetrySample,
} from "./live-telemetry";

// What go2rtc 1.9 lists for the readers of a restreamed camera.
const FRIGATE_DETECT: Go2rtcConsumer = {
  format_name: "rtsp",
  protocol: "rtsp+tcp",
  remote_addr: "127.0.0.1:43122",
  user_agent: "FFmpeg Frigate/0.17.0",
};
const LAVF_LOOPBACK: Go2rtcConsumer = {
  format_name: "rtsp",
  protocol: "rtsp+tcp",
  remote_addr: "127.0.0.1:43200",
  user_agent: "Lavf61.7.100",
};
const GO2RTC_TRANSCODER: Go2rtcConsumer = {
  format_name: "rtsp",
  protocol: "rtsp+tcp",
  remote_addr: "127.0.0.1:43301",
  user_agent: "go2rtc/ffmpeg",
};
// A browser behind Frigate's nginx: loopback, but MSE over a WebSocket.
const BROWSER_MSE: Go2rtcConsumer = {
  format_name: "mse/fmp4",
  protocol: "ws",
  remote_addr: "127.0.0.1:52010 forwarded 192.168.1.40",
  user_agent: "Mozilla/5.0 (X11; Linux x86_64)",
};
const BROWSER_WEBRTC: Go2rtcConsumer = {
  format_name: "webrtc/json",
  protocol: "ws+udp",
  remote_addr: "192.168.1.41:61000 host",
  user_agent: "Mozilla/5.0 (iPhone)",
};
// The Live page's WebRTC check as go2rtc lists it when ICE cannot connect:
// no candidate pair, so no address, and nothing sent (seen on the demo stack).
const WEBRTC_CHECK: Go2rtcConsumer = {
  format_name: "webrtc",
  protocol: "ws",
  user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
};
const HOME_ASSISTANT_RTSP: Go2rtcConsumer = {
  format_name: "rtsp",
  protocol: "rtsp+tcp",
  remote_addr: "192.168.1.10:40122",
  user_agent: "Lavf60.16.100",
};

function streamState(
  name: string,
  overrides: Partial<Go2rtcStateResponse["cameras"][string]["streams"][0]> = {},
) {
  return {
    name,
    configured: true,
    connected: true,
    bytes_received: 1_000_000,
    bytes_per_second: 250_000,
    producers: 1,
    consumers: 2,
    codecs: ["H264", "AAC"],
    source: "rtsp://10.0.0.5:554",
    ...overrides,
  };
}

function state(
  cameras: Go2rtcStateResponse["cameras"],
  updated = 1_000,
): Go2rtcStateResponse {
  return { available: true, updated, cameras };
}

const RESTREAM = (name: string) => `rtsp://127.0.0.1:8554/${name}`;

function rowOf(
  rows: readonly CameraTelemetry[],
  camera: string,
): CameraTelemetry {
  const row = rows.find((entry) => entry.camera === camera);
  if (!row) throw new Error(`no row for ${camera}`);
  return row;
}

describe("consumerKind", () => {
  it("reads go2rtc 1.9's format names", () => {
    expect(consumerKind({ format_name: "rtsp" })).toBe("rtsp");
    expect(consumerKind({ format_name: "mse/fmp4" })).toBe("mse");
    expect(consumerKind({ format_name: "webrtc/json" })).toBe("webrtc");
    expect(consumerKind({ format_name: "webrtc/whep" })).toBe("webrtc");
    expect(consumerKind({ format_name: "hls/fmp4" })).toBe("hls");
    expect(consumerKind({ format_name: "hls/mpegts" })).toBe("hls");
    expect(consumerKind({ format_name: "mjpeg" })).toBe("mjpeg");
    expect(consumerKind({ format_name: "mpjpeg" })).toBe("mjpeg");
    expect(consumerKind({ format_name: "mp4" })).toBe("other");
  });

  it("reads the type older go2rtc releases wrote", () => {
    expect(consumerKind({ type: "RTSP server consumer" })).toBe("rtsp");
    expect(consumerKind({ type: "MSE/WebSocket async" })).toBe("mse");
    expect(consumerKind({ type: "WebRTC/WebSocket async" })).toBe("webrtc");
  });

  it("falls back to the protocol, then to other", () => {
    expect(consumerKind({ protocol: "rtsp+tcp" })).toBe("rtsp");
    expect(consumerKind({})).toBe("other");
  });
});

describe("remoteHost", () => {
  it("drops the port and anything go2rtc appends", () => {
    expect(remoteHost("127.0.0.1:43122")).toBe("127.0.0.1");
    expect(remoteHost("127.0.0.1:52010 forwarded 192.168.1.40")).toBe(
      "127.0.0.1",
    );
    expect(remoteHost("192.168.1.41:61000 host")).toBe("192.168.1.41");
  });

  it("handles IPv6 with and without a port", () => {
    expect(remoteHost("[::1]:43122")).toBe("::1");
    expect(remoteHost("::1")).toBe("::1");
    expect(remoteHost("[fe80::1")).toBe("[fe80::1");
  });

  it("returns an empty host for nothing", () => {
    expect(remoteHost(undefined)).toBe("");
    expect(remoteHost("  ")).toBe("");
  });
});

describe("isInternalConsumer", () => {
  it("counts Frigate's ffmpeg and go2rtc's transcoders as internal", () => {
    expect(isInternalConsumer(FRIGATE_DETECT)).toBe(true);
    expect(isInternalConsumer(LAVF_LOOPBACK)).toBe(true);
    expect(isInternalConsumer(GO2RTC_TRANSCODER)).toBe(true);
  });

  it("treats any loopback RTSP reader as Frigate's", () => {
    for (const address of ["[::1]:5000", "::ffff:127.0.0.1", "localhost"]) {
      expect(
        isInternalConsumer({ format_name: "rtsp", remote_addr: address }),
      ).toBe(true);
    }
  });

  it("keeps browsers behind nginx as viewers despite the loopback address", () => {
    expect(isInternalConsumer(BROWSER_MSE)).toBe(false);
    expect(isInternalConsumer(BROWSER_WEBRTC)).toBe(false);
  });

  it("counts an RTSP reader on another machine as a viewer", () => {
    expect(isInternalConsumer(HOME_ASSISTANT_RTSP)).toBe(false);
  });

  it("knows Frigate's user agent from any address", () => {
    expect(
      isInternalConsumer({
        ...HOME_ASSISTANT_RTSP,
        user_agent: "FFmpeg Frigate/0.17.0",
      }),
    ).toBe(true);
  });
});

describe("isUnconnectedConsumer", () => {
  it("spots a WebRTC reader that never connected", () => {
    expect(isUnconnectedConsumer(WEBRTC_CHECK)).toBe(true);
    expect(isUnconnectedConsumer({ ...WEBRTC_CHECK, remote_addr: " " })).toBe(
      true,
    );
  });

  it("keeps a WebRTC reader once ICE picked an address or media flows", () => {
    expect(isUnconnectedConsumer(BROWSER_WEBRTC)).toBe(false);
    expect(isUnconnectedConsumer({ ...WEBRTC_CHECK, bytes_send: 1200 })).toBe(
      false,
    );
  });

  it("leaves other kinds alone, which start without bytes or report none", () => {
    const { remote_addr: _addr, ...mseWithoutAddress } = BROWSER_MSE;
    expect(isUnconnectedConsumer(mseWithoutAddress)).toBe(false);
    expect(isUnconnectedConsumer(HOME_ASSISTANT_RTSP)).toBe(false);
  });
});

describe("countConsumers", () => {
  it("is all zero for a stream nobody reads", () => {
    const counts = countConsumers(null);
    expect(counts.viewers).toBe(0);
    expect(counts.internal).toBe(0);
    expect(Object.values(counts.kinds).every((count) => count === 0)).toBe(
      true,
    );
  });

  it("splits streams by kind and leaves Frigate's readers out", () => {
    const counts = countConsumers([
      FRIGATE_DETECT,
      LAVF_LOOPBACK,
      BROWSER_MSE,
      BROWSER_WEBRTC,
      { ...BROWSER_WEBRTC, remote_addr: "192.168.1.41:61002 host" },
      HOME_ASSISTANT_RTSP,
    ]);
    // the iPhone plays two WebRTC streams and is one viewer
    expect(counts.viewers).toBe(3);
    expect(counts.streams).toBe(4);
    expect(counts.internal).toBe(2);
    expect(counts.kinds).toEqual({
      webrtc: 2,
      mse: 1,
      hls: 0,
      mjpeg: 0,
      rtsp: 1,
      other: 0,
    });
    expect(viewerKinds(counts)).toEqual([
      { kind: "webrtc", count: 2 },
      { kind: "mse", count: 1 },
      { kind: "rtsp", count: 1 },
    ]);
  });

  it("counts one open Live page once, not its WebRTC check too", () => {
    const counts = countConsumers([FRIGATE_DETECT, WEBRTC_CHECK, BROWSER_MSE]);
    expect(counts.viewers).toBe(1);
    expect(counts.streams).toBe(1);
    expect(counts.internal).toBe(1);
    expect(counts.kinds.webrtc).toBe(0);
    expect(counts.kinds.mse).toBe(1);
  });

  it("has no kinds to list without counts", () => {
    expect(viewerKinds(null)).toEqual([]);
  });

  it("counts two players of one client as one viewer with two streams", () => {
    // one browser with the same camera in two tiles, through nginx
    const counts = countConsumers([
      BROWSER_MSE,
      { ...BROWSER_MSE, remote_addr: "127.0.0.1:52011 forwarded 192.168.1.40" },
    ]);
    expect(counts.viewers).toBe(1);
    expect(counts.streams).toBe(2);
    expect(counts.kinds.mse).toBe(2);
    expect(viewerKinds(counts)).toEqual([{ kind: "mse", count: 2 }]);
  });

  it("knows a browser's MSE and WebRTC players as one client", () => {
    const counts = countConsumers([
      { ...BROWSER_MSE, user_agent: "Mozilla/5.0 (iPhone)" },
      { ...BROWSER_WEBRTC, remote_addr: "192.168.1.40:61000 host" },
    ]);
    expect(counts.viewers).toBe(1);
    expect(counts.streams).toBe(2);
  });

  it("counts two clients as two viewers", () => {
    // another machine, and another browser on the same machine
    const counts = countConsumers([
      BROWSER_MSE,
      { ...BROWSER_MSE, remote_addr: "127.0.0.1:52012 forwarded 192.168.1.50" },
      { ...BROWSER_MSE, user_agent: "Mozilla/5.0 (Windows NT 10.0)" },
    ]);
    expect(counts.viewers).toBe(3);
    expect(counts.streams).toBe(3);
  });

  it("still counts readers go2rtc lists without an address or agent", () => {
    // each on its own: nothing says they share a client
    const counts = countConsumers([
      { format_name: "mse/fmp4" },
      { format_name: "mse/fmp4" },
      { format_name: "hls/fmp4", remote_addr: " ", user_agent: "" },
    ]);
    expect(counts.viewers).toBe(3);
    expect(counts.streams).toBe(3);
    expect(counts.kinds).toMatchObject({ mse: 2, hls: 1 });
  });

  it("keys a reader by whichever of address and agent it has", () => {
    const counts = countConsumers([
      { format_name: "rtsp", remote_addr: "192.168.1.10:40122" },
      { format_name: "rtsp", remote_addr: "192.168.1.10:40123" },
      { format_name: "mjpeg", user_agent: "curl/8.5.0" },
    ]);
    expect(counts.viewers).toBe(2);
    expect(counts.streams).toBe(3);
  });
});

describe("clientAddress", () => {
  it("takes the client a proxy forwarded, without a port", () => {
    expect(clientAddress("127.0.0.1:52010 forwarded 192.168.1.40")).toBe(
      "192.168.1.40",
    );
    // a chain of proxies lists the client first
    expect(
      clientAddress("127.0.0.1:52010 forwarded 203.0.113.9, 172.18.0.1"),
    ).toBe("203.0.113.9");
    expect(clientAddress("127.0.0.1:52010 forwarded 192.168.1.40:51544")).toBe(
      "192.168.1.40",
    );
    expect(clientAddress("127.0.0.1:52010 forwarded 2001:db8::7")).toBe(
      "2001:db8::7",
    );
  });

  it("falls back to the reader's own address", () => {
    expect(clientAddress("192.168.1.41:61000 host")).toBe("192.168.1.41");
    expect(clientAddress("[::ffff:192.168.1.41]:61000 prflx")).toBe(
      "192.168.1.41",
    );
    expect(clientAddress("127.0.0.1:52010 forwarded ")).toBe("127.0.0.1");
    expect(clientAddress(undefined)).toBe("");
  });

  it("keys a reader with neither by the reader itself", () => {
    const bare = { format_name: "mse/fmp4" };
    expect(clientKey(bare)).toBe(bare);
    expect(clientKey(BROWSER_MSE)).toBe(
      "192.168.1.40\nMozilla/5.0 (X11; Linux x86_64)",
    );
  });
});

describe("mergeCounts", () => {
  it("adds streams but counts a client on several streams once", () => {
    const merged = mergeCounts([
      countConsumers([FRIGATE_DETECT, BROWSER_MSE]),
      countConsumers([
        FRIGATE_DETECT,
        {
          ...BROWSER_MSE,
          remote_addr: "127.0.0.1:52020 forwarded 192.168.1.40",
        },
        HOME_ASSISTANT_RTSP,
      ]),
    ]);
    expect(merged.viewers).toBe(2);
    expect(merged.streams).toBe(3);
    expect(merged.internal).toBe(2);
    expect(merged.kinds).toMatchObject({ mse: 2, rtsp: 1 });
  });

  it("is all zero for no streams", () => {
    expect(mergeCounts([])).toMatchObject({
      viewers: 0,
      streams: 0,
      internal: 0,
    });
  });
});

describe("isRestreamInput", () => {
  it("matches go2rtc's restream on this machine", () => {
    expect(isRestreamInput("rtsp://127.0.0.1:8554/front_door")).toBe(true);
    expect(
      isRestreamInput(" rtsp://localhost:8554/front_door?video=copy"),
    ).toBe(true);
    expect(isRestreamInput("rtsps://[::1]:8554/front_door")).toBe(true);
    expect(isRestreamInput("rtsp://user:pass@127.0.0.1:8554/front_door")).toBe(
      true,
    );
  });

  it("rejects a camera read directly", () => {
    expect(isRestreamInput("rtsp://10.0.0.5:554/stream1")).toBe(false);
    expect(isRestreamInput("rtsp://127.0.0.1:554/stream1")).toBe(false);
    expect(isRestreamInput("/media/clip.mp4")).toBe(false);
  });
});

describe("telemetryCameras", () => {
  it("lists enabled cameras in UI order, without replay cameras", () => {
    const camera = (name: string, order: number, enabled = true) => ({
      name,
      enabled_in_config: enabled,
      ui: { order },
      ffmpeg: { inputs: [{ path: RESTREAM(name) }] },
    });
    const config: TelemetryConfig = {
      cameras: {
        garage: camera("garage", 2),
        driveway: camera("driveway", 1),
        backyard: camera("backyard", 1),
        attic: camera("attic", 0, false),
        _replay_front: camera("_replay_front", 0),
      },
    };

    expect(telemetryCameras(config)).toEqual([
      { name: "backyard", inputs: [RESTREAM("backyard")] },
      { name: "driveway", inputs: [RESTREAM("driveway")] },
      { name: "garage", inputs: [RESTREAM("garage")] },
    ]);
    expect(telemetryCameras(undefined)).toEqual([]);
  });
});

describe("buildCameraRows", () => {
  const frontDoor: TelemetryCamera = {
    name: "front_door",
    inputs: [RESTREAM("front_door")],
  };
  const cameras: TelemetryCamera[] = [
    frontDoor,
    {
      name: "driveway",
      inputs: [RESTREAM("driveway_sub"), "rtsp://10.0.0.7:554/main"],
    },
    { name: "garage", inputs: ["rtsp://10.0.0.8:554/main"] },
  ];
  const go2rtc = state({
    front_door: {
      streams: [
        streamState("front_door", { bytes_per_second: 500_000 }),
        streamState("front_door_sub", {
          bytes_per_second: 60_000,
          codecs: ["H264", "PCMA"],
        }),
      ],
    },
    driveway: {
      streams: [streamState("driveway_sub", { bytes_per_second: null })],
    },
    garage: {
      streams: [streamState("garage", { configured: false, codecs: [] })],
    },
  });
  const streams: Go2rtcStreamsResponse = {
    front_door: { consumers: [FRIGATE_DETECT, BROWSER_WEBRTC] },
    front_door_sub: { consumers: [BROWSER_MSE] },
    driveway_sub: { consumers: null },
  };

  it("sums a camera's streams and classifies how it is measured", () => {
    const rows = buildCameraRows(cameras, go2rtc, streams);
    const front = rowOf(rows, "front_door");
    const driveway = rowOf(rows, "driveway");
    const garage = rowOf(rows, "garage");

    expect(front).toMatchObject({
      camera: "front_door",
      status: "measured",
      streams: ["front_door", "front_door_sub"],
      bytesPerSecond: 560_000,
      codecs: ["H264", "AAC", "PCMA"],
    });
    expect(front.consumers?.viewers).toBe(2);
    expect(front.consumers?.streams).toBe(2);
    expect(front.consumers?.internal).toBe(1);

    // a direct input next to the restream: go2rtc sees only part of it
    expect(driveway.status).toBe("partial");
    expect(driveway.bytesPerSecond).toBeNull();
    expect(driveway.consumers?.viewers).toBe(0);

    // not configured in go2rtc: nothing to measure
    expect(garage).toEqual({
      camera: "garage",
      streams: [],
      status: "notMeasured",
      bytesPerSecond: null,
      codecs: [],
      consumers: null,
    });
  });

  it("leaves viewers unknown while the consumer list is unavailable", () => {
    const front = rowOf(
      buildCameraRows(cameras, go2rtc, undefined),
      "front_door",
    );
    expect(front.bytesPerSecond).toBe(560_000);
    expect(front.consumers).toBeNull();
  });

  it("counts a stream go2rtc did not list as unread", () => {
    const front = rowOf(buildCameraRows(cameras, go2rtc, {}), "front_door");
    expect(front.consumers?.viewers).toBe(0);
  });

  it("marks every camera unmeasured before go2rtc answers", () => {
    const rows = buildCameraRows(cameras, undefined, undefined);
    expect(rows.map((row) => row.status)).toEqual([
      "notMeasured",
      "notMeasured",
      "notMeasured",
    ]);
  });

  it("ignores a negative or non-finite rate", () => {
    const rows = buildCameraRows(
      [frontDoor],
      state({
        front_door: {
          streams: [
            streamState("front_door", { bytes_per_second: -1 }),
            streamState("front_door_sub", { bytes_per_second: Number.NaN }),
          ],
        },
      }),
      undefined,
    );
    expect(rowOf(rows, "front_door").bytesPerSecond).toBeNull();
  });
});

describe("telemetryTotals", () => {
  it("counts a stream two cameras share once", () => {
    const cameras: TelemetryCamera[] = [
      { name: "porch", inputs: [RESTREAM("porch")] },
      { name: "porch_zoom", inputs: [RESTREAM("porch")] },
      { name: "shed", inputs: ["rtsp://10.0.0.9/live"] },
    ];
    const go2rtc = state({
      porch: { streams: [streamState("porch", { bytes_per_second: 300_000 })] },
      porch_zoom: {
        streams: [streamState("porch", { bytes_per_second: 300_000 })],
      },
      shed: { streams: [streamState("shed", { configured: false })] },
    });
    const streams: Go2rtcStreamsResponse = {
      porch: { consumers: [FRIGATE_DETECT, BROWSER_MSE, HOME_ASSISTANT_RTSP] },
    };
    const rows = buildCameraRows(cameras, go2rtc, streams);
    const totals = telemetryTotals(rows, go2rtc, streams);

    expect(totals.bytesPerSecond).toBe(300_000);
    expect(totals.consumers?.viewers).toBe(2);
    expect(totals.consumers?.internal).toBe(1);
    expect(totals.measuredCameras).toBe(2);
    expect(totals.partialCameras).toBe(0);
    expect(totals.cameras).toBe(3);
  });

  it("counts one browser on a Live dashboard as one viewer", () => {
    const cameras: TelemetryCamera[] = [
      { name: "street", inputs: [RESTREAM("street")] },
      { name: "walkway", inputs: [RESTREAM("walkway")] },
    ];
    const go2rtc = state({
      street: { streams: [streamState("street")] },
      walkway: { streams: [streamState("walkway")] },
    });
    const streams: Go2rtcStreamsResponse = {
      street: { consumers: [FRIGATE_DETECT, BROWSER_MSE] },
      walkway: {
        consumers: [
          {
            ...BROWSER_MSE,
            remote_addr: "127.0.0.1:52030 forwarded 192.168.1.40",
          },
        ],
      },
    };
    const rows = buildCameraRows(cameras, go2rtc, streams);
    const totals = telemetryTotals(rows, go2rtc, streams);

    expect(totals.consumers?.viewers).toBe(1);
    expect(totals.consumers?.streams).toBe(2);
    expect(viewerKinds(totals.consumers)).toEqual([{ kind: "mse", count: 2 }]);
    // each camera's own count is its streams
    expect(rowOf(rows, "street").consumers?.streams).toBe(1);
    expect(rowOf(rows, "walkway").consumers?.streams).toBe(1);
    expect(telemetrySample(7, rows, totals).viewers).toBe(1);
  });

  it("keeps readers without an address or agent apart across streams", () => {
    const cameras: TelemetryCamera[] = [
      { name: "street", inputs: [RESTREAM("street")] },
      { name: "walkway", inputs: [RESTREAM("walkway")] },
    ];
    const go2rtc = state({
      street: { streams: [streamState("street")] },
      walkway: { streams: [streamState("walkway")] },
    });
    const streams: Go2rtcStreamsResponse = {
      street: { consumers: [{ format_name: "mse/fmp4" }] },
      walkway: { consumers: [{ format_name: "mse/fmp4" }] },
    };
    const totals = telemetryTotals(
      buildCameraRows(cameras, go2rtc, streams),
      go2rtc,
      streams,
    );
    expect(totals.consumers?.viewers).toBe(2);
    expect(totals.consumers?.streams).toBe(2);
  });

  it("has no rate or viewers before go2rtc answers", () => {
    const rows = buildCameraRows(
      [{ name: "porch", inputs: [] }],
      undefined,
      undefined,
    );
    expect(telemetryTotals(rows, undefined, undefined)).toEqual({
      bytesPerSecond: null,
      consumers: null,
      measuredCameras: 0,
      partialCameras: 0,
      cameras: 1,
    });
  });
});

describe("rolling window", () => {
  const sample = (t: number, value: number | null): TelemetrySample => ({
    t,
    bytesPerSecond: value,
    viewers: value === null ? null : 1,
    cameras: { porch: value },
  });

  it("keeps a repeated snapshot once", () => {
    const buffer = [sample(100, 1)];
    expect(appendSample(buffer, sample(100, 2))).toBe(buffer);
  });

  it("drops samples that fell out of the window", () => {
    let buffer: readonly TelemetrySample[] = [];
    for (const t of [0, 5, 10, 15, 20]) {
      buffer = appendSample(buffer, sample(t, t), 10);
    }
    expect(buffer.map((entry) => entry.t)).toEqual([10, 15, 20]);
  });

  it("starts over when the server clock moves back", () => {
    const buffer = [sample(100, 1), sample(105, 2)];
    expect(appendSample(buffer, sample(50, 3))).toEqual([sample(50, 3)]);
  });

  it("draws only the samples that have a value", () => {
    const buffer = [sample(0, 1), sample(5, null), sample(10, 3)];
    expect(sampleSeries(buffer, (entry) => entry.bytesPerSecond)).toEqual({
      values: [1, 3],
      times: [0, 10],
    });
    expect(sampleSeries(buffer, (entry) => entry.cameras["missing"])).toEqual({
      values: [],
      times: [],
    });
  });

  it("samples the totals and each camera of one read", () => {
    const rows = buildCameraRows(
      [{ name: "porch", inputs: [RESTREAM("porch")] }],
      state({ porch: { streams: [streamState("porch")] } }),
      { porch: { consumers: [BROWSER_MSE] } },
    );
    const totals = telemetryTotals(
      rows,
      state({ porch: { streams: [streamState("porch")] } }),
      { porch: { consumers: [BROWSER_MSE] } },
    );
    expect(telemetrySample(42, rows, totals)).toEqual({
      t: 42,
      bytesPerSecond: 250_000,
      viewers: 1,
      cameras: { porch: 250_000 },
    });
  });
});

describe("detector latency", () => {
  const stats = (
    lastUpdated: number,
    detectors: Record<string, number | undefined>,
  ): LatencyStatsSample => ({
    service: { last_updated: lastUpdated },
    detectors: Object.fromEntries(
      Object.entries(detectors).map(([name, speed]) => [
        name,
        speed === undefined ? {} : { inference_speed: speed },
      ]),
    ),
  });

  it("grades a speed against the detector graph's thresholds", () => {
    expect(latencyLevel(49.9)).toBe("ok");
    expect(latencyLevel(50)).toBe("warning");
    expect(latencyLevel(99.9)).toBe("warning");
    expect(latencyLevel(100)).toBe("error");
  });

  it("keeps each detector's speed inside the window", () => {
    const detectors = detectorLatencies(
      [
        stats(0, { coral: 9 }),
        stats(600, { coral: 8.5, openvino: 21 }),
        stats(615, { coral: 9.2, openvino: Number.NaN }),
        stats(630, { coral: 8.8, openvino: 64.2 }),
      ],
      300,
    );

    expect(detectors).toEqual([
      {
        name: "coral",
        latest: 8.8,
        level: "ok",
        series: { values: [8.5, 9.2, 8.8], times: [600, 615, 630] },
      },
      {
        name: "openvino",
        latest: 64.2,
        level: "warning",
        series: { values: [21, 64.2], times: [600, 630] },
      },
    ]);
    expect(worstLatencyLevel(detectors)).toBe("warning");
  });

  it("skips samples without a time and has nothing without history", () => {
    expect(detectorLatencies(undefined)).toEqual([]);
    expect(detectorLatencies([])).toEqual([]);
    expect(
      detectorLatencies([
        { detectors: { cpu: { inference_speed: 80 } } } as never,
      ]),
    ).toEqual([]);
  });

  it("calls the card by its worst detector", () => {
    const at = (level: "ok" | "warning" | "error") => ({
      name: level,
      latest: 1,
      level,
      series: { values: [], times: [] },
    });
    expect(worstLatencyLevel([])).toBe("ok");
    expect(worstLatencyLevel([at("ok"), at("error"), at("warning")])).toBe(
      "error",
    );
  });
});
