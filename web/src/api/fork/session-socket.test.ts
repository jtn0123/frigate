import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRedirectingToLogin,
  setRedirectingToLogin,
} from "@/api/auth-redirect";
import {
  SESSION_CHECK_DELAY_MS,
  SESSION_ENDED_CLOSE_CODE,
  leaveIfSignedOut,
  linkPushSubscription,
  watchSession,
} from "./session-socket";

const mocks = vi.hoisted(() => ({
  get: vi.fn<(url: string) => Promise<unknown>>(),
  put: vi.fn<(url: string, body: unknown) => Promise<unknown>>(),
  isForkEnabled: vi.fn<(flag: string) => boolean>(),
}));

vi.mock("axios", () => ({
  default: {
    get: (url: string) => mocks.get(url),
    put: (url: string, body: unknown) => mocks.put(url, body),
    isAxiosError: (error: unknown) =>
      typeof error === "object" && error !== null && "response" in error,
  },
}));
vi.mock("@/fork/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/fork/flags")>()),
  isForkEnabled: mocks.isForkEnabled,
}));

const SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  keys: { p256dh: "key", auth: "secret" },
};

function unauthorized() {
  return Promise.reject(
    Object.assign(new Error("401"), { response: { status: 401 } }),
  );
}

function serviceWorkers(subscription: unknown) {
  const getRegistration = vi.fn().mockResolvedValue({
    pushManager: {
      getSubscription: vi
        .fn()
        .mockResolvedValue(
          subscription === null ? null : { toJSON: () => subscription },
        ),
    },
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration },
  });
  return getRegistration;
}

describe("leaveIfSignedOut", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    setRedirectingToLogin(false);
  });

  it("goes to the login page once the profile says signed out", async () => {
    mocks.get.mockImplementation(unauthorized);
    const navigate = vi.fn();

    await leaveIfSignedOut(navigate);

    expect(mocks.get).toHaveBeenCalledWith("profile");
    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/\/login$/));
    expect(isRedirectingToLogin()).toBe(true);

    // a second socket closing at the same time does not navigate again
    await leaveIfSignedOut(navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("stays when still signed in, as after a password change here", async () => {
    mocks.get.mockResolvedValue({ data: { username: "bob" } });
    const navigate = vi.fn();

    await leaveIfSignedOut(navigate);

    expect(navigate).not.toHaveBeenCalled();
  });

  it("stays when the server cannot be reached", async () => {
    mocks.get.mockRejectedValue(new Error("Network Error"));
    const navigate = vi.fn();

    await leaveIfSignedOut(navigate);

    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("linkPushSubscription", () => {
  beforeEach(() => {
    mocks.put.mockReset().mockResolvedValue({ data: { linked: true } });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("sends this browser's subscription to be tied to the session", async () => {
    const getRegistration = serviceWorkers(SUBSCRIPTION);

    await linkPushSubscription();

    expect(getRegistration).toHaveBeenCalledWith("/notifications-worker.js");
    expect(mocks.put).toHaveBeenCalledWith("fork/sessions/push", {
      sub: SUBSCRIPTION,
    });
  });

  it("sends nothing without a subscription or service workers", async () => {
    serviceWorkers(null);
    await linkPushSubscription();

    Reflect.deleteProperty(navigator, "serviceWorker");
    await linkPushSubscription();

    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("keeps quiet when the request fails", async () => {
    serviceWorkers(SUBSCRIPTION);
    mocks.put.mockRejectedValue(new Error("Network Error"));

    await expect(linkPushSubscription()).resolves.toBeUndefined();
  });
});

describe("watchSession", () => {
  let socket: EventTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.get.mockReset().mockResolvedValue({ data: {} });
    mocks.put.mockReset().mockResolvedValue({ data: {} });
    mocks.isForkEnabled.mockReturnValue(true);
    socket = new EventTarget();
    serviceWorkers(SUBSCRIPTION);
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  function close(code: number) {
    socket.dispatchEvent(Object.assign(new Event("close"), { code }));
  }

  it("checks the sign-in a moment after the server ends the session", async () => {
    watchSession(socket as WebSocket);

    close(SESSION_ENDED_CLOSE_CODE);
    expect(mocks.get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_DELAY_MS);

    expect(mocks.get).toHaveBeenCalledWith("profile");
  });

  it("leaves any other close to the reconnects", async () => {
    watchSession(socket as WebSocket);

    close(1006);
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_DELAY_MS * 2);

    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("ties the push subscription each time the socket opens", async () => {
    watchSession(socket as WebSocket);

    socket.dispatchEvent(new Event("open"));
    await vi.runAllTimersAsync();

    expect(mocks.put).toHaveBeenCalledWith("fork/sessions/push", {
      sub: SUBSCRIPTION,
    });
  });

  it("does nothing with the sessions feature off", async () => {
    mocks.isForkEnabled.mockReturnValue(false);
    watchSession(socket as WebSocket);

    socket.dispatchEvent(new Event("open"));
    close(SESSION_ENDED_CLOSE_CODE);
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_DELAY_MS);

    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
