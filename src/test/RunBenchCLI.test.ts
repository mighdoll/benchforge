import { expect, test } from "vitest";
import { filterBenchmarks } from "../cli/FilterBenchmarks.ts";
import type { BenchSuite } from "../runners/BenchmarkSpec.ts";
import { runBenchCLITest } from "./TestUtils.ts";

const testSuite: BenchSuite = {
  name: "Test Suite",
  groups: [
    {
      name: "String Operations",
      benchmarks: [
        { name: "concatenation", fn: () => "a" + "b" },
        { name: "template literal", fn: () => `a${"b"}` },
      ],
    },
    {
      name: "Math Operations",
      benchmarks: [
        { name: "addition", fn: () => 1 + 1 },
        { name: "multiplication", fn: () => 2 * 2 },
      ],
    },
  ],
};

const suiteWithSetup: BenchSuite = {
  name: "Array Suite",
  groups: [
    {
      name: "Array Operations",
      setup: () => ({
        numbers: Array.from({ length: 100 }, (_, i) => i),
        strings: Array.from({ length: 100 }, (_, i) => `item${i}`),
      }),
      benchmarks: [
        {
          name: "sum numbers",
          fn: ({ numbers }: any) =>
            numbers.reduce((a: number, b: number) => a + b, 0),
        },
        {
          name: "join strings",
          fn: ({ strings }: any) => strings.join(","),
        },
      ],
    },
  ],
};

test("runs all benchmarks", { timeout: 30000 }, async () => {
  const output = await runBenchCLITest(testSuite, "--duration 0.1 --no-worker");

  expect(output).toContain("concatenation");
  expect(output).toContain("template literal");
  expect(output).toContain("addition");
  expect(output).toContain("multiplication");
  expect(output).toContain("(mean)");
});

test("filters by substring", { timeout: 15000 }, async () => {
  const output = await runBenchCLITest(
    testSuite,
    "--filter concat --duration 0.1 --no-worker",
  );

  expect(output).toContain("concatenation");
  expect(output).not.toContain("addition");
});

test("filters by regex", { timeout: 15000 }, async () => {
  const output = await runBenchCLITest(
    testSuite,
    "--filter ^template --duration 0.1 --no-worker",
  );
  expect(output).toContain("template literal");
  expect(output).not.toContain("addition");
});

test("filter preserves suite structure", () => {
  const filtered = filterBenchmarks(testSuite, "concatenation", false);

  expect(filtered.name).toBe("Test Suite");
  expect(filtered.groups).toHaveLength(2);
  expect(filtered.groups[0].name).toBe("String Operations");
  expect(filtered.groups[0].benchmarks).toHaveLength(1);
  expect(filtered.groups[0].benchmarks[0].name).toBe("concatenation");
  expect(filtered.groups[1].benchmarks).toHaveLength(0);
});

test("runs benchmarks with setup function", { timeout: 30000 }, async () => {
  const output = await runBenchCLITest(
    suiteWithSetup,
    "--duration 0.1 --no-worker",
  );

  expect(output).toContain("sum numbers");
  expect(output).toContain("join strings");
  expect(output).toContain("(mean)");
});

test("runs benchmarks with baseline comparison", {
  timeout: 30000,
}, async () => {
  const suiteWithBaseline: BenchSuite = {
    name: "Baseline Test",
    groups: [
      {
        name: "Sort Comparison",
        setup: () => ({
          data: Array.from({ length: 10 }, () => Math.random()),
        }),
        baseline: {
          name: "baseline sort",
          fn: ({ data }: any) => [...data].sort(),
        },
        benchmarks: [
          {
            name: "optimized sort",
            fn: ({ data }: any) => [...data].sort((a, b) => a - b),
          },
        ],
      },
    ],
  };

  const output = await runBenchCLITest(
    suiteWithBaseline,
    "--iterations 20 --no-worker",
  );

  expect(output).toContain("optimized sort");
  expect(output).toContain("vs baseline"); // verdict line for the comparison
  expect(output).toContain("(mean)");
});
