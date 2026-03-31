/** Toggle for worker process timing logs (manual, not exposed as CLI flag) */
export const debugWorkerTiming = false;

/** Current time in ms, or 0 when debug timing is off (zero-cost no-op) */
export function getPerfNow(): number {
  return debugWorkerTiming ? performance.now() : 0;
}

/** Elapsed ms between marks, or 0 when debug timing is off */
export function getElapsed(startMark: number, endMark?: number): number {
  if (!debugWorkerTiming) return 0;
  const end = endMark ?? performance.now();
  return end - startMark;
}
