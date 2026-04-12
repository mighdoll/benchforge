import type { ViewerConfig } from "../Providers.ts";
import { activeTabId, provider, sourceTabs } from "../State.ts";
import { SamplesPanel } from "./SamplesPanel.tsx";
import { SourcePanel } from "./SourcePanel.tsx";
import { SummaryPanel } from "./SummaryPanel.tsx";

/** Renders all tab panels, showing only the active one via CSS class toggling. */
export function TabContent() {
  const dataProvider = provider.value!;
  const { config } = dataProvider;
  const tabId = activeTabId.value;
  const panelClass = (id: string) => `report-panel${tabId === id ? " active" : ""}`;

  return (
    <div class="tab-content">
      <div id="summary-panel" class={panelClass("summary")}>
        {config.hasReport && <SummaryPanel />}
      </div>
      <div id="samples-panel" class={panelClass("samples")}>
        <SamplesPanel />
      </div>
      <iframe
        id="speedscope-iframe"
        src={iframeSrc(dataProvider.profileUrl("alloc"), config)}
        style={{ display: tabId === "flamechart" ? "block" : "none" }}
      />
      <iframe
        id="time-speedscope-iframe"
        src={iframeSrc(dataProvider.profileUrl("time"), config)}
        style={{ display: tabId === "time-flamechart" ? "block" : "none" }}
      />
      {sourceTabs.value.map(st => (
        <SourcePanel key={st.id} tab={st} />
      ))}
    </div>
  );
}

/** Build a Speedscope iframe hash-URL with optional editor URI. */
function iframeSrc(url: string | null, config: ViewerConfig): string {
  if (!url) return "";
  const parts = ["profileURL=" + encodeURIComponent(url)];
  if (config.editorUri)
    parts.push("editorUri=" + encodeURIComponent(config.editorUri));
  return "speedscope/#" + parts.join("&");
}
