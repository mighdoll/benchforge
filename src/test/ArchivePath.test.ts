import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { expect, test } from "vitest";
import { archiveBenchmark } from "../export/ArchiveExport.ts";
import type { ReportData } from "../viewer/ReportData.ts";

const report: ReportData = {
  groups: [],
  metadata: { timestamp: "2026-07-01T00:00:00Z", bencherVersion: "0" },
};

test("no output path lands a timestamped archive in outputDir", async () => {
  const outputDir = join(await tempDir(), "bench-report");
  const written = await archive({ outputDir });
  expect(await readdir(outputDir)).toEqual([basename(written ?? "")]);
  expect(written).toMatch(/\.benchforge$/);
});

test("a directory output path is auto-named", async () => {
  const dir = await tempDir();
  const written = await archive({ outputPath: dir });
  expect(await readdir(dir)).toEqual([basename(written ?? "")]);
  expect(written).toMatch(/\.benchforge$/);
});

test("a trailing separator names a directory that doesn't exist yet", async () => {
  const dir = await tempDir();
  const written = await archive({ outputPath: join(dir, "out") + sep });
  expect(await readdir(join(dir, "out"))).toEqual([basename(written ?? "")]);
});

test("an explicit file path is used as given", async () => {
  const file = join(await tempDir(), "nested", "run.benchforge");
  expect(await archive({ outputPath: file })).toBe(file);
});

/** Write an archive holding only report data (no profiles) to `dest`. */
function archive(dest: {
  outputPath?: string;
  outputDir?: string;
}): Promise<string | undefined> {
  return archiveBenchmark({ groups: [], reportData: report, ...dest });
}

function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bf-archive-"));
}
