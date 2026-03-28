import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import open from "open";

export interface ViewerServerOptions {
  /** Speedscope JSON profile data */
  profileData: string;
  /** Editor URI prefix for Cmd+Shift+click (e.g. "vscode://file") */
  editorUri?: string;
  /** Port to listen on (default 3939) */
  port?: number;
}

const speedscopeDir = join(homedir(), "lib/speedscope/dist/release");

const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".map": "application/json",
  ".md": "text/plain",
};

/** Start the allocation viewer server and open in browser */
export async function startViewerServer(
  options: ViewerServerOptions,
): Promise<{ server: Server; port: number; close: () => void }> {
  const { profileData, editorUri } = options;
  const port = options.port ?? 3939;

  const server = createServer(async (req, res) => {
    const url = req.url || "/";
    const [pathname] = url.split("?");

    // Viewer shell at root
    if (pathname === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(viewerShellHtml(editorUri));
      return;
    }

    // Profile API
    if (pathname === "/api/profile") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(profileData);
      return;
    }

    // Speedscope static files
    if (pathname.startsWith("/speedscope/")) {
      const relPath = pathname.slice("/speedscope/".length) || "index.html";
      const filePath = join(speedscopeDir, relPath);
      try {
        const content = await readFile(filePath);
        const mime = mimeTypes[extname(filePath)] || "application/octet-stream";
        res.setHeader("Content-Type", mime);
        res.end(content);
      } catch {
        res.statusCode = 404;
        res.end("Not found");
      }
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  });

  const result = await tryListen(server, port);
  const openUrl = `http://localhost:${result.port}`;
  await open(openUrl);
  console.log(`Allocation viewer: ${openUrl}`);

  return {
    server: result.server,
    port: result.port,
    close: () => result.server.close(),
  };
}

function tryListen(
  server: Server,
  port: number,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: actualPort });
    });
  });
}

// ---------------------------------------------------------------------------
// Viewer shell HTML
// ---------------------------------------------------------------------------

function viewerShellHtml(editorUri?: string): string {
  const editorUriAttr = editorUri ? ` data-editor-uri="${escapeAttr(editorUri)}"` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Benchforge Allocation Viewer</title>
<style>
${viewerCss}
</style>
</head>
<body${editorUriAttr}>

<div class="tab-bar">
  <button class="tab active" data-tab="flamechart">Flamechart</button>
  <div class="tab-spacer"></div>
  <button class="tab archive-btn" data-action="archive">Archive ↓</button>
</div>

<div class="tab-content">
  <iframe
    id="speedscope-iframe"
    src="/speedscope/index.html#profileURL=/api/profile${editorUri ? `&editorUri=${encodeURIComponent(editorUri)}` : ""}"
  ></iframe>
</div>

<script>
${viewerJs}
</script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const viewerCss = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --tab-bar-bg: #f8f8f8;
  --tab-border: #ccc;
  --tab-color: #999;
  --tab-active-color: #222;
  --tab-accent: #5f61d8;
  --body-bg: #fff;
  --source-bg: #fff;
  --source-color: #333;
  --source-highlight: #fffbdd;
  --source-line-color: #999;
}

@media (prefers-color-scheme: dark) {
  :root {
    --tab-bar-bg: #1e1e1e;
    --tab-border: #555;
    --tab-color: #999;
    --tab-active-color: #fff;
    --tab-accent: #7b7dea;
    --body-bg: #181818;
    --source-bg: #1e1e1e;
    --source-color: #d4d4d4;
    --source-highlight: #3a3a00;
    --source-line-color: #666;
  }
}

html, body {
  height: 100%;
  background: var(--body-bg);
  font-family: system-ui, sans-serif;
  color: var(--source-color);
}

body { display: flex; flex-direction: column; }

.tab-bar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 6px 8px;
  background: var(--tab-bar-bg);
  flex-shrink: 0;
  position: relative;
  z-index: 10;
}

.tab-bar::after {
  content: "";
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--tab-border);
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  background: transparent;
  border: none;
  border-radius: 0;
  color: var(--tab-color);
  cursor: pointer;
  position: relative;
  font-size: 13px;
  font-family: system-ui, sans-serif;
  white-space: nowrap;
}

.tab:hover { color: var(--tab-active-color); }

.tab.active {
  color: var(--tab-accent);
  font-weight: 600;
  padding-bottom: calc(5px + 6px + 0.5px);
  margin-bottom: calc(-1 * (6px + 0.5px));
  position: relative;
  z-index: 1;
  border-bottom: 2px solid var(--tab-accent);
}

.tab .tab-close {
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0;
  font-size: 16px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tab:hover .tab-close { opacity: 0.6; }
.tab .tab-close:hover { opacity: 1; }

.tab-spacer { flex: 1; }

.archive-btn {
  font-size: 12px;
  color: var(--tab-color);
  opacity: 0.8;
}
.archive-btn:hover { opacity: 1; }

.tab-content {
  flex: 1;
  position: relative;
  min-height: 0;
}

#speedscope-iframe {
  width: 100%;
  height: 100%;
  border: none;
  position: absolute;
  top: 0;
  left: 0;
}

.source-panel {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  overflow: auto;
  background: var(--source-bg);
  padding: 16px 24px;
  display: none;
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
}

.source-panel.active { display: block; }

.source-placeholder {
  color: var(--tab-color);
  font-family: system-ui, sans-serif;
  font-size: 14px;
}

.source-placeholder code {
  background: var(--tab-border);
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 13px;
}
`;

// ---------------------------------------------------------------------------
// Client-side JS
// ---------------------------------------------------------------------------

const viewerJs = `
(function() {
  const tabBar = document.querySelector('.tab-bar');
  const tabContent = document.querySelector('.tab-content');
  const iframe = document.getElementById('speedscope-iframe');
  let activeTabId = 'flamechart';
  const sourceTabs = new Map(); // id -> { file, line, col, button, panel }

  // --- Tab switching ---

  function activateTab(tabId) {
    activeTabId = tabId;

    // Update tab buttons
    tabBar.querySelectorAll('.tab[data-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });

    // Show/hide iframe
    iframe.style.display = (tabId === 'flamechart') ? 'block' : 'none';

    // Show/hide source panels
    sourceTabs.forEach((tab, id) => {
      tab.panel.classList.toggle('active', id === tabId);
    });
  }

  // --- Tab bar clicks ---

  tabBar.addEventListener('click', (ev) => {
    const tabBtn = ev.target.closest('.tab[data-tab]');
    if (tabBtn) {
      // Close button?
      if (ev.target.closest('.tab-close')) {
        closeSourceTab(tabBtn.dataset.tab);
        return;
      }
      activateTab(tabBtn.dataset.tab);
      return;
    }
    if (ev.target.closest('[data-action="archive"]')) {
      // Archive placeholder
      console.log('Archive not yet implemented');
    }
  });

  // --- Source tabs ---

  function sourceTabId(file) {
    return 'src:' + file;
  }

  function openSourceTab(file, line, col) {
    const id = sourceTabId(file);
    const existing = sourceTabs.get(id);
    if (existing) {
      // Update line/col and switch to it
      existing.line = line;
      existing.col = col;
      updateSourcePanel(existing, file, line, col);
      activateTab(id);
      return;
    }

    // Create tab button (insert before spacer)
    const spacer = tabBar.querySelector('.tab-spacer');
    const shortName = file.split('/').pop() || file;
    const label = line ? shortName + ':' + line : shortName;

    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.tab = id;
    btn.innerHTML = escapeHtml(label) +
      ' <span class="tab-close" title="Close">&times;</span>';
    tabBar.insertBefore(btn, spacer);

    // Create source panel
    const panel = document.createElement('div');
    panel.className = 'source-panel';
    tabContent.appendChild(panel);

    const tabData = { file, line, col, button: btn, panel };
    sourceTabs.set(id, tabData);
    updateSourcePanel(tabData, file, line, col);
    activateTab(id);
  }

  function updateSourcePanel(tabData, file, line, col) {
    const { panel, button } = tabData;
    const shortName = file.split('/').pop() || file;
    const label = line ? shortName + ':' + line : shortName;
    button.innerHTML = escapeHtml(label) +
      ' <span class="tab-close" title="Close">&times;</span>';

    panel.innerHTML =
      '<div class="source-placeholder">' +
      '<p><strong>' + escapeHtml(file) + '</strong></p>' +
      (line ? '<p>Line ' + line + (col ? ', Column ' + col : '') + '</p>' : '') +
      '<p style="margin-top:12px;color:var(--tab-color)">Source rendering coming soon.</p>' +
      '</div>';
  }

  function closeSourceTab(tabId) {
    const tab = sourceTabs.get(tabId);
    if (!tab) return;
    tab.button.remove();
    tab.panel.remove();
    sourceTabs.delete(tabId);
    if (activeTabId === tabId) {
      activateTab('flamechart');
    }
  }

  // --- postMessage from speedscope iframe ---

  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'open-source') {
      const { file, line, col } = ev.data;
      if (file) openSourceTab(file, line, col);
    }
  });

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
})();
`;
