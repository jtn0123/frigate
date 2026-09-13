import { describe, expect, it } from "vitest";
import { formatDetectorName } from "./detector-name";

describe("formatDetectorName", () => {
  it("upper-cases hardware acronyms", () => {
    expect(formatDetectorName("cpu")).toBe("CPU");
    expect(formatDetectorName("gpu")).toBe("GPU");
    expect(formatDetectorName("coral_tpu")).toBe("Coral_TPU");
    expect(formatDetectorName("npu-1")).toBe("NPU-1");
  });

  it("otherwise capitalizes only the first letter, as before", () => {
    expect(formatDetectorName("coral")).toBe("Coral");
    expect(formatDetectorName("ov_0")).toBe("Ov_0");
    expect(formatDetectorName("myDetector")).toBe("MyDetector");
  });

  it("does not treat an acronym inside a longer word as one", () => {
    expect(formatDetectorName("cpuish")).toBe("Cpuish");
  });
});
