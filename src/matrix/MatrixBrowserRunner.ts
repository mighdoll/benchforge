import type {
  BrowserRunCtx,
  BrowserRunOptions,
} from "../profiling/browser/BrowserProfiler.ts";
import type { ChromeInstance } from "../profiling/browser/ChromeLauncher.ts";
import { launchChrome } from "../profiling/browser/ChromeLauncher.ts";
import type { CalibrationResult, RunProgress } from "../runners/Calibration.ts";
import {
  type BenchMatrix,
  type MatrixResults,
  type RunMatrixOptions,
  resolveCases,
} from "./BenchMatrix.ts";
import { inlineSource } from "./MatrixInlineRunner.ts";
import {
  buildMatrixPlan,
  calibrateSource,
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
    const allVariants = Object.entries(matrix.variants!);
    const sources = new Map(
      allVariants.map(([id, v]) => [id, inlineSource(id, v)]),
    );
    const runIds = options.filteredVariants ?? allVariants.map(([id]) => id);
    const baselineId = matrix.baselineVariant;

    const plan = await buildMatrixPlan(matrix, options, runIds, variantId => ({
      source: sources.get(variantId)!,
      baselineSource:
        baselineId && baselineId !== variantId
          ? sources.get(baselineId)
          : undefined,
    }));
    // await (not just return) so Chrome stays open until the run completes.
    return await runMatrixPlan(
      matrix.name,
      { ...plan, browser: ctx },
      baselineId,
    );
  } finally {
    await chrome.close();
  }
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
 *  `variants` -- directory variants would require a browser bundle step. */
function requireInline<T>(matrix: BenchMatrix<T>): void {
  if (matrix.variantDir)
    throw new Error(
      "Browser matrix mode needs inline 'variants'; 'variantDir' requires bundling (not yet supported).",
    );
  if (!matrix.variants)
    throw new Error("BenchMatrix requires 'variants' for browser mode");
}

/** Launch the shared Chrome instance for the whole matrix run. */
function launchBrowser(o: BrowserRunOptions): Promise<ChromeInstance> {
  return launchChrome({
    headless: o.headless,
    chromePath: o.chromePath,
    chromeProfile: o.chromeProfile,
    args: o.chromeArgs,
  });
}

/** Derive the per-run browser context from launch options + the live Chrome. */
function browserCtx(
  o: BrowserRunOptions,
  chrome: ChromeInstance,
): BrowserRunCtx {
  return {
    chrome,
    url: o.url,
    pageLoad: o.pageLoad,
    waitFor: o.waitFor,
    timeout: o.timeout,
  };
}
