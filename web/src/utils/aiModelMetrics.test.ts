import { describe, expect, it } from "vitest";
import { AIModelsResponse } from "@/types/aiModels";
import { appendHistory, graphPoints, readMetric } from "./aiModelMetrics";
const sample = (updated: number): AIModelsResponse => ({
  updated,
  models: [],
  audio: { status: "connected" },
  shared_gpus: {},
});
describe("model graph history", () => {
  it("ignores duplicate and delayed responses", () => {
    const history = [sample(100), sample(110)];
    expect(appendHistory(history, sample(110))).toBe(history);
    expect(appendHistory(history, sample(105))).toBe(history);
  });
  it("bounds samples and drops expired history", () => {
    let history: AIModelsResponse[] = [];
    for (let i = 0; i < 200; i++)
      history = appendHistory(history, sample(i * 10));
    expect(history).toHaveLength(200);
    expect(appendHistory(history, sample(90000))).toHaveLength(1);
  });
  it("preserves true zero and leaves missing readings and polling gaps empty", () => {
    const points = graphPoints([sample(100), sample(110), sample(250)], (s) =>
      s.updated === 100 ? 0 : null,
    );
    expect(points).toEqual([
      { x: 100000, y: 0 },
      { x: 110000, y: null },
      { x: 120000, y: null },
      { x: 250000, y: null },
    ]);
    expect(readMetric(sample(100), "missing", "ram_bytes")).toBeNull();
    expect(graphPoints([sample(1)], () => NaN)[0].y).toBeNull();
  });
});
