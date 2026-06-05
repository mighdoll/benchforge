import type { RunnerOptions } from "../runners/BenchRunner.ts";
import {
  type CalibrationResult,
  type RunProgress,
  runCalibration,
} from "../runners/Calibration.ts";
import {
  type RunMatrixVariantParams,
  runMatrixVariant,
} from "../runners/RunnerOrchestrator.ts";
import type { VariantSource } from "../runners/RunnerUtils.ts";
import type {
  BenchMatrix,
  RunMatrixOptions,
  VariantResult,
} from "./BenchMatrix.ts";
import { buildRunnerOptions, resolveCases } from "./BenchMatrix.ts";
import type { CasesModule } from "./CaseLoader.ts";
import {
  inlineCaseDataMap,
  type MatrixPlan,
  runMatrixPlan,
} from "./MatrixRun.ts";
import { discoverVariants } from "./VariantLoader.ts";

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
  return runMatrixPlan(matrix.name, await dirPlan(matrix, variantIds, ctx));
}

/** Build a source-agnostic plan that loads each variant from a directory by id,
 *  with its interleaved baseline from baselineDir (same id, baseline directory)
 *  or baselineVariant (the named reference variant from the same directory). */
async function dirPlan<T>(
  matrix: BenchMatrix<T>,
  variantIds: string[],
  ctx: DirMatrixContext<T>,
): Promise<MatrixPlan<T>> {
  const dirSource = (id: string) => ({
    variantDir: matrix.variantDir!,
    variantId: id,
  });
  const baselineFor = (variantId: string): VariantSource | undefined => {
    if (matrix.baselineDir && ctx.baselineIds.includes(variantId))
      return { variantDir: matrix.baselineDir, variantId };
    if (matrix.baselineVariant && matrix.baselineVariant !== variantId)
      return dirSource(matrix.baselineVariant);
    return undefined;
  };
  return {
    variantIds,
    caseIds: ctx.caseIds,
    casesModule: ctx.casesModule,
    casesModuleUrl: matrix.casesModule,
    caseData: await inlineCaseDataMap(matrix, ctx.caseIds),
    plan: variantId => ({
      source: dirSource(variantId),
      baselineSource: baselineFor(variantId),
    }),
    runnerOpts: ctx.runnerOpts,
    batches: ctx.batches,
    warmupBatch: ctx.warmupBatch,
    useWorker: ctx.useWorker,
  };
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
  const variantArgs: RunMatrixVariantParams = {
    source: { variantDir: matrix.variantDir!, variantId },
    caseId,
    caseData: matrix.cases && !matrix.casesModule ? caseId : undefined,
    casesModule: matrix.casesModule,
    options: ctx.runnerOpts,
    useWorker: ctx.useWorker,
  };
  const current = async () => (await runMatrixVariant(variantArgs))[0];

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
