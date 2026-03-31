import { writeFile } from "node:fs/promises";
import type { DefaultCliArgs } from "../cli/CliArgs.ts";
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import type {
  BenchmarkGroup,
  BenchmarkJsonData,
  BenchmarkResult,
} from "./JsonFormat.ts";

/** Export benchmark results to a JSON file with stats, metadata, and environment info. */
export async function exportBenchmarkJson(
  groups: ReportGroup[],
  outputPath: string,
  args: DefaultCliArgs,
  suiteName = "Benchmark Suite",
): Promise<void> {
  const jsonData = prepareJsonData(groups, args, suiteName);
  const jsonString = JSON.stringify(jsonData, null, 2);

  await writeFile(outputPath, jsonString, "utf-8");
  console.log(`Benchmark data exported to: ${outputPath}`);
}

/** Convert ReportGroup data to JSON format */
function prepareJsonData(
  groups: ReportGroup[],
  args: DefaultCliArgs,
  suiteName: string,
): BenchmarkJsonData {
  return {
    meta: {
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || "unknown",
      args: cleanCliArgs(args),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    },
    suites: [
      {
        name: suiteName,
        groups: groups.map(convertGroup),
      },
    ],
  };
}

/** Clean CLI args for JSON export (remove undefined values, camelCase keys) */
function cleanCliArgs(args: DefaultCliArgs): Record<string, any> {
  const toCamelCase = (k: string) =>
    k.replace(/-([a-z])/g, (_, l) => l.toUpperCase());
  const entries = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [toCamelCase(k), v]);
  return Object.fromEntries(entries);
}

/** Convert a report group, mapping each report to the JSON result format */
function convertGroup(group: ReportGroup): BenchmarkGroup {
  return {
    name: "Benchmark Group", // Could be enhanced to include actual group names
    baseline: group.baseline ? convertReport(group.baseline) : undefined,
    benchmarks: group.reports.map(convertReport),
  };
}

/** Extract measured stats and optional metrics into JSON result shape */
function convertReport(report: any): BenchmarkResult {
  const { name, measuredResults } = report;
  const { time, heapSize, gcTime } = measuredResults;
  const minMaxMean = (s: any) =>
    s ? { min: s.min, max: s.max, mean: s.avg } : undefined;

  return {
    name,
    status: "completed",
    samples: measuredResults.samples || [],
    time: {
      ...minMaxMean(time)!,
      p50: time.p50,
      p75: time.p75,
      p99: time.p99,
      p999: time.p999,
    },
    heapSize: minMaxMean(heapSize),
    gcTime: minMaxMean(gcTime),
    execution: {
      iterations: measuredResults.samples?.length || 0,
      totalTime: measuredResults.totalTime || 0,
      warmupRuns: undefined, // Not available in current data structure
    },
  };
}
