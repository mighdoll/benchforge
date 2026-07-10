import type { CalibrationResult, RunProgress } from "../runners/Calibration.ts";
import type { VariantSource } from "../runners/RunnerUtils.ts";
import {
  type BenchMatrix,
  isStatefulVariant,
  type MatrixResults,
  type RunMatrixOptions,
  resolveCases,
  type Variant,
} from "./BenchMatrix.ts";
import {
  buildMatrixPlan,
  calibrateSource,
  runMatrixPlan,
} from "./MatrixRun.ts";

/** Run a matrix with in-memory variant functions. Variants are serialized to
 *  source and reconstructed in a worker (like directory variants), so inline
 *  matrices get the same batching and isolation -- at the cost that an inline
 *  variant must be self-contained (no captured closure variables). */
export async function runMatrixInline<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<MatrixResults> {
  if (matrix.baselineDir)
    throw new Error(
      "BenchMatrix with inline 'variants' cannot use 'baselineDir'. Use 'variantDir' instead.",
    );

  const allVariants = Object.entries(matrix.variants!);
  const { filteredVariants } = options;
  // Serialize every variant so a filtered run can still resolve its baseline
  // for comparison, but only run (plan) the filtered set.
  const sources = new Map(
    allVariants.map(([id, v]) => [id, inlineSource(id, v)]),
  );
  const runIds = filteredVariants ?? allVariants.map(([id]) => id);
  const baselineId = matrix.baselineVariant;

  const plan = await buildMatrixPlan(matrix, options, runIds, variantId => ({
    source: sources.get(variantId)!,
    baselineSource:
      baselineId && baselineId !== variantId
        ? sources.get(baselineId)
        : undefined,
  }));
  return runMatrixPlan(matrix.name, plan, baselineId);
}

/** Measure the harness noise floor for an inline matrix (current vs current),
 *  using the first filtered variant + case as a representative benchmark. */
export async function runMatrixCalibrationInline<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
  onRun?: (p: RunProgress, label: string) => void,
): Promise<CalibrationResult> {
  const variants = matrix.variants ?? {};
  const variantId = (options.filteredVariants ?? Object.keys(variants))[0];
  const variant = variantId ? variants[variantId] : undefined;
  if (!variantId || !variant)
    throw new Error("No inline variants found in matrix");
  const { caseIds } = await resolveCases(matrix, options);
  const caseId = caseIds[0];
  const source = inlineSource(variantId, variant);
  return calibrateSource(matrix, options, source, caseId, onRun);
}

/** Serialize an inline variant to a worker-reconstructable source. */
function inlineSource<T>(
  variantId: string,
  variant: Variant<T>,
): VariantSource {
  if (isStatefulVariant(variant))
    return {
      variantId,
      runCode: variant.run.toString(),
      setupCode: variant.setup.toString(),
    };
  return { variantId, runCode: variant.toString() };
}
