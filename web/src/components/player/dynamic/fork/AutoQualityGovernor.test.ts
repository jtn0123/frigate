import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoQualityGovernor } from "../AutoQualityGovernor";

describe("adaptive recording quality", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("recovers an unresolved stall even when the player reports it only once", () => {
    const down = vi.fn(() => true);
    const governor = new AutoQualityGovernor(down);
    governor.stallStarted();
    vi.advanceTimersByTime(3999);
    expect(down).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(down).toHaveBeenCalledExactlyOnceWith("stall");
    governor.destroy();
  });

  it("allows seek latency and cancels recovery when playback resumes", () => {
    const down = vi.fn(() => true);
    const governor = new AutoQualityGovernor(down);
    governor.noteSeek();
    governor.stallStarted();
    vi.advanceTimersByTime(5000);
    governor.stallEnded();
    vi.advanceTimersByTime(10000);
    expect(down).not.toHaveBeenCalled();
    governor.destroy();
  });

  it("uses a startup budget and cancels it when the first frame arrives", () => {
    const down = vi.fn(() => true);
    const governor = new AutoQualityGovernor(down);
    governor.sourceLoadStarted();
    vi.advanceTimersByTime(9999);
    governor.sourceLoadEnded();
    vi.advanceTimersByTime(1);
    expect(down).not.toHaveBeenCalled();
    governor.sourceLoadStarted();
    vi.advanceTimersByTime(10000);
    expect(down).toHaveBeenCalledExactlyOnceWith("startup");
    governor.destroy();
  });

  it("requires sustained low throughput and retries main only with headroom", () => {
    const down = vi.fn(() => true);
    const up = vi.fn();
    const governor = new AutoQualityGovernor(down, up);
    governor.bandwidthSample(1_000_000, 4_000_000, true);
    governor.bandwidthSample(1_000_000, 4_000_000, true);
    expect(down).not.toHaveBeenCalled();
    governor.bandwidthSample(1_000_000, 4_000_000, true);
    expect(down).toHaveBeenCalledExactlyOnceWith("bandwidth");
    expect(governor.shouldRetryMain()).toBe(false);
    governor.armUpswitchProbe();
    governor.bandwidthSample(8_000_000, undefined, false);
    expect(up).not.toHaveBeenCalled();
    governor.bandwidthSample(8_000_000, undefined, false);
    expect(up).toHaveBeenCalledOnce();
    expect(governor.shouldRetryMain()).toBe(true);
    governor.destroy();
  });

  it.each(["codec", "data saver"])(
    "does not retry main with %s restrictions",
    (restriction) => {
      const up = vi.fn();
      const governor = new AutoQualityGovernor(() => true, up);
      governor.learnMainBitrate(4_000_000);
      if (restriction === "codec") governor.fatalCodecError();
      else governor.setHoldLow(true);
      governor.armUpswitchProbe();
      governor.bandwidthSample(20_000_000, undefined, false);
      governor.bandwidthSample(20_000_000, undefined, false);
      expect(up).not.toHaveBeenCalled();
      expect(governor.shouldRetryMain()).toBe(false);
      governor.destroy();
    },
  );

  it("cancels pending timers when disposed and retains network knowledge on camera change", () => {
    const down = vi.fn(() => true);
    const governor = new AutoQualityGovernor(down);
    governor.seed(1_000_000);
    governor.sourceLoadStarted();
    governor.stallStarted();
    governor.markMainUnplayable();
    governor.resetForCamera();
    expect(governor.isMainUnplayable).toBe(false);
    expect(governor.shouldStartLow()).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(down).not.toHaveBeenCalled();
    governor.destroy();
  });
});

describe("adaptive quality edge conditions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("ignores invalid estimates and learns camera bitrate only once", () => {
    const governor = new AutoQualityGovernor(() => false);
    expect(governor.shouldStartLow()).toBe(false);
    expect(governor.shouldRetryMain()).toBe(true);
    governor.seed(5_000_000);
    governor.seed(1);
    expect(governor.bandwidthEstimate).toBe(5_000_000);
    for (const value of [0, -1, NaN, Infinity])
      governor.bandwidthSample(value, 1, true);
    expect(governor.bandwidthEstimate).toBe(5_000_000);
    expect(governor.shouldStartLow()).toBe(false);
    governor.learnMainBitrate(0);
    governor.learnMainBitrate(10_000_000);
    governor.learnMainBitrate(1);
    expect(governor.shouldStartLow()).toBe(true);
    expect(governor.shouldRetryMain()).toBe(false);
    governor.bandwidthSample(20_000_000, undefined, true);
    governor.bandwidthSample(20_000_000, 0, true);
    expect(governor.shouldStartLow()).toBe(false);
    governor.destroy();
  });
  it("requires consecutive low samples and propagates unhandled fatal errors", () => {
    const down = vi.fn(() => false);
    const governor = new AutoQualityGovernor(down);
    governor.bandwidthSample(1, 100, true);
    governor.bandwidthSample(200, 100, true);
    governor.bandwidthSample(1, 100, true);
    governor.bandwidthSample(1, 100, true);
    expect(down).not.toHaveBeenCalled();
    expect(governor.fatalNetworkError()).toBe(false);
    expect(down).toHaveBeenCalledWith("fatal-error");
    governor.bandwidthSample(1, 100, true);
    expect(down).toHaveBeenLastCalledWith("bandwidth");
    governor.destroy();
  });
  it("counts cumulative stalls, ignores duplicate starts and expires old episodes", () => {
    const down = vi.fn(() => false);
    const governor = new AutoQualityGovernor(down);
    governor.stallEnded();
    for (let i = 0; i < 2; i++) {
      governor.stallStarted();
      governor.stallStarted();
      vi.advanceTimersByTime(3000);
      governor.stallEnded();
    }
    expect(governor.shouldRetryMain()).toBe(false);
    governor.stallStarted();
    vi.advanceTimersByTime(1000);
    expect(down).toHaveBeenCalledWith("stall");
    expect(governor.shouldRetryMain()).toBe(false);
    governor.stallEnded();
    vi.advanceTimersByTime(60001);
    expect(governor.shouldRetryMain()).toBe(true);
    governor.destroy();
  });
  it("allows a long seek grace and resets its timers on a manual pin", () => {
    const down = vi.fn(() => true);
    const governor = new AutoQualityGovernor(down);
    governor.noteSeek();
    governor.stallStarted();
    vi.advanceTimersByTime(9999);
    expect(down).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(down).toHaveBeenCalledWith("stall");
    governor.stallStarted();
    governor.stallEnded();
    expect(governor.shouldRetryMain()).toBe(true);
    governor.sourceLoadStarted();
    governor.resetStallHistory();
    vi.advanceTimersByTime(10000);
    expect(down).toHaveBeenCalledTimes(1);
    governor.destroy();
  });
});
