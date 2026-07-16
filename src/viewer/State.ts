import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { DataProvider } from "./Providers.ts";
import type {
  AbsolutePercentile,
  ReportData,
  ShiftPercentile,
} from "./ReportData.ts";

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

/** Payload for the shift-detail popup: one point plus its display context. */
export interface ShiftDetail {
  point: ShiftPercentile;
  metric: string;
  /** Resolved display-domain [lo, hi] equivalence band for the diff plot
   *  (legacy symmetric fallback already applied by shiftMarginBand). */
  marginBand?: [number, number];
}

/** Payload for the absolute-distribution detail popup (no-baseline fan): one
 *  percentile's absolute distribution plus its metric label. */
export interface AbsoluteDetail {
  point: AbsolutePercentile;
  metric: string;
}

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

/** User notes saved with the archive. */
export const notes = signal("");

/** Save state of the notes text area. "idle"/"saved" read as persisted;
 *  "dirty"/"saving" as pending. */
export const notesStatus = signal<
  "idle" | "dirty" | "saving" | "saved" | "error"
>("idle");

/** Open detail popup for a shift-function point (verdict or percentile). Null = closed. */
export const shiftDetail = signal<ShiftDetail | null>(null);

/** Open detail popup for an absolute-shift percentile. Null = closed. */
export const absoluteDetail = signal<AbsoluteDetail | null>(null);

/** Instance id of the open help "?" button (one popover at a time; the same
 *  topic can appear on several cards). Null = closed. */
export const openHelp = signal<string | null>(null);

const cookieTheme = document.cookie.match(/(?:^|; )theme=(light|dark)/);
const initialTheme = (cookieTheme?.[1] as ThemePreference) ?? "system";

/** User's light/dark theme preference, initialized from cookie. */
export const themePreference = signal<ThemePreference>(initialTheme);

/** Close a popup (clear its open-state signal) on Escape, for as long as the
 *  calling component is mounted. */
export function useEscapeClose(close: () => void): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Pick the best default tab based on available data. */
export function defaultTabId(): string {
  const config = provider.value?.config;
  if (config?.hasReport) return "summary";
  if (config?.hasProfile) return "flamechart";
  if (config?.hasTimeProfile) return "time-flamechart";
  return "summary";
}
