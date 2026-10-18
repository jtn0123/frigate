import { act, fireEvent, render, screen } from "@testing-library/react";
import type { FieldProps } from "@rjsf/utils";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveStreamsField } from "./LiveStreamsField";

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("axios", () => ({ default: { get: http.get } }));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    i18n: { language: "en-US" },
    t: (key: string, options?: Record<string, unknown>) =>
      options?.kbps === undefined ? key : `${key}:${String(options.kbps)}`,
  }),
}));

const PATH = ["live", "streams"];
const fieldProps = (value: unknown) => value as FieldProps;

type Streams = Record<string, string>;

function setup(
  initial: unknown,
  { camera = "front", transcode = undefined as unknown, disabled = false } = {},
) {
  const changes: Streams[] = [];
  let setCamera: (camera: string) => void = () => {};
  let setStreams: (streams: Streams) => void = () => {};

  function Harness() {
    const [formData, setFormData] = useState(initial);
    const [cameraName, setCameraName] = useState(camera);
    setCamera = setCameraName;
    setStreams = setFormData;
    return (
      <LiveStreamsField
        {...fieldProps({
          schema: { title: "Streams" },
          name: "streams",
          formData,
          disabled,
          readonly: false,
          idSchema: { $id: "root_streams" },
          fieldPathId: { path: PATH },
          onChange: (next: Streams) => {
            changes.push(next);
            setFormData(next);
          },
          registry: {
            formContext: {
              cameraName,
              level: "camera",
              t: () => undefined,
              formData: { transcode },
              fullConfig: {
                go2rtc: { streams: { front_main: [], front_sub: [] } },
              },
            },
          },
        })}
      />
    );
  }

  render(<Harness />);
  return {
    changes,
    switchCamera: (name: string) => act(() => setCamera(name)),
    edit: (streams: Streams) => act(() => setStreams(streams)),
  };
}

const autoOrder = () =>
  screen.getByRole("button", { name: /configForm.liveStreams.autoOrder/ });

function deferBitrates() {
  const pending: { name: string; settle: () => void }[] = [];
  http.get.mockImplementation(
    (url: string) =>
      new Promise((resolve, reject) => {
        const name = decodeURIComponent(url.split("/")[2]);
        pending.push({
          name,
          settle: () =>
            name === "front_main"
              ? resolve({ data: { kbps: 4000 } })
              : reject(new Error("unreachable")),
        });
      }),
  );
  return async () => {
    await act(async () => {
      pending.forEach(({ settle }) => settle());
      await Promise.resolve();
    });
  };
}

afterEach(() => {
  http.get.mockReset();
});

describe("LiveStreamsField", () => {
  it("treats a non-object value as no streams", () => {
    setup(["front_main"]);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(autoOrder()).toBeDisabled();
  });

  it("sorts by measured and set bitrate, failures last", async () => {
    http.get.mockImplementation((url: string) =>
      url.includes("front_main")
        ? Promise.resolve({ data: { kbps: 4000 } })
        : Promise.reject(new Error("unreachable")),
    );
    const { changes } = setup(
      { Sub: "front_sub", Low: "front_transcode_480p", Main: "front_main" },
      {
        transcode: {
          enabled: true,
          source: "front_main",
          qualities: [{ height: 480, bitrate: 500 }],
        },
      },
    );
    expect(screen.getByText("configForm.liveStreams.transcodedBadge"));

    await act(async () => {
      fireEvent.click(autoOrder());
    });

    expect(Object.keys(changes.at(-1)!)).toEqual(["Main", "Low", "Sub"]);
    expect(
      screen.getByText("configForm.liveStreams.rate:4000"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("configForm.liveStreams.rateSet:500"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("configForm.liveStreams.rateFailed"),
    ).toBeInTheDocument();
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  it("leaves an already sorted list alone", async () => {
    http.get.mockResolvedValue({ data: { kbps: 100 } });
    const { changes } = setup({ Main: "front_main", Sub: "front_sub" });
    await act(async () => {
      fireEvent.click(autoOrder());
    });
    expect(changes).toEqual([]);
  });

  it("drops the result when the camera changes while measuring", async () => {
    const settle = deferBitrates();
    const { changes, switchCamera } = setup({
      Sub: "front_sub",
      Main: "front_main",
    });
    fireEvent.click(autoOrder());
    expect(
      screen.getByText("configForm.liveStreams.measuring"),
    ).toBeInTheDocument();
    switchCamera("back");
    await settle();
    expect(changes).toEqual([]);
    expect(
      screen.getByText("configForm.liveStreams.autoOrder"),
    ).toBeInTheDocument();
  });

  it("keeps rows added while measuring after the sorted ones", async () => {
    const settle = deferBitrates();
    const { changes, edit } = setup({ Sub: "front_sub", Main: "front_main" });
    fireEvent.click(autoOrder());
    edit({ Sub: "front_sub", Main: "front_main", Extra: "front_main" });
    await settle();
    expect(Object.keys(changes.at(-1)!)).toEqual(["Main", "Sub", "Extra"]);
    // rates describe the streams as measured, so a later edit hides them
    expect(
      screen.getAllByText("configForm.liveStreams.rate:4000"),
    ).toHaveLength(2);
    edit({ Main: "front_sub" });
    expect(
      screen.queryByText("configForm.liveStreams.rate:4000"),
    ).not.toBeInTheDocument();
  });

  it("adds and removes streams", () => {
    const { changes } = setup({ Main: "front_main" });
    fireEvent.click(
      screen.getByRole("button", { name: /configForm.liveStreams.addStream/ }),
    );
    expect(changes.at(-1)).toEqual({ Main: "front_main", "": "" });

    fireEvent.click(
      screen.getAllByRole("button", { name: "button.delete" })[0],
    );
    expect(changes.at(-1)).toEqual({ "": "" });
  });

  it("locks the controls while disabled", () => {
    setup({ Main: "front_main", Sub: "front_sub" }, { disabled: true });
    expect(autoOrder()).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /configForm.liveStreams.addStream/ }),
    ).toBeDisabled();
  });
});
