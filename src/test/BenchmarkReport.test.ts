import { expect, test } from "vitest";
import { parseCliArgs } from "../cli/CliArgs.ts";
import { defaultReport } from "../cli/CliReport.ts";
import type {
  BenchmarkReport,
  ReportSection,
} from "../report/BenchmarkReport.ts";
import { integer } from "../report/Formatters.ts";
import { gcSection } from "../report/GcSections.ts";
import { adaptiveSections, timeSection } from "../report/StandardSections.ts";
import { reportResults, valuesForReports } from "../report/text/TextReport.ts";
import { createBenchmarkReport, createMeasuredResults } from "./TestUtils.ts";

test("combines time and gc sections into report", () => {
  const sections = [timeSection, gcSection];
  const report = createBenchmarkReport("test", [100, 150]);
  const rows = valuesForReports([report], sections);

  expect(rows[0].name).toBe("test");
  expect(rows[0].mean).toBeCloseTo(report.measuredResults.time.avg, 1);
  expect(rows[0].p50).toBeCloseTo(report.measuredResults.time.p50, 1);
  expect(rows[0].p99).toBeCloseTo(report.measuredResults.time.p99, 1);
  expect(rows[0].gc).toBeDefined();
});

test("generates diff columns for baseline comparison", () => {
  const faster = createMeasuredResults([250, 300]);
  const slower = createMeasuredResults([0, 50]);

  const scale = (results: typeof faster, factor: number) => ({
    ...results,
    time: {
      ...results.time,
      avg: results.time.avg * factor,
      p50: results.time.p50 * factor,
      p99: results.time.p99 * factor,
    },
  });

  const group1Reports: BenchmarkReport[] = [
    { name: "version1", measuredResults: scale(faster, 0.8) },
    { name: "version2", measuredResults: scale(slower, 1.2) },
  ];

  const baseline = createBenchmarkReport("baseVersion", [200, 250]);
  const group2Reports = [
    createBenchmarkReport("test3", [300, 350]),
    createBenchmarkReport("test4", [350, 400]),
  ];

  const groups = [
    { name: "group1", reports: group1Reports, baseline },
    { name: "group2", reports: group2Reports },
  ];

  const table = reportResults(groups, [timeSection]);
  const names = ["version1", "version2", "baseVersion", "test3", "test4"];
  for (const name of names) expect(table).toContain(name);
  expect(table).toContain("Δ%");
});

test("defaultReport uses custom sections when provided", () => {
  const locSection: ReportSection = {
    title: "throughput",
    columns: [
      {
        key: "locPerSec",
        title: "lines/sec",
        formatter: integer,
        comparable: true,
        higherIsBetter: true,
        statKind: "mean",
        toDisplay: (ms: number, meta?: Record<string, unknown>) => {
          const lines = (meta?.linesOfCode ?? 0) as number;
          return lines / (ms / 1000);
        },
      },
      {
        key: "lines",
        title: "lines",
        formatter: integer,
        value: (_r, meta) => meta?.linesOfCode ?? 0,
      },
    ],
  };

  const report: BenchmarkReport = {
    name: "parse",
    measuredResults: createMeasuredResults([100, 150]),
    metadata: { linesOfCode: 500 },
  };
  const groups = [{ name: "parser", reports: [report] }];
  const args = parseCliArgs(["--duration", "0.1"]);

  const output = defaultReport(groups, args, { sections: [locSection] });
  expect(output).toContain("throughput");
  expect(output).toContain("lines/sec");
  expect(output).toContain("500");
  // Custom sections replace defaults: the time section's "mean" header should not appear.
  expect(output).not.toContain("| mean ");
});

test("defaultReport falls back to CLI defaults without opts", () => {
  const report = createBenchmarkReport("plain", [100, 150]);
  const groups = [{ name: "g", reports: [report] }];
  const args = parseCliArgs(["--duration", "0.1"]);
  const output = defaultReport(groups, args);
  expect(output).toContain("mean");
  expect(output).toContain("runs");
});

test("formats adaptive convergence statistics", () => {
  const reports: BenchmarkReport[] = [
    createBenchmarkReport("test-adaptive", [400, 500], {
      convergence: { converged: true, confidence: 95, reason: "stable" },
    }),
    createBenchmarkReport("test-low-confidence", [0, 30], {
      convergence: { converged: false, confidence: 65, reason: "unstable" },
    }),
  ];

  const rows = valuesForReports(reports, adaptiveSections);
  expect(rows[0].convergence).toBe(95);
  expect(rows[1].convergence).toBe(65);

  const table = reportResults(
    [{ name: "adaptive", reports }],
    adaptiveSections,
  );
  expect(table).toContain("95%");
  expect(table).toMatch(/65%/);
});
