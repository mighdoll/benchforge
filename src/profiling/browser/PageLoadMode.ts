import type { CDPSession, Page } from "playwright";
import {
  instrumentOpts,
  startInstruments,
  stopInstruments,
} from "./BrowserCDP.ts";
import type {
  BrowserProfileParams,
  BrowserProfileResult,
} from "./BrowserProfiler.ts";

/** Run passive page-load profiling: instrument ==> navigate ==> wait ==> collect. */
export async function runPageLoad(
  page: Page,
  cdp: CDPSession,
  params: BrowserProfileParams,
  samplingInterval: number,
): Promise<BrowserProfileResult> {
  const opts = instrumentOpts(params, samplingInterval);
  await startInstruments(cdp, opts);

  const { url, waitFor } = params;

  // Navigate with appropriate wait strategy
  if (waitFor === "load" || waitFor === "domcontentloaded") {
    await page.goto(url, { waitUntil: waitFor });
  } else {
    await page.goto(url, { waitUntil: "networkidle" });
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
    const lcp = perf.getEntriesByType("largest-contentful-paint");
    return {
      domContentLoaded: (nav?.domContentLoadedEventEnd as number) ?? 0,
      loadEvent: (nav?.loadEventEnd as number) ?? 0,
      lcp: lcp.at(-1)?.startTime,
    };
  });

  const collected = await stopInstruments(cdp, opts);
  return { ...collected, navTiming, wallTimeMs: navTiming.loadEvent };
}
