import { useState } from "preact/hooks";
import type { DataProvider } from "../Providers.ts";
import {
  activeTabId,
  provider,
  reportData,
  samplesLoaded,
  sourceTabs,
} from "../State.ts";
import { hasSufficientSamples } from "./SamplesPanel.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

export function TabBar() {
  const p = provider.value!;
  const { config } = p;
  const data = reportData.value;
  const samplesEnabled = !!data && hasSufficientSamples(data);

  return (
    <div class="tab-bar">
      <TabButton id="tab-summary" tabId="summary" disabled={!config.hasReport}>
        Summary
      </TabButton>
      <TabButton
        id="tab-samples"
        tabId="samples"
        disabled={!samplesEnabled}
        onActivate={() => {
          samplesLoaded.value = true;
        }}
      >
        Samples
      </TabButton>
      <TabButton
        id="tab-flamechart"
        tabId="flamechart"
        disabled={!config.hasProfile}
      >
        Allocation
      </TabButton>
      <TabButton
        id="tab-time-flamechart"
        tabId="time-flamechart"
        disabled={!config.hasTimeProfile}
      >
        Timing
      </TabButton>

      {sourceTabs.value.map(st => (
        <SourceTabBtn key={st.id} tabId={st.id} file={st.file} line={st.line} />
      ))}

      <div class="tab-spacer" />
      <ThemeToggle />
      <ArchiveButton provider={p} />
    </div>
  );
}

interface TabButtonProps {
  id: string;
  tabId: string;
  disabled: boolean;
  onActivate?: () => void;
  children: preact.ComponentChildren;
}

function TabButton({ id, tabId, disabled, onActivate, children }: TabButtonProps) {
  const active = activeTabId.value === tabId;
  return (
    <button
      class={`tab${active ? " active" : ""}`}
      data-tab={tabId}
      id={id}
      disabled={disabled}
      onClick={() => {
        activeTabId.value = tabId;
        onActivate?.();
      }}
    >
      {children}
    </button>
  );
}

function SourceTabBtn({ tabId, file, line }: { tabId: string; file: string; line: number }) {
  const active = activeTabId.value === tabId;
  const shortName = file.split("/").pop() || file;
  const label = line ? `${shortName}:${line}` : shortName;

  return (
    <button
      class={`tab${active ? " active" : ""}`}
      data-tab={tabId}
      onClick={(e: MouseEvent) => {
        if ((e.target as HTMLElement).closest(".tab-close")) {
          closeSourceTab(tabId);
          return;
        }
        activeTabId.value = tabId;
      }}
    >
      {label}{" "}
      <span class="tab-close" title="Close">
        &times;
      </span>
    </button>
  );
}

function closeSourceTab(tabId: string): void {
  sourceTabs.value = sourceTabs.value.filter(t => t.id !== tabId);
  if (activeTabId.value !== tabId) return;

  const config = provider.value!.config;
  if (config.hasReport) activeTabId.value = "summary";
  else if (config.hasProfile) activeTabId.value = "flamechart";
  else if (config.hasTimeProfile) activeTabId.value = "time-flamechart";
}

function ArchiveButton({ provider: p }: { provider: DataProvider }) {
  const [archiving, setArchiving] = useState(false);

  async function handleArchive(): Promise<void> {
    setArchiving(true);
    try {
      const { blob, filename } = await p.createArchive();
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
      setArchiving(false);
    }
  }

  return (
    <button
      class="tab archive-btn"
      data-action="archive"
      disabled={archiving}
      onClick={handleArchive}
    >
      {archiving ? "Archiving\u2026" : "Archive \u2193"}
    </button>
  );
}
