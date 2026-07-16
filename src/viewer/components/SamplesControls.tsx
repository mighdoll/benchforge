import type { PreparedBenchmark } from "../plots/RenderPlots.ts";
import type { SeriesVisibility } from "../plots/SampleTimeSeries.ts";
import {
  defaultSeriesColor,
  gcSeriesLabel,
  seriesColorMap,
} from "../plots/TimeSeriesSeries.ts";

/** A per-benchmark toggle pill: name, its series color, and whether it's shown. */
interface SeriesPill {
  name: string;
  color: string;
  active: boolean;
}

/** A GC toggle pill for one series with full-GC events: the benchmark name (the
 *  gcShown key), its display label, series color, and whether it's on. */
interface GcPill {
  name: string;
  label: string;
  color: string;
  active: boolean;
}

interface ToggleProps {
  seriesPills: SeriesPill[];
  gcPills: GcPill[];
  hasHeap: boolean;
  hasBaselineHeap: boolean;
  hasRejected: boolean;
  visibility: SeriesVisibility;
  onToggle: (key: keyof SeriesVisibility) => void;
  onToggleBenchmark: (name: string) => void;
  onToggleGc: (name: string) => void;
}

/** Build a colored toggle pill per benchmark (baseline included), so the
 *  baseline pill and the per-variant pills share one show/hide mechanism. */
export function benchmarkPills(
  benchmarks: PreparedBenchmark[],
  hidden: Set<string>,
): SeriesPill[] {
  const colors = benchmarkColors(benchmarks);
  return benchmarks.map(b => ({
    name: b.name,
    color: colors.get(b.name) ?? defaultSeriesColor,
    active: !hidden.has(b.name),
  }));
}

/** One GC pill per series with mark-compact events, colored to match its dots.
 *  A pill is active only when its series is in gcShown (GC marks hidden by
 *  default). A variant with no full GCs gets no pill. */
export function gcPills(
  benchmarks: PreparedBenchmark[],
  gcSeriesNames: string[],
  gcShown: Set<string>,
): GcPill[] {
  const colors = benchmarkColors(benchmarks);
  const gcSet = new Set(gcSeriesNames);
  const series = benchmarks.filter(b => gcSet.has(b.name));
  const multiCurrent = series.filter(b => !b.isBaseline).length > 1;
  return series.map(b => ({
    name: b.name,
    label: gcSeriesLabel(b.name, b.isBaseline, multiCurrent),
    color: colors.get(b.name) ?? defaultSeriesColor,
    active: gcShown.has(b.name),
  }));
}

/** Toggle a name's membership in a set, returning a fresh set. */
export function toggledSet(set: Set<string>, name: string): Set<string> {
  const next = new Set(set);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/** Visibility toggles: one pill per benchmark, plus heap, rejected, per-series GC. */
export function SeriesToggles(props: ToggleProps) {
  const { seriesPills, gcPills, hasHeap, hasBaselineHeap, hasRejected } = props;
  const { visibility, onToggle, onToggleBenchmark, onToggleGc } = props;
  if (!seriesPills.length && !hasHeap && !hasRejected && !gcPills.length)
    return null;
  return (
    <div class="series-toggles">
      {seriesPills.map(p => (
        <SwatchPill
          key={p.name}
          label={p.name}
          color={p.color}
          active={p.active}
          onClick={() => onToggleBenchmark(p.name)}
        />
      ))}
      {hasHeap && (
        <TogglePill
          label="heap"
          title="Overlay heap size: the allocation sawtooth between collections"
          active={visibility.heap}
          onClick={() => onToggle("heap")}
        />
      )}
      {hasBaselineHeap && (
        <TogglePill
          label="heap (baseline)"
          title="Overlay the baseline's heap size"
          active={visibility.baselineHeap}
          onClick={() => onToggle("baselineHeap")}
        />
      )}
      {hasRejected && (
        <TogglePill
          label="rejected"
          title="Highlight samples in batches removed by noise rejection"
          active={visibility.rejected}
          onClick={() => onToggle("rejected")}
        />
      )}
      {gcPills.map(p => (
        <SwatchPill
          key={`gc-${p.name}`}
          label={p.label}
          color={p.color}
          title="Mark where major (full) garbage collections occurred"
          active={p.active}
          onClick={() => onToggleGc(p.name)}
        />
      ))}
    </div>
  );
}

/** Prev/next stepper for cycling through batches or showing all. */
export function BatchStepper({
  batch,
  total,
  onChange,
}: {
  batch: number;
  total: number;
  onChange: (batch: number) => void;
}) {
  const prev = () => onChange(batch <= 0 ? total : batch - 1);
  const next = () => onChange(batch >= total ? 0 : batch + 1);
  const label = batch === 0 ? "All" : `Batch ${batch} of ${total}`;
  return (
    <div class="batch-stepper">
      <button class="batch-btn" onClick={prev}>
        &lsaquo;
      </button>
      <span class="batch-label">{label}</span>
      <button class="batch-btn" onClick={next}>
        &rsaquo;
      </button>
    </div>
  );
}

/** Series color per benchmark name (baselines sorted last), shared by the
 *  benchmark and GC pills so swatches match the plot dots. */
function benchmarkColors(benchmarks: PreparedBenchmark[]): Map<string, string> {
  const baselineNames = new Set(
    benchmarks.filter(b => b.isBaseline).map(b => b.name),
  );
  return seriesColorMap(
    benchmarks.map(b => b.name),
    baselineNames,
  );
}

/** Toggle pill carrying a series color as a leading swatch (benchmarks and GC). */
function SwatchPill({
  label,
  color,
  title,
  active,
  onClick,
}: {
  label: string;
  color: string;
  title?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      class={`toggle-pill${active ? " active" : ""}`}
      title={title}
      onClick={onClick}
    >
      <span class="pill-swatch" style={{ background: color }} />
      {label}
    </button>
  );
}

/** Pill button that toggles a boolean state with active/inactive styling. */
function TogglePill({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      class={`toggle-pill${active ? " active" : ""}`}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
