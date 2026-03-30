import { escapeHtml } from "./Helpers.ts";
import {
  type ArchiveData,
  ArchiveProvider,
  type DataProvider,
} from "./Providers.ts";

const tabBar = document.querySelector(".tab-bar") as HTMLDivElement;
const tabContent = document.querySelector(".tab-content") as HTMLDivElement;

/** Display the drag-drop landing page for the hosted viewer (no server). */
export function showDropZone(onInit: (provider: DataProvider) => void): void {
  tabBar.style.display = "none";
  tabContent.style.display = "none";

  const zone = document.createElement("div");
  zone.className = "drop-zone";
  zone.innerHTML = `
    <div class="drop-zone-content">
      <h2>Benchforge Viewer</h2>
      <p>Drop a <code>.benchforge</code> file here to view results</p>
      <div class="drop-zone-divider">or</div>
      <label class="drop-zone-browse">
        Browse files
        <input type="file" accept=".benchforge" hidden>
      </label>
    </div>
  `;

  zone.addEventListener("dragover", e => {
    e.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", async e => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file) await loadArchiveFile(file, zone, onInit);
  });

  const input = zone.querySelector("input[type=file]") as HTMLInputElement;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file) await loadArchiveFile(file, zone, onInit);
  });

  document.body.appendChild(zone);
}

/** Fetch and parse a `.benchforge` archive from a remote URL. */
export async function loadArchiveFromUrl(
  url: string,
): Promise<DataProvider | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const archive = (await resp.json()) as ArchiveData;
    return new ArchiveProvider(archive);
  } catch (err) {
    console.error("Failed to load archive from URL:", err);
    return null;
  }
}

async function loadArchiveFile(
  file: File,
  zone: HTMLElement,
  onInit: (provider: DataProvider) => void,
): Promise<void> {
  try {
    const text = await file.text();
    const archive = JSON.parse(text) as ArchiveData;
    zone.remove();
    tabBar.style.display = "";
    tabContent.style.display = "";
    onInit(new ArchiveProvider(archive));
  } catch (err) {
    console.error("Failed to load archive:", err);
    const content = zone.querySelector(".drop-zone-content")!;
    content.querySelector(".drop-zone-error")?.remove();
    const msg = escapeHtml(String(err));
    content.insertAdjacentHTML(
      "beforeend",
      `<p class="drop-zone-error">Failed to load file: ${msg}</p>`,
    );
  }
}
