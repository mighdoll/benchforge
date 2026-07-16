import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Browser } from "playwright";
import { chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";

const binPath = path.resolve(import.meta.dirname!, "../../bin/benchforge");
const examplePath = path.resolve(
  import.meta.dirname!,
  "../../examples/simple-cli.ts",
);

let proc: ChildProcess;
let port: number;
let browser: Browser;

beforeAll(async () => {
  const args = [
    examplePath,
    "--view-serve",
    "--alloc",
    "--profile",
    "--iterations",
    "3",
    "--warmup",
    "0",
  ];

  proc = spawn(binPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Parse port from stdout line like "Viewer: http://localhost:3939"
  let portTimer: ReturnType<typeof setTimeout>;
  const portP = new Promise<number>((resolve, reject) => {
    let stdout = "";
    proc.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/Viewer: http:\/\/localhost:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    proc.on("error", reject);
    proc.on("exit", code => {
      if (!port)
        reject(
          new Error(
            `Process exited (${code}) before viewer started.\nstdout: ${stdout}`,
          ),
        );
    });
    portTimer = setTimeout(
      () =>
        reject(new Error(`Timed out waiting for viewer.\nstdout: ${stdout}`)),
      60_000,
    );
    // Clear the timer once the port resolves so it can't outlive the test and
    // hold the worker's event loop open during teardown.
  }).finally(() => clearTimeout(portTimer));

  [port, browser] = await Promise.all([
    portP,
    chromium.launch({ headless: true }),
  ]);
}, 90_000);

afterAll(async () => {
  await browser?.close();
  proc?.kill();
});

test("live viewer: summary tab shows stats", {
  timeout: 30_000,
}, async () => {
  const consoleErrors: string[] = [];
  const page = await browser.newPage();
  try {
    page.on("console", msg => {
      if (msg.type() === "error" && !msg.text().includes("WebGL"))
        consoleErrors.push(msg.text());
    });
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

    const summaryPanel = page.locator("#summary-panel");
    const panel = summaryPanel.locator(".section-panel").first();
    await panel.waitFor({ state: "visible", timeout: 15_000 });
    const metricRows = await summaryPanel.locator(".sparkline-row").count();
    expect(metricRows).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
  expect(consoleErrors).toEqual([]);
});

test("live viewer: samples tab shows chart SVG", {
  timeout: 30_000,
}, async () => {
  const consoleErrors: string[] = [];
  const page = await browser.newPage();
  try {
    page.on("console", msg => {
      if (msg.type() === "error" && !msg.text().includes("WebGL"))
        consoleErrors.push(msg.text());
    });
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

    // Wait for summary to load (samples tab becomes enabled)
    await page
      .locator("#summary-panel .section-panel")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });

    await page.locator("#tab-samples").click();

    const samplesPanel = page.locator("#samples-panel");
    const svg = samplesPanel.locator("svg").first();
    await svg.waitFor({ state: "visible", timeout: 15_000 });
    const childCount = await svg
      .locator("path, rect, circle, line, text")
      .count();
    expect(childCount).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
  expect(consoleErrors).toEqual([]);
});

test("live viewer: notes save into the archive and the field auto-grows", {
  timeout: 30_000,
}, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

    const input = page.locator(".notes-input");
    await input.waitFor({ state: "visible", timeout: 15_000 });

    const emptyHeight = (await input.boundingBox())!.height;
    expect(emptyHeight).toBeLessThan(45);

    // The debounced save PUTs to the server; wait for it before asking for the
    // archive so ctx.notes is populated.
    const savedP = page.waitForResponse(
      r => r.url().includes("/api/notes") && r.request().method() === "PUT",
    );
    await input.fill("line1\nline2\nline3\nline4");
    const grownHeight = (await input.boundingBox())!.height;
    expect(grownHeight).toBeGreaterThan(emptyHeight);

    // No file backs a --view-serve run, so the note stays "(unsaved)".
    const status = page.locator(".notes-status");
    await status.waitFor({ state: "visible" });
    expect(await status.textContent()).toBe("(unsaved)");

    await savedP;
    const notes = await page.evaluate(async () => {
      const resp = await fetch("/api/archive", { method: "POST" });
      const archive = JSON.parse(await resp.text());
      return archive.notes as string | undefined;
    });
    expect(notes).toBe("line1\nline2\nline3\nline4");

    // The "?" explains how notes persist via the Archive button. Anchored at
    // the right edge, the popover must still open full-width, not a sliver.
    await page.locator(".notes-meta .help-button").click();
    const popover = page.locator(".help-popover");
    await popover.waitFor({ state: "visible" });
    expect(await popover.textContent()).toContain("Archive");
    expect((await popover.boundingBox())!.width).toBeGreaterThan(300);
  } finally {
    await page.close();
  }
});

test("live viewer: allocation tab has speedscope content", {
  timeout: 30_000,
}, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

    await page.locator("#tab-flamechart").click();
    const frame = page.frameLocator("#speedscope-iframe");
    await frame
      .locator("body *")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
  } finally {
    await page.close();
  }
});

test("live viewer: timing tab has speedscope content", {
  timeout: 30_000,
}, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

    await page.locator("#tab-time-flamechart").click();
    const frame = page.frameLocator("#time-speedscope-iframe");
    await frame
      .locator("body *")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
  } finally {
    await page.close();
  }
});
