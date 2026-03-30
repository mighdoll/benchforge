import { expect, test } from "vitest";
import { withCoverageProfiling } from "../profiling/node/CoverageSampler.ts";

test("withCoverageProfiling returns function execution counts", async () => {
  function hotFunction() {
    let sum = 0;
    for (let i = 0; i < 100; i++) sum += i;
    return sum;
  }

  const { result, coverage } = await withCoverageProfiling(_session => {
    for (let i = 0; i < 10; i++) hotFunction();
    return 42;
  });

  expect(result).toBe(42);
  expect(coverage.scripts.length).toBeGreaterThan(0);

  // Find our test file in the coverage data
  const thisScript = coverage.scripts.find(s =>
    s.url.includes("CoverageSampler.test"),
  );
  expect(thisScript).toBeDefined();
  expect(thisScript!.functions.length).toBeGreaterThan(0);

  // Find hotFunction and verify its count
  const hotFn = thisScript!.functions.find(
    f => f.functionName === "hotFunction",
  );
  expect(hotFn).toBeDefined();
  const count = hotFn!.ranges[0].count;
  expect(count).toBe(10);
});
