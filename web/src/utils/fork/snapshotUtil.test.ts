import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadSnapshot,
  fetchCameraSnapshot,
  generateSnapshotFilename,
  grabVideoSnapshot,
} from "@/utils/snapshotUtil";

const asContext = (value: unknown) => value as CanvasRenderingContext2D;
const asResponse = (value: unknown) => value as Response;

// A real Response's blob() is Node's Blob, which jsdom's FileReader rejects on
// Node 22 (CI), so the stub hands back a jsdom Blob instead.
function jpegResponse(body: string[], init: ResponseInit = {}) {
  const headers = new Headers({
    "content-type": "image/jpeg",
    ...(init.headers as Record<string, string> | undefined),
  });
  const status = init.status ?? 200;
  return asResponse({
    ok: status >= 200 && status < 300,
    status,
    headers,
    blob: async () =>
      new Blob(body, { type: headers.get("content-type") ?? "" }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("fetchCameraSnapshot", () => {
  it("requests the encoded latest.jpg without caching", async () => {
    const fetchMock = vi.fn(async () =>
      jpegResponse(["abc"], { headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCameraSnapshot("front door");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/api\/front%20door\/latest\.jpg$/),
      { method: "GET", cache: "no-store", credentials: "same-origin" },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contentType).toBe("image/png");
      expect(result.data.dataUrl).toMatch(/^data:image\/png;base64,/);
      expect(result.data.blob.size).toBe(3);
    }
  });

  it("defaults the content type to jpeg", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = jpegResponse(["abc"]);
        response.headers.delete("content-type");
        return response;
      }),
    );
    const result = await fetchCameraSnapshot("front");
    expect(result.success && result.data.contentType).toBe("image/jpeg");
  });

  it("reports the status of a failed request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jpegResponse([], { status: 404 })),
    );
    expect(await fetchCameraSnapshot("front")).toEqual({
      success: false,
      error: "Snapshot request failed with status 404",
    });
  });

  it("rejects an empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jpegResponse([])),
    );
    expect(await fetchCameraSnapshot("front")).toEqual({
      success: false,
      error: "Snapshot response was empty",
    });
  });

  it("returns thrown error messages and a generic message otherwise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await fetchCameraSnapshot("front")).toEqual({
      success: false,
      error: "offline",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "boom";
      }),
    );
    expect(await fetchCameraSnapshot("front")).toEqual({
      success: false,
      error: "Unknown error occurred",
    });
  });

  it("fails when the reader produces no string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jpegResponse(["abc"])),
    );
    class NullReader {
      result: unknown = null;
      error: DOMException | null = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        queueMicrotask(() => this.onloadend?.());
      }
    }
    vi.stubGlobal("FileReader", NullReader);
    expect(await fetchCameraSnapshot("front")).toEqual({
      success: false,
      error: "Failed to convert blob to data URL",
    });
  });

  it("surfaces reader errors with a fallback message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jpegResponse(["abc"])),
    );
    class FailingReader {
      result: unknown = null;
      error: DOMException | null = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("FileReader", FailingReader);
    expect(await fetchCameraSnapshot("front")).toEqual({
      success: false,
      error: "Failed to read snapshot blob",
    });
  });
});

describe("downloadSnapshot", () => {
  it("clicks a temporary link with the filename and removes it", () => {
    const clicks: HTMLAnchorElement[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push(this);
        expect(document.body.contains(this)).toBe(true);
      });

    downloadSnapshot("data:image/jpeg;base64,AAA", "front.jpg");

    expect(click).toHaveBeenCalledOnce();
    expect(clicks[0]?.download).toBe("front.jpg");
    expect(clicks[0]?.href).toBe("data:image/jpeg;base64,AAA");
    expect(document.querySelector("a")).toBeNull();
  });

  it("logs instead of throwing when the download fails", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("blocked");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => downloadSnapshot("data:,", "x.jpg")).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      "Failed to download snapshot for x.jpg:",
      expect.any(Error),
    );
  });
});

describe("generateSnapshotFilename", () => {
  it("uses the playback timestamp when given", () => {
    expect(generateSnapshotFilename("front", 1_700_000_000)).toBe(
      "front_snapshot_2023-11-14T22-13-20.jpg",
    );
  });

  it("uses the current time otherwise", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.678Z"));
    try {
      expect(generateSnapshotFilename("back")).toBe(
        "back_snapshot_2026-01-02T03-04-05.jpg",
      );
      expect(generateSnapshotFilename("back", Number.NaN)).toBe(
        "back_snapshot_2026-01-02T03-04-05.jpg",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("grabVideoSnapshot", () => {
  function video(width: number, height: number) {
    const element = document.createElement("video");
    Object.defineProperty(element, "videoWidth", { value: width });
    Object.defineProperty(element, "videoHeight", { value: height });
    return element;
  }

  it("fails when no player video is on the page", async () => {
    expect(await grabVideoSnapshot()).toEqual({
      success: false,
      error: "Video element not found",
    });
  });

  it("fails when the video has not loaded dimensions", async () => {
    expect(await grabVideoSnapshot(video(0, 480))).toEqual({
      success: false,
      error: "Video element has no dimensions",
    });
  });

  it("fails without a 2d context", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(await grabVideoSnapshot(video(640, 480))).toEqual({
      success: false,
      error: "Failed to get canvas context",
    });
  });

  it("draws the frame from the player container into a jpeg", async () => {
    const container = document.createElement("div");
    container.id = "player-container";
    const element = video(640, 480);
    container.appendChild(element);
    document.body.appendChild(container);

    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      asContext({
        drawImage,
      }),
    );
    const toDataURL = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/jpeg;base64,AAA");
    const fetchMock = vi.fn(async () => new Response("x"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await grabVideoSnapshot();

    expect(drawImage).toHaveBeenCalledWith(element, 0, 0, 640, 480);
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.9);
    expect(fetchMock).toHaveBeenCalledWith("data:image/jpeg;base64,AAA");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dataUrl).toBe("data:image/jpeg;base64,AAA");
      expect(result.data.contentType).toBe("image/jpeg");
      expect(result.data.blob.size).toBe(1);
    }
  });

  it("returns the error when drawing throws", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      asContext({
        drawImage: () => {
          throw new Error("tainted");
        },
      }),
    );
    expect(await grabVideoSnapshot(video(10, 10))).toEqual({
      success: false,
      error: "tainted",
    });
  });

  it("uses a generic message for non-error throws", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => {
        throw "nope";
      },
    );
    expect(await grabVideoSnapshot(video(10, 10))).toEqual({
      success: false,
      error: "Unknown error occurred",
    });
  });
});
