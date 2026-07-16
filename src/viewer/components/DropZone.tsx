import { useRef, useState } from "preact/hooks";
import { openArchiveFile } from "../ArchiveLoad.ts";
import { benchforgeLabel } from "../BenchforgeVersion.ts";
import { urlError } from "../State.ts";

/** Public sample archives, loaded via the `?url=` param (see App.tsx `resolve`). */
const sampleArchives = [
  {
    title: "Statistical comparison",
    description: "Two versions, within the noise floor",
    url: "https://raw.githubusercontent.com/mighdoll/big-files/main/benchforge/wesl-link-equivalent-1.benchforge",
  },
  {
    title: "Profiling",
    description: "Allocation, time, and call count per function",
    url: "https://raw.githubusercontent.com/mighdoll/big-files/main/benchforge/wesl-link-investigate-1.benchforge",
  },
];

/** Landing page for loading `.benchforge` archive files via drag-drop or file picker. */
export function DropZone() {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Parse an archive JSON file and initialize the viewer with its data. */
  async function loadFile(file: File): Promise<void> {
    try {
      await openArchiveFile(file);
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
        <div class="drop-zone-samples">
          <div class="drop-zone-samples-heading">or explore a sample</div>
          <div class="drop-zone-sample-grid">
            {sampleArchives.map(sample => (
              <a
                key={sample.url}
                class="drop-zone-sample"
                href={`?url=${encodeURIComponent(sample.url)}`}
              >
                <span class="drop-zone-sample-title">{sample.title}</span>
                <span class="drop-zone-sample-desc">{sample.description}</span>
              </a>
            ))}
          </div>
        </div>
        {urlError.value && (
          <p class="drop-zone-error">
            Failed to load archive from <b>{urlError.value.url}</b>.{" "}
            {urlError.value.detail}
            <p>Download the file and drop it here instead.</p>
          </p>
        )}
        {error && <p class="drop-zone-error">Failed to load file: {error}</p>}
      </div>
      <div class="drop-zone-version">{benchforgeLabel()}</div>
    </div>
  );
}
