import { expect, test } from "vitest";
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import { markdownReport } from "../report/MarkdownReport.ts";
import { timeSection } from "../report/StandardSections.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type { NoiseFloor } from "../stats/NoiseFloor.ts";
import type {
  ProfileSummary,
  ReportData,
  ShiftPercentile,
} from "../viewer/ReportData.ts";

const zeroStats = { min: 0, max: 0, avg: 0, p50: 0, p75: 0, p99: 0, p999: 0 };

/** A one-group ReportData carrying a single benchmark with a profile summary. */
function profileData(summary: ProfileSummary): ReportData {
  return {
    groups: [
      {
        name: "parse",
        benchmarks: [
          {
            name: "current",
            samples: [],
            stats: zeroStats,
            profileSummary: summary,
          },
        ],
      },
    ],
    metadata: { timestamp: "", bencherVersion: "0" },
  };
}

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
  return { name: "current", samples, batchOffsets, time: zeroStats };
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
              {
                label: "mean",
                entries: [{ runName: "current", value: "1.2us" }],
              },
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
  // the free A-vs-A baseline noise floor rides along on every A/B run
  expect(md).toContain("**baseline noise floor:**");
  expect(md).toContain("baseline batches");
});

/** A one-case ReportData whose group carries only a noise floor (no sections),
 *  with an optional equiv-margin in the CLI args. */
function noiseData(nf: NoiseFloor, margin?: number): ReportData {
  return {
    groups: [
      {
        name: "sort",
        benchmarks: [{ name: "current", samples: [], stats: zeroStats }],
        noiseFloor: nf,
      },
    ],
    metadata: {
      timestamp: "",
      bencherVersion: "0",
      cliArgs: margin != null ? { "equiv-margin": margin } : undefined,
    },
  };
}

const cleanFloor: NoiseFloor = {
  halfWidthPct: 0.42,
  dispersionPct: 0.5,
  batches: 24,
  driftPct: 0.05,
  crossRoundAcf: 0,
};

test("noise floor renders a compact context line with the batch count", () => {
  const md = markdownReport(noiseData(cleanFloor));
  expect(md).toContain(
    "**baseline noise floor:** +/-0.42% over 24 baseline batches.",
  );
  // no margin configured => no margin text, and clean case stays one line
  expect(md).not.toContain("equiv-margin");
  expect(md).not.toContain("likely environmental");
});

test("noise floor warns only when it reaches the margin", () => {
  const atMargin = markdownReport(
    noiseData({ ...cleanFloor, halfWidthPct: 0.6 }, 0.5),
  );
  expect(atMargin).toContain("equiv-margin 0.50%");
  expect(atMargin).toContain("likely environmental, not a real change");

  const underMargin = markdownReport(noiseData(cleanFloor, 0.5));
  expect(underMargin).toContain("equiv-margin 0.50%");
  expect(underMargin).not.toContain("likely environmental");
});

test("noise floor softens wording below ~20 batches", () => {
  const md = markdownReport(noiseData({ ...cleanFloor, batches: 8 }));
  expect(md).toContain("few batches, so this floor is itself rough");
});

test("noise floor flags drift only when it exceeds the run's resolution", () => {
  const drifted = markdownReport(
    noiseData({ ...cleanFloor, halfWidthPct: 0.3, driftPct: 1.1 }),
  );
  expect(drifted).toContain("drifted +1.1%");
  expect(drifted).toContain("environment was not stationary");

  const steady = markdownReport(
    noiseData({ ...cleanFloor, halfWidthPct: 0.5, driftPct: 0.1 }),
  );
  expect(steady).not.toContain("not stationary");
});

test("renders a hot-functions table without a baseline (4 columns)", () => {
  const summary: ProfileSummary = {
    totalUs: 32500,
    iterations: 100,
    rows: [
      {
        name: "countLineBreaks",
        url: "/Lines.ts",
        line: 42,
        selfUs: 12400,
        selfPct: 38.2,
      },
      {
        name: "tokenize",
        url: "/Token.ts",
        line: 88,
        selfUs: 8100,
        selfPct: 24.9,
      },
    ],
  };
  const md = markdownReport(profileData(summary));

  expect(md).toContain("#### hot functions (self time, profiled pass)");
  expect(md).toContain("| self/iter | self% | function | location |");
  // self time is shown per iteration: 12400us / 100 = 124us
  expect(md).toContain("| 124μs | 38.2% | countLineBreaks | /Lines.ts:42 |");
  expect(md).not.toContain("95% CI");
});

test("renders a hot-functions delta table with a baseline (5 columns)", () => {
  const summary: ProfileSummary = {
    totalUs: 32500,
    baseTotalUs: 24000,
    iterations: 100,
    rows: [
      {
        name: "countLineBreaks",
        url: "/Lines.ts",
        line: 42,
        selfUs: 12400,
        selfPct: 38.2,
        baseUs: 8800,
        deltaPct: 40.9,
        deltaCI: [20, 62],
      },
      // a function with no baseline match renders as "new"
      {
        name: "normalizeEol",
        url: "/Eol.ts",
        line: 5,
        selfUs: 3000,
        selfPct: 9.2,
      },
    ],
  };
  const md = markdownReport(profileData(summary));

  expect(md).toContain("#### hot functions (self time, current vs baseline)");
  expect(md).toContain(
    "| self/iter | self% | Δ% share (95% CI) | function | location |",
  );
  expect(md).toContain(
    "| 124μs | 38.2% | +40.9% [+20.0%, +62.0%] | countLineBreaks | /Lines.ts:42 |",
  );
  expect(md).toMatch(/\| new \| normalizeEol \| \/Eol\.ts:5 \|/);
});

test("renders a heap allocation table with sites, percent, callers, and footer", () => {
  const data: ReportData = {
    groups: [
      {
        name: "parse",
        benchmarks: [
          {
            name: "current",
            samples: [],
            stats: zeroStats,
            heapSites: [
              {
                name: "makeToken",
                location: "user.ts:20:8",
                bytes: 2000,
                pct: 71.4,
                callers: ["parseModule"],
              },
              {
                name: "concat",
                location: "node:internal/util:3",
                bytes: 800,
                pct: 28.6,
              },
            ],
            heapSummary: { totalBytes: 2800, userBytes: 2000, sampleCount: 3 },
          },
        ],
      },
    ],
    metadata: { timestamp: "", bencherVersion: "0" },
  };
  const md = markdownReport(data);

  expect(md).toContain("#### heap allocation sites (top 2, garbage included)");
  expect(md).toContain("| bytes | % | function | location | callers |");
  expect(md).toContain(
    "| 2.0KB | 71.4% | makeToken | user.ts:20:8 | parseModule |",
  );
  // a site with no resolved user-code callers leaves the caller cell blank
  expect(md).toContain("| 800B | 28.6% | concat | node:internal/util:3 |  |");
  expect(md).toContain("Total (all): 2.7KB -- user code: 2.0KB -- samples: 3");
});

test("renders the reconstructed cli command in the header", () => {
  const data: ReportData = {
    groups: [],
    metadata: {
      timestamp: "",
      bencherVersion: "0",
      cliArgs: { batches: 4, profile: true, batchesAlias: 4 },
      cliDefaults: { batches: 1 },
    },
  };
  const md = markdownReport(data);

  expect(md).toContain("`benchforge --batches 4 --profile`");
});
