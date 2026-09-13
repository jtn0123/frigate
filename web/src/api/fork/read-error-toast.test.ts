import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import {
  registerToaster,
  reportReadError,
  resetReadErrorCooldowns,
} from "./read-error-toast";

function httpError(status: number, message: string) {
  return { response: { status, data: { message } } };
}

describe("reportReadError", () => {
  beforeEach(() => {
    toastError.mockReset();
    resetReadErrorCooldowns();
    registerToaster();
  });

  it("does not toast a 404 for previews that do not exist yet", () => {
    reportReadError(
      httpError(404, "No previews found."),
      "preview/all/start/1789016400/end/1789106400",
    );
    reportReadError(
      httpError(404, "Preview not found"),
      '@"preview/front_door/start/1/end/2",',
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("does not toast a 404 when Explore has no matching review item", () => {
    reportReadError(
      httpError(404, "Review item not found"),
      "review/event/1789140562.067691-d0isz7",
    );
    reportReadError(
      httpError(404, "Review item not found"),
      '@"review/event/abc123",',
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("still toasts other failures of the preview endpoints", () => {
    reportReadError(
      httpError(500, "boom"),
      "preview/all/start/1789016400/end/1789106400",
    );
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("still toasts a 404 from other endpoints", () => {
    reportReadError(httpError(404, "Event not found"), "events/abc123");
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls.at(0)?.at(1)).toMatchObject({
      description: "Event not found",
    });
  });
});

describe("reportReadError bursts (UI47)", () => {
  beforeEach(() => {
    toastError.mockReset();
    resetReadErrorCooldowns();
    registerToaster();
  });

  it("shows one toast for several endpoints failing at once", () => {
    // Opening a recording used to stack one toast per failed endpoint over
    // the toolbar; they now share one id, so the newest replaces the rest.
    reportReadError(httpError(500, "down"), "recordings/unavailable");
    reportReadError(httpError(500, "down"), "review/activity/motion");
    reportReadError(httpError(500, "down"), "front_door/recordings");

    expect(toastError).toHaveBeenCalledTimes(3);
    const ids = new Set(
      toastError.mock.calls.map(
        (call) => (call[1] as { id?: string } | undefined)?.id,
      ),
    );
    expect(ids).toEqual(new Set(["fork-read-error"]));
  });
});
