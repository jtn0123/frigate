import { describe, expect, it } from "vitest";
import {
  hasCredentials,
  isMaskedPath,
  maskCredentials,
} from "@/utils/credentialMask";

// Upstream #24719: the settings UI must mask and detect the same credential
// forms as clean_camera_user_pass, or a save writes the mask back over the
// real credential.
describe("credentialMask", () => {
  const cases: Array<[string, string]> = [
    [
      "rtsp://first.last@mail.com:p%40w@10.0.0.2/live",
      "rtsp://*:*@10.0.0.2/live",
    ],
    ["rtsp://:pw@10.0.0.2/live", "rtsp://*:*@10.0.0.2/live"],
    ["tapo://cloudpassword@10.0.0.2", "tapo://*:*@10.0.0.2"],
    ["rtsp://admin:2024/pw@10.0.0.2/x", "rtsp://*:*@10.0.0.2/x"],
    ["rtsp://10.0.0.2:554/live?password=pre@suf", "rtsp://*:*@"],
    [
      "http://h/cgi?password=x&user=admin&channel=1",
      "http://h/cgi?password=*&user=*&channel=1",
    ],
    ["ring:?refresh_token=abc.def", "ring:?refresh_token=*"],
    [
      "nest:?client_id=1&client_secret=s&refresh_token=t&project_id=p",
      "nest:?client_id=1&client_secret=*&refresh_token=*&project_id=p",
    ],
  ];

  it.each(cases)("masks %s", (path, expected) => {
    const masked = maskCredentials(path);
    expect(masked).toBe(expected);
    expect(isMaskedPath(masked)).toBe(true);
    expect(hasCredentials(path)).toBe(true);
    expect(maskCredentials(masked)).toBe(masked);
  });

  it.each([
    "rtsp://10.0.0.2:554/live",
    "ffmpeg:front_door#video=copy",
    "http://10.0.0.1/snap.jpg?email=me@x.com",
    "http://h/x?auth=a&author=b&private=1",
  ])("leaves %s alone", (path) => {
    expect(maskCredentials(path)).toBe(path);
    expect(isMaskedPath(path)).toBe(false);
    expect(hasCredentials(path)).toBe(false);
  });
});
