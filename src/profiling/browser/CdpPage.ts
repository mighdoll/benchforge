import type { CdpClient } from "./CdpClient.ts";

/** Page-level CDP abstraction for navigation, evaluation, and event handling. */
export interface CdpPage {
  navigate(
    url: string,
    opts?: { waitUntil?: "load" | "domcontentloaded" },
  ): Promise<void>;
  evaluate<R>(
    fn: (...args: any[]) => R | Promise<R>,
    arg?: unknown,
  ): Promise<Awaited<R>>;
  exposeFunction(name: string, fn: (...args: any[]) => any): Promise<void>;
  addInitScript(fn: () => void): Promise<void>;
  waitForSelector(selector: string): Promise<void>;
  waitForFunction(expression: string): Promise<void>;
  onPageError(handler: (message: string) => void): void;
}

/** Create a page abstraction over a CDP client connected to a page target. */
export async function createCdpPage(
  cdp: CdpClient,
  opts?: { timeout?: number },
): Promise<CdpPage> {
  const timeout = opts?.timeout ?? 30_000;

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  return {
    navigate: (url, navOpts) => cdpNavigate(cdp, url, navOpts),
    evaluate: (fn, arg) => cdpEvaluate(cdp, fn, arg),
    exposeFunction: (name, fn) => cdpExpose(cdp, name, fn),
    async addInitScript(fn) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(${fn.toString()})()`,
      });
    },
    waitForSelector(sel) {
      const expr = `!!document.querySelector(${JSON.stringify(sel)})`;
      return pollEval(cdp, expr, timeout);
    },
    waitForFunction: expr => pollEval(cdp, expr, timeout),
    onPageError(handler) {
      cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => {
        handler(d.exception?.description || d.text);
      });
    },
  };
}

/** Navigate to a URL and wait for the specified load condition. */
async function cdpNavigate(
  cdp: CdpClient,
  url: string,
  navOpts?: { waitUntil?: "load" | "domcontentloaded" },
): Promise<void> {
  const waitUntil = navOpts?.waitUntil ?? "load";
  const event =
    waitUntil === "domcontentloaded"
      ? "Page.domContentEventFired"
      : "Page.loadEventFired";
  const loaded = new Promise<void>(r => cdp.once(event, () => r()));
  await cdp.send("Page.navigate", { url });
  await loaded;
}

/** Evaluate a function in the page and return the result. */
async function cdpEvaluate(
  cdp: CdpClient,
  fn: (...args: any[]) => any,
  arg?: unknown,
): Promise<any> {
  const argStr = arg !== undefined ? JSON.stringify(arg) : "";
  const expression = `(${fn.toString()})(${argStr})`;
  const opts = { expression, awaitPromise: true, returnByValue: true };
  const { result, exceptionDetails: err } = await cdp.send(
    "Runtime.evaluate",
    opts,
  );
  if (err) throw new Error(err.exception?.description || err.text);
  return result.value;
}

/** Expose a Node function to the page via Runtime.addBinding. */
async function cdpExpose(
  cdp: CdpClient,
  name: string,
  fn: (...args: any[]) => any,
): Promise<void> {
  const binding = `__cdp_${name}`;
  await cdp.send("Runtime.addBinding", { name: binding });

  // Wrapper: page calls window[name](...) ==> binding fires ==> Node runs fn ==> resolve
  const wrapper = `(() => {
    const g = globalThis;
    if (!g.__cdpSeq) { g.__cdpSeq = 0; g.__cdpCbs = {}; }
    g[${JSON.stringify(name)}] = (...args) => new Promise((resolve, reject) => {
      const seq = ++g.__cdpSeq;
      g.__cdpCbs[seq] = { resolve, reject };
      g[${JSON.stringify(binding)}](JSON.stringify({ seq, args }));
    });
  })()`;

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: wrapper });
  await cdp.send("Runtime.evaluate", { expression: wrapper });

  const pageEval = (expr: string) =>
    cdp.send("Runtime.evaluate", { expression: expr });
  cdp.on("Runtime.bindingCalled", async params => {
    if (params.name !== binding) return;
    const { seq, args } = JSON.parse(params.payload);
    const cb = `globalThis.__cdpCbs[${seq}]`;
    try {
      const val = await fn(...args);
      await pageEval(`${cb}?.resolve(${JSON.stringify(val ?? null)})`);
    } catch (err: any) {
      const msg = JSON.stringify(String(err.message));
      await pageEval(`${cb}?.reject(new Error(${msg}))`);
    }
  });
}

/** Poll a JS expression until truthy, with timeout. */
async function pollEval(
  cdp: CdpClient,
  expression: string,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  const evalOpts = { expression, returnByValue: true };
  while (Date.now() < deadline) {
    const { result } = await cdp.send("Runtime.evaluate", evalOpts);
    if (result.value) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}
