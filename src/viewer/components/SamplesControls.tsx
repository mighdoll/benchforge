import type { PreparedBenchmark } from "../plots/RenderPlots.ts";
import type { SeriesVisibility } from "../plots/SampleTimeSeries.ts";
import {
  defaultSeriesColor,
  seriesColorMap,
} from "../plots/TimeSeriesSeries.ts";

/** A per-benchmark toggle pill: name, its series color, and whether it's shown. */
interface SeriesPill {
  name: string;
  color: string;
  active: boolean;
}

interface ToggleProps {
  seriesPills: SeriesPill[];
  hasHeap: boolean;
  hasBaselineHeap: boolean;
  hasRejected: boolean;
  hasFullGc: boolean;
  visibility: SeriesVisibility;
  onToggle: (key: keyof SeriesVisibility) => void;
  onToggleBenchmark: (name: string) => void;
}

/** Build a colored toggle pill per benchmark (baseline included), so the
 *  baseline pill and the per-variant pills share one show/hide mechanism. */
export function benchmarkPills(
  benchmarks: PreparedBenchmark[],
  hidden: Set<string>,
): SeriesPill[] {
  const baselineNames = new Set(
    benchmarks.filter(b => b.isBaseline).map(b => b.name),
  );
  const colors = seriesColorMap(benchmarks.map(b => b.name), baselineNames);
  return benchmarks.map(b => ({
    name: b.name,
    color: colors.get(b.name) ?? defaultSeriesColor,
    active: !hidden.has(b.name),
  }));
}

/** Toggle a name's membership in a set, returning a fresh set. */
export function toggledSet(set: Set<string>, name: string): Set<string> {
  const next = new Set(set);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/** Visibility toggles: one pill per benchmark, plus heap, rejected, full GC. */
export function SeriesToggles(props: ToggleProps) {
  const { seriesPills, hasHeap, hasBaselineHeap, hasRejected, hasFullGc } = props;
  const { visibility, onToggle, onToggleBenchmark } = props;
  if (!seriesPills.length && !hasHeap && !hasRejected && !hasFullGc) return null;
  return (
    <div class="series-toggles">
      {seriesPills.map(p => (
        <BenchmarkPill key={p.name} pill={p} onClick={() => onToggleBenchmark(p.name)} />
      ))}
      {hasHeap && <TogglePill label="heap" active={visibility.heap} onClick={() => onToggle("heap")} />}
      {hasBaselineHeap && <TogglePill label="heap (baseline)" active={visibility.baselineHeap} onClick={() => onToggle("baselineHeap")} />}
      {hasRejected && <TogglePill label="rejected" active={visibility.rejected} onClick={() => onToggle("rejected")} />}
      {hasFullGc && <TogglePill label="full GC" active={visibility.fullGc} onClick={() => onToggle("fullGc")} />}
    </div>
  );
}

/** Prev/next stepper for cycling through batches or showing all. */
export function BatchStepper({ batch, total, onChange }: {
  batch: number; total: number; onChange: (batch: number) => void;
}) {
  const prev = () => onChange(batch <= 0 ? total : batch - 1);
  const next = () => onChange(batch >= total ? 0 : batch + 1);
  const label = batch === 0 ? "All" : `Batch ${batch} of ${total}`;
  return (
    <div class="batch-stepper">
      <button class="batch-btn" onClick={prev}>&lsaquo;</button>
      <span class="batch-label">{label}</span>
      <button class="batch-btn" onClick={next}>&rsaquo;</button>
    </div>
  );
}

/** Pill button that toggles a boolean state with active/inactive styling. */
function TogglePill(
  { label, active, onClick }: { label: string; active: boolean; onClick: () => void },
) {
  return (
    <button class={`toggle-pill${active ? " active" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}

/** Toggle pill carrying a benchmark's series color as a leading swatch. */
function BenchmarkPill({ pill, onClick }: { pill: SeriesPill; onClick: () => void }) {
  return (
    <button class={`toggle-pill${pill.active ? " active" : ""}`} onClick={onClick}>
      <span class="pill-swatch" style={{ background: pill.color }} />
      {pill.name}
    </button>
  );
}
