import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { optionalJson, startViewerServer } from "../cli/ViewerServer.ts";
import { archiveSchemaVersion } from "../export/ArchiveFormat.ts";

const examplePath = join(
  import.meta.dirname!,
  "../../examples/simple-cli.benchforge",
);

let browser: Browser;
let close: () => void;
let port: number;
let archiveFile: string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "bf-notes-view-"));
  archiveFile = join(dir, "run.benchforge");
  await copyFile(examplePath, archiveFile);
  const raw = JSON.parse(await readFile(archiveFile, "utf-8"));

  // Same wiring as `benchforge view <file>`, but without opening a browser.
  const started = await startViewerServer({
    profileData: optionalJson(raw.allocProfile),
    timeProfileData: optionalJson(raw.timeProfile),
    reportData: optionalJson(raw.report),
    sources: raw.sources,
    notes: raw.notes,
    notesFile: archiveFile,
    open: false,
    port: 0,
  });
  close = started.close;
  port = started.port;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  close?.();
});

test("view mode: notes are written back to the archive file on disk", {
  timeout: 30_000,
}, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

    const input = page.locator(".notes-input");
    await input.waitFor({ state: "visible", timeout: 15_000 });
    await input.fill("write me back");

    // The tag flips to "(saved)" once the write-back to the file lands.
    await page
      .locator(".notes-status")
      .filter({ hasText: "(saved)" })
      .waitFor({ state: "visible", timeout: 15_000 });

    const saved = JSON.parse(await readFile(archiveFile, "utf-8"));
    expect(saved.notes).toBe("write me back");
    expect(saved.report).toBeTruthy();
    expect(saved.allocProfile).toBeTruthy();
    expect(saved.schema).toBe(archiveSchemaVersion);
  } finally {
    await page.close();
  }
});
