import { nameFromUrl } from "../cli/BrowserMeasured.ts";
import type {
  BrowserRunCtx,
  BrowserRunOptions,
} from "../profiling/browser/BrowserProfiler.ts";
import type { ChromeInstance } from "../profiling/browser/ChromeLauncher.ts";
import { launchChrome } from "../profiling/browser/ChromeLauncher.ts";
import type { CalibrationResult, RunProgress } from "../runners/Calibration.ts";
import {
  type BenchMatrix,
  buildRunnerOptions,
  type MatrixResults,
  type RunMatrixOptions,
  resolveCases,
} from "./BenchMatrix.ts";
import {
  buildInlineVariantPlan,
  inlineSource,
  requireNoBaselineDir,
} from "./MatrixInlineRunner.ts";
import {
  calibrateSource,
  type MatrixPlan,
  runMatrixPlan,
} from "./MatrixRun.ts";

/** Run an inline matrix in the browser: launch Chrome once, then drive the shared
 *  batching/baseline loop with each variant/case injected into a fresh tab. Only
 *  inline `variants` are supported (directory variants would need bundling). */
export async function runMatrixBrowser<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
): Promise<MatrixResults> {
  requireInline(matrix);
  const chrome = await launchBrowser(options.browser!);
  try {
    const ctx = browserCtx(options.browser!, chrome);
    const { plan, baselineId } = await buildInlineVariantPlan(matrix, options);
    const browserPlan = { ...plan, browser: ctx };
    // await (not just return) so Chrome stays open until the run completes.
    return await runMatrixPlan(matrix.name, browserPlan, baselineId);
  } finally {
    await chrome.close();
  }
}

/** Run a bare `--url` browser benchmark as a synthesized one-variant matrix: the
 *  page owns the benchmark (`window.__bench` or a page load), so the variant is a
 *  page-url source rather than injected code. `--baseline-url` becomes the
 *  variant's paired baseline (a second page). Reuses the shared batching/report
 *  pipeline instead of a separate browser batching loop. */
export async function runSingleUrlBrowser(
  url: string,
  baselineUrl: string | undefined,
  options: RunMatrixOptions,
): Promise<MatrixResults> {
  const chrome = await launchBrowser(options.browser!);
  try {
    const ctx = browserCtx(options.browser!, chrome);
    const currentId = nameFromUrl(url);
    // The baseline URL is the current variant's paired baseline (carried on the
    // report), not a sibling variant, so give it a distinct id when its basename
    // collides with the current's (e.g. two hosts serving index.html) and leave
    // `baselineVariant` unset -- peer-baseline mode does not apply.
    const baselineId = baselineUrl
      ? distinctBaselineId(nameFromUrl(baselineUrl), currentId)
      : undefined;
    const plan: MatrixPlan<unknown> = {
      variantIds: [currentId],
      caseIds: [currentId],
      plan: () => ({
        source: { pageUrl: url, variantId: currentId },
        baselineSource: baselineUrl
          ? { pageUrl: baselineUrl, variantId: baselineId! }
          : undefined,
      }),
      runnerOpts: buildRunnerOptions(options),
      batches: options.batches ?? 1,
      warmupBatch: options.warmupBatch ?? false,
      useWorker: false,
      browser: ctx,
    };
    // await (not just return) so Chrome stays open until the run completes.
    return await runMatrixPlan(currentId, plan);
  } finally {
    await chrome.close();
  }
}

/** Keep the baseline variant id distinct from the current one so the report's
 *  per-variant keying does not treat the current variant as its own baseline. */
function distinctBaselineId(baselineId: string, currentId: string): string {
  return baselineId === currentId ? `${baselineId} (baseline)` : baselineId;
}

/** Measure the browser harness noise floor (current vs current) for an inline
 *  matrix, using the first filtered variant + case as a representative benchmark. */
export async function runMatrixCalibrationBrowser<T>(
  matrix: BenchMatrix<T>,
  options: RunMatrixOptions,
  onRun?: (p: RunProgress, label: string) => void,
): Promise<CalibrationResult> {
  requireInline(matrix);
  const variants = matrix.variants ?? {};
  const variantId = (options.filteredVariants ?? Object.keys(variants))[0];
  const variant = variantId ? variants[variantId] : undefined;
  if (!variantId || !variant)
    throw new Error("No inline variants found in matrix");

  const chrome = await launchBrowser(options.browser!);
  try {
    const ctx = browserCtx(options.browser!, chrome);
    const { caseIds } = await resolveCases(matrix, options);
    const source = inlineSource(variantId, variant);
    // await (not just return) so Chrome stays open until calibration completes.
    return await calibrateSource(
      matrix,
      options,
      source,
      caseIds[0],
      onRun,
      ctx,
    );
  } finally {
    await chrome.close();
  }
}

/** Browser matrix mode reconstructs variants in-page, so it needs inline
 *  `variants` -- directory variants would require a browser bundle step. Case
 *  data must also be inline: `casesModule` is loaded per-case only by the Node
 *  worker/direct paths (see `resolveVariantFn`), so a browser run would silently
 *  inject `undefined` case data instead of erroring (not yet supported). */
function requireInline<T>(matrix: BenchMatrix<T>): void {
  if (matrix.variantDir)
    throw new Error(
      "Browser matrix mode needs inline 'variants'; 'variantDir' requires bundling (not yet supported).",
    );
  if (!matrix.variants)
    throw new Error("BenchMatrix requires 'variants' for browser mode");
  requireNoBaselineDir(matrix);
  if (matrix.casesModule)
    throw new Error(
      "Browser matrix mode needs inline 'caseData'; 'casesModule' is not yet loaded for browser runs.",
    );
}

/** Launch the shared Chrome instance for the whole matrix run. */
function launchBrowser(options: BrowserRunOptions): Promise<ChromeInstance> {
  return launchChrome({
    headless: options.headless,
    chromePath: options.chromePath,
    chromeProfile: options.chromeProfile,
    args: options.chromeArgs,
  });
}

/** Derive the per-run browser context from launch options + the live Chrome. */
function browserCtx(
  options: BrowserRunOptions,
  chrome: ChromeInstance,
): BrowserRunCtx {
  return {
    chrome,
    url: options.url,
    pageLoad: options.pageLoad,
    waitFor: options.waitFor,
    timeout: options.timeout,
  };
}
