import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";

const binPath = path.resolve(import.meta.dirname!, "../../bin/benchforge");
const examplePath = path.resolve(
  import.meta.dirname!,
  "../../examples/simple-cli.ts",
);

let proc: ChildProcess;
let port: number;

beforeAll(async () => {
  const args = [
    examplePath,
    "--view",
    "--alloc",
    "--time-sample",
    "--iterations",
    "3",
    "--warmup",
    "0",
    "--skip-settle",
  ];

  proc = spawn(binPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BENCHFORGE_NO_OPEN: "1" },
  });

  // Parse port from stdout line like "Viewer: http://localhost:3939"
  port = await new Promise<number>((resolve, reject) => {
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
    setTimeout(
      () =>
        reject(new Error(`Timed out waiting for viewer.\nstdout: ${stdout}`)),
      60_000,
    );
  });
}, 90_000);

afterAll(() => {
  proc?.kill();
});

test("live viewer: report tab shows chart SVG", {
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

    const reportPanel = page.locator("#report-panel");
    const svg = reportPanel.locator("svg").first();
    await svg.waitFor({ state: "visible", timeout: 15_000 });
    const childCount = await svg
      .locator("path, rect, circle, line, text")
      .count();
    expect(childCount).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
  expect(consoleErrors).toEqual([]);
});

test("live viewer: allocation tab has speedscope content", {
  timeout: 30_000,
}, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

    await page.locator("#tab-flamechart").click();
    const frame = page.frameLocator("#speedscope-iframe");
    await frame
      .locator("body *")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
  } finally {
    await browser.close();
  }
});

test("live viewer: timing tab has speedscope content", {
  timeout: 30_000,
}, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

    await page.locator("#tab-time-flamechart").click();
    const frame = page.frameLocator("#time-speedscope-iframe");
    await frame
      .locator("body *")
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
  } finally {
    await browser.close();
  }
});
