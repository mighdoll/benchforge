import {
  instrumentOpts,
  startInstruments,
  stopInstruments,
} from "./BrowserCDP.ts";
import type {
  BrowserProfileParams,
  BrowserProfileResult,
} from "./BrowserProfiler.ts";
import type { CdpClient } from "./CdpClient.ts";
import type { CdpPage } from "./CdpPage.ts";

/** Run passive page-load profiling: instrument ==> navigate ==> wait ==> collect. */
export async function runPageLoad(
  page: CdpPage,
  cdp: CdpClient,
  params: BrowserProfileParams,
  samplingInterval: number,
): Promise<BrowserProfileResult> {
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

  // Navigate with appropriate wait strategy
  if (waitFor === "load" || waitFor === "domcontentloaded") {
    await page.navigate(url, { waitUntil: waitFor });
  } else {
    await page.navigate(url, { waitUntil: "networkidle" });
  }

  // Custom wait: CSS selector or JS expression
  if (waitFor && waitFor !== "load" && waitFor !== "domcontentloaded") {
    if (/^[#.[]/.test(waitFor)) {
      await page.waitForSelector(waitFor);
    } else {
      await page.waitForFunction(waitFor);
    }
  }

  // Read real timing from the page (accurate, not fence timing)
  const navTiming = await page.evaluate(() => {
    const perf = performance as any;
    const nav = perf.getEntriesByType("navigation")[0];
    return {
      domContentLoaded: (nav?.domContentLoadedEventEnd as number) ?? 0,
      loadEvent: (nav?.loadEventEnd as number) ?? 0,
      lcp: (globalThis as any).__lcpTime as number | undefined,
    };
  });

  const collected = await stopInstruments(cdp, opts);
  return { ...collected, navTiming, wallTimeMs: navTiming.loadEvent };
}
