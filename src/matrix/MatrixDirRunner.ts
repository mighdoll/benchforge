import type { RunnerOptions } from "../runners/BenchRunner.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { runMatrixVariant } from "../runners/RunnerOrchestrator.ts";
import type {
  BenchMatrix,
  CaseResult,
  RunMatrixOptions,
  VariantResult,
} from "./BenchMatrix.ts";
import {
  applyBaselineVariant,
  buildRunnerOptions,
  computeDeltaPercent,
  resolveCases,
} from "./BenchMatrix.ts";
import type { CasesModule } from "./CaseLoader.ts";
import { loadCaseData } from "./CaseLoader.ts";
import { discoverVariants } from "./VariantLoader.ts";

/** Shared state for directory-based matrix execution */
interface DirMatrixContext<T> {
  matrix: BenchMatrix<T>;
  casesModule?: CasesModule<T>;
  baselineIds: string[];
  caseIds: string[];
  runnerOpts: RunnerOptions;
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
  for (const id of variantIds) {
    const cases = await runDirVariantCases(id, ctx);
    variants.push({ id, cases });
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

    const { metadata } = await loadCaseData(casesModule, caseId);
    const baseline = await runBaselineIfExists({
      variantId,
      caseId,
      caseData,
      ctx,
    });
    const deltaPercent = baseline
      ? computeDeltaPercent(baseline, measured)
      : undefined;
    cases.push({ caseId, measured, metadata, baseline, deltaPercent });
  }
  return cases;
}

/** Run the matching baseline variant for delta comparison, if configured */
async function runBaselineIfExists<T>(params: {
  variantId: string;
  caseId: string;
  caseData: unknown;
  ctx: DirMatrixContext<T>;
}): Promise<MeasuredResults | undefined> {
  const { variantId, caseId, caseData, ctx } = params;
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
