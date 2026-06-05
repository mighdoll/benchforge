import { expect, test } from "vitest";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { warmupShape } from "../report/WarmupShape.ts";

/** MeasuredResults carrying just the fields warmupShape reads. */
function results(samples: number[], batchOffsets?: number[]): MeasuredResults {
  return {
    name: "t",
    samples,
    batchOffsets,
    time: { min: 0, max: 0, avg: 0, p50: 0, p75: 0, p99: 0, p999: 0 },
  };
}

/** A batch whose first 5% runs at `hot` and the rest at `plateau`. */
function ramped(n: number, hot: number, plateau: number): number[] {
  return Array.from({ length: n }, (_, i) => (i < n * 0.05 ? hot : plateau));
}

test("warmupShape returns undefined below the minimum batch size", () => {
  expect(warmupShape(results(new Array(19).fill(1)))).toBeUndefined();
});

test("warmupShape measures a front-loaded ramp against the plateau", () => {
  const w = warmupShape(results(ramped(100, 2, 1)))!;
  expect(w.batches).toBe(1);
  const first = w.regions[0];
  const plateau = w.regions.at(-1)!;
  expect(first.label).toBe("first 5%");
  expect(first.pctVsPlateau).toBeCloseTo(1.0); // 2ms vs 1ms plateau = +100%
  expect(plateau.pctVsPlateau).toBe(0); // plateau is its own reference
});

test("warmupShape summarizes each batch independently", () => {
  const samples = [...ramped(100, 2, 1), ...ramped(100, 2, 1)];
  const w = warmupShape(results(samples, [0, 100]))!;
  expect(w.batches).toBe(2);
  expect(w.regions[0].pctVsPlateau).toBeCloseTo(1.0);
});
