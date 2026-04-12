import { useEffect, useState } from "preact/hooks";
import type { DataProvider } from "../Providers.ts";
import {
  type ArchiveData,
  ArchiveProvider,
  ServerProvider,
} from "../Providers.ts";
import {
  activeTabId,
  defaultTabId,
  provider,
  reportData,
  samplesLoaded,
  sourceTabs,
  urlError,
} from "../State.ts";
import { DropZone } from "./DropZone.tsx";
import { Shell } from "./Shell.tsx";

/** Reset viewer state and activate the appropriate default tab for the provider. */
export function initViewer(p: DataProvider): void {
  provider.value = p;
  reportData.value = null;
  samplesLoaded.value = false;
  urlError.value = null;
  sourceTabs.value = [];
  activeTabId.value = defaultTabId();
}

export function App() {
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    resolve().then(() => setResolved(true));
  }, []);

  if (provider.value) return <Shell />;
  if (resolved) return <DropZone />;
  return null;
}

/** Try archive URL param, preloaded data, then dev server -- first match wins. */
async function resolve(): Promise<void> {
  const archiveUrl = new URLSearchParams(window.location.search).get("url");
  if (archiveUrl) {
    try {
      const resp = await fetch(archiveUrl);
      if (resp.ok) {
        initViewer(new ArchiveProvider((await resp.json()) as ArchiveData));
        return;
      }
      urlError.value = { url: archiveUrl, detail: `(${resp.status})` };
    } catch {
      urlError.value = {
        url: archiveUrl,
        detail: "(Perhaps CORS or network error?)",
      };
    }
  }

  const preloaded = (window as unknown as Record<string, unknown>)
    .__benchforgeArchive as ArchiveData | undefined;
  if (preloaded) {
    initViewer(new ArchiveProvider(preloaded));
    return;
  }

  try {
    initViewer(await ServerProvider.create());
  } catch {
    // No server available
  }
}
