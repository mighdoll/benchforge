import type { RunnerOptions } from "../runners/BenchRunner.ts";
import { runBatchedPair } from "../runners/MergeBatches.ts";
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
  batches: number;
  warmupBatch: boolean;
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
  const batches = options.batches ?? 1;
  const runnerOpts = buildRunnerOptions(options);
  if (batches > 1) runnerOpts.maxTime = (runnerOpts.maxTime ?? 1000) / batches;
  return {
    matrix, casesModule, baselineIds, caseIds, runnerOpts,
    batches, warmupBatch: options.warmupBatch ?? false,
  };
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
  const { matrix, casesModule, caseIds, runnerOpts, batches } = ctx;
  const cases: CaseResult[] = [];

  for (const caseId of caseIds) {
    const caseData = !matrix.casesModule && matrix.cases ? caseId : undefined;
    const variantArgs = {
      variantDir: matrix.variantDir!,
      variantId, caseId, caseData,
      casesModule: matrix.casesModule,
      runner: "basic" as const,
      options: runnerOpts,
    };
    const hasBaseline =
      matrix.baselineDir && ctx.baselineIds.includes(variantId);
    const baselineArgs = hasBaseline
      ? { ...variantArgs, variantDir: matrix.baselineDir! }
      : undefined;

    const { metadata } = await loadCaseData(casesModule, caseId);
    const { measured, baseline } = batches > 1
      ? await runCaseBatched(variantArgs, baselineArgs, ctx)
      : await runCaseSingle(variantArgs, baselineArgs);
    const deltaPercent = baseline
      ? computeDeltaPercent(baseline, measured)
      : undefined;
    cases.push({ caseId, measured, metadata, baseline, deltaPercent });
  }
  return cases;
}

/** Run a single unbatched measurement for a case. */
async function runCaseSingle(
  variantArgs: Parameters<typeof runMatrixVariant>[0],
  baselineArgs: Parameters<typeof runMatrixVariant>[0] | undefined,
): Promise<{ measured: MeasuredResults; baseline?: MeasuredResults }> {
  const [measured] = await runMatrixVariant(variantArgs);
  const baseline = baselineArgs
    ? (await runMatrixVariant(baselineArgs))[0]
    : undefined;
  return { measured, baseline };
}

/** Run a batched measurement for a case, alternating current/baseline order. */
async function runCaseBatched<T>(
  variantArgs: Parameters<typeof runMatrixVariant>[0],
  baselineArgs: Parameters<typeof runMatrixVariant>[0] | undefined,
  ctx: DirMatrixContext<T>,
): Promise<{ measured: MeasuredResults; baseline?: MeasuredResults }> {
  const runCurrent = async () => (await runMatrixVariant(variantArgs))[0];
  const runBaseline = baselineArgs
    ? async () => (await runMatrixVariant(baselineArgs))[0]
    : undefined;
  const { current, baseline } = await runBatchedPair(
    runCurrent, runBaseline, ctx.batches, ctx.warmupBatch,
  );
  return { measured: current, baseline };
}

