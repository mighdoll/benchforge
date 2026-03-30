import type { RunnerOptions } from "../runners/BenchRunner.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { average } from "../stats/StatisticalUtils.ts";
import type { CasesModule } from "./CaseLoader.ts";
import { loadCasesModule } from "./CaseLoader.ts";
import { runMatrixWithDir } from "./MatrixDirRunner.ts";
import { runMatrixInline } from "./MatrixInlineRunner.ts";

/** Stateless variant - called each iteration with case data */
export type VariantFn<T = unknown> = (caseData: T) => void;

/** Stateful variant - setup once, run many */
export interface StatefulVariant<T = unknown, S = unknown> {
  setup: (caseData: T) => S | Promise<S>;
  run: (state: S) => void;
}

/** A variant is either a plain function or a stateful setup+run pair */
export type Variant<T = unknown, S = unknown> =
  | VariantFn<T>
  | StatefulVariant<T, S>;

/** Variant with any state type - used in BenchMatrix to allow mixed variants */
export type AnyVariant<T = unknown> = VariantFn<T> | StatefulVariant<T, any>;

/** Result from casesModule.loadCase() */
export interface LoadedCase<T = unknown> {
  data: T;
  metadata?: Record<string, unknown>;
}

export interface MatrixDefaults {
  warmup?: number;
  maxTime?: number;
  iterations?: number;
}

/** Bench matrix configuration */
export interface BenchMatrix<T = unknown> {
  name: string;
  variantDir?: string;
  variants?: Record<string, AnyVariant<T>>;
  cases?: string[];
  casesModule?: string;
  baselineDir?: string;
  baselineVariant?: string;
  defaults?: MatrixDefaults;
}

/** Collection of matrices */
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
  deltaPercent?: number;
}

/** Results from running a matrix */
export interface MatrixResults {
  name: string;
  variants: VariantResult[];
}

/** Options for runMatrix */
export interface RunMatrixOptions {
  iterations?: number;
  maxTime?: number;
  warmup?: number;
  useWorker?: boolean; // use worker process isolation (default: true for variantDir)
  filteredCases?: string[]; // run only these cases (from filter)
  filteredVariants?: string[]; // run only these variants (from filter)
  // Runner options passthrough
  gcForce?: boolean;
  traceOpt?: boolean;
  noSettle?: boolean;
  pauseFirst?: number;
  pauseInterval?: number;
  pauseDuration?: number;
  gcStats?: boolean;
  alloc?: boolean;
  allocInterval?: number;
  allocDepth?: number;
  timeSample?: boolean;
  timeInterval?: number;
  callCounts?: boolean;
}

/** @return true if variant is a StatefulVariant (has setup + run) */
export function isStatefulVariant<T, S>(
  v: Variant<T, S>,
): v is StatefulVariant<T, S> {
  return typeof v === "object" && "setup" in v && "run" in v;
}

/** Run a BenchMatrix with inline variants or variantDir */
export async function runMatrix<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions = {},
): Promise<MatrixResults> {
  if (matrix.baselineDir && matrix.baselineVariant) {
    throw new Error(
      "BenchMatrix cannot have both 'baselineDir' and 'baselineVariant'",
    );
  }
  const effectiveOptions = { ...matrix.defaults, ...options };

  if (matrix.variantDir) {
    return runMatrixWithDir(matrix, effectiveOptions);
  }
  if (matrix.variants) {
    return runMatrixInline(matrix, effectiveOptions);
  }
  throw new Error("BenchMatrix requires either 'variants' or 'variantDir'");
}

/** Apply baselineVariant comparison - one variant is the reference for all others */
export function applyBaselineVariant(
  variants: VariantResult[],
  baselineVariantId: string,
): void {
  const baselineVariant = variants.find(v => v.id === baselineVariantId);
  if (!baselineVariant) return;

  const baselineByCase = new Map(
    baselineVariant.cases.map(c => [c.caseId, c.measured]),
  );

  for (const variant of variants) {
    if (variant.id === baselineVariantId) continue;
    for (const cr of variant.cases) {
      const base = baselineByCase.get(cr.caseId);
      if (base) {
        cr.baseline = base;
        cr.deltaPercent = computeDeltaPercent(base, cr.measured);
      }
    }
  }
}

/** Load cases module and resolve filtered case IDs */
export async function resolveCases<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<{ casesModule: CasesModule<T> | undefined; caseIds: string[] }> {
  const casesModule = matrix.casesModule
    ? await loadCasesModule<T>(matrix.casesModule)
    : undefined;
  const allCaseIds = casesModule?.cases ?? matrix.cases ?? ["default"];
  const caseIds = options.filteredCases ?? allCaseIds;
  return { casesModule, caseIds };
}

/** Convert matrix options to runner options */
export function buildRunnerOptions(options: RunMatrixOptions): RunnerOptions {
  return {
    maxIterations: options.iterations,
    maxTime: options.maxTime ?? 1000,
    warmup: options.warmup ?? 0,
    gcForce: options.gcForce,
    traceOpt: options.traceOpt,
    noSettle: options.noSettle,
    pauseFirst: options.pauseFirst,
    pauseInterval: options.pauseInterval,
    pauseDuration: options.pauseDuration,
    gcStats: options.gcStats,
    alloc: options.alloc,
    allocInterval: options.allocInterval,
    allocDepth: options.allocDepth,
    timeSample: options.timeSample,
    timeInterval: options.timeInterval,
    callCounts: options.callCounts,
  };
}

/** Compute delta percentage: (current - baseline) / baseline * 100 */
export function computeDeltaPercent(
  base: MeasuredResults,
  cur: MeasuredResults,
): number {
  const avg = average(base.samples);
  if (avg === 0) return 0;
  return ((average(cur.samples) - avg) / avg) * 100;
}
