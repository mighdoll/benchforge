import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Handle for a running Chrome instance. */
export interface ChromeInstance {
  port: number;
  process: ChildProcess;
  close(): Promise<void>;
}

/** Launch Chrome with remote debugging and return instance handle. */
export async function launchChrome(opts: {
  headless?: boolean;
  chromePath?: string;
  chromeProfile?: string;
  args?: string[];
}): Promise<ChromeInstance> {
  const { headless = false, chromeProfile, chromePath, args = [] } = opts;
  const chrome = chromePath || process.env.CHROME_PATH || findChrome();

  const tmpDir = chromeProfile
    ? undefined
    : await mkdtemp(join(tmpdir(), "benchforge-"));
  const userDataDir = chromeProfile || tmpDir!;

  const flags = [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(headless ? ["--headless=new"] : []),
    ...args,
  ];

  const proc = spawn(chrome, flags, { stdio: ["pipe", "pipe", "pipe"] });
  const wsUrlPromise = parseWsUrl(proc);
  pipeChromeOutput(proc);
  const wsUrl = await wsUrlPromise;
  const port = Number(new URL(wsUrl).port);

  return {
    port,
    process: proc,
    async close() {
      proc.kill();
      await new Promise<void>(r => proc.on("exit", () => r()));
      if (tmpDir)
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Create a new browser tab and return its CDP WebSocket URL. */
export async function createTab(port: number): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${port}/json/new`, {
    method: "PUT",
  });
  const text = await resp.text();
  let data: { webSocketDebuggerUrl: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Chrome /json/new returned non-JSON: ${text.slice(0, 200)}`,
    );
  }
  return data.webSocketDebuggerUrl;
}

/** Find Chrome/Chromium on the system. */
function findChrome(): string {
  if (process.platform === "darwin") {
    const path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(path)) return path;
  }
  if (process.platform === "win32") {
    for (const env of ["ProgramFiles", "ProgramFiles(x86)"] as const) {
      const base = process.env[env];
      if (!base) continue;
      const p = join(base, "Google", "Chrome", "Application", "chrome.exe");
      if (existsSync(p)) return p;
    }
  }
  for (const name of ["google-chrome", "chromium-browser", "chromium"]) {
    try {
      return execFileSync("which", [name], { encoding: "utf8" }).trim();
    } catch {}
  }
  throw new Error(
    "Chrome not found. Install Chrome or set CHROME_PATH, or use --chrome <path>.",
  );
}

/** Forward Chrome's stdout/stderr to the terminal. */
function pipeChromeOutput(proc: ChildProcess): void {
  const forward = (stream: NodeJS.ReadableStream | null) =>
    stream?.on("data", (chunk: Buffer) => {
      const lines = chunk
        .toString()
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);
      for (const line of lines) process.stderr.write(`[chrome] ${line}\n`);
    });
  forward(proc.stdout);
  forward(proc.stderr);
}

/** Parse the DevTools WebSocket URL from Chrome's stderr. */
function parseWsUrl(proc: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const wsPattern = /DevTools listening on (ws:\/\/\S+)/;
    const onData = (chunk: Buffer) => {
      const match = chunk.toString().match(wsPattern);
      if (match) {
        proc.stderr?.off("data", onData);
        resolve(match[1]);
      }
    };
    proc.stderr?.on("data", onData);
    proc.on("error", reject);
    proc.on("exit", code =>
      reject(new Error(`Chrome exited (code ${code}) before DevTools ready`)),
    );
  });
}
