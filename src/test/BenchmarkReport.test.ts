import { expect, test } from "vitest";
import { parseCliArgs } from "../cli/CliArgs.ts";
import { defaultReportData } from "../cli/CliReport.ts";
import {
  type BenchmarkReport,
  metricSection,
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
  expect(data.groups[0].benchmarks[0].comparisonCI).toBeDefined();
  expect(consoleSummary(data)).toContain("vs baseline");
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
