import { expect, test } from "vitest";
import { withTimeProfiling } from "../profiling/node/TimeSampler.ts";

test("withTimeProfiling returns valid V8 CPU profile", async () => {
  // Burn some CPU to produce samples
  const { result, profile } = await withTimeProfiling(
    {},
    async ({ start, stop }) => {
      await start();
      let sum = 0;
      for (let i = 0; i < 1e6; i++) sum += Math.sqrt(i);
      await stop();
      return sum;
    },
  );

  expect(result).toBeGreaterThan(0);
  expect(profile.nodes.length).toBeGreaterThan(0);
  expect(profile.startTime).toBeLessThan(profile.endTime);
  expect(profile.samples).toBeDefined();
  expect(profile.timeDeltas).toBeDefined();
  expect(profile.samples!.length).toBe(profile.timeDeltas!.length);

  const node = profile.nodes[0];
  expect(node).toHaveProperty("id");
  expect(node).toHaveProperty("callFrame");
  expect(node.callFrame).toHaveProperty("functionName");
  expect(node.callFrame).toHaveProperty("url");
  expect(node.callFrame).toHaveProperty("lineNumber");
});

test("withTimeProfiling respects custom interval", async () => {
  // A 10x finer interval samples the same fixed work ~10x as often. Run the fine
  // pass first so JIT warmup (shorter second run) can only widen the gap, never
  // close it.
  const fine = await sampleCount(100);
  const coarse = await sampleCount(1000);
  expect(fine).toBeGreaterThan(coarse);
});

/** Profile identical fixed work at the given sampling interval (microseconds);
 *  return the number of CPU samples collected. */
async function sampleCount(interval: number): Promise<number> {
  const { profile } = await withTimeProfiling(
    { interval },
    async ({ start, stop }) => {
      await start();
      let sum = 0;
      for (let i = 0; i < 2e7; i++) sum += Math.sqrt(i);
      await stop();
      return sum;
    },
  );
  return profile.samples!.length;
}
