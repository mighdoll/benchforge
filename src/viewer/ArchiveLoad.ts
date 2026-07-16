import { signal } from "@preact/signals";
import { initViewer } from "./components/App.tsx";
import { type ArchiveData, ArchiveProvider } from "./Providers.ts";
import { notesStatus, provider } from "./State.ts";

/** Transient error from the last failed archive open (drop or Open button). */
export const openError = signal<string | null>(null);

/** Parse a `.benchforge` archive file and switch the viewer to it.
 *  Throws on invalid JSON or schema so callers show their own error. */
export async function openArchiveFile(file: File): Promise<void> {
  const text = await file.text();
  const archive = JSON.parse(text) as ArchiveData;
  initViewer(new ArchiveProvider(archive));
}

/** Open an archive over the current view: confirm if in-memory notes would be
 *  discarded, and surface failures in `openError` (auto-clearing). */
export async function replaceArchive(file: File): Promise<void> {
  if (!confirmDiscardNotes()) return;
  try {
    await openArchiveFile(file);
    openError.value = null;
  } catch (err) {
    console.error("Failed to load archive:", err);
    showOpenError(String(err));
  }
}

/** Archive notes reach disk only on the next download, so confirm before
 *  discarding notes edited this session. Server notes persist server-side. */
function confirmDiscardNotes(): boolean {
  const inMemory = provider.value instanceof ArchiveProvider;
  if (!inMemory || notesStatus.value === "idle") return true;
  return window.confirm("Discard unsaved notes and open the new archive?");
}

let errorTimer: ReturnType<typeof setTimeout>;

function showOpenError(message: string): void {
  openError.value = message;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => (openError.value = null), 6000);
}
