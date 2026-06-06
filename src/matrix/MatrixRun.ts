import type { RunnerOptions } from "../runners/BenchRunner.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { runBatched } from "../runners/MergeBatches.ts";
import {
  type RunMatrixVariantParams,
  runMatrixVariant,
} from "../runners/RunnerOrchestrator.ts";
import type { VariantSource } from "../runners/RunnerUtils.ts";
import type { BenchMatrix, CaseResult, VariantResult } from "./BenchMatrix.ts";
import { computeDeltaPercent, resolveInlineCase } from "./BenchMatrix.ts";
import type { CasesModule } from "./CaseLoader.ts";
import { loadCaseData } from "./CaseLoader.ts";

/** A variant's code source for a case, plus its optional paired baseline source.
 *  Returning undefined for a (variantId, caseId) skips that case. */
export interface VariantPlan {
  source: VariantSource;
  baselineSource?: VariantSource;
}

/** Source-agnostic matrix execution: how to enumerate variants/cases and turn a
 *  (variantId, caseId) into runnable sources. Both the directory runner and the
 *  inline runner supply one of these and share the batching/baseline loop. */
export interface MatrixPlan<T> {
  variantIds: string[];
  caseIds: string[];
  /** Loaded cases module, used here only to read per-case metadata. */
  casesModule?: CasesModule<T>;
  /** Cases module URL, passed to the worker so it loads case data in isolation. */
  casesModuleUrl?: string;
  /** Resolve the run + baseline sources for one variant/case. */
  plan: (variantId: string, caseId: string) => VariantPlan;
  /** Pre-resolved inline case data by case id (used when there is no cases
   *  module); passed to the worker as the variant's argument. */
  caseData?: Map<string, unknown>;
  runnerOpts: RunnerOptions;
  batches: number;
  warmupBatch: boolean;
  useWorker: boolean;
}

/** Pre-resolve the per-case data passed to the worker as the variant argument:
 *  inline caseData (thunks invoked once here), else the caseId string when there
 *  is no cases module, else nothing (the worker loads from the module). */
export async function inlineCaseDataMap<T>(
  matrix: BenchMatrix<T>,
  caseIds: string[],
): Promise<Map<string, unknown> | undefined> {
  if (matrix.caseData) {
    const entries = await Promise.all(
      caseIds.map(
        async id =>
          [id, await resolveInlineCase(matrix.caseData!, id)] as const,
      ),
    );
    return new Map(entries);
  }
  if (matrix.casesModule) return undefined;
  return new Map(caseIds.map(id => [id, id]));
}

/** Run every variant over every case, batching and interleaving each variant
 *  with its paired baseline. Shared by the directory and inline matrix runners. */
export async function runMatrixPlan<T>(
  name: string,
  plan: MatrixPlan<T>,
): Promise<{ name: string; variants: VariantResult[] }> {
  const variants: VariantResult[] = [];
  for (const variantId of plan.variantIds) {
    variants.push({
      id: variantId,
      cases: await runVariantCases(variantId, plan),
    });
  }
  return { name, variants };
}

/** Run all cases for a single variant. */
async function runVariantCases<T>(
  variantId: string,
  plan: MatrixPlan<T>,
): Promise<CaseResult[]> {
  const cases: CaseResult[] = [];
  for (const caseId of plan.caseIds) {
    const { source, baselineSource } = plan.plan(variantId, caseId);
    const caseData = plan.caseData?.get(caseId);
    const variantArgs = caseArgs(source, caseId, caseData, plan);
    const baselineArgs = baselineSource
      ? caseArgs(baselineSource, caseId, caseData, plan)
      : undefined;

    const { metadata } = await loadCaseData(plan.casesModule, caseId);
    const { measured, baseline } =
      plan.batches > 1
        ? await runCaseBatched(variantArgs, baselineArgs, plan)
        : await runCaseSingle(variantArgs, baselineArgs);
    const deltaPercent = baseline
      ? computeDeltaPercent(baseline, measured)
      : undefined;
    const baselineId = baselineSource?.variantId;
    cases.push({ caseId, measured, metadata, baseline, baselineId, deltaPercent });
  }
  return cases;
}

/** Assemble the params to run one variant/case from its source. The worker
 *  loads case data from the module URL when present (for isolation); otherwise
 *  inline case data is passed directly. */
function caseArgs<T>(
  source: VariantSource,
  caseId: string,
  caseData: unknown,
  plan: MatrixPlan<T>,
): RunMatrixVariantParams {
  return {
    source,
    caseId,
    caseData: plan.casesModuleUrl ? undefined : caseData,
    casesModule: plan.casesModuleUrl,
    options: plan.runnerOpts,
    useWorker: plan.useWorker,
  };
}

/** Run one variant/case, returning its single MeasuredResults. */
async function runVariantOnce(
  args: RunMatrixVariantParams,
): Promise<MeasuredResults> {
  return (await runMatrixVariant(args))[0];
}

/** Run a batched measurement for a case, alternating current/baseline order. */
async function runCaseBatched<T>(
  variantArgs: RunMatrixVariantParams,
  baselineArgs: RunMatrixVariantParams | undefined,
  plan: MatrixPlan<T>,
): Promise<{ measured: MeasuredResults; baseline?: MeasuredResults }> {
  const runCurrent = () => runVariantOnce(variantArgs);
  const runBase = baselineArgs ? () => runVariantOnce(baselineArgs) : undefined;
  const { results, baseline } = await runBatched(
    [runCurrent],
    runBase,
    plan.batches,
    plan.warmupBatch,
  );
  return { measured: results[0], baseline };
}

/** Run a single unbatched measurement for a case. */
async function runCaseSingle(
  variantArgs: RunMatrixVariantParams,
  baselineArgs: RunMatrixVariantParams | undefined,
): Promise<{ measured: MeasuredResults; baseline?: MeasuredResults }> {
  const measured = await runVariantOnce(variantArgs);
  const baseline = baselineArgs
    ? await runVariantOnce(baselineArgs)
    : undefined;
  return { measured, baseline };
}
