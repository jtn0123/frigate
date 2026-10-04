import { describe, expect, it } from "vitest";
import {
  ACTIVE_NOW_SECONDS,
  groupSessionsByUser,
  isActiveNow,
  isPrivateAddress,
  otherSessions,
  parseUserAgent,
  sessionAge,
  sharedProxyAddress,
  sortSessions,
} from "./sessions";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const CHROME_ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.65";
const SAFARI_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
const HA_INTEGRATION = "HomeAssistant/2024.10.1 aiohttp/3.10.5 Python/3.12";
const HA_IOS_APP =
  "Home Assistant/2024.10 (io.robbie.HomeAssistant; build:2024.1077; iOS 18.0.0) Mobile/HomeAssistant, like Safari";
const HA_ANDROID_APP = "Home Assistant/2024.10.1-full (Android 14; SM-S928B)";

describe("parseUserAgent", () => {
  it.each([
    [CHROME_MAC, { kind: "desktop", browser: "Chrome", os: "macOS" }],
    [SAFARI_IPHONE, { kind: "phone", browser: "Safari", os: "iOS" }],
    [CHROME_ANDROID, { kind: "phone", browser: "Chrome", os: "Android" }],
    [
      CHROME_ANDROID_TABLET,
      { kind: "tablet", browser: "Chrome", os: "Android" },
    ],
    [FIREFOX_WINDOWS, { kind: "desktop", browser: "Firefox", os: "Windows" }],
    [EDGE_WINDOWS, { kind: "desktop", browser: "Edge", os: "Windows" }],
    [SAFARI_IPAD, { kind: "tablet", browser: "Safari", os: "iPadOS" }],
  ])("names the browser and system of %s", (ua, expected) => {
    expect(parseUserAgent(ua)).toEqual(expected);
  });

  it("names Home Assistant clients as apps", () => {
    expect(parseUserAgent(HA_INTEGRATION)).toEqual({
      kind: "app",
      app: "Home Assistant",
    });
    expect(parseUserAgent(HA_IOS_APP)).toEqual({
      kind: "app",
      app: "Home Assistant",
      os: "iOS",
    });
    expect(parseUserAgent(HA_ANDROID_APP)).toEqual({
      kind: "app",
      app: "Home Assistant",
      os: "Android",
    });
  });

  it("names scripts and other programs", () => {
    expect(parseUserAgent("python-requests/2.32.3")).toEqual({
      kind: "app",
      app: "Python requests",
    });
    expect(parseUserAgent("curl/8.7.1")).toEqual({ kind: "app", app: "curl" });
    expect(parseUserAgent("Frigate-Exporter/1.2")).toEqual({
      kind: "app",
      app: "Frigate-Exporter",
    });
  });

  it("names Node.js clients by either token", () => {
    expect(parseUserAgent("node")).toEqual({ kind: "app", app: "Node.js" });
    expect(parseUserAgent("my-tool axios/1.7.7")).toEqual({
      kind: "app",
      app: "Node.js",
    });
  });

  it("names Safari only when its version comes before the Safari token", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
      ),
    ).toEqual({ kind: "desktop", browser: "Safari", os: "macOS" });
    expect(
      parseUserAgent("Mozilla/5.0 (Macintosh) Safari/605.1.15 Version/17.6"),
    ).toEqual({ kind: "desktop", os: "macOS" });
  });

  it("reads a long hostile user agent", () => {
    const ua = `Mozilla/5.0 ${"Version/1.".repeat(20000)}`;
    expect(parseUserAgent(ua)).toEqual({ kind: "desktop" });
  });

  it("reports an empty or unreadable user agent as unknown", () => {
    expect(parseUserAgent("")).toEqual({ kind: "unknown" });
    expect(parseUserAgent(undefined)).toEqual({ kind: "unknown" });
    expect(parseUserAgent("   ")).toEqual({ kind: "unknown" });
    expect(parseUserAgent("???")).toEqual({ kind: "unknown" });
  });

  it("keeps a browser without a known name", () => {
    expect(parseUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toEqual({
      kind: "desktop",
      os: "Linux",
    });
  });
});

describe("isActiveNow", () => {
  it("counts recent activity as now", () => {
    expect(isActiveNow(1000, 1000)).toBe(true);
    expect(isActiveNow(1000, 1000 + ACTIVE_NOW_SECONDS - 1)).toBe(true);
    expect(isActiveNow(1000, 1000 + ACTIVE_NOW_SECONDS)).toBe(false);
  });
});

describe("sessionAge", () => {
  it("reads recent times as now", () => {
    expect(sessionAge(1000, 1000)).toEqual({ unit: "now" });
    expect(sessionAge(1000, 1059)).toEqual({ unit: "now" });
    expect(sessionAge(1000, 1000 + 119, ACTIVE_NOW_SECONDS)).toEqual({
      unit: "now",
    });
  });

  it("reads a time slightly in the future as now", () => {
    expect(sessionAge(1010, 1000)).toEqual({ unit: "now" });
  });

  it("uses the largest whole unit", () => {
    expect(sessionAge(0, 60)).toEqual({ unit: "minutes", count: 1 });
    expect(sessionAge(0, 3599)).toEqual({ unit: "minutes", count: 59 });
    expect(sessionAge(0, 3600)).toEqual({ unit: "hours", count: 1 });
    expect(sessionAge(0, 86399)).toEqual({ unit: "hours", count: 23 });
    expect(sessionAge(0, 86400)).toEqual({ unit: "days", count: 1 });
    expect(sessionAge(0, 86400 * 9.5)).toEqual({ unit: "days", count: 9 });
  });

  it("counts at least one minute past the now window", () => {
    expect(sessionAge(0, 150, ACTIVE_NOW_SECONDS)).toEqual({
      unit: "minutes",
      count: 2,
    });
    expect(sessionAge(0, 30, 10)).toEqual({ unit: "minutes", count: 1 });
  });
});

const session = (
  id: string,
  username: string,
  last_seen: number,
  current = false,
) => ({ id, username, last_seen, current });

describe("sortSessions", () => {
  it("puts the current session first, then the most recent", () => {
    const sorted = sortSessions([
      session("old", "bob", 10),
      session("new", "bob", 30),
      session("mine", "bob", 5, true),
    ]);

    expect(sorted.map((s) => s.id)).toEqual(["mine", "new", "old"]);
  });

  it("does not change its input", () => {
    const input = [session("a", "bob", 1), session("b", "bob", 2)];
    sortSessions(input);

    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("groupSessionsByUser", () => {
  it("lists the signed-in user first, then everyone by name", () => {
    const groups = groupSessionsByUser(
      [
        session("z1", "zoe", 50),
        session("a1", "admin", 10, true),
        session("b1", "bob", 40),
        session("b2", "bob", 60),
      ],
      "admin",
    );

    expect(groups.map((g) => g.username)).toEqual(["admin", "bob", "zoe"]);
    expect(groups.at(1)?.sessions.map((s) => s.id)).toEqual(["b2", "b1"]);
  });

  it("orders by name when the signed-in user has no session", () => {
    const groups = groupSessionsByUser(
      [session("c", "carol", 1), session("a", "alice", 1)],
      undefined,
    );

    expect(groups.map((g) => g.username)).toEqual(["alice", "carol"]);
  });
});

describe("otherSessions", () => {
  it("leaves out the current session", () => {
    const others = otherSessions([
      session("mine", "bob", 1, true),
      session("phone", "bob", 2),
    ]);

    expect(others.map((s) => s.id)).toEqual(["phone"]);
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "10.1.2.3",
    "127.0.0.1",
    "169.254.10.1",
    "172.16.0.1",
    "172.22.0.1",
    "172.31.255.254",
    "192.168.1.20",
    "100.64.0.1",
    "::ffff:172.17.0.1",
    "::1",
    "fd00::1",
    "fc12:3456::1",
    "fe80::1",
  ])("treats %s as a local network address", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.1.1",
    "100.128.0.1",
    "203.0.113.9",
    "2001:db8::1",
    "",
  ])("treats %s as a public address", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("sharedProxyAddress", () => {
  it("names the private address every session shares", () => {
    expect(
      sharedProxyAddress([{ ip: "172.22.0.1" }, { ip: "172.22.0.1" }]),
    ).toBe("172.22.0.1");
  });

  it("says nothing for one session, mixed or public addresses", () => {
    expect(sharedProxyAddress([])).toBeNull();
    expect(sharedProxyAddress([{ ip: "172.22.0.1" }])).toBeNull();
    expect(
      sharedProxyAddress([{ ip: "172.22.0.1" }, { ip: "192.168.1.20" }]),
    ).toBeNull();
    expect(
      sharedProxyAddress([{ ip: "203.0.113.9" }, { ip: "203.0.113.9" }]),
    ).toBeNull();
    expect(sharedProxyAddress([{ ip: "" }, { ip: "" }])).toBeNull();
  });
});
