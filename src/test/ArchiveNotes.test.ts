import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  buildArchiveObject,
  saveArchiveNotes,
} from "../export/ArchiveExport.ts";
import { archiveSchemaVersion } from "../export/ArchiveFormat.ts";

test("buildArchiveObject carries notes", () => {
  const { archive } = buildArchiveObject({
    sources: {},
    notes: "regressed at p99",
  });
  expect(archive.notes).toBe("regressed at p99");
});

test("empty notes produce no notes key in the JSON", () => {
  const { archive } = buildArchiveObject({ sources: {}, notes: "" });
  expect(JSON.stringify(archive)).not.toContain("notes");
});

test("saveArchiveNotes round-trips and preserves unknown fields", async () => {
  const file = await tempArchive({
    schema: archiveSchemaVersion,
    sources: {},
    metadata: { timestamp: "t", benchforgeVersion: "0" },
    futureField: 42,
  });
  await saveArchiveNotes(file, "a note");
  const saved = JSON.parse(await readFile(file, "utf-8"));
  expect(saved.notes).toBe("a note");
  expect(saved.schema).toBe(archiveSchemaVersion);
  expect(saved.futureField).toBe(42);
});

test("saveArchiveNotes deletes the key for blank input", async () => {
  const file = await tempArchive({
    schema: archiveSchemaVersion,
    sources: {},
    metadata: { timestamp: "t", benchforgeVersion: "0" },
    notes: "old",
  });
  await saveArchiveNotes(file, "   ");
  const saved = JSON.parse(await readFile(file, "utf-8"));
  expect("notes" in saved).toBe(false);
});

/** Write an archive object to a fresh tmp file and return its path. */
async function tempArchive(archive: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bf-notes-"));
  const file = join(dir, "a.benchforge");
  await writeFile(file, JSON.stringify(archive));
  return file;
}
