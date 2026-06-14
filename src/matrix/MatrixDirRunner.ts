import type { RunnerOptions } from "../runners/BenchRunner.ts";
import {
  type CalibrationResult,
  type RunProgress,
  runCalibration,
} from "../runners/Calibration.ts";
import type { RunMatrixVariantParams } from "../runners/RunnerOrchestrator.ts";
import type { VariantSource } from "../runners/RunnerUtils.ts";
import type {
  BenchMatrix,
  MatrixResults,
  RunMatrixOptions,
} from "./BenchMatrix.ts";
import { buildRunnerOptions, resolveCases } from "./BenchMatrix.ts";
import {
  buildMatrixPlan,
  inlineCaseDataMap,
  runMatrixPlan,
  runVariantOnce,
} from "./MatrixRun.ts";
import { discoverVariants } from "./VariantLoader.ts";

/** Resolved options for a single calibration benchmark from a variant dir. */
interface DirMatrixContext {
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
): Promise<MatrixResults> {
  const allVariantIds = await discoverVariants(matrix.variantDir!);
  if (allVariantIds.length === 0) {
    throw new Error(`No variants found in ${matrix.variantDir}`);
  }
  const variantIds = options.filteredVariants ?? allVariantIds;
  const baselineIds = matrix.baselineDir
    ? await discoverVariants(matrix.baselineDir)
    : [];

  const plan = await buildMatrixPlan(
    matrix,
    options,
    variantIds,
    dirPlan(matrix, baselineIds),
  );
  return runMatrixPlan(matrix.name, plan, matrix.baselineVariant);
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
  const caseData = await inlineCaseDataMap(matrix, [caseId]);
  const variantArgs: RunMatrixVariantParams = {
    source: { variantDir: matrix.variantDir!, variantId },
    caseId,
    caseData: matrix.casesModule ? undefined : caseData?.get(caseId),
    casesModule: matrix.casesModule,
    options: ctx.runnerOpts,
    useWorker: ctx.useWorker,
  };
  const current = () => runVariantOnce(variantArgs);

  return runCalibration({
    current,
    batches: ctx.batches,
    runs: options.calibrateRuns ?? 15,
    warmupBatch: ctx.warmupBatch,
    onRun: onRun ? p => onRun(p, label) : undefined,
  });
}

/** Per-variant source resolver for a directory matrix: load each variant from
 *  the directory by id, with its interleaved baseline from baselineDir (same id,
 *  baseline directory) or baselineVariant (the named reference variant from the
 *  same directory). */
function dirPlan<T>(matrix: BenchMatrix<T>, baselineIds: string[]) {
  const dirSource = (id: string) => ({
    variantDir: matrix.variantDir!,
    variantId: id,
  });
  const baselineFor = (variantId: string): VariantSource | undefined => {
    if (matrix.baselineDir && baselineIds.includes(variantId))
      return { variantDir: matrix.baselineDir, variantId };
    if (matrix.baselineVariant && matrix.baselineVariant !== variantId)
      return dirSource(matrix.baselineVariant);
    return undefined;
  };
  return (variantId: string) => ({
    source: dirSource(variantId),
    baselineSource: baselineFor(variantId),
  });
}

/** Resolve cases, runner options, and batching for a calibration benchmark. */
async function createDirContext<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<DirMatrixContext> {
  const { caseIds } = await resolveCases(matrix, options);
  const runnerOpts = buildRunnerOptions(options);
  const { batches = 1, warmupBatch = false, useWorker = true } = options;
  return { caseIds, runnerOpts, batches, warmupBatch, useWorker };
}
