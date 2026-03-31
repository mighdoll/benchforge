import { signal } from "@preact/signals";
import type { DataProvider } from "./Providers.ts";
import type { ReportData } from "./ReportData.ts";

/** Tracked state for an open source-code tab in the viewer. */
export interface SourceTabState {
  id: string;
  file: string;
  line: number;
  col: number;
  generation: number;
}

export type ThemePreference = "system" | "light" | "dark";

export const provider = signal<DataProvider | null>(null);
export const reportData = signal<ReportData | null>(null);
export const activeTabId = signal("summary");
export const samplesLoaded = signal(false);
export const sourceTabs = signal<SourceTabState[]>([]);

function readThemeCookie(): ThemePreference {
  const m = document.cookie.match(/(?:^|; )theme=(light|dark)/);
  return (m?.[1] as ThemePreference) ?? "system";
}

export const themePreference = signal<ThemePreference>(readThemeCookie());

/** Pick the best default tab based on available data. */
export function defaultTabId(): string {
  const config = provider.value?.config;
  if (config?.hasReport) return "summary";
  if (config?.hasProfile) return "flamechart";
  if (config?.hasTimeProfile) return "time-flamechart";
  return "summary";
}
