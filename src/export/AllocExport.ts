import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HeapProfile } from "../profiling/node/HeapSampler.ts";
import {
  type ResolvedProfile,
  resolveProfile,
} from "../profiling/node/ResolvedProfile.ts";
import { groupReports, type ReportGroup } from "../report/BenchmarkReport.ts";
import type { ReportData } from "../viewer/ReportData.ts";
import {
  internFrame,
  type SpeedscopeFile,
  type SpeedscopeFrame,
  type SpeedscopeHeapProfile,
  speedscopeFile,
} from "./SpeedscopeTypes.ts";

export interface ArchiveOptions {
  groups: ReportGroup[];
  reportData?: ReportData;
  timeProfileData?: string;
  coverageData?: string;
  outputPath?: string;
}

/** Export heap profiles from benchmark results to speedscope JSON format.
 *  Creates one speedscope profile per benchmark that has a heapProfile.
 *  @returns resolved output path, or undefined if no profiles were found */
export function exportSpeedscope(
  groups: ReportGroup[],
  outputPath: string,
): string | undefined {
  const file = buildSpeedscopeFile(groups);
  if (!file) {
    console.log("No heap profiles to export.");
    return undefined;
  }

  const absPath = resolve(outputPath);
  writeFileSync(absPath, JSON.stringify(file));
  console.log(`Speedscope profile exported to: ${outputPath}`);
  return absPath;
}

/** Convert a single HeapProfile to speedscope format (for standalone use) */
export function heapProfileToSpeedscope(
  name: string,
  profile: HeapProfile,
): SpeedscopeFile {
  const frames: SpeedscopeFrame[] = [];
  const frameIndex = new Map<string, number>();
  const resolved = resolveProfile(profile);
  const p = buildProfile(name, resolved, frames, frameIndex);

  return speedscopeFile(frames, [p]);
}

/** Build SpeedscopeFile from report groups. Returns undefined if no heap profiles. */
export function buildSpeedscopeFile(
  groups: ReportGroup[],
): SpeedscopeFile | undefined {
  const frames: SpeedscopeFrame[] = [];
  const frameIndex = new Map<string, number>();
  const profiles: SpeedscopeHeapProfile[] = [];

  for (const group of groups) {
    for (const report of groupReports(group)) {
      const { heapProfile } = report.measuredResults;
      if (!heapProfile) continue;
      const resolved = resolveProfile(heapProfile);
      profiles.push(buildProfile(report.name, resolved, frames, frameIndex));
    }
  }

  if (profiles.length === 0) return undefined;

  return speedscopeFile(frames, profiles);
}

/** Fetch a single source URL. Supports file:// (fs read) and http(s):// (fetch). */
export async function fetchSource(url: string): Promise<string | undefined> {
  try {
    if (url.startsWith("file://")) {
      return await readFile(fileURLToPath(url), "utf-8");
    }
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return undefined;
    return await resp.text();
  } catch {
    return undefined;
  }
}

/** Fetch source code for all unique file URLs in profile frames.
 *  Skips URLs that fail to fetch. */
export async function collectSources(
  frames: { file?: string }[],
  cache?: Map<string, string>,
): Promise<Record<string, string>> {
  const urls = new Set(frames.map(f => f.file).filter((u): u is string => !!u));

  const sources: Record<string, string> = {};
  for (const url of urls) {
    const cached = cache?.get(url);
    const text = cached ?? (await fetchSource(url));
    if (text === undefined) continue;
    sources[url] = text;
    if (!cached) cache?.set(url, text);
  }

  return sources;
}

/** Build a .benchforge archive containing profile + report + sources.
 *  @returns resolved output path, or undefined if nothing to archive */
export async function archiveBenchmark(
  options: ArchiveOptions,
): Promise<string | undefined> {
  const { groups, reportData, timeProfileData, coverageData, outputPath } =
    options;
  const file = buildSpeedscopeFile(groups);
  const timeProfile = timeProfileData ? JSON.parse(timeProfileData) : null;
  if (!file && !timeProfile && !reportData) {
    console.log("No data to archive.");
    return undefined;
  }

  const allFrames = [
    ...(file?.shared?.frames ?? []),
    ...(timeProfile?.shared?.frames ?? []),
  ];
  const sources = allFrames.length ? await collectSources(allFrames) : {};
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const coverage = coverageData ? JSON.parse(coverageData) : null;
  const archive = {
    schema: 1,
    profile: file ?? null,
    timeProfile,
    coverage,
    report: reportData ?? null,
    sources,
    metadata: {
      timestamp,
      benchforgeVersion: process.env.npm_package_version || "unknown",
    },
  };

  const fallback = file
    ? archiveFileName(file, timestamp)
    : `benchforge-${timestamp}.benchforge`;
  const filename = outputPath || fallback;
  const absPath = resolve(filename);
  writeFileSync(absPath, JSON.stringify(archive));
  console.log(`Archive written to: ${filename}`);
  return absPath;
}

/** Derive an archive filename from the profile name.
 *  e.g. "http://localhost:8080/my-app" → "localhost-8080-my-app-2026-03-28T17-25.benchforge" */
export function archiveFileName(
  file: SpeedscopeFile,
  timestamp: string,
): string {
  const raw = file.profiles[0]?.name || "profile";
  const sanitized = raw
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const base = sanitized || "profile";
  return `${base}-${timestamp}.benchforge`;
}

/** Build a single speedscope profile from a resolved heap profile */
function buildProfile(
  name: string,
  resolved: ResolvedProfile,
  sharedFrames: SpeedscopeFrame[],
  frameIndex: Map<string, number>,
): SpeedscopeHeapProfile {
  const intern = (f: {
    name: string;
    url: string;
    line: number;
    col?: number | null;
  }) => internFrame(f.name, f.url, f.line, f.col, sharedFrames, frameIndex);

  // Build nodeId -> stack of frame indices
  const nodeStacks = new Map<number, number[]>();
  for (const node of resolved.nodes) {
    nodeStacks.set(node.nodeId, node.stack.map(intern));
  }

  const samples: number[][] = [];
  const weights: number[] = [];

  if (!resolved.sortedSamples?.length) {
    const msg = `Speedscope export: no samples in heap profile for "${name}", skipping`;
    console.error(msg);
    return {
      type: "sampled",
      name,
      unit: "bytes",
      startValue: 0,
      endValue: 0,
      samples,
      weights,
    };
  }

  for (const sample of resolved.sortedSamples) {
    const stack = nodeStacks.get(sample.nodeId);
    if (stack) {
      samples.push(stack);
      weights.push(sample.size);
    }
  }

  const totalBytes = weights.reduce((sum, w) => sum + w, 0);

  return {
    type: "sampled",
    name,
    unit: "bytes",
    startValue: 0,
    endValue: totalBytes,
    samples,
    weights,
  };
}
