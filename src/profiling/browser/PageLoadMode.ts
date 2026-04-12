import {
  instrumentOpts,
  startInstruments,
  stopInstruments,
} from "./BrowserCDP.ts";
import type {
  BrowserProfileResult,
  NavTiming,
  ProfileCtx,
} from "./BrowserProfiler.ts";
import type { CdpPage } from "./CdpPage.ts";

/** Run passive page-load profiling: instrument ==> navigate ==> wait ==> collect. */
export async function runPageLoad(
  ctx: ProfileCtx,
): Promise<BrowserProfileResult> {
  const { page, cdp, params, samplingInterval } = ctx;
  const opts = instrumentOpts(params, samplingInterval);
  await startInstruments(cdp, opts);

  // Observe LCP via PerformanceObserver (avoids deprecated getEntriesByType warning)
  await page.addInitScript(() => {
    const g = globalThis as any;
    g.__lcpTime = undefined;
    new PerformanceObserver(list => {
      const entries = list.getEntries();
      if (entries.length) g.__lcpTime = entries.at(-1)!.startTime;
    }).observe({ type: "largest-contentful-paint" as any, buffered: true });
  });

  const { url, waitFor } = params;

  const isBuiltinWait = waitFor === "load" || waitFor === "domcontentloaded";
  const waitUntil = isBuiltinWait ? waitFor : "load";
  await page.navigate(url, { waitUntil });

  if (waitFor && !isBuiltinWait) {
    if (/^[#.[]/.test(waitFor)) {
      await page.waitForSelector(waitFor);
    } else {
      await page.waitForFunction(waitFor);
    }
  }

  const navTiming = await readNavTiming(page);
  const collected = await stopInstruments(cdp, opts);
  return { ...collected, navTiming, wallTimeMs: navTiming.loadEvent };
}

/** Read navigation timing from the page via Performance API. */
export async function readNavTiming(page: CdpPage): Promise<NavTiming> {
  return page.evaluate(() => {
    const perf = performance as any;
    const nav = perf.getEntriesByType("navigation")[0] ?? {};
    return {
      domContentLoaded: (nav.domContentLoadedEventEnd as number) ?? 0,
      loadEvent: (nav.loadEventEnd as number) ?? 0,
      lcp: (globalThis as any).__lcpTime as number | undefined,
    };
  });
}
