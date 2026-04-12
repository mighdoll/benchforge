import { useRef, useState } from "preact/hooks";
import { type ArchiveData, ArchiveProvider } from "../Providers.ts";
import { urlError } from "../State.ts";
import { initViewer } from "./App.tsx";

/** Landing page for loading `.benchforge` archive files via drag-drop or file picker. */
export function DropZone() {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Parse an archive JSON file and initialize the viewer with its data. */
  async function loadFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const archive = JSON.parse(text) as ArchiveData;
      initViewer(new ArchiveProvider(archive));
    } catch (err) {
      console.error("Failed to load archive:", err);
      setError(String(err));
    }
  }

  return (
    <div
      class={`drop-zone${dragOver ? " drag-over" : ""}`}
      onDragOver={e => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={async e => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer?.files[0];
        if (file) loadFile(file);
      }}
    >
      <div class="drop-zone-content">
        <h2>Benchforge Viewer</h2>
        <p>
          Drop a <code>.benchforge</code> file here to view results
        </p>
        <div class="drop-zone-divider">or</div>
        <label class="drop-zone-browse">
          Browse files
          <input
            ref={inputRef}
            type="file"
            accept=".benchforge"
            hidden
            onChange={() => {
              const file = inputRef.current?.files?.[0];
              if (file) loadFile(file);
            }}
          />
        </label>
        {urlError.value && (
          <p class="drop-zone-error">
            Failed to load archive from <b>{urlError.value.url}</b>.{" "}
            {urlError.value.detail}
            <p>Download the file and drop it here instead.</p>
          </p>
        )}
        {error && (
          <p class="drop-zone-error">Failed to load file: {error}</p>
        )}
      </div>
    </div>
  );
}
