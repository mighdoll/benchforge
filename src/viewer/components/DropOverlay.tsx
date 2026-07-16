import { useEffect, useState } from "preact/hooks";
import { openError, replaceArchive } from "../ArchiveLoad.ts";

/** Full-window drop target for opening another `.benchforge` archive from any
 *  tab, plus the transient error banner for failed opens. */
export function DropOverlay() {
  const [dragDepth, setDragDepth] = useState(0);
  useEffect(() => listenForFileDrags(setDragDepth), []);

  return (
    <>
      {dragDepth > 0 && <div class="drop-overlay">Drop to open archive</div>}
      {openError.value && (
        <div class="drop-error-banner" onClick={() => (openError.value = null)}>
          Failed to load archive: {openError.value}
        </div>
      )}
    </>
  );
}

/** Register window-level drag listeners that track file-drag depth (so the
 *  overlay doesn't flicker over child elements) and open dropped archives.
 *  Returns the cleanup function for useEffect. */
function listenForFileDrags(
  setDragDepth: (fn: (d: number) => number) => void,
): () => void {
  function hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer?.types.includes("Files");
  }
  function onDragEnter(e: DragEvent): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragDepth(d => d + 1);
  }
  function onDragOver(e: DragEvent): void {
    if (hasFiles(e)) e.preventDefault();
  }
  function onDragLeave(e: DragEvent): void {
    if (hasFiles(e)) setDragDepth(d => Math.max(0, d - 1));
  }
  function onDrop(e: DragEvent): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragDepth(() => 0);
    const file = e.dataTransfer?.files[0];
    if (file) replaceArchive(file);
  }

  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
  return () => {
    window.removeEventListener("dragenter", onDragEnter);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
  };
}
