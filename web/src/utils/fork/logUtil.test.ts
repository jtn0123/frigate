import { describe, expect, it } from "vitest";
import { parseLogLines } from "@/utils/logUtil";

const PREFIX = "2024-05-01 12:00:00.000000000  ";

describe("parseLogLines for frigate", () => {
  it("parses a python log line", () => {
    expect(
      parseLogLines("frigate", [
        `${PREFIX}[2024-05-01 12:00:00] frigate.app                    INFO    : Starting Frigate (0.17.0)`,
        `${PREFIX}[2024-05-01 12:00:01] frigate.video                  ERROR   : front: Unable to read frames\u200bretrying`,
      ]),
    ).toEqual([
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "info",
        section: "frigate.app",
        content: "Starting Frigate (0.17.0)",
      },
      {
        dateStamp: "2024-05-01 12:00:01",
        severity: "error",
        section: "frigate.video",
        content: "front: Unable to read frames\nretrying",
      },
    ]);
  });

  it("parses s6 logging, startup and unknown lines", () => {
    expect(
      parseLogLines("frigate", [
        `${PREFIX}[LOGGING] level changed\u200bto debug`,
        `${PREFIX}[INFO] Preparing Frigate...`,
        `${PREFIX}something odd happened`,
      ]),
    ).toEqual([
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "info",
        section: "logging",
        content: "level changed\nto debug",
      },
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "info",
        section: "startup",
        content: "Preparing Frigate...",
      },
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "unknown",
        section: "unknown",
        content: "something odd happened",
      },
    ]);
  });
});

describe("parseLogLines for go2rtc", () => {
  it("reads the section and severity", () => {
    expect(
      parseLogLines("go2rtc", [
        `${PREFIX}12:00:00.000 INF [rtsp] listen addr=:8554`,
        `${PREFIX}12:00:00.000 ERR [streams] error=timeout`,
      ]),
    ).toEqual([
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "info",
        section: "rtsp",
        content: "listen addr=:8554",
      },
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "error",
        section: "streams",
        content: "error=timeout",
      },
    ]);
  });

  it("treats unsectioned lines as startup", () => {
    expect(
      parseLogLines("go2rtc", [
        `${PREFIX}[INFO] Preparing go2rtc config...`,
        `${PREFIX}12:00:00.000 WRN deprecated option`,
        "",
      ]),
    ).toEqual([
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "info",
        section: "startup",
        content: "Preparing go2rtc config...",
      },
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "warning",
        section: "startup",
        content: "deprecated option",
      },
    ]);
  });

  it("parses logging lines and defaults other severities to info", () => {
    expect(
      parseLogLines("go2rtc", [
        `${PREFIX}[LOGGING] go2rtc level debug`,
        `${PREFIX}12:00:00.000 DEB [exec] probing`,
      ]),
    ).toEqual([
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "info",
        section: "logging",
        content: "go2rtc level debug",
      },
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "info",
        section: "exec",
        content: "probing",
      },
    ]);
  });
});

describe("parseLogLines for nginx", () => {
  const TS = "2024-05-01 12:00:00.123456789 ";

  it("classifies logging, startup, error and request lines", () => {
    expect(
      parseLogLines("nginx", [
        `${TS}[LOGGING] nginx level info`,
        `${TS}[INFO] Starting NGINX...`,
        `${TS}2024/05/01 12:00:00 [error] 12#12: *1 connect() failed, client: 10.0.0.1, server: , request: "GET /api HTTP/1.1", upstream: "http://x"`,
        `${TS}10.0.0.1 - - [01/May/2024:12:00:00 +0000] "POST /api/events HTTP/1.1" 200 12`,
        `${TS}10.0.0.1 - - [01/May/2024:12:00:00 +0000] "HEAD / HTTP/1.1" 200 0`,
      ]),
    ).toEqual([
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "info",
        section: "logging",
        content: "nginx level info",
      },
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "info",
        section: "startup",
        content: "[INFO] Starting NGINX...",
      },
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "error",
        section: "error",
        content:
          '[error] 12#12: *1 connect() failed, client: 10.0.0.1, server: , request: "GET /api HTTP/1.1"',
      },
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "info",
        section: "POST",
        content: '"POST /api/events HTTP/1.1" 200 12',
      },
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "info",
        section: "META",
        content: '"HEAD / HTTP/1.1" 200 0',
      },
    ]);
  });

  it("keeps unmatched lines and drops blank ones", () => {
    expect(
      parseLogLines("nginx", [
        `${TS}worker process started`,
        "   ",
        "no timestamp [error] without request",
        "GET without quotes",
      ]),
    ).toEqual([
      {
        dateStamp: "2024-05-01 12:00:00",
        severity: "unknown",
        section: "unknown",
        content: "worker process started",
      },
      {
        dateStamp: "",
        severity: "error",
        section: "error",
        content: "no timestamp [error] without request",
      },
      {
        dateStamp: "",
        severity: "info",
        section: "GET",
        content: "GET without quotes",
      },
    ]);
  });
});

it("returns nothing for services without a parser", () => {
  expect(parseLogLines("websocket", ["anything"])).toEqual([]);
});
