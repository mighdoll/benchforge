import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatDateWithTimezone } from "../viewer/DateFormat.ts";

/** Git commit hash, date, and dirty status for version tracking */
export interface GitVersion {
  hash: string;
  date: string;
  dirty?: boolean;
}

/** Get current git version info. For dirty repos, uses most recent modified file date. */
export function getCurrentGitVersion(): GitVersion | undefined {
  try {
    const exec = (cmd: string) => execSync(cmd, { encoding: "utf-8" }).trim();
    const hash = exec("git rev-parse --short HEAD");
    const commitDate = exec("git log -1 --format=%aI");
    const dirty = exec("git status --porcelain").length > 0;

    const date = dirty
      ? (getMostRecentModifiedDate(".") ?? commitDate)
      : commitDate;
    return { hash, date, dirty };
  } catch {
    return undefined;
  }
}

/** Read baseline version from .baseline-version file */
export function getBaselineVersion(
  baselineDir = "_baseline",
): GitVersion | undefined {
  const versionFile = join(baselineDir, ".baseline-version");
  if (!existsSync(versionFile)) return undefined;

  try {
    const content = readFileSync(versionFile, "utf-8");
    const data = JSON.parse(content);
    return { hash: data.hash, date: data.date };
  } catch {
    return undefined;
  }
}

/** Format git version for display: "abc1234 (Jan 9, 2026, 3:45 PM)" or "abc1234*" if dirty */
export function formatGitVersion(version: GitVersion): string {
  const hashDisplay = version.dirty ? `${version.hash}*` : version.hash;
  const dateDisplay = formatDateWithTimezone(version.date);
  return `${hashDisplay} (${dateDisplay})`;
}

/** Get most recent modified file date in a directory (for dirty repos) */
export function getMostRecentModifiedDate(dir: string): string | undefined {
  try {
    const opts = { encoding: "utf-8" as const, cwd: dir };
    const raw = execSync("git status --porcelain", opts);
    const modifiedFiles = raw
      .trim()
      .split("\n")
      .filter(line => line.length > 0)
      .map(line => line.slice(3));

    if (modifiedFiles.length === 0) return undefined;

    const mtime = (f: string): number => {
      try {
        const p = join(dir, f);
        return existsSync(p) ? statSync(p).mtimeMs : 0;
      } catch {
        return 0;
      }
    };
    const mostRecent = Math.max(0, ...modifiedFiles.map(mtime));
    return mostRecent > 0 ? new Date(mostRecent).toISOString() : undefined;
  } catch {
    return undefined;
  }
}
