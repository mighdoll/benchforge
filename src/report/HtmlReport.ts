import { bootstrapDifferenceCI, flipCI } from "../stats/StatisticalUtils.ts";
import type {
  BenchmarkEntry,
  BenchmarkGroup,
  ReportData,
  SectionStat,
} from "../viewer/ReportData.ts";
import {
  isHigherIsBetter,
  type ReportGroup,
  type ResultsMapper,
} from "./BenchmarkReport.ts";
import type { GitVersion } from "./GitUtils.ts";

/** Options for prepareHtmlData: report sections, git versions, and CLI args */
export interface PrepareHtmlOptions {
  cliArgs?: Record<string, unknown>;
  sections?: ResultsMapper[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

type ColumnLike = {
  key: string;
  title: string;
  formatter?: (v: unknown) => string | null;
};

/** Convert benchmark results into a ReportData payload for the HTML viewer */
export function prepareHtmlData(
  groups: ReportGroup[],
  options: PrepareHtmlOptions,
): ReportData {
  const { cliArgs, sections, currentVersion, baselineVersion } = options;
  const higherIsBetter = sections ? isHigherIsBetter(sections) : false;
  return {
    groups: groups.map(group =>
      prepareGroupData(group, sections, higherIsBetter),
    ),
    metadata: {
      timestamp: new Date().toISOString(),
      bencherVersion: process.env.npm_package_version || "unknown",
      cliArgs,
      gcTrackingEnabled: cliArgs?.["gc-stats"] === true,
      currentVersion,
      baselineVersion,
    },
  };
}

/** @return group data with bootstrap CI comparisons against baseline */
function prepareGroupData(
  group: ReportGroup,
  sections?: ResultsMapper[],
  higherIsBetter?: boolean,
): BenchmarkGroup {
  const base = group.baseline;
  const baseSamples = base?.measuredResults.samples;
  const baseData = base ? prepareBenchmarkData(base, sections) : undefined;
  const baseline = baseData
    ? { ...baseData, comparisonCI: undefined }
    : undefined;
  return {
    name: group.name,
    baseline,
    benchmarks: group.reports.map(report => {
      const samples = report.measuredResults.samples;
      const rawCI =
        baseSamples && samples
          ? bootstrapDifferenceCI(baseSamples, samples)
          : undefined;
      const comparisonCI = rawCI && higherIsBetter ? flipCI(rawCI) : rawCI;
      return { ...prepareBenchmarkData(report, sections), comparisonCI };
    }),
  };
}

/** @return benchmark data with samples, stats, and formatted section values */
function prepareBenchmarkData(
  report: {
    name: string;
    measuredResults: any;
    metadata?: Record<string, unknown>;
  },
  sections?: ResultsMapper[],
): Omit<BenchmarkEntry, "comparisonCI"> {
  const m = report.measuredResults;
  return {
    name: report.name,
    samples: m.samples,
    warmupSamples: m.warmupSamples,
    allocationSamples: m.allocationSamples,
    heapSamples: m.heapSamples,
    gcEvents: m.nodeGcTime?.events,
    optSamples: m.optSamples,
    pausePoints: m.pausePoints,
    stats: m.time,
    heapSize: m.heapSize,
    sectionStats: sections ? extractSectionStats(report, sections) : undefined,
  };
}

/** @return formatted stats from all sections for tooltip display */
function extractSectionStats(
  report: { measuredResults: any; metadata?: Record<string, unknown> },
  sections: ResultsMapper[],
): SectionStat[] {
  return sections.flatMap(section => {
    const vals = section.extract(report.measuredResults, report.metadata);
    return section
      .columns()
      .flatMap(g => g.columns.map(c => formatColumnStat(vals, c, g.groupTitle)))
      .filter((stat): stat is SectionStat => stat !== undefined);
  });
}

/** @return formatted stat for a single column, or undefined if empty/placeholder */
function formatColumnStat(
  values: Record<string, unknown>,
  col: ColumnLike,
  groupTitle?: string,
): SectionStat | undefined {
  const raw = values[col.key];
  if (raw === undefined) return undefined;
  const formatted = col.formatter ? col.formatter(raw) : String(raw);
  if (!formatted || formatted === "—" || formatted === "") return undefined;
  return { label: col.title, value: formatted, groupTitle };
}
