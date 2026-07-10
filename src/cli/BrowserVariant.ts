import type {
  BrowserProfileParams,
  BrowserRunCtx,
  InjectVariant,
} from "../profiling/browser/BrowserProfiler.ts";
import { profileBrowser } from "../profiling/browser/BrowserProfiler.ts";
import type { RunnerOptions } from "../runners/BenchRunner.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import type { RunMatrixVariantParams } from "../runners/RunnerOrchestrator.ts";
import { toBrowserMeasured } from "./BrowserBatcher.ts";

/** Run one matrix variant/case in the browser: eval the serialized inline variant
 *  against the harness page and time it, returning the same MeasuredResults the
 *  Node executors produce. Called (lazily) from runMatrixVariant when a run-level
 *  browser context is present, so the matrix batching/report path is unchanged. */
export async function runBrowserVariant(
  params: RunMatrixVariantParams,
  name: string,
): Promise<MeasuredResults[]> {
  const { source, caseData, options } = params;
  const ctx = params.browser!;
  if (!("runCode" in source))
    throw new Error(
      "Browser matrix mode requires inline 'variants' (directory variants need bundling).",
    );
  const inject: InjectVariant = {
    runCode: source.runCode,
    setupCode: source.setupCode,
    caseData,
  };
  const profileParams = browserProfileParams(options, ctx, inject);
  const raw = await profileBrowser(profileParams);
  return [toBrowserMeasured(name, raw)];
}

/** Build profiler params from the per-run RunnerOptions and shared browser ctx. */
function browserProfileParams(
  options: RunnerOptions,
  ctx: BrowserRunCtx,
  inject: InjectVariant,
): BrowserProfileParams {
  return {
    url: ctx.url,
    chrome: ctx.chrome,
    pageLoad: ctx.pageLoad,
    waitFor: ctx.waitFor,
    timeout: ctx.timeout,
    maxTime: options.maxTime,
    maxIterations: options.maxIterations,
    alloc: options.alloc,
    allocOptions: {
      samplingInterval: options.allocInterval,
      stackDepth: options.allocDepth,
    },
    profile: options.profile,
    profileInterval: options.profileInterval,
    gcStats: options.gcStats,
    callCounts: options.callCounts,
    inject,
  };
}
