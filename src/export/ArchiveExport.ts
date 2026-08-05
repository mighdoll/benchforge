/** .benchforge archive creation, source collection, and archive filename derivation. */

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
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
  /** Prebuilt alloc flamegraph (already user-only filtered); rebuilt from
   *  groups (unfiltered) when omitted. */
  allocProfile?: SpeedscopeFile;
  reportData?: ReportData;
  timeProfileData?: string;
  coverageData?: string;

  /** Explicit destination. A directory value (existing, or written with a
   *  trailing separator) gets the default timestamped filename inside it. */
  outputPath?: string;

  /** Directory for the default filename when outputPath is omitted (cwd if
   *  unset). */
  outputDir?: string;
}

export interface ArchiveInput {
  allocProfile?: SpeedscopeFile;
  timeProfile?: SpeedscopeFile;
  coverage?: Record<string, LineCoverage[]>;
  report?: ReportData;
  notes?: string;
  sources: Record<string, string>;
}

/** Build a .benchforge archive file. Returns output path, or undefined if nothing to archive. */
export async function archiveBenchmark(
  options: ArchiveOptions,
): Promise<string | undefined> {
  const { groups, reportData, timeProfileData, coverageData, outputPath } =
    options;
  const allocProfile = options.allocProfile ?? buildSpeedscopeFile(groups);
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
  const name = defaultArchiveName(allocProfile, timestamp);
  const absPath = archivePath(outputPath, options.outputDir, name);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, JSON.stringify(archive));
  console.log(`Archive written to: ${absPath}`);
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
    notes: blankToUndefined(input.notes),
    sources: input.sources,
    metadata: {
      timestamp,
      benchforgeVersion: process.env.npm_package_version || "unknown",
    },
  };
  return { archive, timestamp };
}

/** Map blank (empty or whitespace-only) notes to undefined so blank text never
 *  persists; the value itself is returned unchanged (not trimmed). */
export function blankToUndefined(
  notes: string | undefined,
): string | undefined {
  return notes?.trim() ? notes : undefined;
}

/** Set or clear the notes of an existing archive file, preserving every other
 *  field. Re-reads and re-parses the file so fields this version doesn't model
 *  survive, and writes via temp + rename so a crash can't truncate the archive. */
export async function saveArchiveNotes(
  filePath: string,
  notes: string,
): Promise<void> {
  const raw = await readFile(filePath, "utf-8");
  const archive = JSON.parse(raw) as BenchforgeArchive;
  if (notes.trim()) archive.notes = notes;
  else delete archive.notes;
  const temp = `${filePath}.tmp`;
  await writeFile(temp, JSON.stringify(archive));
  await rename(temp, filePath);
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

/** Resolve where the archive lands: an explicit file path as given, a directory
 *  value auto-named with `name`, and an omitted path inside `outputDir`. */
function archivePath(
  outputPath: string | undefined,
  outputDir: string | undefined,
  name: string,
): string {
  if (!outputPath) return resolve(outputDir ?? ".", name);
  if (isDirPath(outputPath)) return resolve(outputPath, name);
  return resolve(outputPath);
}

/** True when the path names a directory: it exists as one, or was written with
 *  a trailing separator (a dir that doesn't exist yet). */
function isDirPath(path: string): boolean {
  if (path.endsWith("/") || path.endsWith(sep)) return true;
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
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
