import { useEffect, useRef, useState } from "preact/hooks";
import type { HighlighterCore } from "shiki/core";
import { filePathFromUrl, guessLang } from "../Helpers.ts";
import {
  computeLineData,
  formatGutterBytes,
  formatGutterCount,
  formatGutterTime,
} from "../LineData.ts";
import type {
  DataProvider,
  ViewerCoverageData,
  ViewerSpeedscopeFile,
} from "../Providers.ts";
import { isLargeSource, plainSourceHtml } from "../SourceRender.ts";
import {
  activeTabId,
  provider,
  type SourceTabState,
  sourceTabs,
} from "../State.ts";

let highlighterPromise: Promise<HighlighterCore> | undefined;

/**
 * Lazily create a shared Shiki highlighter with light/dark themes.
 * Shiki plus its grammars are ~400 KB, so they load via dynamic import
 * only when the first source tab opens, keeping the entry chunk small.
 */
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [
      { createHighlighterCore },
      { createJavaScriptRegexEngine },
      langCss,
      langHtml,
      langJs,
      langTs,
      themeDark,
      themeLight,
    ] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/dist/langs/css.mjs"),
      import("shiki/dist/langs/html.mjs"),
      import("shiki/dist/langs/javascript.mjs"),
      import("shiki/dist/langs/typescript.mjs"),
      import("shiki/dist/themes/github-dark.mjs"),
      import("shiki/dist/themes/github-light.mjs"),
    ]);
    return createHighlighterCore({
      themes: [themeLight.default, themeDark.default],
      langs: [
        langJs.default,
        langTs.default,
        langCss.default,
        langHtml.default,
      ],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighterPromise;
}

/** Fetch source and produce display HTML. Large files skip Shiki (which freezes
 *  on minified/huge input) and render plain lines, unless the user opted back
 *  in via `forceHighlight`. `plain` reports whether the plain path was taken. */
async function loadSource(
  dataProvider: DataProvider,
  file: string,
  forceHighlight: boolean,
): Promise<{ html: string; plain: boolean }> {
  const code = await dataProvider.fetchSource(file);
  if (isLargeSource(code) && !forceHighlight)
    return { html: plainSourceHtml(code), plain: true };

  const highlighter = await getHighlighter();
  const themes = { light: "github-light", dark: "github-dark" };
  const lang = guessLang(file);
  const html = highlighter.codeToHtml(code, {
    lang,
    themes,
    defaultColor: false,
  });
  return { html, plain: false };
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

/** Fetches source, highlights with Shiki (plain text for very large or minified
 *  files), then overlays profiling gutters and scrolls to the target line. */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: orchestrates fetch + highlight + gutter overlay; cohesive
export function SourcePanel({
  tab,
}: {
  tab: SourceTabState;
}): preact.JSX.Element {
  const dataProvider = provider.value!;
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plain, setPlain] = useState(false);
  const [forceHighlight, setForceHighlight] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const active = activeTabId.value === tab.id;

  // Fetch and highlight. Keyed on the file (not the line/generation) so jumping
  // to a hot line in an already-open file re-scrolls without re-tokenizing.
  useEffect(() => {
    let stale = false;
    setHtml(null);
    setError(null);

    loadSource(dataProvider, tab.file, forceHighlight)
      .then(({ html: loaded, plain: isPlain }) => {
        if (stale) return;
        setPlain(isPlain);
        setHtml(loaded);
      })
      .catch(() => {
        if (!stale) setError(tab.file);
      });

    return () => {
      stale = true;
    };
  }, [tab.file, dataProvider, forceHighlight]);

  // Overlay per-line profiling gutters once the source HTML is in the DOM.
  useEffect(() => {
    if (!html || !panelRef.current) return;
    let stale = false;
    const panel = panelRef.current;

    Promise.all([
      dataProvider.fetchProfileData("alloc"),
      dataProvider.fetchProfileData("time"),
      dataProvider.fetchCoverageData(),
    ]).then(([alloc, time, coverage]) => {
      if (stale || !panel.isConnected) return;
      renderGutters(panel, tab.file, alloc, time, coverage);
    });

    return () => {
      stale = true;
    };
  }, [html, dataProvider, tab.file]);

  // Scroll to (and mark) the target line whenever it or the tab generation
  // changes. Separate from highlighting so re-clicking a hot line is cheap.
  useEffect(() => {
    if (!html || !panelRef.current || !tab.line) return;
    const panel = panelRef.current;
    const target = panel.querySelectorAll(".source-code .line")[tab.line - 1];
    if (!target) return;
    panel
      .querySelector(".source-code .line.highlighted")
      ?.classList.remove("highlighted");
    target.classList.add("highlighted");
    target.scrollIntoView({ block: "center" });
  }, [html, tab.line, tab.generation]);

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
        plain={plain}
        onHighlight={() => setForceHighlight(true)}
      />
    </div>
  );
}

interface SourceBodyProps {
  file: string;
  line: number;
  col: number;
  html: string | null;
  error: string | null;
  editorUri: string | null;
  plain: boolean;
  onHighlight: () => void;
}

/** Render loading/error placeholder or the source with header, plus a
 *  "highlighting off" banner when Shiki was skipped for a large file. */
function SourceBody({
  file,
  line,
  col,
  html,
  error,
  editorUri,
  plain,
  onHighlight,
}: SourceBodyProps) {
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
      {plain && (
        <div class="source-large-banner">
          <span>Large file -- syntax highlighting off.</span>
          <button
            type="button"
            class="source-highlight-btn"
            onClick={onHighlight}
          >
            Highlight anyway
          </button>
        </div>
      )}
      <div class="source-code" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

/** File path display with optional "Open in Editor" link. */
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
  const path = filePathFromUrl(file);
  const href = editorUri
    ? `${editorUri}${path}:${line || 1}:${col || 1}`
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

/** Build a gutter span with optional heat-map styling (CSS custom property). */
function gutter(kind: string, text: string, heat?: number): string {
  const style = heat ? ` style="--heat:${heat.toFixed(3)}"` : "";
  const cls = heat ? ` heat` : "";
  return `<span class="gutter gutter-${kind}${cls}"${style}>${text}</span>`;
}

/** Inject call-count, alloc, and time gutters into highlighted source lines. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: gutter assembly branches per metric; cohesive
function renderGutters(
  panel: HTMLElement,
  file: string,
  allocProfile: ViewerSpeedscopeFile | null,
  timeProfile: ViewerSpeedscopeFile | null,
  coverage: ViewerCoverageData | null,
): void {
  const { callCounts, allocBytes, selfTimeUs } = computeLineData(
    file,
    allocProfile,
    timeProfile,
    coverage,
  );
  const hasCounts = callCounts.size > 0;
  const hasAlloc = allocBytes.size > 0;
  const hasTime = selfTimeUs.size > 0;
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
    if (hasAlloc)
      gutterHtml += gutter(
        "alloc",
        formatGutterBytes(alloc),
        heatAboveThreshold(allocHeat),
      );
    if (hasTime)
      gutterHtml += gutter(
        "time",
        formatGutterTime(time),
        heatAboveThreshold(timeHeat),
      );

    el.insertAdjacentHTML("afterbegin", gutterHtml);
  }
}
