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
  type LineGutterData,
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
} from "../state.ts";

let highlighterPromise: Promise<HighlighterCore> | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [themeLight, themeDark],
    langs: [langJs, langTs, langCss, langHtml],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

export function openSourceTab(
  file: string,
  line: number,
  col: number,
): void {
  const id = "src:" + file;
  const existing = sourceTabs.value.find(t => t.id === id);
  if (existing) {
    sourceTabs.value = sourceTabs.value.map(t =>
      t.id === id
        ? { ...t, line, col, generation: t.generation + 1 }
        : t,
    );
  } else {
    sourceTabs.value = [
      ...sourceTabs.value,
      { id, file, line, col, generation: 1 },
    ];
  }
  activeTabId.value = id;
}

export function SourcePanel({ tab }: { tab: SourceTabState }) {
  const p = provider.value!;
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
        const code = await p.fetchSource(tab.file);
        if (stale) return;
        const highlighter = await getHighlighter();
        if (stale) return;
        const themes = { light: "github-light", dark: "github-dark" };
        setHtml(highlighter.codeToHtml(code, { lang: guessLang(tab.file), themes }));
      } catch {
        if (!stale) setError(tab.file);
      }
    })();

    return () => {
      stale = true;
    };
  }, [tab.file, tab.generation, p]);

  // Add gutters and scroll after source renders
  useEffect(() => {
    if (!html || !panelRef.current) return;
    let stale = false;

    Promise.all([
      p.fetchProfileData("alloc"),
      p.fetchProfileData("time"),
      p.fetchCoverageData(),
    ]).then(([alloc, time, coverage]) => {
      if (stale || !panelRef.current) return;
      renderGutters(panelRef.current, tab.file, alloc, time, coverage);

      if (tab.line) {
        const target = panelRef.current.querySelectorAll(
          ".source-code .line",
        )[tab.line - 1];
        if (target) {
          target.classList.add("highlighted");
          target.scrollIntoView({ block: "center" });
        }
      }
    });

    return () => {
      stale = true;
    };
  }, [html, tab.line, p, tab.file]);

  const editorUri = p.config.editorUri;

  return (
    <div
      class={`source-panel${active ? " active" : ""}`}
      data-tab={tab.id}
      ref={panelRef}
    >
      {error ? (
        <div class="source-placeholder">
          <p>Source unavailable for {error}</p>
        </div>
      ) : !html ? (
        <div class="source-placeholder">
          <p>Loading source&hellip;</p>
        </div>
      ) : (
        <>
          <SourceHeader
            file={tab.file}
            line={tab.line}
            col={tab.col}
            editorUri={editorUri}
          />
          <div
            class="source-code"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </>
      )}
    </div>
  );
}

function SourceHeader({
  file,
  line,
  col,
  editorUri,
}: {
  file: string;
  line: number;
  col: number;
  editorUri: string | null;
}) {
  const href = editorUri
    ? editorUri + filePathFromUrl(file) + ":" + (line || 1) + ":" + (col || 1)
    : null;
  return (
    <div class="source-header">
      <span class="source-path">{file}</span>
      {href && (
        <a class="source-editor-link" href={href}>
          Open in Editor
        </a>
      )}
    </div>
  );
}

function gutter(kind: string, text: string): string {
  return `<span class="gutter gutter-${kind}">${text}</span>`;
}

function renderGutters(
  panel: HTMLElement,
  file: string,
  allocProfile: ViewerSpeedscopeFile | null,
  timeProfile: ViewerSpeedscopeFile | null,
  coverage: ViewerCoverageData | null,
): void {
  const lineData = computeLineData(file, allocProfile, timeProfile, coverage);
  const hasCounts = lineData.callCounts.size > 0;
  const hasAlloc = lineData.allocBytes.size > 0;
  const hasTime = lineData.selfTimeUs.size > 0;
  if (!hasCounts && !hasAlloc && !hasTime) return;

  const codeEl = panel.querySelector(".source-code") as HTMLElement;
  if (!codeEl) return;
  const maxAlloc = hasAlloc ? Math.max(...lineData.allocBytes.values()) : 0;
  const maxTime = hasTime ? Math.max(...lineData.selfTimeUs.values()) : 0;

  const lines = codeEl.querySelectorAll(".line");
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const el = lines[i] as HTMLElement;
    const counts = lineData.callCounts.get(lineNum);
    const alloc = lineData.allocBytes.get(lineNum);
    const time = lineData.selfTimeUs.get(lineNum);
    let gutterHtml = "";
    if (hasCounts) gutterHtml += gutter("count", formatGutterCount(counts));
    if (hasAlloc) gutterHtml += gutter("alloc", formatGutterBytes(alloc));
    if (hasTime) gutterHtml += gutter("time", formatGutterTime(time));

    el.insertAdjacentHTML("afterbegin", gutterHtml);
    applyHeatMap(el, lineNum, lineData, maxAlloc, maxTime);
  }
}

function applyHeatMap(
  el: HTMLElement,
  lineNum: number,
  lineData: LineGutterData,
  maxAlloc: number,
  maxTime: number,
): void {
  const alloc = lineData.allocBytes.get(lineNum) || 0;
  const time = lineData.selfTimeUs.get(lineNum) || 0;
  const allocRatio = maxAlloc > 0 ? alloc / maxAlloc : 0;
  const timeRatio = maxTime > 0 ? time / maxTime : 0;
  const heat = Math.max(allocRatio, timeRatio);
  if (heat > 0.01) {
    el.style.setProperty("--heat", heat.toFixed(3));
    el.classList.add("heat");
  }
}
