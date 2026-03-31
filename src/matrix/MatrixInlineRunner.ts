import { BasicRunner } from "../runners/BasicRunner.ts";
import type { RunnerOptions } from "../runners/BenchRunner.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type {
  AnyVariant,
  BenchMatrix,
  CaseResult,
  RunMatrixOptions,
  VariantResult,
} from "./BenchMatrix.ts";
import {
  applyBaselineVariant,
  buildRunnerOptions,
  isStatefulVariant,
  resolveCases,
} from "./BenchMatrix.ts";
import { loadCaseData } from "./CaseLoader.ts";

/** Run matrix with in-memory variant functions (no worker isolation) */
export async function runMatrixInline<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<{ name: string; variants: VariantResult[] }> {
  if (matrix.baselineDir) {
    const msg =
      "BenchMatrix with inline 'variants' cannot use 'baselineDir'. Use 'variantDir' instead.";
    throw new Error(msg);
  }

  const { casesModule, caseIds } = await resolveCases(matrix, options);
  const runner = new BasicRunner();
  const runnerOpts = buildRunnerOptions(options);

  const all = Object.entries(matrix.variants!);
  const filtered = options.filteredVariants;
  const variantEntries = filtered
    ? all.filter(([id]) => filtered.includes(id))
    : all;

  const variants: VariantResult[] = [];
  for (const [variantId, variant] of variantEntries) {
    const cases: CaseResult[] = [];
    for (const caseId of caseIds) {
      const loaded = await loadCaseData(casesModule, caseId);
      const data = casesModule || matrix.cases ? loaded.data : (undefined as T);
      const params = { variant, data, variantId, runner, runnerOpts };
      const measured = await runVariant(params);
      cases.push({ caseId, measured, metadata: loaded.metadata });
    }
    variants.push({ id: variantId, cases });
  }

  if (matrix.baselineVariant) {
    applyBaselineVariant(variants, matrix.baselineVariant);
  }

  return { name: matrix.name, variants };
}

/** Set up and benchmark a single variant, returning measured results */
async function runVariant<T>(params: {
  variant: AnyVariant<T>;
  data: T;
  variantId: string;
  runner: BasicRunner;
  runnerOpts: RunnerOptions;
}): Promise<MeasuredResults> {
  const { variant, data, variantId, runner, runnerOpts } = params;
  let fn: () => void;
  if (isStatefulVariant(variant)) {
    const state = await variant.setup(data);
    fn = () => variant.run(state);
  } else {
    fn = () => variant(data);
  }
  const [result] = await runner.runBench({ name: variantId, fn }, runnerOpts);
  return result;
}
