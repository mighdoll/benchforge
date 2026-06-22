import type { ResolvedFrame } from "./ResolvedProfile.ts";
import { resolveCallFrame } from "./ResolvedProfile.ts";
import type { TimeProfile } from "./TimeSampler.ts";

/** A function's self-time, aggregated across all of its call sites in one CPU
 *  profile. The CPU counterpart of {@link HeapSite}. */
export interface TimeSite {
  name: string;
  url: string;
  /** 1-indexed */
  line: number;
  col?: number;
  /** Microseconds sampled with this function as the executing (top) frame. */
  selfUs: number;
  /** Sample ticks attributed here; drives the reliability of a baseline delta
   *  (a ratio of two small tick counts is dominated by sampling noise). */
  ticks: number;
}

/** Folded self-time for one profile: sites keyed by {@link siteKey}, plus the
 *  total sampled time (the denominator for self-percentages). */
export interface TimeFold {
  byKey: Map<string, TimeSite>;
  totalUs: number;
}

/** Fold a V8 CPU profile into per-function self-time. Self-time is the wall time
 *  sampled with a function on top of the stack: sum the `timeDeltas` of the ticks
 *  whose `samples` node is that function (the same samples+timeDeltas basis the
 *  speedscope exporter uses, not `hitCount`, which ignores sample spacing).
 *  Functions reached from several call sites are distinct profile nodes; they
 *  merge by {@link siteKey} so each named function gets one total. Empty when the
 *  profile lacks the sample/delta arrays. */
export function summarizeTimeProfile(profile: TimeProfile): TimeFold {
  const { nodes, samples, timeDeltas } = profile;
  const byKey = new Map<string, TimeSite>();
  if (!samples || !timeDeltas) return { byKey, totalUs: 0 };

  const selfByNode = new Map<number, number>();
  const ticksByNode = new Map<number, number>();
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    selfByNode.set(id, (selfByNode.get(id) ?? 0) + (timeDeltas[i] ?? 0));
    ticksByNode.set(id, (ticksByNode.get(id) ?? 0) + 1);
  }

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  for (const [id, selfUs] of selfByNode) {
    const node = nodeMap.get(id);
    if (!node || selfUs <= 0) continue;
    const ticks = ticksByNode.get(id) ?? 0;
    const frame = resolveCallFrame(node.callFrame);
    const key = siteKey(frame);
    const existing = byKey.get(key);
    if (existing) {
      existing.selfUs += selfUs;
      existing.ticks += ticks;
    } else {
      byKey.set(key, { ...frame, selfUs, ticks });
    }
  }

  const totalUs = timeDeltas.reduce((sum, d) => sum + (d ?? 0), 0);
  return { byKey, totalUs };
}

/** Pool several profiles (one per batch) into a single fold: a function's
 *  self-time and ticks sum across batches. Pooling all batches, rather than
 *  keeping one, is what gives a baseline delta enough ticks to be meaningful. */
export function poolTimeProfiles(profiles: TimeProfile[]): TimeFold {
  return poolFolds(profiles.map(summarizeTimeProfile));
}

/** Sum several folds: a function's self-time and ticks add across folds. */
export function poolFolds(folds: TimeFold[]): TimeFold {
  const byKey = new Map<string, TimeSite>();
  let totalUs = 0;
  for (const fold of folds) {
    totalUs += fold.totalUs;
    for (const [key, site] of fold.byKey) {
      const existing = byKey.get(key);
      if (existing) {
        existing.selfUs += site.selfUs;
        existing.ticks += site.ticks;
      } else {
        byKey.set(key, { ...site });
      }
    }
  }
  return { byKey, totalUs };
}

/** Sites sorted by self-time descending. */
export function sortedTimeSites(byKey: Map<string, TimeSite>): TimeSite[] {
  return [...byKey.values()].sort((a, b) => b.selfUs - a.selfUs);
}

/** Aggregation + cross-profile join key. Named functions key on name + file base
 *  name (not the full path: a baseline build commonly lives in another worktree,
 *  so only the directory prefix differs) and ignore the line, so a function
 *  matches its counterpart across builds despite path and line drift. Anonymous
 *  frames stay line-qualified, having no stable identity to match. */
export function siteKey(f: ResolvedFrame): string {
  const base = `${f.name}@${fileName(f.url)}`;
  if (f.name && f.name !== "(anonymous)") return base;
  return `${base}:${f.line}:${f.col ?? "?"}`;
}

/** The file name from a frame url (last path segment), or the whole string for
 *  synthetic urls with no slash (e.g. "node:inspector", "" for GC). */
function fileName(url: string): string {
  const path = url.split(/[?#]/)[0];
  return path.slice(path.lastIndexOf("/") + 1);
}
