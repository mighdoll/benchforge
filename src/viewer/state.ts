import { signal } from "@preact/signals";
import type { DataProvider } from "./Providers.ts";
import type { ReportData } from "./ReportData.ts";

export interface SourceTabState {
  id: string;
  file: string;
  line: number;
  col: number;
  generation: number;
}

export const provider = signal<DataProvider | null>(null);
export const reportData = signal<ReportData | null>(null);
export const activeTabId = signal("summary");
export const samplesLoaded = signal(false);
export const sourceTabs = signal<SourceTabState[]>([]);
