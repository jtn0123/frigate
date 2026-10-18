import { describe, expect, it, vi } from "vitest";
import { LiveStreamGovernor } from "./LiveStreamGovernor";

// two configured streams plus the jsmpeg floor
const RUNGS = 3;

function setup(rungs = RUNGS) {
  let time = 0;
  const governor = new LiveStreamGovernor(rungs, () => time);
  return {
    governor,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const healthy = { bytes: 1000, mediaSeconds: 1, wallSeconds: 1 };
const slow = { bytes: 1000, mediaSeconds: 0.5, wallSeconds: 1 };

describe("LiveStreamGovernor", () => {
  it("starts on the top rung with no reason", () => {
    const { governor } = setup();
    expect(governor.getSnapshot()).toEqual({ rung: 0, reason: undefined });
  });

  it("ignores warmup, empty and zero-length samples", () => {
    const { governor, advance } = setup();
    for (let i = 0; i < 5; i++) {
      governor.sample({ bytes: 1000, mediaSeconds: 0, wallSeconds: 1 });
    }
    advance(5000);
    governor.sample({ bytes: 0, mediaSeconds: 0, wallSeconds: 10 });
    governor.sample({ bytes: 1000, mediaSeconds: 0, wallSeconds: 0 });
    expect(governor.getSnapshot().rung).toBe(0);
  });

  it("steps down on sustained under-delivery and notifies listeners", () => {
    const { governor, advance } = setup();
    const listener = vi.fn();
    const unsubscribe = governor.subscribe(listener);
    advance(4000);
    for (let i = 0; i < 4; i++) {
      advance(1000);
      governor.sample(slow);
    }
    expect(governor.getSnapshot()).toEqual({ rung: 1, reason: "bandwidth" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    advance(4000);
    for (let i = 0; i < 4; i++) {
      advance(1000);
      governor.sample(slow);
    }
    expect(governor.getSnapshot()).toEqual({ rung: 2, reason: "floor" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("lets a fast second offset a slow one", () => {
    const { governor, advance } = setup();
    advance(4000);
    for (let i = 0; i < 10; i++) {
      advance(1000);
      governor.sample(i % 2 ? slow : { ...healthy, mediaSeconds: 1.5 });
    }
    expect(governor.getSnapshot().rung).toBe(0);
  });

  it("steps down on repeated short stalls within the chronic window", () => {
    const { governor, advance } = setup();
    advance(4000);
    // each stall is offset in the sustained window but adds to the chronic one
    for (let i = 0; i < 7; i++) {
      advance(1000);
      governor.sample({ bytes: 1000, mediaSeconds: 0, wallSeconds: 1 });
      advance(1000);
      governor.sample({ bytes: 1000, mediaSeconds: 2, wallSeconds: 1 });
      if (governor.getSnapshot().rung) break;
    }
    expect(governor.getSnapshot().rung).toBe(1);
  });

  it("does not step down past the floor", () => {
    const { governor } = setup(1);
    expect(governor.playerError("mse-decode", true)).toBe(false);
    expect(governor.getSnapshot()).toEqual({ rung: 0, reason: undefined });
  });

  it("marks a codec failure unplayable for the session", () => {
    const { governor, advance } = setup();
    expect(governor.playerError("mse-codec", true)).toBe(true);
    expect(governor.getSnapshot()).toEqual({ rung: 1, reason: "codec" });

    // rung 0 is never retried, so there is nothing to climb to
    advance(10 * 60_000);
    governor.tick();
    expect(governor.getSnapshot().rung).toBe(1);
  });

  it("hands an offline camera's error to the fallback", () => {
    const { governor } = setup();
    expect(governor.playerError("stalled", false)).toBe(false);
    expect(governor.getSnapshot().rung).toBe(0);
    expect(governor.playerError("stalled", true)).toBe(true);
    expect(governor.getSnapshot().rung).toBe(1);
  });

  it("climbs after a clean minute and backs off when the climb fails", () => {
    const { governor, advance } = setup();
    governor.playerError("stalled", true);
    expect(governor.getSnapshot().rung).toBe(1);

    advance(59_000);
    governor.tick();
    expect(governor.getSnapshot().rung).toBe(1);
    advance(1000);
    governor.tick();
    expect(governor.getSnapshot()).toEqual({ rung: 0, reason: undefined });

    // failing during probation returns down even for an offline source
    expect(governor.playerError("stalled", false)).toBe(true);
    expect(governor.getSnapshot().rung).toBe(1);

    // the wait doubled, so a minute is no longer enough
    advance(60_000);
    governor.tick();
    expect(governor.getSnapshot().rung).toBe(1);
    advance(60_000);
    governor.tick();
    expect(governor.getSnapshot().rung).toBe(0);

    // surviving probation resets the backoff
    advance(30_000);
    governor.tick();
    governor.playerError("stalled", true);
    advance(60_000);
    governor.tick();
    expect(governor.getSnapshot().rung).toBe(0);
  });

  it("holds the lowest playable stream for data saver", () => {
    const { governor, advance } = setup();
    governor.setHoldLow(true);
    expect(governor.getSnapshot()).toEqual({ rung: 1, reason: "saveData" });

    // from the floor, data saver climbs back to its stream but not above
    governor.playerError("stalled", true);
    expect(governor.getSnapshot()).toEqual({ rung: 2, reason: "floor" });
    advance(60_000);
    governor.tick();
    expect(governor.getSnapshot().rung).toBe(1);
    advance(10 * 60_000);
    governor.tick();
    expect(governor.getSnapshot().rung).toBe(1);

    governor.setHoldLow(false);
    expect(governor.getSnapshot()).toEqual({ rung: 1, reason: "bandwidth" });
  });

  it("holds the floor for data saver when nothing else plays", () => {
    const { governor } = setup(2);
    governor.playerError("mse-codec", true);
    governor.setHoldLow(true);
    expect(governor.getSnapshot()).toEqual({ rung: 1, reason: "floor" });
  });

  it("skips unplayable rungs on the way down and up", () => {
    const { governor, advance } = setup(4);
    governor.playerError("stalled", true);
    governor.playerError("mse-codec", true);
    expect(governor.getSnapshot().rung).toBe(2);

    advance(60_000);
    governor.tick();
    expect(governor.getSnapshot().rung).toBe(0);
    governor.playerError("stalled", true);
    expect(governor.getSnapshot().rung).toBe(2);
  });

  it("reset returns to the top and forgets codec failures", () => {
    const { governor } = setup();
    governor.playerError("mse-codec", true);
    governor.reset();
    expect(governor.getSnapshot()).toEqual({ rung: 0, reason: undefined });

    governor.setHoldLow(true);
    governor.playerError("stalled", true);
    governor.reset();
    expect(governor.getSnapshot().rung).toBe(1);
  });

  it("resetHistory restarts warmup on the same rung", () => {
    const { governor, advance } = setup();
    advance(4000);
    governor.sample(slow);
    governor.resetHistory();
    for (let i = 0; i < 2; i++) {
      advance(1000);
      governor.sample({ bytes: 1000, mediaSeconds: 0, wallSeconds: 1 });
    }
    expect(governor.getSnapshot().rung).toBe(0);
  });
});
