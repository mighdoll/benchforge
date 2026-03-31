import type { ViewerConfig } from "../Providers.ts";
import { activeTabId, provider, sourceTabs } from "../State.ts";
import { SamplesPanel } from "./SamplesPanel.tsx";
import { SourcePanel } from "./SourcePanel.tsx";
import { SummaryPanel } from "./SummaryPanel.tsx";

export function TabContent() {
  const p = provider.value!;
  const { config } = p;
  const tabId = activeTabId.value;

  return (
    <div class="tab-content">
      <div
        id="summary-panel"
        class={`report-panel${tabId === "summary" ? " active" : ""}`}
      >
        {config.hasReport && <SummaryPanel />}
      </div>
      <div
        id="samples-panel"
        class={`report-panel${tabId === "samples" ? " active" : ""}`}
      >
        <SamplesPanel />
      </div>
      <iframe
        id="speedscope-iframe"
        src={iframeSrc(p.profileUrl("alloc"), config)}
        style={{ display: tabId === "flamechart" ? "block" : "none" }}
      />
      <iframe
        id="time-speedscope-iframe"
        src={iframeSrc(p.profileUrl("time"), config)}
        style={{ display: tabId === "time-flamechart" ? "block" : "none" }}
      />
      {sourceTabs.value.map(st => (
        <SourcePanel key={st.id} tab={st} />
      ))}
    </div>
  );
}

function iframeSrc(url: string | null, config: ViewerConfig): string {
  if (!url) return "";
  const parts = ["profileURL=" + encodeURIComponent(url)];
  if (config.editorUri)
    parts.push("editorUri=" + encodeURIComponent(config.editorUri));
  return "speedscope/#" + parts.join("&");
}
