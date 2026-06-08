import { expect, test } from "vitest";
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import { markdownReport } from "../report/MarkdownReport.ts";
import { timeSection } from "../report/StandardSections.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type { ReportData, ShiftPercentile } from "../viewer/ReportData.ts";

const zeroStats = { min: 0, max: 0, avg: 0, p50: 0, p75: 0, p99: 0, p999: 0 };

function point(
  label: string,
  percent: number,
  ci: [number, number],
  reliable: boolean,
  cur: string,
  base: string,
): ShiftPercentile {
  return {
    percentile: 0.5,
    label,
    diff: { percent, ci, direction: percent < 0 ? "faster" : "slower" },
    runs: [
      {
        runName: "current",
        bootstrapCI: {
          estimate: 0,
          ci: [0, 0],
          histogram: [],
          estimateLabel: cur,
        },
      },
      {
        runName: "baseline",
        bootstrapCI: {
          estimate: 0,
          ci: [0, 0],
          histogram: [],
          estimateLabel: base,
        },
      },
    ],
    reliable,
    tailCount: reliable ? 100 : 6,
    tailBatches: reliable ? 10 : 2,
  };
}

test("renders a shift table with mean, percentiles, and reliability", () => {
  const points = [
    {
      ...point("mean", -2.1, [-3.8, -0.4], true, "1,240,000", "1,214,000"),
      isMean: true,
    },
    point("p99", 14.8, [7, 22], false, "980,000", "1,150,000"),
  ];
  const data: ReportData = {
    groups: [
      {
        name: "WESL Parser",
        benchmarks: [{ name: "reduceTwo", samples: [], stats: zeroStats }],
        sections: [
          {
            title: "lines / sec",
            rows: [
              {
                label: "mean",
                primary: true,
                entries: [
                  {
                    runName: "current",
                    value: "1,240,000",
                    shiftFunction: { metric: "lines / sec", points },
                  },
                ],
              },
              {
                label: "lines",
                shared: true,
                entries: [{ runName: "current", value: "85,000" }],
              },
            ],
          },
        ],
      },
    ],
    metadata: { timestamp: "", bencherVersion: "0" },
  };
  const md = markdownReport(data);

  expect(md).toContain("## WESL Parser");
  expect(md).toContain("#### lines / sec");
  expect(md).toContain(
    "| mean | 1,240,000 | 1,214,000 | -2.1% | [-3.8%, -0.4%] | better |",
  );
  expect(md).toContain(
    "| p99 | 980,000 | 1,150,000 | +14.8% | [+7.0%, +22.0%] | worse (unreliable, n=6) |",
  );
  // shared row (no baseline) rendered as a value table below the shift table
  expect(md).toContain("| lines | 85,000 |");
});

test("scalar-only section (no baseline) renders a value table, lifts runs, skips empty titles", () => {
  const data: ReportData = {
    groups: [
      {
        name: "g",
        benchmarks: [{ name: "concat", samples: [], stats: zeroStats }],
        sections: [
          {
            title: "time",
            rows: [
              { label: "mean", entries: [{ runName: "current", value: "1.2us" }] },
            ],
          },
          {
            title: "",
            rows: [
              {
                label: "runs",
                shared: true,
                entries: [{ runName: "current", value: "5" }],
              },
            ],
          },
        ],
      },
    ],
    metadata: { timestamp: "", bencherVersion: "0" },
  };
  const md = markdownReport(data);

  expect(md).toContain("#### time");
  expect(md).toContain("| mean | 1.2us |");
  // runs is lifted to a case metadata line, not left in a section
  expect(md).toMatch(/## g\n\nruns: 5/);
  // empty-title runs-only section emits nothing (no bare header)
  expect(md).not.toContain("#### \n");
});

test("comparable scalar section (GC) shows per-track values with inline Δ%", () => {
  const data: ReportData = {
    groups: [
      {
        name: "g",
        benchmarks: [{ name: "parse", samples: [], stats: zeroStats }],
        sections: [
          {
            title: "gc",
            rows: [
              {
                label: "alloc/iter",
                entries: [
                  {
                    runName: "current",
                    value: "1.2KB",
                    comparisonCI: {
                      percent: -12.5,
                      ci: [-12.5, -12.5],
                      direction: "uncertain",
                    },
                  },
                  { runName: "baseline", value: "1.4KB", isBaseline: true },
                ],
              },
            ],
          },
        ],
      },
    ],
    metadata: { timestamp: "", bencherVersion: "0" },
  };
  const md = markdownReport(data);

  expect(md).toContain("#### gc");
  expect(md).toContain("| metric | current | baseline |");
  expect(md).toContain("| alloc/iter | 1.2KB (-12.5%) | 1.4KB |");
});

/** Batched samples as a global ramp, so percentile tails are genuinely sparse.
 *  scale > 1 makes every value larger (slower), simulating a regression. */
function batched(
  batches: number,
  perBatch: number,
  scale = 1,
): MeasuredResults {
  const samples: number[] = [];
  const batchOffsets: number[] = [];
  const n = batches * perBatch;
  let k = 0;
  for (let b = 0; b < batches; b++) {
    batchOffsets.push(samples.length);
    for (let i = 0; i < perBatch; i++)
      samples.push((1 + (k++ / n) * 2) * scale);
  }
  return { name: "current", samples, batchOffsets } as MeasuredResults;
}

test("integration: baseline run flows through prepareHtmlData into a shift table", () => {
  const current = batched(24, 50);
  const baseline = { ...batched(24, 50, 1.3), name: "baseline" };
  const groups: ReportGroup[] = [
    {
      name: "sort",
      reports: [{ name: "current", measuredResults: current }],
      baseline: { name: "baseline", measuredResults: baseline },
    },
  ];
  const data = prepareHtmlData(groups, {
    sections: [timeSection],
    resamples: 200,
  });
  const md = markdownReport(data);

  expect(md).toContain("#### time");
  expect(md).toContain("| stat | current | baseline | Δ% | 95% CI | verdict |");
  expect(md).toMatch(/^\| mean \|/m);
  expect(md).toMatch(/^\| p50 \|/m);
  // current is faster than the 1.3x-slower baseline
  expect(md).toContain("better");
});
