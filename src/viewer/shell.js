(async function () {
  const tabBar = document.querySelector(".tab-bar");
  const tabContent = document.querySelector(".tab-content");
  const iframe = document.getElementById("speedscope-iframe");
  let activeTabId = "flamechart";
  const sourceTabs = new Map(); // id -> { file, line, col, generation, button, panel }

  // --- Load config and set iframe src ---

  const config = await fetch("/api/config").then(r => r.json());
  const hashParts = ["profileURL=/api/profile"];
  if (config.editorUri) hashParts.push("editorUri=" + encodeURIComponent(config.editorUri));
  iframe.src = "/speedscope/index.html#" + hashParts.join("&");

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

    sourceTabs.forEach((tab, id) => {
      tab.panel.classList.toggle("active", id === tabId);
    });
  }

  // --- Tab bar clicks ---

  tabBar.addEventListener("click", ev => {
    const tabBtn = ev.target.closest(".tab[data-tab]");
    if (tabBtn) {
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
      activateTab("flamechart");
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
})();
