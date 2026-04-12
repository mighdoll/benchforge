/** .benchforge archive creation, source collection, and archive filename derivation. */

import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReportGroup } from "../report/BenchmarkReport.ts";
import type { ReportData } from "../viewer/ReportData.ts";
import { buildSpeedscopeFile } from "./AllocExport.ts";
import {
  archiveSchemaVersion,
  type BenchforgeArchive,
} from "./ArchiveFormat.ts";
import type { LineCoverage } from "./CoverageExport.ts";
import type { SpeedscopeFile } from "./SpeedscopeTypes.ts";

export interface ArchiveOptions {
  groups: ReportGroup[];
  reportData?: ReportData;
  timeProfileData?: string;
  coverageData?: string;
  outputPath?: string;
}

export interface ArchiveInput {
  allocProfile?: SpeedscopeFile;
  timeProfile?: SpeedscopeFile;
  coverage?: Record<string, LineCoverage[]>;
  report?: ReportData;
  sources: Record<string, string>;
}

/** Build a .benchforge archive file. Returns output path, or undefined if nothing to archive. */
export async function archiveBenchmark(
  options: ArchiveOptions,
): Promise<string | undefined> {
  const { groups, reportData, timeProfileData, coverageData, outputPath } =
    options;
  const allocProfile = buildSpeedscopeFile(groups) ?? undefined;
  const timeProfile = timeProfileData ? JSON.parse(timeProfileData) : undefined;
  if (!allocProfile && !timeProfile && !reportData) {
    console.log("No data to archive.");
    return undefined;
  }

  const allFrames = collectProfileFrames(allocProfile, timeProfile);
  const sources = allFrames.length ? await collectSources(allFrames) : {};
  const coverage = coverageData ? JSON.parse(coverageData) : undefined;
  const input: ArchiveInput = {
    allocProfile,
    timeProfile,
    coverage,
    report: reportData,
    sources,
  };
  const { archive, timestamp } = buildArchiveObject(input);
  const filename = outputPath || defaultArchiveName(allocProfile, timestamp);
  const absPath = resolve(filename);
  writeFileSync(absPath, JSON.stringify(archive));
  console.log(`Archive written to: ${filename}`);
  return absPath;
}

export function buildArchiveObject(input: ArchiveInput): {
  archive: BenchforgeArchive;
  timestamp: string;
} {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archive = {
    schema: archiveSchemaVersion,
    allocProfile: input.allocProfile,
    timeProfile: input.timeProfile,
    coverage: input.coverage,
    report: input.report,
    sources: input.sources,
    metadata: {
      timestamp,
      benchforgeVersion: process.env.npm_package_version || "unknown",
    },
  };
  return { archive, timestamp };
}

export function collectProfileFrames(
  allocProfile: SpeedscopeFile | null | undefined,
  timeProfile: { shared?: { frames: { file?: string }[] } } | null | undefined,
): { file?: string }[] {
  const heapFrames = allocProfile?.shared?.frames ?? [];
  const timeFrames = timeProfile?.shared?.frames ?? [];
  return [...heapFrames, ...timeFrames];
}

/** Fetch source code for all unique file URLs in profile frames. */
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

/** Derive archive filename from profile (or generic fallback). */
export function defaultArchiveName(
  profile: SpeedscopeFile | null | undefined,
  timestamp: string,
): string {
  return profile
    ? archiveFileName(profile, timestamp)
    : `benchforge-${timestamp}.benchforge`;
}

/** Fetch source text from a file:// or http(s):// URL. */
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

/** Derive an archive filename from the profile name (sanitizes URLs to safe filenames). */
function archiveFileName(file: SpeedscopeFile, timestamp: string): string {
  const raw = file.profiles[0]?.name || "profile";
  const sanitized = raw
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const base = sanitized || "profile";
  return `${base}-${timestamp}.benchforge`;
}
