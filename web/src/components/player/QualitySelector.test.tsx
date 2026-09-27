import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QualitySelectorContent } from "./QualitySelector";
import type { StreamMediaSummary } from "@/types/record";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { codec?: string; rate?: number }) =>
      [key, values?.codec, values?.rate].filter((v) => v != null).join(" "),
  }),
}));
afterEach(cleanup);
const media = (
  values: Partial<StreamMediaSummary> = {},
): StreamMediaSummary => ({
  video_codec: null,
  audio_codec: null,
  audio_rate: null,
  has_audio: null,
  bitrate: null,
  ...values,
});

it("selects every quality and marks the active choice", () => {
  const onSetQuality = vi.fn();
  render(<QualitySelectorContent quality="auto" onSetQuality={onSetQuality} />);
  for (const quality of ["auto", "main", "sub"]) {
    const button = screen.getByRole("button", { name: `quality.${quality}` });
    expect(button.getAttribute("aria-pressed")).toBe(
      String(quality === "auto"),
    );
    fireEvent.click(button);
    expect(onSetQuality).toHaveBeenLastCalledWith(quality);
  }
});
it.each([
  [
    { video_codec: "h264", audio_codec: "aac", audio_rate: 48000 },
    "H.264 · quality.audioCodecRate AAC 48",
  ],
  [{ video_codec: "hevc", has_audio: false }, "H.265 · quality.noAudio"],
  [{ video_codec: "av1", audio_codec: "opus" }, "AV1 · Opus"],
  [{ video_codec: "vp9", audio_codec: "flac" }, "VP9 · FLAC"],
  [{ audio_rate: 16000 }, "quality.audioRate 16"],
  [{ audio_codec: "pcm_alaw" }, "PCM-A"],
  [{ audio_codec: "pcm_mulaw" }, "PCM-U"],
  [{ audio_codec: "mp3" }, "MP3"],
  [{ video_codec: "h265" }, "H.265"],
  [{}, undefined],
] satisfies [Partial<StreamMediaSummary>, string | undefined][])(
  "describes stream media %j",
  (summary, expected) => {
    render(
      <QualitySelectorContent
        quality="main"
        onSetQuality={vi.fn()}
        streams={{ main: media(summary) }}
      />,
    );
    const button = screen.getByRole("button", { name: /^quality.main/ });
    expect(button.textContent).toBe(`quality.main${expected ?? ""}`);
    expect(
      screen.getByRole("button", { name: /^quality.sub/ }).textContent,
    ).toContain("quality.noRecordings");
  },
);
it.each([
  ["codec", "quality.autoLowCodec"],
  ["saveData", "quality.autoLowSaveData"],
  [undefined, "quality.autoLow"],
] as const)("explains auto quality reason %s", (reason, text) => {
  render(
    <QualitySelectorContent
      quality="auto"
      onSetQuality={vi.fn()}
      autoLow
      autoLowReason={reason}
      mainUnsupported
      streams={{ main: media(), sub: media() }}
    />,
  );
  expect(screen.getByText(text)).toBeTruthy();
  expect(screen.getByText("quality.notSupportedBrowser")).toBeTruthy();
});
it("reports missing main footage before browser compatibility", () => {
  render(
    <QualitySelectorContent
      quality="main"
      onSetQuality={vi.fn()}
      streams={{ sub: media() }}
      mainUnsupported
    />,
  );
  expect(
    screen.getByRole("button", { name: /^quality.main/ }).textContent,
  ).toContain("quality.noRecordings");
});
