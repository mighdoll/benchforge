import { TimingRunner } from "../runners/TimingRunner.ts";
import type {
  BenchMatrix,
  CaseResult,
  RunMatrixOptions,
  VariantResult,
} from "./BenchMatrix.ts";
import {
  buildRunnerOptions,
  prepareBenchFn,
  resolveCases,
} from "./BenchMatrix.ts";
import { loadCaseData } from "./CaseLoader.ts";

/** Run matrix with in-memory variant functions (no worker isolation) */
export async function runMatrixInline<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<{ name: string; variants: VariantResult[] }> {
  if (matrix.baselineDir)
    throw new Error(
      "BenchMatrix with inline 'variants' cannot use 'baselineDir'. Use 'variantDir' instead.",
    );

  const { casesModule, caseIds } = await resolveCases(matrix, options);
  const runner = new TimingRunner();
  const runnerOpts = buildRunnerOptions(options);

  const allEntries = Object.entries(matrix.variants!);
  const { filteredVariants } = options;
  const variantEntries = filteredVariants
    ? allEntries.filter(([id]) => filteredVariants.includes(id))
    : allEntries;

  const variants: VariantResult[] = [];
  for (const [variantId, variant] of variantEntries) {
    const cases: CaseResult[] = [];
    for (const caseId of caseIds) {
      const loaded = await loadCaseData(casesModule, caseId);
      const data = casesModule || matrix.cases ? loaded.data : (undefined as T);
      const fn = await prepareBenchFn(variant, data);
      const spec = { name: variantId, fn };
      const [measured] = await runner.runBench(spec, runnerOpts);
      cases.push({ caseId, measured, metadata: loaded.metadata });
    }
    variants.push({ id: variantId, cases });
  }

  return { name: matrix.name, variants };
}
