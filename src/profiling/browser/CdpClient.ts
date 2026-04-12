/** Minimal CDP WebSocket client. */
export interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, handler: (params: any) => void): void;
  once(event: string, handler: (params: any) => void): void;
  close(): void;
}

/** Connect to a CDP WebSocket endpoint and return a client. */
export async function connectCdp(wsUrl: string): Promise<CdpClient> {
  const ws = await openWebSocket(wsUrl);
  let nextId = 1;
  type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(params: any) => void>>();

  ws.addEventListener("message", event => {
    const msg = JSON.parse(String(event.data));
    if ("id" in msg) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
    } else if ("method" in msg) {
      for (const h of listeners.get(msg.method) ?? []) h(msg.params ?? {});
    }
  });

  const client: CdpClient = {
    send(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.delete(id))
            reject(new Error(`CDP timeout after 60s: ${method}`));
        }, 60_000);
        const clear = () => clearTimeout(timer);
        pending.set(id, {
          resolve(v) {
            clear();
            resolve(v);
          },
          reject(e) {
            clear();
            reject(e);
          },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(handler);
    },
    once(event, handler) {
      const wrap = (params: any) => {
        listeners.get(event)?.delete(wrap);
        handler(params);
      };
      client.on(event, wrap);
    },
    close() {
      for (const [, p] of pending) p.reject(new Error("CDP connection closed"));
      pending.clear();
      ws.close();
    },
  };
  return client;
}

/** Open a WebSocket connection, rejecting if the handshake fails. */
async function openWebSocket(wsUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl);
  const err = new Error(`CDP connect failed: ${wsUrl}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(err));
  });
  return ws;
}
