import { signal } from "@preact/signals";
import type { DataProvider } from "./Providers.ts";
import type { ReportData, ShiftPercentile } from "./ReportData.ts";

/** Tracked state for an open source-code tab in the viewer. */
export interface SourceTabState {
  id: string;
  file: string;
  line: number;
  col: number;
  generation: number;
}

/** User color-scheme preference: follow OS, or force light/dark. */
export type ThemePreference = "system" | "light" | "dark";

/** Outlier-trim mode: "trim" removes slow-outlier batches from display+CIs;
 *  "raw" uses every sample. Default is "trim". */
export type TrimMode = "trim" | "raw";

/** Active data source (server or archive). */
export const provider = signal<DataProvider | null>(null);

/** Parsed report data from the provider. */
export const reportData = signal<ReportData | null>(null);

/** Currently visible tab id. */
export const activeTabId = signal("summary");

/** Whether sample data has been loaded for the samples tab. */
export const samplesLoaded = signal(false);

/** Error info when a `?url=` archive fetch fails. */
export const urlError = signal<{ url: string; detail: string } | null>(null);

/** Open source-code tabs. */
export const sourceTabs = signal<SourceTabState[]>([]);
export const trimMode = signal<TrimMode>("trim");

/** Payload for the shift-detail popup: one point plus its display context. */
export interface ShiftDetail {
  point: ShiftPercentile;
  metric: string;
  equivMargin?: number;
}

/** Open detail popup for a shift-function point (verdict or percentile). Null = closed. */
export const shiftDetail = signal<ShiftDetail | null>(null);

const cookieTheme = document.cookie.match(/(?:^|; )theme=(light|dark)/);
const initialTheme = (cookieTheme?.[1] as ThemePreference) ?? "system";

/** User's light/dark theme preference, initialized from cookie. */
export const themePreference = signal<ThemePreference>(initialTheme);

/** Pick the best default tab based on available data. */
export function defaultTabId(): string {
  const config = provider.value?.config;
  if (config?.hasReport) return "summary";
  if (config?.hasProfile) return "flamechart";
  if (config?.hasTimeProfile) return "time-flamechart";
  return "summary";
}
