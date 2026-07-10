import type {
  BrowserProfileParams,
  BrowserProfileResult,
  BrowserRunCtx,
  InjectVariant,
  NavTiming,
} from "../profiling/browser/BrowserProfiler.ts";
import { profileBrowser } from "../profiling/browser/BrowserProfiler.ts";
import type { RunnerOptions } from "../runners/BenchRunner.ts";
import type { MeasuredResults } from "../runners/MeasuredResults.ts";
import { mergeGcStats } from "../runners/MergeBatches.ts";
import type { RunMatrixVariantParams } from "../runners/RunnerOrchestrator.ts";
import { computeStats } from "../runners/SampleStats.ts";
import { toBrowserMeasured } from "./BrowserMeasured.ts";

/** Run one matrix variant/case in the browser, returning the same MeasuredResults
 *  the Node executors produce. Two source shapes:
 *  - inline variant: eval the serialized run/setup against the harness page.
 *  - page-url variant: the page owns the benchmark (`window.__bench` or a page
 *    load); no code is injected.
 *  Called (lazily) from runMatrixVariant when a run-level browser context is
 *  present, so the matrix batching/report path is unchanged. */
export async function runBrowserVariant(
  params: RunMatrixVariantParams,
  name: string,
): Promise<MeasuredResults[]> {
  const { source, caseData, options } = params;
  const ctx = params.browser!;
  if ("variantDir" in source)
    throw new Error(
      "Browser matrix mode requires inline 'variants' (directory variants need bundling).",
    );

  if ("pageUrl" in source)
    return [await runPageVariant(source.pageUrl, ctx, options, name)];

  const inject: InjectVariant = {
    runCode: source.runCode,
    setupCode: source.setupCode,
    caseData,
  };
  const raw = await profileBrowser(
    profileParams(options, ctx, ctx.url, inject),
  );
  return [toBrowserMeasured(name, raw)];
}

/** Run a whole-page variant for one batch. Bench pages yield all their iteration
 *  samples from a single profile call; page-load pages yield one nav sample per
 *  call, so loop until the duration/iteration budget. When the mode is unknown,
 *  the first call auto-detects and its result seeds the page-load loop. */
async function runPageVariant(
  url: string,
  ctx: BrowserRunCtx,
  options: RunnerOptions,
  name: string,
): Promise<MeasuredResults> {
  const base = profileParams(options, ctx, url);
  if (ctx.pageLoad) return multiPageLoad(base, options, name);

  const raw = await profileBrowser(base);
  // Iteration samples ==> bench mode; the single call covered the whole batch.
  if (raw.samples?.length) return toBrowserMeasured(name, raw);
  // No samples but a navTiming ==> auto-detected page load; the probe is load #0.
  // Persist the mode on the shared run context so later batches skip the redundant
  // detection navigation (and its repeated "No __bench" warning).
  ctx.pageLoad = true;
  return multiPageLoad({ ...base, pageLoad: true }, options, name, raw);
}

/** Run page loads until the duration or iteration budget is met, collecting each
 *  load's wall time as a sample. `seed` reuses an auto-detect probe as load #0. */
async function multiPageLoad(
  params: BrowserProfileParams,
  options: RunnerOptions,
  name: string,
  seed?: BrowserProfileResult,
): Promise<MeasuredResults> {
  const capIter = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const capTime = options.maxTime ?? Number.POSITIVE_INFINITY;
  const raws = seed ? [seed] : [];
  let accumulated = seed?.wallTimeMs ?? 0;
  // Always run at least one load (a batch with no samples would break stats),
  // then continue until the iteration or time budget is met.
  while (
    raws.length === 0 ||
    (raws.length < capIter && accumulated < capTime)
  ) {
    const raw = await profileBrowser({ ...params, pageLoad: true });
    raws.push(raw);
    accumulated += raw.wallTimeMs ?? 0;
    if (
      capIter === Number.POSITIVE_INFINITY &&
      capTime === Number.POSITIVE_INFINITY
    )
      break;
  }

  const samples = raws.map(r => r.wallTimeMs ?? 0);
  const navTimings = raws.map(r => r.navTiming).filter(Boolean) as NavTiming[];
  const { heapProfile, timeProfile, coverage } = raws[raws.length - 1];
  return {
    name,
    samples,
    time: computeStats(samples),
    totalTime: accumulated / 1000,
    navTimings: navTimings.length ? navTimings : undefined,
    gcStats: mergeGcStats(raws),
    heapProfile,
    timeProfile,
    coverage,
  };
}

/** Build profiler params from the per-run RunnerOptions and shared browser ctx. */
function profileParams(
  options: RunnerOptions,
  ctx: BrowserRunCtx,
  url: string,
  inject?: InjectVariant,
): BrowserProfileParams {
  return {
    url,
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
