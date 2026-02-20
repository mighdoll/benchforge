import type {
  ReportColumnGroup,
  ReportGroup,
  ResultsMapper,
} from "./BenchmarkReport.ts";
import type { GitVersion } from "./GitUtils.ts";
import type {
  BenchmarkData,
  DifferenceCI,
  FormattedStat,
  GroupData,
  ReportData,
} from "./html/index.ts";
import { bootstrapDifferenceCI } from "./StatisticalUtils.ts";

export interface PrepareHtmlOptions {
  cliArgs?: Record<string, unknown>;
  sections?: ResultsMapper[];
  currentVersion?: GitVersion;
  baselineVersion?: GitVersion;
}

/** Find higherIsBetter from first comparable column in sections */
function findHigherIsBetter(sections?: ResultsMapper[]): boolean {
  const cols = sections?.flatMap(s => s.columns().flatMap(g => g.columns));
  return cols?.find(c => c.comparable)?.higherIsBetter ?? false;
}

/** Flip CI percent for metrics where higher is better (e.g., lines/sec) */
function flipCI(ci: DifferenceCI): DifferenceCI {
  return {
    percent: -ci.percent,
    ci: [-ci.ci[1], -ci.ci[0]],
    direction: ci.direction,
    histogram: ci.histogram?.map(bin => ({ x: -bin.x, count: bin.count })),
  };
}

/** Prepare ReportData from benchmark results for HTML rendering */
export function prepareHtmlData(
  groups: ReportGroup[],
  options: PrepareHtmlOptions,
): ReportData {
  const { cliArgs, sections, currentVersion, baselineVersion } = options;
  const higherIsBetter = findHigherIsBetter(sections);
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
): GroupData {
  const baselineSamples = group.baseline?.measuredResults.samples;
  return {
    name: group.name,
    baseline: group.baseline
      ? prepareBenchmarkData(group.baseline, sections)
      : undefined,
    benchmarks: group.reports.map(report => {
      const samples = report.measuredResults.samples;
      const rawCI =
        baselineSamples && samples
          ? bootstrapDifferenceCI(baselineSamples, samples)
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
): Omit<BenchmarkData, "comparisonCI"> {
  const { measuredResults } = report;
  return {
    name: report.name,
    samples: measuredResults.samples,
    warmupSamples: measuredResults.warmupSamples,
    allocationSamples: measuredResults.allocationSamples,
    heapSamples: measuredResults.heapSamples,
    gcEvents: measuredResults.nodeGcTime?.events,
    optSamples: measuredResults.optSamples,
    pausePoints: measuredResults.pausePoints,
    stats: measuredResults.time,
    heapSize: measuredResults.heapSize,
    sectionStats: sections ? extractSectionStats(report, sections) : undefined,
  };
}

/** @return formatted stats from all sections for tooltip display */
function extractSectionStats(
  report: { measuredResults: any; metadata?: Record<string, unknown> },
  sections: ResultsMapper[],
): FormattedStat[] {
  return sections.flatMap(section => {
    const vals = section.extract(report.measuredResults, report.metadata);
    return section.columns().flatMap(g => formatGroupStats(vals, g));
  });
}

/** @return formatted stats for one column group, skipping undefined values */
function formatGroupStats(
  values: Record<string, unknown>,
  group: ReportColumnGroup<Record<string, unknown>>,
): FormattedStat[] {
  return group.columns
    .map(c => formatColumnStat(values, c, group.groupTitle))
    .filter((s): s is FormattedStat => s !== undefined);
}

type ColumnLike = {
  key: string;
  title: string;
  formatter?: (v: unknown) => string | null;
};

/** @return formatted stat for a single column, or undefined if empty/placeholder */
function formatColumnStat(
  values: Record<string, unknown>,
  col: ColumnLike,
  groupTitle?: string,
): FormattedStat | undefined {
  const raw = values[col.key];
  if (raw === undefined) return undefined;
  const formatted = col.formatter ? col.formatter(raw) : String(raw);
  if (!formatted || formatted === "—" || formatted === "") return undefined;
  return { label: col.title, value: formatted, groupTitle };
}
