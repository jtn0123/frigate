import { fireEvent, render, screen } from "@testing-library/react";
import type { FieldProps } from "@rjsf/utils";
import { describe, expect, it, vi } from "vitest";
import type { LiveTranscodeConfig } from "@/types/frigateConfig";
import { LiveTranscodeField } from "./LiveTranscodeField";

const PATH = ["live", "transcode"];

function setup(
  formData: Partial<LiveTranscodeConfig> | undefined,
  {
    go2rtc = ["front_main", "front_sub"],
    baselineSource = null as string | null,
    disabled = false,
  } = {},
) {
  const onChange = vi.fn<(value: unknown, path: string[]) => void>();
  const props = {
    formData: formData && {
      enabled: false,
      source: null,
      qualities: [],
      ...formData,
    },
    onChange,
    disabled,
    readonly: false,
    idSchema: { $id: "root_transcode" },
    fieldPathId: { path: PATH },
    registry: {
      formContext: {
        cameraName: "front",
        formData: { streams: { Main: "front_main", Sub: "front_sub" } },
        fullConfig: {
          go2rtc: {
            streams: Object.fromEntries(go2rtc.map((name) => [name, []])),
          },
        },
        baselineFormData: { live: { transcode: { source: baselineSource } } },
      },
    },
  };
  const fieldProps = (value: unknown) => value as FieldProps;
  render(<LiveTranscodeField {...fieldProps(props)} />);
  const transcodeChange = () =>
    onChange.mock.calls.find(
      ([, path]) => path === PATH,
    )?.[0] as LiveTranscodeConfig;
  const streamsChange = () =>
    onChange.mock.calls.find(
      ([, path]) => path.join(".") === "live.streams",
    )?.[0] as Record<string, string>;
  return { onChange, transcodeChange, streamsChange };
}

const enabled = {
  enabled: true,
  source: "front_main",
  qualities: [{ height: 480, bitrate: 500 }],
};

describe("LiveTranscodeField", () => {
  it("explains and locks the switch without a go2rtc stream", () => {
    setup(undefined, { go2rtc: [] });
    expect(
      screen.getByText("configForm.liveTranscode.unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("pins the first source when turned on", () => {
    const { transcodeChange, streamsChange } = setup({});
    fireEvent.click(screen.getByRole("switch"));
    expect(transcodeChange()).toMatchObject({
      enabled: true,
      source: "front_main",
    });
    expect(streamsChange()).toEqual({ Main: "front_main", Sub: "front_sub" });
  });

  it("restores the saved source when turned off", () => {
    const { transcodeChange, streamsChange } = setup(enabled, {
      baselineSource: "front_sub",
    });
    fireEvent.click(screen.getByRole("switch"));
    expect(transcodeChange()).toMatchObject({
      enabled: false,
      source: "front_sub",
    });
    expect(streamsChange()).toEqual({ Main: "front_main", Sub: "front_sub" });
  });

  it("adds the next unused height with its default bitrate", () => {
    const { transcodeChange, streamsChange } = setup(enabled);
    fireEvent.click(
      screen.getByRole("button", {
        name: /configForm.liveTranscode.addQuality/,
      }),
    );
    expect(transcodeChange().qualities).toEqual([
      { height: 480, bitrate: 500 },
      { height: 1080, bitrate: 2500 },
    ]);
    expect(streamsChange()).toMatchObject({
      "480p": "front_transcode_480p",
      "1080p": "front_transcode_1080p",
    });
  });

  it("disables adding once every height is used", () => {
    setup({
      ...enabled,
      qualities: [1080, 720, 480, 360, 240].map((height) => ({
        height,
        bitrate: 500,
      })),
    });
    expect(
      screen.getByRole("button", {
        name: /configForm.liveTranscode.addQuality/,
      }),
    ).toBeDisabled();
  });

  it("removes a quality", () => {
    const { transcodeChange } = setup(enabled);
    fireEvent.click(
      screen.getByRole("button", {
        name: "configForm.liveTranscode.removeQuality",
      }),
    );
    expect(transcodeChange().qualities).toEqual([]);
  });

  it("updates the bitrate but ignores an empty input", () => {
    const { onChange, transcodeChange } = setup(enabled);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "750" } });
    expect(transcodeChange().qualities).toEqual([
      { height: 480, bitrate: 750 },
    ]);
  });

  it("locks every control while the form is disabled", () => {
    setup(enabled, { disabled: true });
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("spinbutton")).toBeDisabled();
  });
});
