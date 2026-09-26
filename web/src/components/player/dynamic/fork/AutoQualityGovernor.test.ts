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
