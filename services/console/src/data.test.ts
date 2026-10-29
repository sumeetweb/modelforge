import { describe, expect, it } from "vitest";
import { currentValue, selectSeries, filterSeries, linePath } from "./data";

describe("telemetry presentation", () => {
  it("does not present absent or old samples as current", () => {
    expect(currentValue({ labels: {}, points: [[100, 12]] }, 120)).toBeNull();
    expect(currentValue({ labels: {}, points: [[120, 0]] }, 120)).toBe(0);
    expect(currentValue({ labels: {}, points: [[120, null]] }, 120)).toBeNull();
  });
  it("separates deployment targets that share an artifact version", () => {
    const stable = { labels: { version: "v1", target: "stable" }, points: [] };
    const candidate = {
      labels: { version: "v1", target: "candidate" },
      points: [],
    };
    const metrics = { modelRate: [stable, candidate] };
    expect(selectSeries(metrics, "modelRate", "v1", "stable")).toEqual([
      stable,
    ]);
    expect(selectSeries(metrics, "modelRate", "v1", "candidate")).toEqual([
      candidate,
    ]);
    expect(filterSeries(metrics.modelRate, "CANDIDATE")).toEqual([candidate]);
  });
  it("breaks chart paths across missing timestamps and non-finite samples", () => {
    expect(
      linePath(
        [
          [0, 1],
          [15, 2],
          [60, 3],
          [75, null],
          [90, 4],
        ],
        15,
        (n) => n,
        (n) => n,
      ),
    ).toBe("M0.0,1.0 L15.0,2.0 M60.0,3.0  M90.0,4.0");
  });
});
