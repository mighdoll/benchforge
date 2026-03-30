import { createServer, type Server } from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import sirv from "sirv";
import { afterAll, beforeAll, expect, test } from "vitest";

const viewerDir = path.resolve(import.meta.dirname!, "../../dist/viewer");
const archivePath = path.resolve(
  import.meta.dirname!,
  "../../examples/link-2026-03-29T15-00-30-087Z.benchforge",
);

let server: Server;
let port: number;

beforeAll(async () => {
  const assets = sirv(viewerDir, { single: true });
  server = createServer((req, res) => {
    assets(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  });
  port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) resolve(addr.port);
      else reject(new Error("Failed to get server address"));
    });
  });
});

afterAll(() => {
  server?.close();
});

test("static viewer: drop zone appears on load", {
  timeout: 30_000,
}, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

    await page.locator(".drop-zone").waitFor({ state: "visible" });
  } finally {
    await browser.close();
  }
});

test("static viewer: archive upload shows summary with stats", {
  timeout: 30_000,
}, async () => {
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on("console", msg => {
      if (msg.type() === "error" && !msg.text().includes("WebGL"))
        consoleErrors.push(msg.text());
    });
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(archivePath);

    await page
      .locator(".drop-zone")
      .waitFor({ state: "detached", timeout: 15_000 });

    const summaryPanel = page.locator("#summary-panel");
    const stats = summaryPanel.locator(".stats-grid").first();
    await stats.waitFor({ state: "visible", timeout: 15_000 });
    const statItems = await summaryPanel.locator(".stat-item").count();
    expect(statItems).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
  expect(consoleErrors).toEqual([]);
});

test("static viewer: tab navigation after archive upload", {
  timeout: 30_000,
}, async () => {
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on("console", msg => {
      if (msg.type() === "error" && !msg.text().includes("WebGL"))
        consoleErrors.push(msg.text());
    });
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(archivePath);
    await page
      .locator(".drop-zone")
      .waitFor({ state: "detached", timeout: 15_000 });

    // Wait for summary to load
    const summaryPanel = page.locator("#summary-panel");
    await summaryPanel
      .locator(".stats-grid")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });

    // Samples tab
    await page.locator("#tab-samples").click();
    const samplesPanel = page.locator("#samples-panel");
    await samplesPanel
      .locator("svg")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });

    // Allocation tab
    await page.locator("#tab-flamechart").click();
    const allocFrame = page.frameLocator("#speedscope-iframe");
    await allocFrame
      .locator("body *")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });

    // Back to Summary
    await page.locator("#tab-summary").click();
    await summaryPanel
      .locator(".stats-grid")
      .first()
      .waitFor({ state: "visible" });
  } finally {
    await browser.close();
  }
  expect(consoleErrors).toEqual([]);
});
