import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sirv from "sirv";
import { afterEach, expect, test } from "vitest";
import { createRequestHandler } from "../cli/ViewerRoutes.ts";
import type { ViewerServerOptions } from "../cli/ViewerServer.ts";
import { archiveSchemaVersion } from "../export/ArchiveFormat.ts";

const servers: Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

test("notes start empty and round-trip through GET/PUT", async () => {
  const base = await startServer({});
  expect(await getJson(`${base}/api/notes`)).toEqual({ notes: "" });

  const put = await fetch(`${base}/api/notes`, putBody("hello"));
  expect(put.status).toBe(204);
  expect(await getJson(`${base}/api/notes`)).toEqual({ notes: "hello" });
});

test("archive download includes the current notes", async () => {
  const base = await startServer({
    reportData: JSON.stringify({ groups: [] }),
  });
  await fetch(`${base}/api/notes`, putBody("shipped it"));
  const resp = await fetch(`${base}/api/archive`, { method: "POST" });
  const archive = JSON.parse(await resp.text());
  expect(archive.notes).toBe("shipped it");
});

test("PUT writes notes back to the archive file when notesFile is set", async () => {
  const file = await tempArchive();
  const base = await startServer({ notesFile: file });
  await fetch(`${base}/api/notes`, putBody("on disk"));
  const saved = JSON.parse(await readFile(file, "utf-8"));
  expect(saved.notes).toBe("on disk");
  expect(saved.schema).toBe(archiveSchemaVersion);
});

test("config reports the notes filename only when writing back", async () => {
  const withFile = await startServer({ notesFile: "/tmp/run.benchforge" });
  expect((await getJson(`${withFile}/api/config`)).notesFile).toBe(
    "run.benchforge",
  );
  const withoutFile = await startServer({});
  expect((await getJson(`${withoutFile}/api/config`)).notesFile).toBe(null);
});

/** Start a viewer request handler on an ephemeral port; returns the base URL. */
async function startServer(ctx: ViewerServerOptions): Promise<string> {
  const assets = sirv(await mkdtemp(join(tmpdir(), "bf-notes-assets-")));
  const server = createServer(createRequestHandler(ctx, new Map(), assets));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Fetch options for a JSON notes PUT. */
function putBody(notes: string): RequestInit {
  return {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes }),
  };
}

/** GET a URL and parse the JSON body. */
async function getJson(url: string): Promise<Record<string, unknown>> {
  const resp = await fetch(url);
  return (await resp.json()) as Record<string, unknown>;
}

/** Write a minimal valid archive to a tmp file; returns its path (basename kept). */
async function tempArchive(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bf-notes-"));
  const file = join(dir, "run.benchforge");
  const archive = {
    schema: archiveSchemaVersion,
    sources: {},
    metadata: { timestamp: "t", benchforgeVersion: "0" },
  };
  await writeFile(file, JSON.stringify(archive));
  return file;
}
