import type { RunnerOptions } from "../runners/BenchRunner.ts";
import {
  type CalibrationResult,
  type RunProgress,
  runCalibration,
} from "../runners/Calibration.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { runBatched } from "../runners/MergeBatches.ts";
import { runMatrixVariant } from "../runners/RunnerOrchestrator.ts";
import type {
  BenchMatrix,
  CaseResult,
  RunMatrixOptions,
  VariantResult,
} from "./BenchMatrix.ts";
import {
  buildRunnerOptions,
  computeDeltaPercent,
  resolveCases,
} from "./BenchMatrix.ts";
import type { CasesModule } from "./CaseLoader.ts";
import { loadCaseData } from "./CaseLoader.ts";
import { discoverVariants } from "./VariantLoader.ts";

type VariantArgs = Parameters<typeof runMatrixVariant>[0];

/** Shared state for directory-based matrix execution */
interface DirMatrixContext<T> {
  matrix: BenchMatrix<T>;
  casesModule?: CasesModule<T>;
  baselineIds: string[];
  caseIds: string[];
  runnerOpts: RunnerOptions;
  batches: number;
  warmupBatch: boolean;
  useWorker: boolean;
}

/** Run matrix using variant files from a directory, each in a worker process */
export async function runMatrixWithDir<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<{ name: string; variants: VariantResult[] }> {
  const allVariantIds = await discoverVariants(matrix.variantDir!);
  if (allVariantIds.length === 0) {
    throw new Error(`No variants found in ${matrix.variantDir}`);
  }
  const variantIds = options.filteredVariants ?? allVariantIds;

  const ctx = await createDirContext(matrix, options);
  const variants = await runDirVariants(variantIds, ctx);
  return { name: matrix.name, variants };
}

/** Measure the harness noise floor for one variant/case (current vs current).
 *  Uses the first filtered variant + case so calibration runs a single
 *  representative benchmark rather than the whole matrix. */
export async function runMatrixCalibration<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
  onRun?: (p: RunProgress, label: string) => void,
): Promise<CalibrationResult> {
  const allVariantIds = await discoverVariants(matrix.variantDir!);
  const variantId = (options.filteredVariants ?? allVariantIds)[0];
  if (!variantId) throw new Error(`No variants found in ${matrix.variantDir}`);

  const ctx = await createDirContext(matrix, options);
  const caseId = ctx.caseIds[0];
  const label = `${variantId}/${caseId}`;
  const variantArgs = buildVariantArgs(matrix, variantId, caseId, ctx);
  const current = () => runVariantOnce(variantArgs);

  return runCalibration({
    current,
    batches: ctx.batches,
    runs: options.calibrateRuns ?? 15,
    warmupBatch: ctx.warmupBatch,
    onRun: onRun ? p => onRun(p, label) : undefined,
  });
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
  const { batches = 1, warmupBatch = false, useWorker = true } = options;
  return {
    matrix,
    casesModule,
    baselineIds,
    caseIds,
    runnerOpts,
    batches,
    warmupBatch,
    useWorker,
  };
}

/** Run all variants sequentially, collecting per-case results */
async function runDirVariants<T>(
  variantIds: string[],
  ctx: DirMatrixContext<T>,
): Promise<VariantResult[]> {
  const variants: VariantResult[] = [];
  for (const id of variantIds) {
    const cases = await runDirVariantCases(id, ctx);
    variants.push({ id, cases });
  }
  return variants;
}

/** Build the args to run one variant/case, directly or in a worker. */
function buildVariantArgs<T>(
  matrix: BenchMatrix<T>,
  variantId: string,
  caseId: string,
  ctx: DirMatrixContext<T>,
): VariantArgs {
  return {
    variantDir: matrix.variantDir!,
    variantId,
    caseId,
    caseData: matrix.cases && !matrix.casesModule ? caseId : undefined,
    casesModule: matrix.casesModule,
    options: ctx.runnerOpts,
    useWorker: ctx.useWorker,
  };
}

/** Run one variant/case, returning its single MeasuredResults. */
async function runVariantOnce(args: VariantArgs): Promise<MeasuredResults> {
  return (await runMatrixVariant(args))[0];
}

/** Run all cases for a single variant */
async function runDirVariantCases<T>(
  variantId: string,
  ctx: DirMatrixContext<T>,
): Promise<CaseResult[]> {
  const { matrix, casesModule, caseIds, batches } = ctx;
  const cases: CaseResult[] = [];

  for (const caseId of caseIds) {
    const variantArgs = buildVariantArgs(matrix, variantId, caseId, ctx);
    const baselineArgs =
      matrix.baselineDir && ctx.baselineIds.includes(variantId)
        ? { ...variantArgs, variantDir: matrix.baselineDir! }
        : undefined;

    const { metadata } = await loadCaseData(casesModule, caseId);
    const { measured, baseline } =
      batches > 1
        ? await runCaseBatched(variantArgs, baselineArgs, ctx)
        : await runCaseSingle(variantArgs, baselineArgs);
    const deltaPercent = baseline
      ? computeDeltaPercent(baseline, measured)
      : undefined;
    cases.push({ caseId, measured, metadata, baseline, deltaPercent });
  }
  return cases;
}

/** Run a batched measurement for a case, alternating current/baseline order. */
async function runCaseBatched<T>(
  variantArgs: VariantArgs,
  baselineArgs: VariantArgs | undefined,
  ctx: DirMatrixContext<T>,
): Promise<{ measured: MeasuredResults; baseline?: MeasuredResults }> {
  const runCurrent = () => runVariantOnce(variantArgs);
  const runBase = baselineArgs ? () => runVariantOnce(baselineArgs) : undefined;
  const { results, baseline } = await runBatched(
    [runCurrent],
    runBase,
    ctx.batches,
    ctx.warmupBatch,
  );
  return { measured: results[0], baseline };
}

/** Run a single unbatched measurement for a case. */
async function runCaseSingle(
  variantArgs: VariantArgs,
  baselineArgs: VariantArgs | undefined,
): Promise<{ measured: MeasuredResults; baseline?: MeasuredResults }> {
  const measured = await runVariantOnce(variantArgs);
  const baseline = baselineArgs
    ? await runVariantOnce(baselineArgs)
    : undefined;
  return { measured, baseline };
}
