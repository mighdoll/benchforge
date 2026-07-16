import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import sirv from "sirv";
import { afterAll, beforeAll, expect, test } from "vitest";

const viewerDir = path.resolve(import.meta.dirname!, "../../dist/viewer");
const examplePath = path.resolve(
  import.meta.dirname!,
  "../../examples/simple-cli.benchforge",
);

// A minified file (one very long line) and a many-line file both trip the
// large-source guard; a real small source stays on the Shiki path.
const minifiedKey = "test:///minified.js";
const manyLinesKey = "test:///many-lines.ts";
const normalKey =
  "file:///Users/lee/wesl/benchforge/src/runners/SampleStats.ts";

let server: Server;
let port: number;
let browser: Browser;
let archivePath: string;

beforeAll(async () => {
  const archive = JSON.parse(await readFile(examplePath, "utf-8"));
  archive.sources[minifiedKey] = `const x = ${"a".repeat(250_000)};`;
  archive.sources[manyLinesKey] = Array.from(
    { length: 6000 },
    (_, i) => `const v${i} = ${i};`,
  ).join("\n");
  archivePath = path.join(tmpdir(), "benchforge-large-source.benchforge");
  await writeFile(archivePath, JSON.stringify(archive));

  const assets = sirv(viewerDir, { single: true });
  server = createServer((req, res) => {
    assets(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  });
  const portP = new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) resolve(addr.port);
      else reject(new Error("Failed to get server address"));
    });
  });
  [port, browser] = await Promise.all([
    portP,
    chromium.launch({ headless: true }),
  ]);
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

/** Load the patched archive and wait for the viewer shell to be ready. */
async function loadArchive(page: Page): Promise<void> {
  await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });
  await page
    .locator('.drop-zone input[type="file"]')
    .setInputFiles(archivePath);
  await page
    .locator(".drop-zone")
    .waitFor({ state: "detached", timeout: 15_000 });
  await page
    .locator("#tab-summary")
    .waitFor({ state: "visible", timeout: 15_000 });
}

/** Ask the shell to open a source tab (same channel the flamechart uses). */
async function openSource(page: Page, file: string, line = 0): Promise<void> {
  await page.evaluate(
    ([f, l]) =>
      // @ts-expect-error window is a browser global; this callback runs in the page context via page.evaluate
      window.postMessage(
        { type: "open-source", file: f, line: l, col: 0 },
        "*",
      ),
    [file, line] as [string, number],
  );
}

test("large minified source skips highlighting and shows the banner", {
  timeout: 30_000,
}, async () => {
  const page = await browser.newPage();
  try {
    await loadArchive(page);
    await openSource(page, minifiedKey);
    const panel = page.locator(`.source-panel[data-tab="src:${minifiedKey}"]`);
    await panel
      .locator(".source-large-banner")
      .waitFor({ state: "visible", timeout: 15_000 });

    // Plain path: one line span, no Shiki token spans.
    expect(await panel.locator(".source-code .line").count()).toBe(1);
    expect(
      await panel.locator(".source-code .line span:not(.gutter)").count(),
    ).toBe(0);
  } finally {
    await page.close();
  }
});

test("large many-line source scrolls to line, then opts back into highlighting", {
  timeout: 40_000,
}, async () => {
  const page = await browser.newPage();
  try {
    await loadArchive(page);
    await openSource(page, manyLinesKey, 3000);
    const panel = page.locator(`.source-panel[data-tab="src:${manyLinesKey}"]`);
    await panel
      .locator(".source-large-banner")
      .waitFor({ state: "visible", timeout: 15_000 });
    expect(await panel.locator(".source-code .line").count()).toBe(6000);

    // Scroll-to-line still works on the plain path.
    await panel
      .locator(".source-code .line.highlighted")
      .waitFor({ state: "attached", timeout: 15_000 });

    // Highlight-anyway swaps to Shiki: banner leaves, token spans appear.
    await panel.locator(".source-highlight-btn").click();
    await panel
      .locator(".source-large-banner")
      .waitFor({ state: "detached", timeout: 25_000 });
    await panel
      .locator(".source-code .line span:not(.gutter)")
      .first()
      .waitFor({ state: "attached", timeout: 25_000 });
  } finally {
    await page.close();
  }
});

test("normal-sized source is highlighted with no banner", {
  timeout: 30_000,
}, async () => {
  const page = await browser.newPage();
  try {
    await loadArchive(page);
    await openSource(page, normalKey);
    const panel = page.locator(`.source-panel[data-tab="src:${normalKey}"]`);
    await panel
      .locator(".source-code .line")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });

    expect(await panel.locator(".source-large-banner").count()).toBe(0);
    expect(
      await panel.locator(".source-code .line span:not(.gutter)").count(),
    ).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});
