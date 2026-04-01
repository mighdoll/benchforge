import type { CdpClient } from "./CdpClient.ts";

/** Page-level CDP abstraction. */
export interface CdpPage {
  navigate(
    url: string,
    opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" },
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
  let networkInFlight = 0;

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");

  cdp.on("Network.requestWillBeSent", () => networkInFlight++);
  cdp.on("Network.loadingFinished", () => networkInFlight--);
  cdp.on("Network.loadingFailed", () => networkInFlight--);

  return {
    async navigate(url, navOpts) {
      const waitUntil = navOpts?.waitUntil ?? "load";
      networkInFlight = 0;

      const event =
        waitUntil === "domcontentloaded"
          ? "Page.domContentEventFired"
          : "Page.loadEventFired";
      const loaded = new Promise<void>(r => cdp.once(event, () => r()));
      await cdp.send("Page.navigate", { url });
      await loaded;

      if (waitUntil === "networkidle") await waitForNetworkIdle();
    },

    async evaluate(fn, arg) {
      const call =
        arg !== undefined
          ? `(${fn.toString()})(${JSON.stringify(arg)})`
          : `(${fn.toString()})()`;
      const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
        expression: call,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) {
        const msg =
          exceptionDetails.exception?.description || exceptionDetails.text;
        throw new Error(msg);
      }
      return result.value;
    },

    async exposeFunction(name, fn) {
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

      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: wrapper,
      });
      await cdp.send("Runtime.evaluate", { expression: wrapper });

      cdp.on("Runtime.bindingCalled", async params => {
        if (params.name !== binding) return;
        const { seq, args } = JSON.parse(params.payload);
        try {
          const val = await fn(...args);
          await cdp.send("Runtime.evaluate", {
            expression: `globalThis.__cdpCbs[${seq}]?.resolve(${JSON.stringify(val ?? null)})`,
          });
        } catch (err: any) {
          await cdp.send("Runtime.evaluate", {
            expression: `globalThis.__cdpCbs[${seq}]?.reject(new Error(${JSON.stringify(String(err.message))}))`,
          });
        }
      });
    },

    async addInitScript(fn) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(${fn.toString()})()`,
      });
    },

    async waitForSelector(selector) {
      const expr = `!!document.querySelector(${JSON.stringify(selector)})`;
      await pollEval(cdp, expr, timeout);
    },

    async waitForFunction(expression) {
      await pollEval(cdp, expression, timeout);
    },

    onPageError(handler) {
      cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
        handler(
          exceptionDetails.exception?.description || exceptionDetails.text,
        );
      });
    },
  };

  /** Wait until no network requests in flight for 500ms. */
  async function waitForNetworkIdle(): Promise<void> {
    let quietStart = networkInFlight <= 0 ? Date.now() : 0;
    while (true) {
      await new Promise(r => setTimeout(r, 100));
      if (networkInFlight <= 0) {
        if (!quietStart) quietStart = Date.now();
        if (Date.now() - quietStart >= 500) return;
      } else {
        quietStart = 0;
      }
    }
  }
}

/** Poll a JS expression until truthy, with timeout. */
async function pollEval(
  cdp: CdpClient,
  expression: string,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (result.value) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}
