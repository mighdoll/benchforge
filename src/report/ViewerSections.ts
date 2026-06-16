import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type { BootstrapResult, DifferenceCI } from "../stats/Bootstrap.ts";
import type { ViewerRow, ViewerSection } from "../viewer/ReportData.ts";
import type {
  ComparisonOptions,
  MetricSection,
  ReportSection,
  ScalarSection,
  UnknownRecord,
} from "./BenchmarkReport.ts";
import { metricRow, scalarRow } from "./ViewerRows.ts";

/** One display track in a case: a measured series and, for a comparison track,
 *  the paired baseline it diffs against. The baseline track has no `baseline`. */
export interface CaseTrack {
  name: string;
  measured: MeasuredResults;
  meta?: UnknownRecord;
  isBaseline: boolean;
  baseline?: { measured: MeasuredResults; meta?: UnknownRecord; name: string };
}

/** The tracks of one case plus the comparison options driving its stats. */
export interface CaseContext {
  tracks: CaseTrack[];
  comparison?: ComparisonOptions;
}

/** Per-section reusable bootstrap results, indexed by track order. Supplying a
 *  cached `track[i]` / `diff[i]` causes the metric-row build to skip the matching
 *  bootstrap and reuse it -- used to share computation between the trim and raw
 *  views when trimming is a no-op for that track. */
export interface SectionCICache {
  /** Per-track absolute-stat bootstrap (metric row), aligned to tracks. */
  track?: (BootstrapResult | undefined)[];
  /** Per-track diff vs the track's baseline (metric row); undefined on baseline. */
  diff?: (DifferenceCI | undefined)[];
}

/** Build track-columned ViewerSections from ReportSections: one ViewerEntry per
 *  track, with bootstrap CIs and a per-comparison-track diff + shift function.
 *  Display values use samples with slow-outlier batches removed unless
 *  comparison.noBatchTrim. Returns per-section bootstrap caches so a second call
 *  (the raw view) can reuse results for tracks trimming left untouched. */
export function buildViewerSections(
  sections: ReportSection[],
  ctx: CaseContext,
  reuseCaches?: SectionCICache[],
): { sections: ViewerSection[]; caches: SectionCICache[] } {
  const caches: SectionCICache[] = [];
  const viewerSections: ViewerSection[] = [];
  sections.forEach((section, i) => {
    const cache: SectionCICache = {};
    const layout = section.kind === "scalar" ? section.layout : undefined;
    const placement = section.kind === "scalar" ? section.placement : undefined;
    const rows =
      section.kind === "metric"
        ? metricRows(section, ctx, reuseCaches?.[i], cache)
        : scalarRows(section, ctx);
    caches[i] = cache;
    if (rows.length)
      viewerSections.push({ title: section.title, rows, layout, placement });
  });
  return { sections: viewerSections, caches };
}

/** Build the rows for a metric section: one comparable metric row (one cell per
 *  track, marked primary) followed by its scalar extras. */
function metricRows(
  section: MetricSection,
  ctx: CaseContext,
  reuse: SectionCICache | undefined,
  cache: SectionCICache,
): ViewerRow[] {
  const row = metricRow(section, ctx, reuse, cache);
  const extras = (section.extras ?? []).flatMap(r => {
    const out = scalarRow(r, ctx);
    return out ? [out] : [];
  });
  return [row, ...extras];
}

/** Build the rows for a scalar section: one row per scalar row. */
function scalarRows(section: ScalarSection, ctx: CaseContext): ViewerRow[] {
  return section.rows.flatMap(r => {
    const out = scalarRow(r, ctx);
    return out ? [out] : [];
  });
}
