let activeTabId: string | null = null;

/** Show the given tab and hide all others (summary, samples, flamechart, source). */
export function activateTab(tabId: string): void {
  activeTabId = tabId;
  const $ = document.getElementById.bind(document);

  document
    .querySelectorAll<HTMLButtonElement>(".tab-bar .tab[data-tab]")
    .forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === tabId);
    });

  const iframe = $("speedscope-iframe") as HTMLIFrameElement;
  const timeIframe = $("time-speedscope-iframe") as HTMLIFrameElement;
  iframe.style.display = tabId === "flamechart" ? "block" : "none";
  timeIframe.style.display = tabId === "time-flamechart" ? "block" : "none";

  $("summary-panel")?.classList.toggle("active", tabId === "summary");
  $("samples-panel")?.classList.toggle("active", tabId === "samples");

  document.querySelectorAll<HTMLDivElement>(".source-panel").forEach(p => {
    p.classList.toggle("active", p.dataset.tab === tabId);
  });
}

/** Return the currently active tab id, or null if none. */
export function getActiveTabId(): string | null {
  return activeTabId;
}
