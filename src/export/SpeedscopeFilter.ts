/** User-only filtering for built speedscope files. */

import { isNodeUserCode } from "../profiling/node/HeapSampleReport.ts";
import type { SpeedscopeFile } from "./SpeedscopeTypes.ts";

/** Splice non-user frames out of every sample stack so the flamegraph shows only
 *  user code. Node internals, GC, and the inspector-based profiler's own frames
 *  (post/#onMessage/dispatch) drop out; their weight re-attributes to the nearest
 *  surviving user ancestor, or to unattributed root time when a stack is entirely
 *  internal. Sample weights are untouched, so the total still reflects real cost,
 *  matching the summary table's percentages (a share of the full total). Returns
 *  the file unchanged when userOnly is off or there is nothing to filter. */
export function userOnlySpeedscope(
  file: SpeedscopeFile | undefined,
  userOnly: boolean,
): SpeedscopeFile | undefined {
  if (!file || !userOnly) return file;
  const isUser = file.shared.frames.map(f =>
    isNodeUserCode({ name: f.name, url: f.file ?? "", line: f.line ?? 0 }),
  );
  const profiles = file.profiles.map(p => ({
    ...p,
    samples: p.samples.map(stack => stack.filter(i => isUser[i])),
  }));
  return { ...file, profiles };
}
