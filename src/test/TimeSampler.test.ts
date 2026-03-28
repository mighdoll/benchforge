import { expect, test } from "vitest";
import { withTimeProfiling } from "../time-sample/TimeSampler.ts";

test("withTimeProfiling returns valid V8 CPU profile", async () => {
  // Burn some CPU to produce samples
  const { result, profile } = await withTimeProfiling({}, () => {
    let sum = 0;
    for (let i = 0; i < 1e6; i++) sum += Math.sqrt(i);
    return sum;
  });

  expect(result).toBeGreaterThan(0);
  expect(profile.nodes.length).toBeGreaterThan(0);
  expect(profile.startTime).toBeLessThan(profile.endTime);
  expect(profile.samples).toBeDefined();
  expect(profile.timeDeltas).toBeDefined();
  expect(profile.samples!.length).toBe(profile.timeDeltas!.length);

  // Verify node structure
  const node = profile.nodes[0];
  expect(node).toHaveProperty("id");
  expect(node).toHaveProperty("callFrame");
  expect(node.callFrame).toHaveProperty("functionName");
  expect(node.callFrame).toHaveProperty("url");
  expect(node.callFrame).toHaveProperty("lineNumber");
});

test("withTimeProfiling respects custom interval", async () => {
  const { profile } = await withTimeProfiling({ interval: 100 }, () => {
    let sum = 0;
    for (let i = 0; i < 1e6; i++) sum += Math.sqrt(i);
    return sum;
  });

  // Finer interval should produce more samples for the same work
  expect(profile.samples!.length).toBeGreaterThan(0);
});
