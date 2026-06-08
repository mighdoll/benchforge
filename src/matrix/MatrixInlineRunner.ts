import type { VariantSource } from "../runners/RunnerUtils.ts";
import {
  type BenchMatrix,
  isStatefulVariant,
  type RunMatrixOptions,
  type Variant,
  type VariantResult,
} from "./BenchMatrix.ts";
import { buildMatrixPlan, runMatrixPlan } from "./MatrixRun.ts";

/** Run a matrix with in-memory variant functions. Variants are serialized to
 *  source and reconstructed in a worker (like directory variants), so inline
 *  matrices get the same batching and isolation -- at the cost that an inline
 *  variant must be self-contained (no captured closure variables). */
export async function runMatrixInline<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<{ name: string; variants: VariantResult[] }> {
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
  return runMatrixPlan(matrix.name, plan);
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
