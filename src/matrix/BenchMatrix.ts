import type { RunnerOptions } from "../runners/BenchRunner.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { average } from "../stats/StatisticalUtils.ts";
import type { CasesModule } from "./CaseLoader.ts";
import { loadCasesModule } from "./CaseLoader.ts";
import { runMatrixWithDir } from "./MatrixDirRunner.ts";
import { runMatrixInline } from "./MatrixInlineRunner.ts";

/** Stateless variant: called each iteration with case data. */
export type VariantFn<T = unknown> = (caseData: T) => void;

/** Stateful variant: setup once, run many. */
export interface StatefulVariant<T = unknown, S = unknown> {
  setup: (caseData: T) => S | Promise<S>;
  run: (state: S) => void;
}

/** A variant is either a plain function or a stateful setup+run pair */
export type Variant<T = unknown, S = unknown> =
  | VariantFn<T>
  | StatefulVariant<T, S>;

/** Variant with any state type, allowing mixed variants in a matrix */
export type AnyVariant<T = unknown> = VariantFn<T> | StatefulVariant<T, any>;

/** Case data and optional metadata returned by a cases module */
export interface LoadedCase<T = unknown> {
  data: T;
  metadata?: Record<string, unknown>;
}

/** Default runner settings applied to all matrix benchmarks */
export interface MatrixDefaults {
  warmup?: number;
  maxTime?: number;
  iterations?: number;
}

/** Inline case data: each value is the case's data, or a thunk producing it
 *  (called once in the parent, like a shared setup). Use instead of casesModule
 *  for self-contained data that needs no module/dir. */
export type InlineCases<T> = Record<string, T | (() => T | Promise<T>)>;

/** Configuration for a cases x variants benchmark matrix */
export interface BenchMatrix<T = unknown> {
  name: string;
  variantDir?: string;
  variants?: Record<string, AnyVariant<T>>;
  cases?: string[];
  /** Inline case data keyed by case id (alternative to cases/casesModule). */
  caseData?: InlineCases<T>;
  casesModule?: string;
  baselineDir?: string;
  baselineVariant?: string;
  defaults?: MatrixDefaults;
}

/** Named collection of benchmark matrices */
export interface MatrixSuite {
  name: string;
  matrices: BenchMatrix<any>[];
}

/** Results for a single variant across all cases */
export interface VariantResult {
  id: string;
  cases: CaseResult[];
}

/** Results for a single (variant, case) pair */
export interface CaseResult {
  caseId: string;
  measured: MeasuredResults;
  metadata?: Record<string, unknown>;
  baseline?: MeasuredResults;
  /** Variant id that produced `baseline` (the reference variant for
   *  baselineVariant, or this variant's own id for a baselineDir comparison). */
  baselineId?: string;
  deltaPercent?: number;
}

/** Aggregated results from running a benchmark matrix */
export interface MatrixResults {
  name: string;
  variants: VariantResult[];
}

/** Options for {@link runMatrix} */
export interface RunMatrixOptions {
  /** Maximum iterations per benchmark */
  iterations?: number;
  /** Maximum time in ms per benchmark */
  maxTime?: number;
  /** Number of warmup iterations before measurement */
  warmup?: number;
  /** Use worker process isolation (default: true for variantDir) */
  useWorker?: boolean;
  /** Number of interleaved batches for baseline comparison */
  batches?: number;
  /** Include first batch in results (normally dropped for OS cache warmup) */
  warmupBatch?: boolean;
  /** Measure the noise floor (current-vs-current) instead of comparing variants */
  calibrate?: boolean;
  /** Number of self-comparison repetitions when calibrating */
  calibrateRuns?: number;
  /** Run only these cases (from --filter) */
  filteredCases?: string[];
  /** Run only these variants (from --filter) */
  filteredVariants?: string[];
  /** Force garbage collection between iterations */
  gcForce?: boolean;
  /** Pause duration in ms before warmup begins */
  pauseWarmup?: number;
  /** Pause duration in ms before first measurement */
  pauseFirst?: number;
  /** Pause every N iterations during measurement */
  pauseInterval?: number;
  /** Duration of each pause in ms */
  pauseDuration?: number;
  /** Collect GC statistics via --trace-gc-nvp */
  gcStats?: boolean;
  /** Enable heap allocation profiling */
  alloc?: boolean;
  /** Heap sampling interval in bytes */
  allocInterval?: number;
  /** Maximum stack depth for allocation traces */
  allocDepth?: number;
  /** Enable CPU time profiling */
  profile?: boolean;
  /** CPU profiling sample interval in microseconds */
  profileInterval?: number;
  /** Track function call counts via V8 coverage */
  callCounts?: boolean;
}

/** Run a BenchMatrix with inline variants or variantDir */
export async function runMatrix<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions = {},
): Promise<MatrixResults> {
  if (matrix.baselineDir && matrix.baselineVariant)
    throw new Error(
      "BenchMatrix cannot have both 'baselineDir' and 'baselineVariant'",
    );
  if (!matrix.variantDir && !matrix.variants)
    throw new Error("BenchMatrix requires either 'variants' or 'variantDir'");

  const effectiveOptions = { ...matrix.defaults, ...options };
  // baselineVariant is interleaved per-variant inside the runners (like
  // baselineDir), so each variant is paired against its own measurement of the
  // reference rather than compared post-hoc against a single shared run.
  return matrix.variantDir
    ? runMatrixWithDir(matrix, effectiveOptions)
    : runMatrixInline(matrix, effectiveOptions);
}

/** Prepare a benchmark function from a variant, calling setup if stateful. */
export async function prepareBenchFn<T>(
  variant: Variant<T>,
  data: T,
): Promise<() => void> {
  if (isStatefulVariant(variant)) {
    const state = await variant.setup(data);
    return () => variant.run(state);
  }
  return () => variant(data);
}

/** Type guard for StatefulVariant */
export function isStatefulVariant<T, S>(
  v: Variant<T, S>,
): v is StatefulVariant<T, S> {
  return typeof v === "object" && "setup" in v && "run" in v;
}

/** Load cases module and resolve filtered case IDs. Inline caseData keys take
 *  precedence over cases[] / the casesModule's case list. */
export async function resolveCases<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<{ casesModule: CasesModule<T> | undefined; caseIds: string[] }> {
  const casesModule = matrix.casesModule
    ? await loadCasesModule<T>(matrix.casesModule)
    : undefined;
  const inlineIds = matrix.caseData ? Object.keys(matrix.caseData) : undefined;
  const allCaseIds = inlineIds ??
    casesModule?.cases ??
    matrix.cases ?? ["default"];
  const caseIds = options.filteredCases ?? allCaseIds;
  return { casesModule, caseIds };
}

/** Resolve one inline case's data, invoking it if it's a thunk. */
export async function resolveInlineCase<T>(
  caseData: InlineCases<T>,
  caseId: string,
): Promise<T> {
  const value = caseData[caseId];
  if (typeof value === "function") return (value as () => T | Promise<T>)();
  return value;
}

/** Map matrix options to runner options, applying defaults for maxTime and warmup */
export function buildRunnerOptions(opts: RunMatrixOptions): RunnerOptions {
  const {
    filteredCases,
    filteredVariants,
    useWorker,
    batches,
    warmupBatch,
    calibrate,
    calibrateRuns,
    ...base
  } = opts;
  const { iterations, maxTime, warmup, ...rest } = base;
  return {
    maxIterations: iterations,
    maxTime: maxTime ?? (iterations ? undefined : 1000),
    warmup: warmup ?? 0,
    ...rest,
  };
}

/** Compute percentage change of current vs baseline mean */
export function computeDeltaPercent(
  base: MeasuredResults,
  cur: MeasuredResults,
): number {
  const avg = average(base.samples);
  if (avg === 0) return 0;
  return ((average(cur.samples) - avg) / avg) * 100;
}
