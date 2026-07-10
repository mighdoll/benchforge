import { expect, test } from "vitest";
import { parseCliArgs } from "../cli/CliArgs.ts";
import { defaultReportData } from "../cli/CliReport.ts";
import {
  type BenchmarkReport,
  metricSection,
  type ReportGroup,
} from "../report/BenchmarkReport.ts";
import { consoleSummary, primaryMetricRow } from "../report/ConsoleSummary.ts";
import { integer } from "../report/Formatters.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import { timeSection } from "../report/StandardSections.ts";
import type { NoiseFloor } from "../stats/NoiseFloor.ts";
import type { ReportData } from "../viewer/ReportData.ts";
import { createBenchmarkReport, createMeasuredResults } from "./TestUtils.ts";

const noisyFloor: NoiseFloor = {
  halfWidthPct: 3.1,
  dispersionPct: 2.5,
  batches: 40,
  driftPct: 3.2,
  crossRoundAcf: 0,
};

/** A ReportData whose single group carries the given noise floor (equiv-margin
 *  defaults to 2%), for exercising the console noisy-run caption. */
function reportWithNoiseFloor(nf?: NoiseFloor): ReportData {
  const groups = [
    {
      name: "group1",
      reports: [createBenchmarkReport("version1", [250, 300])],
      baseline: createBenchmarkReport("baseVersion", [200, 250]),
    },
  ];
  const args = parseCliArgs(undefined, ["--duration", "0.1"]);
  const data = defaultReportData(groups, args, { sections: [timeSection] });
  data.groups[0].noiseFloor = nf;
  return data;
}

test("produces a comparison CI and verdict for a baseline", () => {
  const groups = [
    {
      name: "group1",
      reports: [createBenchmarkReport("version1", [250, 300])],
      baseline: createBenchmarkReport("baseVersion", [200, 250]),
    },
  ];
  const data = prepareHtmlData(groups, { sections: [timeSection] });
  const metric = data.groups[0].sections
    ?.flatMap(s => s.rows)
    .find(r => r.primary);
  const comparison = metric?.entries.find(e => e.comparisonCI);
  expect(comparison?.comparisonCI).toBeDefined();
  expect(consoleSummary(data)).toContain("vs baseline");
});

test("baselineVariant mode consolidates variants into one track-columned row", () => {
  const groups: ReportGroup[] = [
    {
      name: "case",
      baselineVariantId: "spread",
      reports: [
        {
          ...createBenchmarkReport("slice", [0, 60]),
          baseline: createBenchmarkReport("spread", [60, 120]),
        },
        createBenchmarkReport("spread", [60, 120]),
        {
          ...createBenchmarkReport("from", [120, 180]),
          baseline: createBenchmarkReport("spread", [60, 120]),
        },
      ],
    },
  ];
  const data = prepareHtmlData(groups, { sections: [timeSection] });
  const metric = data.groups[0]
    .sections!.flatMap(s => s.rows)
    .find(r => r.primary)!;

  // one cell per track, the baseline variant flagged in place (report order)
  expect(metric.entries.map(e => e.runName)).toEqual([
    "slice",
    "spread",
    "from",
  ]);
  const spread = metric.entries.find(e => e.runName === "spread")!;
  expect(spread.isBaseline).toBe(true);
  expect(spread.comparisonCI).toBeUndefined();
  // comparison variants each carry their own Δ% vs the shared baseline
  expect(
    metric.entries.find(e => e.runName === "slice")!.comparisonCI,
  ).toBeDefined();
  expect(
    metric.entries.find(e => e.runName === "from")!.comparisonCI,
  ).toBeDefined();
});

test("report uses custom sections when provided", () => {
  const locSection = metricSection({
    title: "lines / sec",
    higherIsBetter: true,
    formatter: integer,
    toDisplay: (ms: number, meta?: Record<string, unknown>) => {
      const lines = (meta?.linesOfCode ?? 0) as number;
      return lines / (ms / 1000);
    },
    extras: [
      {
        key: "lines",
        title: "lines",
        formatter: integer,
        value: (_r, meta) => meta?.linesOfCode ?? 0,
      },
    ],
  });

  const report: BenchmarkReport = {
    name: "parse",
    measuredResults: createMeasuredResults([100, 150]),
    metadata: { linesOfCode: 500 },
  };
  const groups = [{ name: "parser", reports: [report] }];
  const args = parseCliArgs(undefined, ["--duration", "0.1"]);

  const output = consoleSummary(
    defaultReportData(groups, args, { sections: [locSection] }),
  );
  expect(output).toContain("lines / sec");
  expect(output).toContain("(mean)");
});

test("report falls back to CLI defaults without opts", () => {
  const report = createBenchmarkReport("plain", [100, 150]);
  const groups = [{ name: "g", reports: [report] }];
  const args = parseCliArgs(undefined, ["--duration", "0.1"]);
  const output = consoleSummary(defaultReportData(groups, args));
  expect(output).toContain("(mean)");
});

test("console summary flags a noisy run when both gates fire", () => {
  const output = consoleSummary(reportWithNoiseFloor(noisyFloor));
  expect(output).toContain("noisy run:");
  expect(output).toContain("baseline noise +/-3.1% vs margin 2.0%");
  expect(output).toContain("timing drifted +3.2% mid-run");
});

test("console summary includes only the clause whose gate fired", () => {
  const driftOnly = { ...noisyFloor, halfWidthPct: 0.5, driftPct: 1.2 };
  const output = consoleSummary(reportWithNoiseFloor(driftOnly));
  expect(output).toContain("noisy run:");
  expect(output).toContain("timing drifted +1.2% mid-run");
  expect(output).not.toContain("baseline noise");
});

test("console summary appends the display-domain margin under a transform", () => {
  const data = reportWithNoiseFloor(noisyFloor);
  const metric = primaryMetricRow(data.groups[0])!;
  metric.label = "lines / sec";
  const entry = metric.entries.find(e => !e.isBaseline)!;
  // A +/-5% time margin under a reciprocal transform is slightly asymmetric,
  // e.g. band [-4.76, 5.26]; max |end| = 5.26 -> "5.3%" at one decimal.
  entry.shiftFunction = {
    metric: "lines / sec",
    equivMarginBand: [-4.76, 5.26],
    points: [],
  };
  const output = consoleSummary(data);
  expect(output).toContain("baseline noise +/-3.1% vs margin 2.0%");
  expect(output).toContain("(about +/-5.3% in lines / sec)");
});

test("console summary omits the display-domain margin without a transform", () => {
  // timeSection has no display transform, so the quoted margin equals the CLI
  // margin and no parenthetical is appended.
  const output = consoleSummary(reportWithNoiseFloor(noisyFloor));
  expect(output).toContain("baseline noise +/-3.1% vs margin 2.0%");
  expect(output).not.toContain("about +/-");
});

test("console summary omits the noisy-run line without a noise floor", () => {
  const output = consoleSummary(reportWithNoiseFloor(undefined));
  expect(output).not.toContain("noisy run:");
});

test("console summary stays quiet when both gates are below threshold", () => {
  const quiet = { ...noisyFloor, halfWidthPct: 0.5, driftPct: 0.1 };
  const output = consoleSummary(reportWithNoiseFloor(quiet));
  expect(output).not.toContain("noisy run:");
});
