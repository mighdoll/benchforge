(async function () {
  const tabBar = document.querySelector(".tab-bar");
  const tabContent = document.querySelector(".tab-content");
  const iframe = document.getElementById("speedscope-iframe");
  let activeTabId = "flamechart";
  const sourceTabs = new Map(); // id -> { file, line, col, button, panel }

  // --- Load config and set iframe src ---

  const config = await fetch("/api/config").then(r => r.json());
  const hashParts = ["profileURL=/api/profile"];
  if (config.editorUri) hashParts.push("editorUri=" + encodeURIComponent(config.editorUri));
  iframe.src = "/speedscope/index.html#" + hashParts.join("&");

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
      console.log("Archive not yet implemented");
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

    const tabData = { file, line, col, button: btn, panel };
    sourceTabs.set(id, tabData);
    updateSourcePanel(tabData, file, line, col);
    activateTab(id);
  }

  function updateSourcePanel(tabData, file, line, col) {
    const { panel, button } = tabData;
    const shortName = file.split("/").pop() || file;
    const label = line ? shortName + ":" + line : shortName;
    button.innerHTML =
      escapeHtml(label) + ' <span class="tab-close" title="Close">&times;</span>';

    panel.innerHTML =
      '<div class="source-placeholder">' +
      "<p><strong>" + escapeHtml(file) + "</strong></p>" +
      (line
        ? "<p>Line " + line + (col ? ", Column " + col : "") + "</p>"
        : "") +
      '<p style="margin-top:12px;color:var(--tab-color)">Source rendering coming soon.</p>' +
      "</div>";
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

  // --- postMessage from speedscope iframe ---

  window.addEventListener("message", ev => {
    if (ev.data && ev.data.type === "open-source") {
      const { file, line, col } = ev.data;
      if (file) openSourceTab(file, line, col);
    }
  });

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
})();
