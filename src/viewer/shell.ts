import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import langCss from "shiki/dist/langs/css.mjs";
import langHtml from "shiki/dist/langs/html.mjs";
import langJs from "shiki/dist/langs/javascript.mjs";
import langTs from "shiki/dist/langs/typescript.mjs";
import themeDark from "shiki/dist/themes/github-dark.mjs";
import themeLight from "shiki/dist/themes/github-light.mjs";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// ─── Types ─────────────────────────────────────────────────

interface ViewerConfig {
  editorUri: string | null;
  hasReport: boolean;
  hasProfile: boolean;
  hasTimeProfile: boolean;
}

interface ArchiveData {
  schema?: number;
  profile: unknown;
  timeProfile: unknown;
  report: unknown;
  sources: Record<string, string>;
  metadata?: { timestamp: string; benchforgeVersion: string };
}

interface SourceTabData {
  file: string;
  line: number;
  col: number;
  generation: number;
  button: HTMLButtonElement;
  panel: HTMLDivElement;
}

interface VersionInfo {
  hash: string;
  date?: string;
  dirty?: boolean;
}

// ─── Data Provider ─────────────────────────────────────────

interface DataProvider {
  readonly config: ViewerConfig;
  fetchReportData(): Promise<unknown>;
  fetchSource(url: string): Promise<string>;
  speedscopeHash(type: "alloc" | "time"): string | null;
  createArchive(): Promise<{ blob: Blob; filename: string }>;
}

class ServerProvider implements DataProvider {
  readonly config: ViewerConfig;
  constructor(config: ViewerConfig) {
    this.config = config;
  }

  static async create(): Promise<ServerProvider> {
    const resp = await fetch("/api/config");
    return new ServerProvider(await resp.json());
  }

  async fetchReportData(): Promise<unknown> {
    const resp = await fetch("/api/report-data");
    if (!resp.ok) throw new Error("No report data: " + resp.status);
    return resp.json();
  }

  async fetchSource(url: string): Promise<string> {
    const resp = await fetch("/api/source?url=" + encodeURIComponent(url));
    if (!resp.ok) throw new Error("Source unavailable");
    return resp.text();
  }

  speedscopeHash(type: "alloc" | "time"): string | null {
    const has =
      type === "alloc" ? this.config.hasProfile : this.config.hasTimeProfile;
    if (!has) return null;
    const url = type === "alloc" ? "/api/profile" : "/api/profile/time";
    const parts = ["profileURL=" + url];
    if (this.config.editorUri)
      parts.push("editorUri=" + encodeURIComponent(this.config.editorUri));
    return parts.join("&");
  }

  async createArchive(): Promise<{ blob: Blob; filename: string }> {
    const resp = await fetch("/api/archive", { method: "POST" });
    if (!resp.ok) throw new Error("Archive failed");
    const blob = await resp.blob();
    const disp = resp.headers.get("Content-Disposition") || "";
    const m = disp.match(/filename="?(.+?)"?$/);
    return { blob, filename: m?.[1] || "benchforge-archive.benchforge" };
  }
}

class ArchiveProvider implements DataProvider {
  readonly config: ViewerConfig;
  private blobUrls = new Map<string, string>();
  private archive: ArchiveData;

  constructor(archive: ArchiveData) {
    this.archive = archive;
    this.config = {
      editorUri: null,
      hasReport: !!archive.report,
      hasProfile: !!archive.profile,
      hasTimeProfile: !!archive.timeProfile,
    };
  }

  async fetchReportData(): Promise<unknown> {
    if (!this.archive.report) throw new Error("No report data");
    return this.archive.report;
  }

  async fetchSource(url: string): Promise<string> {
    const source = this.archive.sources?.[url];
    if (source === undefined) throw new Error("Source unavailable");
    return source;
  }

  speedscopeHash(type: "alloc" | "time"): string | null {
    const data =
      type === "alloc" ? this.archive.profile : this.archive.timeProfile;
    if (!data) return null;
    let url = this.blobUrls.get(type);
    if (!url) {
      url = URL.createObjectURL(
        new Blob([JSON.stringify(data)], { type: "application/json" }),
      );
      this.blobUrls.set(type, url);
    }
    return "profileURL=" + encodeURIComponent(url);
  }

  async createArchive(): Promise<{ blob: Blob; filename: string }> {
    const blob = new Blob([JSON.stringify(this.archive)], {
      type: "application/json",
    });
    const ts =
      this.archive.metadata?.timestamp ||
      new Date().toISOString().replace(/[:.]/g, "-");
    return { blob, filename: `benchforge-${ts}.benchforge` };
  }
}

// ─── DOM References ────────────────────────────────────────

const tabBar = document.querySelector(".tab-bar") as HTMLDivElement;
const tabContent = document.querySelector(".tab-content") as HTMLDivElement;
const iframe = document.getElementById(
  "speedscope-iframe",
) as HTMLIFrameElement;
const timeIframe = document.getElementById(
  "time-speedscope-iframe",
) as HTMLIFrameElement;
const reportPanel = document.getElementById("report-panel") as HTMLDivElement;
const reportTab = document.getElementById("tab-report") as HTMLButtonElement;
const allocTab = document.getElementById("tab-flamechart") as HTMLButtonElement;
const timeTab = document.getElementById(
  "tab-time-flamechart",
) as HTMLButtonElement;

// ─── State ─────────────────────────────────────────────────

let provider: DataProvider;
let activeTabId: string | null = null;
let reportLoaded = false;
const sourceTabs = new Map<string, SourceTabData>();

// ─── Shiki (lazy singleton) ───────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let highlighterPromise: Promise<HighlighterCore> | undefined;

function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [themeLight, themeDark],
    langs: [langJs, langTs, langCss, langHtml],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

// ─── Tab Switching ─────────────────────────────────────────

function activateTab(tabId: string): void {
  activeTabId = tabId;
  tabBar.querySelectorAll<HTMLButtonElement>(".tab[data-tab]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  iframe.style.display = tabId === "flamechart" ? "block" : "none";
  timeIframe.style.display = tabId === "time-flamechart" ? "block" : "none";
  reportPanel.classList.toggle("active", tabId === "report");
  sourceTabs.forEach((tab, id) => {
    tab.panel.classList.toggle("active", id === tabId);
  });
}

tabBar.addEventListener("click", (ev: MouseEvent) => {
  const target = ev.target as HTMLElement;
  const tabBtn = target.closest<HTMLButtonElement>(".tab[data-tab]");
  if (tabBtn) {
    if (tabBtn.disabled) return;
    if (target.closest(".tab-close")) {
      closeSourceTab(tabBtn.dataset.tab!);
      return;
    }
    activateTab(tabBtn.dataset.tab!);
    return;
  }
  if (target.closest('[data-action="archive"]')) {
    archiveProfile();
  }
});

// ─── Report Tab ────────────────────────────────────────────

async function loadReport(): Promise<void> {
  if (reportLoaded) return;
  reportLoaded = true;
  reportPanel.innerHTML =
    '<div class="empty-state"><p>Loading report\u2026</p></div>';

  try {
    const data = await provider.fetchReportData();
    const rd = data as { metadata: Record<string, unknown>; groups: unknown[] };

    reportPanel.innerHTML =
      buildReportHeader(rd.metadata) +
      rd.groups
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((group: any, i: number) => buildGroupHtml(group, i))
        .join("");

    const { renderPlots } = (await import("./plots/RenderPlots.ts")) as {
      renderPlots: (data: unknown) => void;
    };
    renderPlots(data);
  } catch (err) {
    console.error("Report load failed:", err);
    reportPanel.innerHTML =
      '<div class="empty-state"><p>Failed to load report data: ' +
      escapeHtml(String(err)) +
      "</p></div>";
  }
}

function buildReportHeader(metadata: Record<string, unknown>): string {
  const cliArgs = formatCliArgs(
    metadata.cliArgs as Record<string, unknown> | undefined,
  );
  const version = formatVersionInfo(metadata);
  return `<div class="report-header">
    <div class="cli-args">${escapeHtml(cliArgs)}</div>
    <div class="header-right">
      <div class="metadata">Generated: ${escapeHtml(new Date().toLocaleString())}</div>
      ${version}
    </div>
  </div>`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildGroupHtml(group: any, i: number): string {
  if (!group.benchmarks || group.benchmarks.length === 0) {
    return `<div id="group-${i}"><div class="error">No benchmark data available for this group</div></div>`;
  }
  const badge = comparisonBadge(group, i);
  return `<div id="group-${i}">
    <div class="group-header">
      <h2>${escapeHtml(group.name)}</h2>
      ${badge}
    </div>
    <div class="plot-grid">
      <div class="plot-container">
        <div class="plot-title">Time per Sample</div>
        <div class="plot-description">Execution time for each sample in collection order</div>
        <div id="sample-timeseries-${i}" class="plot-area">
          <div class="loading">Loading time series...</div>
        </div>
      </div>
      <div class="plot-container">
        <div class="plot-title">Time Distribution</div>
        <div class="plot-description">Frequency distribution of execution times</div>
        <div id="histogram-${i}" class="plot-area">
          <div class="loading">Loading histogram...</div>
        </div>
      </div>
    </div>
    <div id="stats-${i}"></div>
  </div>`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function comparisonBadge(group: any, i: number): string {
  const ci = group.benchmarks[0]?.comparisonCI;
  if (!ci) return "";
  const labels: Record<string, string> = {
    faster: "Faster",
    slower: "Slower",
    uncertain: "Inconclusive",
  };
  return `<span class="badge badge-${ci.direction}">${labels[ci.direction]}</span>
    <div id="ci-plot-${i}" class="ci-plot-container"></div>`;
}

const defaultArgs: Record<string, unknown> = {
  worker: true,
  time: 5,
  warmup: 500,
  "pause-interval": 0,
  "pause-duration": 100,
};
const skipArgs = new Set(["_", "$0", "view"]);

function formatCliArgs(args?: Record<string, unknown>): string {
  if (!args) return "benchforge";
  const parts = ["benchforge"];
  for (const [key, value] of Object.entries(args)) {
    if (skipArgs.has(key) || value === undefined || value === false) continue;
    if (defaultArgs[key] === value) continue;
    if (!key.includes("-") && key !== key.toLowerCase()) continue;
    if (key === "convergence" && !args.adaptive) continue;
    parts.push(value === true ? `--${key}` : `--${key} ${value}`);
  }
  return parts.join(" ");
}

function formatVersionInfo(metadata: Record<string, unknown>): string {
  const currentVersion = metadata.currentVersion as VersionInfo | undefined;
  const baselineVersion = metadata.baselineVersion as VersionInfo | undefined;
  if (!currentVersion && !baselineVersion) return "";
  const parts: string[] = [];
  if (currentVersion) parts.push("Current: " + formatVersion(currentVersion));
  if (baselineVersion)
    parts.push("Baseline: " + formatVersion(baselineVersion));
  return `<div class="version-info">${parts.join(" | ")}</div>`;
}

function formatVersion(v: VersionInfo): string {
  if (!v || v.hash === "unknown") return "unknown";
  const hash = v.dirty ? v.hash + "*" : v.hash;
  if (!v.date) return hash;
  const diffMs = Date.now() - new Date(v.date).getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  let rel: string;
  if (mins < 1) rel = "just now";
  else if (mins < 60) rel = `${mins}m ago`;
  else if (hours < 24) rel = `${hours}h ago`;
  else if (days === 1) rel = "yesterday";
  else if (days < 30) rel = `${days} days ago`;
  else
    rel = new Date(v.date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  return `${hash} (${rel})`;
}

// ─── Source Tabs ───────────────────────────────────────────

function sourceTabId(file: string): string {
  return "src:" + file;
}

function openSourceTab(file: string, line: number, col: number): void {
  const id = sourceTabId(file);
  const existing = sourceTabs.get(id);
  if (existing) {
    existing.line = line;
    existing.col = col;
    existing.generation = (existing.generation || 0) + 1;
    updateSourcePanel(existing, file, line, col);
    activateTab(id);
    return;
  }

  const spacer = tabBar.querySelector(".tab-spacer")!;
  const shortName = file.split("/").pop() || file;
  const label = line ? shortName + ":" + line : shortName;

  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.tab = id;
  btn.innerHTML =
    escapeHtml(label) + ' <span class="tab-close" title="Close">&times;</span>';
  tabBar.insertBefore(btn, spacer);

  const panel = document.createElement("div");
  panel.className = "source-panel";
  tabContent.appendChild(panel);

  const tabData: SourceTabData = {
    file,
    line,
    col,
    generation: 1,
    button: btn,
    panel,
  };
  sourceTabs.set(id, tabData);
  updateSourcePanel(tabData, file, line, col);
  activateTab(id);
}

function buildSourceHeader(file: string, line: number, col: number): string {
  let header = '<div class="source-header">';
  header += '<span class="source-path">' + escapeHtml(file) + "</span>";
  if (provider.config.editorUri) {
    const editorHref =
      provider.config.editorUri +
      filePathFromUrl(file) +
      ":" +
      (line || 1) +
      ":" +
      (col || 1);
    header +=
      ' <a class="source-editor-link" href="' +
      escapeHtml(editorHref) +
      '">Open in Editor</a>';
  }
  header += "</div>";
  return header;
}

async function updateSourcePanel(
  tabData: SourceTabData,
  file: string,
  line: number,
  col: number,
): Promise<void> {
  const { panel, button } = tabData;
  const gen = tabData.generation;
  const shortName = file.split("/").pop() || file;
  const label = line ? shortName + ":" + line : shortName;
  button.innerHTML =
    escapeHtml(label) + ' <span class="tab-close" title="Close">&times;</span>';

  panel.innerHTML =
    '<div class="source-placeholder"><p>Loading source\u2026</p></div>';

  try {
    const code = await provider.fetchSource(file);
    if (tabData.generation !== gen) return;

    const lang = guessLang(file);
    const highlighter = await getHighlighter();
    if (tabData.generation !== gen) return;

    const html = highlighter.codeToHtml(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
    });

    const header = buildSourceHeader(file, line, col);
    panel.innerHTML = header + '<div class="source-code">' + html + "</div>";

    if (line) {
      const lines = panel.querySelectorAll(".source-code .line");
      const target = lines[line - 1];
      if (target) {
        target.classList.add("highlighted");
        target.scrollIntoView({ block: "center" });
      }
    }
  } catch {
    if (tabData.generation !== gen) return;
    panel.innerHTML =
      '<div class="source-placeholder"><p>Source unavailable for ' +
      escapeHtml(file) +
      "</p></div>";
  }
}

function closeSourceTab(tabId: string): void {
  const tab = sourceTabs.get(tabId);
  if (!tab) return;
  tab.button.remove();
  tab.panel.remove();
  sourceTabs.delete(tabId);
  if (activeTabId === tabId) {
    if (provider.config.hasReport) activateTab("report");
    else if (provider.config.hasProfile) activateTab("flamechart");
    else if (provider.config.hasTimeProfile) activateTab("time-flamechart");
  }
}

// ─── Archive ───────────────────────────────────────────────

async function archiveProfile(): Promise<void> {
  const btn = tabBar.querySelector(
    '[data-action="archive"]',
  ) as HTMLButtonElement;
  const originalText = btn.textContent;
  btn.textContent = "Archiving\u2026";
  btn.disabled = true;

  try {
    const { blob, filename } = await provider.createArchive();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    console.error("Archive failed:", err);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// ─── PostMessage from speedscope iframe ────────────────────

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.data?.type === "open-source") {
    const { file, line, col } = ev.data;
    if (file) openSourceTab(file, line, col);
  }
});

// ─── Helpers ───────────────────────────────────────────────

function guessLang(file: string): string {
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return "typescript";
  if (file.endsWith(".css")) return "css";
  if (file.endsWith(".html")) return "html";
  return "javascript";
}

function filePathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ─── Drop Zone (hosted viewer mode) ───────────────────────

function showDropZone(): void {
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
    if (file) await loadArchiveFile(file, zone);
  });

  const input = zone.querySelector("input[type=file]") as HTMLInputElement;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file) await loadArchiveFile(file, zone);
  });

  document.body.appendChild(zone);
}

async function loadArchiveFile(file: File, zone: HTMLElement): Promise<void> {
  try {
    const text = await file.text();
    const archive = JSON.parse(text) as ArchiveData;
    zone.remove();
    tabBar.style.display = "";
    tabContent.style.display = "";
    reportLoaded = false;
    initViewer(new ArchiveProvider(archive));
  } catch (err) {
    console.error("Failed to load archive:", err);
    const content = zone.querySelector(".drop-zone-content")!;
    const existing = content.querySelector(".drop-zone-error");
    if (existing) existing.remove();
    content.insertAdjacentHTML(
      "beforeend",
      `<p class="drop-zone-error">Failed to load file: ${escapeHtml(String(err))}</p>`,
    );
  }
}

async function loadArchiveFromUrl(url: string): Promise<DataProvider | null> {
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

// ─── Viewer Initialization ─────────────────────────────────

function initViewer(p: DataProvider): void {
  provider = p;
  const { config } = p;

  if (config.hasReport) reportTab.disabled = false;
  if (config.hasProfile) allocTab.disabled = false;
  if (config.hasTimeProfile) timeTab.disabled = false;

  const allocHash = p.speedscopeHash("alloc");
  if (allocHash) iframe.src = "speedscope/#" + allocHash;
  const timeHash = p.speedscopeHash("time");
  if (timeHash) timeIframe.src = "speedscope/#" + timeHash;

  if (config.hasReport) {
    activateTab("report");
    loadReport();
  } else if (config.hasProfile) {
    activateTab("flamechart");
  } else if (config.hasTimeProfile) {
    activateTab("time-flamechart");
  }
}

// ─── Entry Point ───────────────────────────────────────────

async function main(): Promise<void> {
  // 1. URL parameter: ?url=https://...
  const params = new URLSearchParams(window.location.search);
  const archiveUrl = params.get("url");
  if (archiveUrl) {
    const p = await loadArchiveFromUrl(archiveUrl);
    if (p) {
      initViewer(p);
      return;
    }
  }

  // 2. Pre-loaded archive (set externally)
  const preloaded = (window as Record<string, unknown>).__benchforgeArchive as
    | ArchiveData
    | undefined;
  if (preloaded) {
    initViewer(new ArchiveProvider(preloaded));
    return;
  }

  // 3. Server mode (live CLI viewer)
  try {
    const p = await ServerProvider.create();
    initViewer(p);
    return;
  } catch {
    // No server available
  }

  // 4. Hosted viewer — show drop zone
  showDropZone();
}

main();
