const tabBar = document.querySelector(".tab-bar");
const tabContent = document.querySelector(".tab-content");
const iframe = document.getElementById("speedscope-iframe");
const reportPanel = document.getElementById("report-panel");
const reportTab = document.getElementById("tab-report");
const allocTab = document.getElementById("tab-flamechart");

let activeTabId = null;
let reportLoaded = false;
const sourceTabs = new Map(); // id -> { file, line, col, generation, button, panel }

// --- Load config ---

const config = await fetch("/api/config").then(r => r.json());

// Enable tabs based on available data
if (config.hasReport) reportTab.disabled = false;
if (config.hasProfile) allocTab.disabled = false;

// Set up speedscope iframe if profile data available
if (config.hasProfile) {
  const hashParts = ["profileURL=/api/profile"];
  if (config.editorUri) hashParts.push("editorUri=" + encodeURIComponent(config.editorUri));
  iframe.src = "/speedscope/index.html#" + hashParts.join("&");
}

// Auto-activate first available tab
if (config.hasReport) {
  activateTab("report");
  loadReport();
} else if (config.hasProfile) {
  activateTab("flamechart");
}

// --- Shiki (lazy singleton) ---

let highlighterPromise;
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import("https://cdn.jsdelivr.net/npm/shiki@3/+esm")
      .then(({ createHighlighter }) =>
        createHighlighter({
          themes: ["github-light", "github-dark"],
          langs: ["javascript", "typescript"],
        })
      );
  }
  return highlighterPromise;
}

// --- Tab switching ---

function activateTab(tabId) {
  activeTabId = tabId;

  tabBar.querySelectorAll(".tab[data-tab]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });

  iframe.style.display = tabId === "flamechart" ? "block" : "none";
  reportPanel.classList.toggle("active", tabId === "report");

  sourceTabs.forEach((tab, id) => {
    tab.panel.classList.toggle("active", id === tabId);
  });
}

// --- Tab bar clicks ---

tabBar.addEventListener("click", ev => {
  const tabBtn = ev.target.closest(".tab[data-tab]");
  if (tabBtn) {
    if (tabBtn.disabled) return;
    if (ev.target.closest(".tab-close")) {
      closeSourceTab(tabBtn.dataset.tab);
      return;
    }
    activateTab(tabBtn.dataset.tab);
    return;
  }
  if (ev.target.closest('[data-action="archive"]')) {
    archiveProfile();
  }
});

// --- Report tab ---

async function loadReport() {
  if (reportLoaded) return;
  reportLoaded = true;

  reportPanel.innerHTML = '<div class="empty-state"><p>Loading report\u2026</p></div>';

  try {
    const resp = await fetch("/api/report-data");
    if (!resp.ok) throw new Error("No report data: " + resp.status);
    const data = await resp.json();

    // Build DOM skeleton
    reportPanel.innerHTML = buildReportHeader(data.metadata) +
      data.groups.map((group, i) => buildGroupHtml(group, i)).join("");

    // Load and run plots
    const { renderPlots } = await import("/viewer/plots.js");
    renderPlots(data);
  } catch (err) {
    console.error("Report load failed:", err);
    reportPanel.innerHTML =
      '<div class="empty-state"><p>Failed to load report data: ' +
      escapeHtml(String(err)) + '</p></div>';
  }
}

function buildReportHeader(metadata) {
  const cliArgs = formatCliArgs(metadata.cliArgs);
  const version = formatVersionInfo(metadata);
  return `<div class="report-header">
    <div class="cli-args">${escapeHtml(cliArgs)}</div>
    <div class="header-right">
      <div class="metadata">Generated: ${escapeHtml(new Date().toLocaleString())}</div>
      ${version}
    </div>
  </div>`;
}

function buildGroupHtml(group, i) {
  if (!group.benchmarks || group.benchmarks.length === 0) {
    return `<div id="group-${i}"><div class="error">No benchmark data available for this group</div></div>`;
  }

  const badge = comparisonBadge(group, i);
  return `<div id="group-${i}">
    <div class="group-header">
      <h2>${escapeHtml(group.name)}</h2>
      ${badge}
    </div>
    <div class="plot-grid">
      <div class="plot-container">
        <div class="plot-title">Time per Sample</div>
        <div class="plot-description">Execution time for each sample in collection order</div>
        <div id="sample-timeseries-${i}" class="plot-area">
          <div class="loading">Loading time series...</div>
        </div>
      </div>
      <div class="plot-container">
        <div class="plot-title">Time Distribution</div>
        <div class="plot-description">Frequency distribution of execution times</div>
        <div id="histogram-${i}" class="plot-area">
          <div class="loading">Loading histogram...</div>
        </div>
      </div>
    </div>
    <div id="stats-${i}"></div>
  </div>`;
}

function comparisonBadge(group, i) {
  const ci = group.benchmarks[0]?.comparisonCI;
  if (!ci) return "";
  const labels = { faster: "Faster", slower: "Slower", uncertain: "Inconclusive" };
  return `<span class="badge badge-${ci.direction}">${labels[ci.direction]}</span>
    <div id="ci-plot-${i}" class="ci-plot-container"></div>`;
}

const defaultArgs = {
  worker: true, time: 5, warmup: 500, "pause-interval": 0, "pause-duration": 100,
};
const skipArgs = new Set(["_", "$0", "view"]);

function formatCliArgs(args) {
  if (!args) return "benchforge";
  const parts = ["benchforge"];
  for (const [key, value] of Object.entries(args)) {
    if (skipArgs.has(key) || value === undefined || value === false) continue;
    if (defaultArgs[key] === value) continue;
    if (!key.includes("-") && key !== key.toLowerCase()) continue;
    if (key === "convergence" && !args.adaptive) continue;
    parts.push(value === true ? `--${key}` : `--${key} ${value}`);
  }
  return parts.join(" ");
}

function formatVersionInfo(metadata) {
  const { currentVersion, baselineVersion } = metadata;
  if (!currentVersion && !baselineVersion) return "";
  const parts = [];
  if (currentVersion) parts.push("Current: " + formatVersion(currentVersion));
  if (baselineVersion) parts.push("Baseline: " + formatVersion(baselineVersion));
  return `<div class="version-info">${parts.join(" | ")}</div>`;
}

function formatVersion(v) {
  if (!v || v.hash === "unknown") return "unknown";
  const hash = v.dirty ? v.hash + "*" : v.hash;
  if (!v.date) return hash;
  const diffMs = Date.now() - new Date(v.date).getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  let rel;
  if (mins < 1) rel = "just now";
  else if (mins < 60) rel = `${mins}m ago`;
  else if (hours < 24) rel = `${hours}h ago`;
  else if (days === 1) rel = "yesterday";
  else if (days < 30) rel = `${days} days ago`;
  else rel = new Date(v.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${hash} (${rel})`;
}

// --- Source tabs ---

function sourceTabId(file) {
  return "src:" + file;
}

function openSourceTab(file, line, col) {
  const id = sourceTabId(file);
  const existing = sourceTabs.get(id);
  if (existing) {
    existing.line = line;
    existing.col = col;
    existing.generation = (existing.generation || 0) + 1;
    updateSourcePanel(existing, file, line, col);
    activateTab(id);
    return;
  }

  const spacer = tabBar.querySelector(".tab-spacer");
  const shortName = file.split("/").pop() || file;
  const label = line ? shortName + ":" + line : shortName;

  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.tab = id;
  btn.innerHTML =
    escapeHtml(label) + ' <span class="tab-close" title="Close">&times;</span>';
  tabBar.insertBefore(btn, spacer);

  const panel = document.createElement("div");
  panel.className = "source-panel";
  tabContent.appendChild(panel);

  const tabData = { file, line, col, generation: 1, button: btn, panel };
  sourceTabs.set(id, tabData);
  updateSourcePanel(tabData, file, line, col);
  activateTab(id);
}

async function updateSourcePanel(tabData, file, line, col) {
  const { panel, button } = tabData;
  const gen = tabData.generation;
  const shortName = file.split("/").pop() || file;
  const label = line ? shortName + ":" + line : shortName;
  button.innerHTML =
    escapeHtml(label) + ' <span class="tab-close" title="Close">&times;</span>';

  panel.innerHTML = '<div class="source-placeholder"><p>Loading source\u2026</p></div>';

  try {
    const resp = await fetch("/api/source?url=" + encodeURIComponent(file));
    if (tabData.generation !== gen) return;
    if (!resp.ok) throw new Error("not ok");
    const code = await resp.text();
    if (tabData.generation !== gen) return;

    const lang = guessLang(file);
    const highlighter = await getHighlighter();
    if (tabData.generation !== gen) return;

    const html = highlighter.codeToHtml(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
    });

    let header = '<div class="source-header">';
    header += '<span class="source-path">' + escapeHtml(file) + "</span>";
    if (config.editorUri) {
      const editorHref = config.editorUri + filePathFromUrl(file) +
        ":" + (line || 1) + ":" + (col || 1);
      header += ' <a class="source-editor-link" href="' +
        escapeHtml(editorHref) + '">Open in Editor</a>';
    }
    header += "</div>";

    panel.innerHTML = header + '<div class="source-code">' + html + "</div>";

    if (line) {
      const lines = panel.querySelectorAll(".source-code .line");
      const target = lines[line - 1];
      if (target) {
        target.classList.add("highlighted");
        target.scrollIntoView({ block: "center" });
      }
    }
  } catch {
    if (tabData.generation !== gen) return;
    panel.innerHTML =
      '<div class="source-placeholder"><p>Source unavailable for ' +
      escapeHtml(file) + "</p></div>";
  }
}

function closeSourceTab(tabId) {
  const tab = sourceTabs.get(tabId);
  if (!tab) return;
  tab.button.remove();
  tab.panel.remove();
  sourceTabs.delete(tabId);
  if (activeTabId === tabId) {
    // Fall back to first enabled fixed tab
    if (config.hasReport) activateTab("report");
    else if (config.hasProfile) activateTab("flamechart");
  }
}

// --- Archive ---

async function archiveProfile() {
  const btn = tabBar.querySelector('[data-action="archive"]');
  const originalText = btn.textContent;
  btn.textContent = "Archiving\u2026";
  btn.disabled = true;

  try {
    const resp = await fetch("/api/archive", { method: "POST" });
    if (!resp.ok) throw new Error("Archive failed");

    const blob = await resp.blob();
    const disposition = resp.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?(.+?)"?$/);
    const filename = match ? match[1] : "benchforge-archive.benchforge";

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
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// --- postMessage from speedscope iframe ---

window.addEventListener("message", ev => {
  if (ev.data && ev.data.type === "open-source") {
    const { file, line, col } = ev.data;
    if (file) openSourceTab(file, line, col);
  }
});

// --- Helpers ---

function guessLang(file) {
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return "typescript";
  if (file.endsWith(".css")) return "css";
  if (file.endsWith(".html")) return "html";
  return "javascript";
}

function filePathFromUrl(url) {
  try { return new URL(url).pathname; }
  catch { return url; }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
