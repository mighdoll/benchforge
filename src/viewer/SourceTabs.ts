import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import langCss from "shiki/dist/langs/css.mjs";
import langHtml from "shiki/dist/langs/html.mjs";
import langJs from "shiki/dist/langs/javascript.mjs";
import langTs from "shiki/dist/langs/typescript.mjs";
import themeDark from "shiki/dist/themes/github-dark.mjs";
import themeLight from "shiki/dist/themes/github-light.mjs";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { escapeHtml, filePathFromUrl, guessLang } from "./Helpers.ts";
import type { DataProvider, ViewerConfig } from "./Providers.ts";
import { activateTab, getActiveTabId } from "./TabSwitcher.ts";

interface SourceTabData {
  file: string;
  line: number;
  col: number;
  generation: number;
  button: HTMLButtonElement;
  panel: HTMLDivElement;
}

const tabBar = document.querySelector(".tab-bar") as HTMLDivElement;
const tabContent = document.querySelector(".tab-content") as HTMLDivElement;
const sourceTabs = new Map<string, SourceTabData>();

let highlighterPromise: Promise<HighlighterCore> | undefined;

/** Open (or re-focus) a syntax-highlighted source tab for the given file and line. */
export function openSourceTab(
  file: string,
  line: number,
  col: number,
  provider: DataProvider,
): void {
  const id = sourceTabId(file);
  const existing = sourceTabs.get(id);
  if (existing) {
    existing.line = line;
    existing.col = col;
    existing.generation = (existing.generation || 0) + 1;
    updateSourcePanel(existing, file, line, col, provider);
    activateTab(id);
    return;
  }

  const spacer = tabBar.querySelector(".tab-spacer")!;

  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.tab = id;
  btn.innerHTML = tabLabelHtml(file, line);
  tabBar.insertBefore(btn, spacer);

  const panel = document.createElement("div");
  panel.className = "source-panel";
  panel.dataset.tab = id;
  tabContent.appendChild(panel);

  const tabData: SourceTabData = {
    file,
    line,
    col,
    generation: 1,
    button: btn,
    panel,
  };
  sourceTabs.set(id, tabData);
  updateSourcePanel(tabData, file, line, col, provider);
  activateTab(id);
}

/** Remove a source tab and fall back to the best available tab. */
export function closeSourceTab(tabId: string, config: ViewerConfig): void {
  const tab = sourceTabs.get(tabId);
  if (!tab) return;
  tab.button.remove();
  tab.panel.remove();
  sourceTabs.delete(tabId);
  if (getActiveTabId() === tabId) {
    if (config.hasReport) activateTab("summary");
    else if (config.hasProfile) activateTab("flamechart");
    else if (config.hasTimeProfile) activateTab("time-flamechart");
  }
}

function sourceTabId(file: string): string {
  return "src:" + file;
}

function tabLabelHtml(file: string, line: number): string {
  const shortName = file.split("/").pop() || file;
  const label = line ? shortName + ":" + line : shortName;
  return (
    escapeHtml(label) + ' <span class="tab-close" title="Close">&times;</span>'
  );
}

async function updateSourcePanel(
  tabData: SourceTabData,
  file: string,
  line: number,
  col: number,
  provider: DataProvider,
): Promise<void> {
  const { panel, button } = tabData;
  const gen = tabData.generation;
  button.innerHTML = tabLabelHtml(file, line);

  panel.innerHTML =
    '<div class="source-placeholder"><p>Loading source\u2026</p></div>';

  try {
    const code = await provider.fetchSource(file);
    if (tabData.generation !== gen) return;

    const lang = guessLang(file);
    const highlighter = await getHighlighter();
    if (tabData.generation !== gen) return;

    const html = highlighter.codeToHtml(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
    });

    const header = buildSourceHeader(
      file,
      line,
      col,
      provider.config.editorUri,
    );
    panel.innerHTML = header + '<div class="source-code">' + html + "</div>";

    const target = line
      ? panel.querySelectorAll(".source-code .line")[line - 1]
      : undefined;
    if (target) {
      target.classList.add("highlighted");
      target.scrollIntoView({ block: "center" });
    }
  } catch {
    if (tabData.generation !== gen) return;
    panel.innerHTML =
      '<div class="source-placeholder"><p>Source unavailable for ' +
      escapeHtml(file) +
      "</p></div>";
  }
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [themeLight, themeDark],
    langs: [langJs, langTs, langCss, langHtml],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

function buildSourceHeader(
  file: string,
  line: number,
  col: number,
  editorUri: string | null,
): string {
  const path = escapeHtml(file);
  const editorLink = editorUri
    ? ` <a class="source-editor-link" href="${escapeHtml(
        editorUri + filePathFromUrl(file) + `:${line || 1}:${col || 1}`,
      )}">Open in Editor</a>`
    : "";
  return `<div class="source-header"><span class="source-path">${path}</span>${editorLink}</div>`;
}
