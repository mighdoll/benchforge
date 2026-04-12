import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import langCss from "shiki/dist/langs/css.mjs";
import langHtml from "shiki/dist/langs/html.mjs";
import langJs from "shiki/dist/langs/javascript.mjs";
import langTs from "shiki/dist/langs/typescript.mjs";
import themeDark from "shiki/dist/themes/github-dark.mjs";
import themeLight from "shiki/dist/themes/github-light.mjs";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { useEffect, useRef, useState } from "preact/hooks";
import { filePathFromUrl, guessLang } from "../Helpers.ts";
import {
  computeLineData,
  formatGutterBytes,
  formatGutterCount,
  formatGutterTime,
} from "../LineData.ts";
import type {
  ViewerCoverageData,
  ViewerSpeedscopeFile,
} from "../Providers.ts";
import {
  activeTabId,
  provider,
  sourceTabs,
  type SourceTabState,
} from "../State.ts";

let highlighterPromise: Promise<HighlighterCore> | undefined;

/** Lazily create a shared Shiki highlighter with light/dark themes. */
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [themeLight, themeDark],
    langs: [langJs, langTs, langCss, langHtml],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

/** Open or focus a source tab, scrolling to the given line and column. */
export function openSourceTab(file: string, line: number, col: number): void {
  const id = "src:" + file;
  const tabs = sourceTabs.value;
  const existing = tabs.find(t => t.id === id);
  if (existing) {
    sourceTabs.value = tabs.map(t =>
      t.id === id ? { ...t, line, col, generation: t.generation + 1 } : t,
    );
  } else {
    sourceTabs.value = [...tabs, { id, file, line, col, generation: 1 }];
  }
  activeTabId.value = id;
}

/** Fetches source, highlights with Shiki, then overlays profiling gutters and scrolls to target line. */
export function SourcePanel({ tab }: { tab: SourceTabState }): preact.JSX.Element {
  const dataProvider = provider.value!;
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const active = activeTabId.value === tab.id;

  useEffect(() => {
    let stale = false;
    setHtml(null);
    setError(null);

    (async () => {
      try {
        const code = await dataProvider.fetchSource(tab.file);
        if (stale) return;
        const highlighter = await getHighlighter();
        if (stale) return;
        const lang = guessLang(tab.file);
        const themes = { light: "github-light", dark: "github-dark" };
        setHtml(highlighter.codeToHtml(code, { lang, themes, defaultColor: false }));
      } catch {
        if (!stale) setError(tab.file);
      }
    })();

    return () => {
      stale = true;
    };
  }, [tab.file, tab.generation, dataProvider]);

  useEffect(() => {
    if (!html || !panelRef.current) return;
    let stale = false;

    Promise.all([
      dataProvider.fetchProfileData("alloc"),
      dataProvider.fetchProfileData("time"),
      dataProvider.fetchCoverageData(),
    ]).then(([alloc, time, coverage]) => {
      if (stale || !panelRef.current) return;
      renderGutters(panelRef.current, tab.file, alloc, time, coverage);

      if (tab.line) {
        const lines = panelRef.current.querySelectorAll(".source-code .line");
        const target = lines[tab.line - 1];
        if (target) {
          target.classList.add("highlighted");
          target.scrollIntoView({ block: "center" });
        }
      }
    });

    return () => {
      stale = true;
    };
  }, [html, tab.line, dataProvider, tab.file]);

  const editorUri = dataProvider.config.editorUri;
  const cls = `source-panel${active ? " active" : ""}`;

  return (
    <div class={cls} data-tab={tab.id} ref={panelRef}>
      <SourceBody
        file={tab.file}
        line={tab.line}
        col={tab.col}
        html={html}
        error={error}
        editorUri={editorUri}
      />
    </div>
  );
}

interface SourceBodyProps {
  file: string; line: number; col: number;
  html: string | null; error: string | null; editorUri: string | null;
}

/** Render loading/error placeholder or the highlighted source with header. */
function SourceBody({ file, line, col, html, error, editorUri }: SourceBodyProps) {
  if (error) {
    return (
      <div class="source-placeholder">
        <p>Source unavailable for {error}</p>
      </div>
    );
  }
  if (!html) {
    return (
      <div class="source-placeholder">
        <p>Loading source&hellip;</p>
      </div>
    );
  }
  return (
    <>
      <SourceHeader file={file} line={line} col={col} editorUri={editorUri} />
      <div class="source-code" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

/** File path display with optional "Open in Editor" link. */
function SourceHeader({ file, line, col, editorUri }: {
  file: string; line: number; col: number; editorUri: string | null;
}) {
  const path = filePathFromUrl(file);
  const href = editorUri ? `${editorUri}${path}:${line || 1}:${col || 1}` : null;
  return (
    <div class="source-header">
      <span class="source-path">{file}</span>
      {href && <a class="source-editor-link" href={href}>Open in Editor</a>}
    </div>
  );
}

/** Build a gutter span with optional heat-map styling (CSS custom property). */
function gutter(kind: string, text: string, heat?: number): string {
  const style = heat ? ` style="--heat:${heat.toFixed(3)}"` : "";
  const cls = heat ? ` heat` : "";
  return `<span class="gutter gutter-${kind}${cls}"${style}>${text}</span>`;
}

/** Inject call-count, alloc, and time gutters into highlighted source lines. */
function renderGutters(
  panel: HTMLElement,
  file: string,
  allocProfile: ViewerSpeedscopeFile | null,
  timeProfile: ViewerSpeedscopeFile | null,
  coverage: ViewerCoverageData | null,
): void {
  const { callCounts, allocBytes, selfTimeUs } = computeLineData(file, allocProfile, timeProfile, coverage);
  const hasCounts = callCounts.size > 0, hasAlloc = allocBytes.size > 0, hasTime = selfTimeUs.size > 0;
  if (!hasCounts && !hasAlloc && !hasTime) return;

  const codeEl = panel.querySelector(".source-code") as HTMLElement;
  if (!codeEl) return;
  const maxAlloc = hasAlloc ? Math.max(...allocBytes.values()) : 0;
  const maxTime = hasTime ? Math.max(...selfTimeUs.values()) : 0;

  const heatAboveThreshold = (h: number) => (h > 0.01 ? h : undefined);
  const lines = codeEl.querySelectorAll(".line");
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const el = lines[i] as HTMLElement;
    const counts = callCounts.get(lineNum);
    const alloc = allocBytes.get(lineNum);
    const time = selfTimeUs.get(lineNum);
    const allocHeat = alloc && maxAlloc > 0 ? alloc / maxAlloc : 0;
    const timeHeat = time && maxTime > 0 ? time / maxTime : 0;
    let gutterHtml = "";
    if (hasCounts) gutterHtml += gutter("count", formatGutterCount(counts));
    if (hasAlloc) gutterHtml += gutter("alloc", formatGutterBytes(alloc), heatAboveThreshold(allocHeat));
    if (hasTime) gutterHtml += gutter("time", formatGutterTime(time), heatAboveThreshold(timeHeat));

    el.insertAdjacentHTML("afterbegin", gutterHtml);
  }
}

