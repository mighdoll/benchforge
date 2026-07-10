import type { CalibrationResult, RunProgress } from "../runners/Calibration.ts";
import type { VariantSource } from "../runners/RunnerUtils.ts";
import type {
  BenchMatrix,
  MatrixResults,
  RunMatrixOptions,
} from "./BenchMatrix.ts";
import { resolveCases } from "./BenchMatrix.ts";
import {
  buildMatrixPlan,
  calibrateSource,
  runMatrixPlan,
} from "./MatrixRun.ts";
import { discoverVariants } from "./VariantLoader.ts";

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
  const { caseIds } = await resolveCases(matrix, options);
  const caseId = caseIds[0];
  const source = { variantDir: matrix.variantDir!, variantId };
  return calibrateSource(matrix, options, source, caseId, onRun);
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
