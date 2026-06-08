import { expect, test } from "vitest";
import { parseCliArgs } from "../cli/CliArgs.ts";
import { defaultReportData } from "../cli/CliReport.ts";
import {
  type BenchmarkReport,
  metricSection,
  type ReportGroup,
} from "../report/BenchmarkReport.ts";
import { consoleSummary } from "../report/ConsoleSummary.ts";
import { integer } from "../report/Formatters.ts";
import { prepareHtmlData } from "../report/HtmlReport.ts";
import { timeSection } from "../report/StandardSections.ts";
import { createBenchmarkReport, createMeasuredResults } from "./TestUtils.ts";

test("produces a comparison CI and verdict for a baseline", () => {
  const groups = [
    {
      name: "group1",
      reports: [createBenchmarkReport("version1", [250, 300])],
      baseline: createBenchmarkReport("baseVersion", [200, 250]),
    },
  ];
  const data = prepareHtmlData(groups, { sections: [timeSection] });
  const metric = data.groups[0].sections?.flatMap(s => s.rows).find(r => r.primary);
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
  const metric = data.groups[0].sections!
    .flatMap(s => s.rows)
    .find(r => r.primary)!;

  // one cell per track, the baseline variant flagged in place (report order)
  expect(metric.entries.map(e => e.runName)).toEqual(["slice", "spread", "from"]);
  const spread = metric.entries.find(e => e.runName === "spread")!;
  expect(spread.isBaseline).toBe(true);
  expect(spread.comparisonCI).toBeUndefined();
  // comparison variants each carry their own Δ% vs the shared baseline
  expect(metric.entries.find(e => e.runName === "slice")!.comparisonCI).toBeDefined();
  expect(metric.entries.find(e => e.runName === "from")!.comparisonCI).toBeDefined();
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
