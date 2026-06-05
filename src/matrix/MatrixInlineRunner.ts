import type { VariantSource } from "../runners/RunnerUtils.ts";
import {
  type BenchMatrix,
  buildRunnerOptions,
  isStatefulVariant,
  type RunMatrixOptions,
  resolveCases,
  type Variant,
  type VariantResult,
} from "./BenchMatrix.ts";
import {
  inlineCaseDataMap,
  type MatrixPlan,
  runMatrixPlan,
} from "./MatrixRun.ts";

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

  const { casesModule, caseIds } = await resolveCases(matrix, options);
  const runnerOpts = buildRunnerOptions(options);
  const { batches = 1, warmupBatch = false, useWorker = true } = options;

  const all = Object.entries(matrix.variants!);
  const { filteredVariants } = options;
  const entries = filteredVariants
    ? all.filter(([id]) => filteredVariants.includes(id))
    : all;
  const sources = new Map(entries.map(([id, v]) => [id, inlineSource(id, v)]));

  const plan: MatrixPlan<T> = {
    variantIds: [...sources.keys()],
    caseIds,
    casesModule,
    casesModuleUrl: matrix.casesModule,
    caseData: await inlineCaseDataMap(matrix, caseIds),
    plan: variantId => ({ source: sources.get(variantId)! }),
    runnerOpts,
    batches,
    warmupBatch,
    useWorker,
  };
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
