import { expect, test } from "vitest";
import type { MatrixSuite } from "../matrix/BenchMatrix.ts";
import { runBenchCLITest } from "./TestUtils.ts";

const testSuite: MatrixSuite = {
  name: "Test Suite",
  matrices: [
    {
      name: "String Operations",
      variants: {
        concatenation: () => "a" + "b",
        "template literal": () => `a${"b"}`,
      },
    },
    {
      name: "Math Operations",
      variants: {
        addition: () => 1 + 1,
        multiplication: () => 2 * 2,
      },
    },
  ],
};

const suiteWithSetup: MatrixSuite = {
  name: "Array Suite",
  matrices: [
    {
      name: "Array Operations",
      caseData: {
        data: () => ({
          numbers: Array.from({ length: 100 }, (_, i) => i),
          strings: Array.from({ length: 100 }, (_, i) => `item${i}`),
        }),
      },
      variants: {
        "sum numbers": ({ numbers }: any) =>
          numbers.reduce((a: number, b: number) => a + b, 0),
        "join strings": ({ strings }: any) => strings.join(","),
      },
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

test("filters by variant substring", { timeout: 15000 }, async () => {
  const output = await runBenchCLITest(
    testSuite,
    "--filter /concat --duration 0.1 --no-worker",
  );

  expect(output).toContain("concatenation");
  expect(output).not.toContain("addition");
});

test("filters by another variant substring", { timeout: 15000 }, async () => {
  const output = await runBenchCLITest(
    testSuite,
    "--filter /template --duration 0.1 --no-worker",
  );
  expect(output).toContain("template literal");
  expect(output).not.toContain("addition");
});

test("runs benchmarks with shared case data", { timeout: 30000 }, async () => {
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
  const suiteWithBaseline: MatrixSuite = {
    name: "Baseline Test",
    matrices: [
      {
        name: "Sort Comparison",
        caseData: {
          data: () => Array.from({ length: 10 }, () => Math.random()),
        },
        variants: {
          "baseline sort": (data: number[]) => [...data].sort(),
          "optimized sort": (data: number[]) => [...data].sort((a, b) => a - b),
        },
        baselineVariant: "baseline sort",
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
