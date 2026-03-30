import { archiveProfile } from "./Archive.ts";
import { loadArchiveFromUrl, showDropZone } from "./DropZone.ts";
import type { ArchiveData, DataProvider, ViewerConfig } from "./Providers.ts";
import { ArchiveProvider, ServerProvider } from "./Providers.ts";
import type { ReportData } from "./ReportData.ts";
import { loadSummary } from "./ReportTab.ts";
import { hasSufficientSamples, loadSamples } from "./SamplesTab.ts";
import { closeSourceTab, openSourceTab } from "./SourceTabs.ts";
import { activateTab } from "./TabSwitcher.ts";

const $ = document.getElementById.bind(document);
const tabBar = document.querySelector(".tab-bar") as HTMLDivElement;
const summaryPanel = $("summary-panel") as HTMLDivElement;
const samplesPanel = $("samples-panel") as HTMLDivElement;
const iframe = $("speedscope-iframe") as HTMLIFrameElement;
const timeIframe = $("time-speedscope-iframe") as HTMLIFrameElement;
const summaryTabBtn = $("tab-summary") as HTMLButtonElement;
const samplesTabBtn = $("tab-samples") as HTMLButtonElement;
const allocTab = $("tab-flamechart") as HTMLButtonElement;
const timeTab = $("tab-time-flamechart") as HTMLButtonElement;

let provider: DataProvider;
let reportData: ReportData | null = null;
let samplesLoaded = false;

async function initViewer(p: DataProvider): Promise<void> {
  provider = p;
  reportData = null;
  samplesLoaded = false;
  const { config } = p;

  summaryTabBtn.disabled = !config.hasReport;
  samplesTabBtn.disabled = true;
  allocTab.disabled = !config.hasProfile;
  timeTab.disabled = !config.hasTimeProfile;

  const allocUrl = p.profileUrl("alloc");
  if (allocUrl) iframe.src = "speedscope/#" + speedscopeHash(allocUrl, config);
  const timeUrl = p.profileUrl("time");
  if (timeUrl)
    timeIframe.src = "speedscope/#" + speedscopeHash(timeUrl, config);

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

function speedscopeHash(url: string, config: ViewerConfig): string {
  const parts = ["profileURL=" + encodeURIComponent(url)];
  if (config.editorUri)
    parts.push("editorUri=" + encodeURIComponent(config.editorUri));
  return parts.join("&");
}

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

  const preloaded = (window as unknown as Record<string, unknown>)
    .__benchforgeArchive as ArchiveData | undefined;
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

tabBar.addEventListener("click", async (ev: MouseEvent) => {
  const target = ev.target as HTMLElement;

  if (target.closest('[data-action="archive"]')) {
    archiveProfile(provider);
    return;
  }

  const tabBtn = target.closest<HTMLButtonElement>(".tab[data-tab]");
  if (!tabBtn || tabBtn.disabled) return;

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
});

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.data?.type === "open-source") {
    const { file, line, col } = ev.data;
    if (file) openSourceTab(file, line, col, provider);
  }
});

main();
