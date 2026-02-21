import type { MeasuredResults } from "./MeasuredResults.ts";
import { loadCaseData, loadCasesModule } from "./matrix/CaseLoader.ts";
import { discoverVariants } from "./matrix/VariantLoader.ts";
import { BasicRunner } from "./runners/BasicRunner.ts";
import type { RunnerOptions } from "./runners/BenchRunner.ts";
import { runMatrixVariant } from "./runners/RunnerOrchestrator.ts";
import { average } from "./StatisticalUtils.ts";

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

/** @return true if variant is a StatefulVariant (has setup + run) */
export function isStatefulVariant<T, S>(
  v: Variant<T, S>,
): v is StatefulVariant<T, S> {
  return typeof v === "object" && "setup" in v && "run" in v;
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
  collect?: boolean;
  cpuCounters?: boolean;
  traceOpt?: boolean;
  noSettle?: boolean;
  pauseFirst?: number;
  pauseInterval?: number;
  pauseDuration?: number;
  gcStats?: boolean;
  heapSample?: boolean;
  heapInterval?: number;
  heapDepth?: number;
}

/** Run a BenchMatrix with inline variants or variantDir */
export async function runMatrix<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions = {},
): Promise<MatrixResults> {
  validateBaseline(matrix);
  const effectiveOptions = { ...matrix.defaults, ...options };

  if (matrix.variantDir) {
    return runMatrixWithDir(matrix, effectiveOptions);
  }
  if (matrix.variants) {
    return runMatrixInline(matrix, effectiveOptions);
  }
  throw new Error("BenchMatrix requires either 'variants' or 'variantDir'");
}

/** @throws if both baselineDir and baselineVariant are set */
function validateBaseline<T>(matrix: BenchMatrix<T>): void {
  const msg =
    "BenchMatrix cannot have both 'baselineDir' and 'baselineVariant'";
  if (matrix.baselineDir && matrix.baselineVariant) throw new Error(msg);
}

function buildRunnerOptions(options: RunMatrixOptions): RunnerOptions {
  return {
    maxIterations: options.iterations,
    maxTime: options.maxTime ?? 1000,
    warmup: options.warmup ?? 0,
    collect: options.collect,
    cpuCounters: options.cpuCounters,
    traceOpt: options.traceOpt,
    noSettle: options.noSettle,
    pauseFirst: options.pauseFirst,
    pauseInterval: options.pauseInterval,
    pauseDuration: options.pauseDuration,
    gcStats: options.gcStats,
    heapSample: options.heapSample,
    heapInterval: options.heapInterval,
    heapDepth: options.heapDepth,
  };
}

/** Load cases module and resolve filtered case IDs */
async function resolveCases<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
) {
  const casesModule = matrix.casesModule
    ? await loadCasesModule<T>(matrix.casesModule)
    : undefined;
  const allCaseIds = casesModule?.cases ?? matrix.cases ?? ["default"];
  const caseIds = options.filteredCases ?? allCaseIds;
  return { casesModule, caseIds };
}

/** Run matrix with inline variants (non-worker mode) */
async function runMatrixInline<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<MatrixResults> {
  // baselineDir is only valid with variantDir
  const msg =
    "BenchMatrix with inline 'variants' cannot use 'baselineDir'. Use 'variantDir' instead.";
  if (matrix.baselineDir) throw new Error(msg);

  const { casesModule, caseIds } = await resolveCases(matrix, options);
  const runner = new BasicRunner();
  const runnerOpts = buildRunnerOptions(options);

  const variantEntries = options.filteredVariants
    ? Object.entries(matrix.variants!).filter(([id]) =>
        options.filteredVariants!.includes(id),
      )
    : Object.entries(matrix.variants!);

  const variants: VariantResult[] = [];
  for (const [variantId, variant] of variantEntries) {
    const cases: CaseResult[] = [];
    for (const caseId of caseIds) {
      const loaded = await loadCaseData(casesModule, caseId);
      const caseData =
        casesModule || matrix.cases ? loaded.data : (undefined as T);
      const measured = await runVariant(
        variant,
        caseData,
        variantId,
        runner,
        runnerOpts,
      );
      cases.push({ caseId, measured, metadata: loaded.metadata });
    }
    variants.push({ id: variantId, cases });
  }

  if (matrix.baselineVariant) {
    applyBaselineVariant(variants, matrix.baselineVariant);
  }

  return { name: matrix.name, variants };
}

/** Context for running matrix benchmarks in worker mode */
interface DirMatrixContext<T> {
  matrix: BenchMatrix<T>;
  casesModule?: import("./matrix/CaseLoader.ts").CasesModule<T>;
  baselineIds: string[];
  caseIds: string[];
  runnerOpts: RunnerOptions;
}

/** Run matrix with variantDir (worker mode for memory isolation) */
async function runMatrixWithDir<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<MatrixResults> {
  const allVariantIds = await discoverVariants(matrix.variantDir!);
  if (allVariantIds.length === 0) {
    throw new Error(`No variants found in ${matrix.variantDir}`);
  }
  const variantIds = options.filteredVariants ?? allVariantIds;

  const ctx = await createDirContext(matrix, options);
  const variants = await runDirVariants(variantIds, ctx);

  if (matrix.baselineVariant) {
    applyBaselineVariant(variants, matrix.baselineVariant);
  }
  return { name: matrix.name, variants };
}

/** Create context for directory-based matrix execution */
async function createDirContext<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<DirMatrixContext<T>> {
  const baselineIds = matrix.baselineDir
    ? await discoverVariants(matrix.baselineDir)
    : [];
  const { casesModule, caseIds } = await resolveCases(matrix, options);
  const runnerOpts = buildRunnerOptions(options);
  return { matrix, casesModule, baselineIds, caseIds, runnerOpts };
}

/** Run all variants using worker processes */
async function runDirVariants<T>(
  variantIds: string[],
  ctx: DirMatrixContext<T>,
): Promise<VariantResult[]> {
  const variants: VariantResult[] = [];
  for (const variantId of variantIds) {
    const cases = await runDirVariantCases(variantId, ctx);
    variants.push({ id: variantId, cases });
  }
  return variants;
}

/** Run all cases for a single variant */
async function runDirVariantCases<T>(
  variantId: string,
  ctx: DirMatrixContext<T>,
): Promise<CaseResult[]> {
  const { matrix, casesModule, caseIds, runnerOpts } = ctx;
  const cases: CaseResult[] = [];

  for (const caseId of caseIds) {
    const caseData = !matrix.casesModule && matrix.cases ? caseId : undefined;
    const [measured] = await runMatrixVariant({
      variantDir: matrix.variantDir!,
      variantId,
      caseId,
      caseData,
      casesModule: matrix.casesModule,
      runner: "basic",
      options: runnerOpts,
    });

    const loaded = await loadCaseData(casesModule, caseId);
    const baseline = await runBaselineIfExists(
      variantId,
      caseId,
      caseData,
      ctx,
    );
    const deltaPercent = baseline
      ? computeDeltaPercent(baseline, measured)
      : undefined;
    const metadata = loaded.metadata;
    cases.push({ caseId, measured, metadata, baseline, deltaPercent });
  }
  return cases;
}

/** Run baseline variant if it exists in baselineDir */
async function runBaselineIfExists<T>(
  variantId: string,
  caseId: string,
  caseData: unknown,
  ctx: DirMatrixContext<T>,
): Promise<MeasuredResults | undefined> {
  const { matrix, baselineIds, runnerOpts } = ctx;
  if (!matrix.baselineDir || !baselineIds.includes(variantId)) return undefined;

  const [measured] = await runMatrixVariant({
    variantDir: matrix.baselineDir,
    variantId,
    caseId,
    caseData,
    casesModule: matrix.casesModule,
    runner: "basic",
    options: runnerOpts,
  });
  return measured;
}

/** Compute delta percentage: (current - baseline) / baseline * 100 */
function computeDeltaPercent(
  baseline: MeasuredResults,
  current: MeasuredResults,
): number {
  const baseAvg = average(baseline.samples);
  if (baseAvg === 0) return 0;
  return ((average(current.samples) - baseAvg) / baseAvg) * 100;
}

/** Apply baselineVariant comparison - one variant is the reference for all others */
function applyBaselineVariant(
  variants: VariantResult[],
  baselineVariantId: string,
): void {
  const baselineVariant = variants.find(v => v.id === baselineVariantId);
  if (!baselineVariant) return;

  const baselineByCase = new Map<string, MeasuredResults>();
  for (const c of baselineVariant.cases) {
    baselineByCase.set(c.caseId, c.measured);
  }

  for (const variant of variants) {
    if (variant.id === baselineVariantId) continue;
    for (const caseResult of variant.cases) {
      const baseline = baselineByCase.get(caseResult.caseId);
      if (baseline) {
        caseResult.baseline = baseline;
        caseResult.deltaPercent = computeDeltaPercent(
          baseline,
          caseResult.measured,
        );
      }
    }
  }
}

/** Run a single variant with case data */
async function runVariant<T>(
  variant: AnyVariant<T>,
  caseData: T,
  name: string,
  runner: BasicRunner,
  options: RunnerOptions,
): Promise<MeasuredResults> {
  if (isStatefulVariant(variant)) {
    const state = await variant.setup(caseData);
    const [result] = await runner.runBench(
      { name, fn: () => variant.run(state) },
      options,
    );
    return result;
  }
  const [result] = await runner.runBench(
    { name, fn: () => variant(caseData) },
    options,
  );
  return result;
}
