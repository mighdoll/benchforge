import { archiveProfile } from "./Archive.ts";
import { loadArchiveFromUrl, showDropZone } from "./DropZone.ts";
import type { ArchiveData, DataProvider } from "./Providers.ts";
import { ArchiveProvider, ServerProvider } from "./Providers.ts";
import type { ReportData } from "./ReportData.ts";
import { loadSummary } from "./ReportTab.ts";
import { hasSufficientSamples, loadSamples } from "./SamplesTab.ts";
import { closeSourceTab, openSourceTab } from "./SourceTabs.ts";
import { activateTab } from "./TabSwitcher.ts";

// ─── DOM References ────────────────────────────────────────

const tabBar = document.querySelector(".tab-bar") as HTMLDivElement;
const summaryPanel = document.getElementById("summary-panel") as HTMLDivElement;
const samplesPanel = document.getElementById("samples-panel") as HTMLDivElement;
const iframe = document.getElementById(
  "speedscope-iframe",
) as HTMLIFrameElement;
const timeIframe = document.getElementById(
  "time-speedscope-iframe",
) as HTMLIFrameElement;
const summaryTabBtn = document.getElementById(
  "tab-summary",
) as HTMLButtonElement;
const samplesTabBtn = document.getElementById(
  "tab-samples",
) as HTMLButtonElement;
const allocTab = document.getElementById("tab-flamechart") as HTMLButtonElement;
const timeTab = document.getElementById(
  "tab-time-flamechart",
) as HTMLButtonElement;

// ─── State ─────────────────────────────────────────────────

let provider: DataProvider;
let reportData: ReportData | null = null;
let samplesLoaded = false;

// ─── Tab Bar Event Delegation ──────────────────────────────

tabBar.addEventListener("click", async (ev: MouseEvent) => {
  const target = ev.target as HTMLElement;
  const tabBtn = target.closest<HTMLButtonElement>(".tab[data-tab]");
  if (tabBtn) {
    if (tabBtn.disabled) return;
    if (target.closest(".tab-close")) {
      closeSourceTab(tabBtn.dataset.tab!, provider.config);
      return;
    }
    const tabId = tabBtn.dataset.tab!;
    activateTab(tabId);
    if (tabId === "samples" && !samplesLoaded && reportData) {
      samplesLoaded = true;
      loadSamples(reportData, samplesPanel);
    }
    return;
  }
  if (target.closest('[data-action="archive"]')) {
    archiveProfile(provider);
  }
});

// ─── PostMessage from speedscope iframe ────────────────────

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.data?.type === "open-source") {
    const { file, line, col } = ev.data;
    if (file) openSourceTab(file, line, col, provider);
  }
});

// ─── Initialization ────────────────────────────────────────

async function initViewer(p: DataProvider): Promise<void> {
  provider = p;
  reportData = null;
  samplesLoaded = false;
  const { config } = p;

  summaryTabBtn.disabled = !config.hasReport;
  samplesTabBtn.disabled = true;
  allocTab.disabled = !config.hasProfile;
  timeTab.disabled = !config.hasTimeProfile;

  const allocHash = p.speedscopeHash("alloc");
  if (allocHash) iframe.src = "speedscope/#" + allocHash;
  const timeHash = p.speedscopeHash("time");
  if (timeHash) timeIframe.src = "speedscope/#" + timeHash;

  if (config.hasReport) {
    activateTab("summary");
    reportData = await loadSummary(p, summaryPanel);
    if (reportData && hasSufficientSamples(reportData)) {
      samplesTabBtn.disabled = false;
    }
  } else if (config.hasProfile) {
    activateTab("flamechart");
  } else if (config.hasTimeProfile) {
    activateTab("time-flamechart");
  }
}

// ─── Entry Point ───────────────────────────────────────────

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const archiveUrl = params.get("url");
  if (archiveUrl) {
    const p = await loadArchiveFromUrl(archiveUrl);
    if (p) {
      initViewer(p);
      return;
    }
  }

  const preloaded = (window as Record<string, unknown>).__benchforgeArchive as
    | ArchiveData
    | undefined;
  if (preloaded) {
    initViewer(new ArchiveProvider(preloaded));
    return;
  }

  try {
    const p = await ServerProvider.create();
    initViewer(p);
    return;
  } catch {
    // No server available
  }

  showDropZone(initViewer);
}

main();
