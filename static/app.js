(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const statusLabel = statusEl.querySelector(".label");
  const previewEl = $("preview");
  const errorEl = $("error");
  const renderBtn = $("render-btn");
  const downloadBtn = $("download-btn");
  const timelineBtn = $("timeline-btn");
  const citeBtn = $("cite-btn");
  const commentsBtn = $("comments-btn");
  const commentsBadge = $("comments-badge");
  const commentsPanel = $("comments-panel");
  const commentsListEl = $("comments-list");
  const commentsEmptyEl = $("comments-empty");
  const commentsCloseBtn = $("comments-close");
  const commentsShowResolved = $("comments-show-resolved");
  const linePopupEl = $("line-popup");
  const tabsEl = $("tabs");
  const sidebarEl = $("sidebar");
  const sidebarToggle = $("sidebar-toggle");
  const fileListEl = $("file-list");
  const newDocBtn = $("new-doc");
  const newFolderBtn = $("new-folder");

  const STORAGE_PREFIX = "agentex:";
  const lsGet = (k, fallback) => {
    try { const v = localStorage.getItem(STORAGE_PREFIX + k); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  };
  const lsSet = (k, v) => {
    try { localStorage.setItem(STORAGE_PREFIX + k, JSON.stringify(v)); } catch {}
  };

  let openTabs = lsGet("openTabs", []);
  let activeName = "";
  let renderTargetName = "";
  let allDocs = [];
  let allDirs = [];
  let expandedFolders = new Set(lsGet("expandedFolders", []));

  function saveExpanded() {
    lsSet("expandedFolders", Array.from(expandedFolders));
  }

  function ensureAncestorsExpanded(path) {
    if (!path) return;
    const parts = path.split("/");
    parts.pop();
    let acc = "";
    let changed = false;
    for (const p of parts) {
      acc = acc ? acc + "/" + p : p;
      if (!expandedFolders.has(acc)) {
        expandedFolders.add(acc);
        changed = true;
      }
    }
    if (changed) saveExpanded();
  }

  // Encode each segment but keep slashes as path separators — FastAPI's
  // {name:path} expects the slashes intact in the URL.
  function encodePath(p) {
    return p.split("/").map(encodeURIComponent).join("/");
  }

  // ---------- in-page dialogs ----------
  // Native prompt/confirm/alert use the browser chrome and the OS font, which
  // breaks visual consistency with the app. These three helpers replace them
  // with styled in-page dialogs sharing the same typography. They also don't
  // block the JS event loop — WebSocket messages keep flowing while a dialog
  // is open, which native dialogs can't do.
  function _createModal() {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    backdrop.appendChild(dialog);
    return { backdrop, dialog };
  }
  function _addLabel(dialog, text) {
    const el = document.createElement("div");
    el.className = "modal-label";
    el.textContent = text;
    dialog.appendChild(el);
  }
  function _addActions(dialog, buttons) {
    const wrap = document.createElement("div");
    wrap.className = "modal-actions";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "modal-btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : "");
      btn.textContent = b.label;
      btn.addEventListener("click", b.onClick);
      wrap.appendChild(btn);
    }
    dialog.appendChild(wrap);
  }
  function _trapFocus(dialog) {
    dialog.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const focusables = [...dialog.querySelectorAll("input, button")];
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }
  function modalIsOpen() {
    return !!document.querySelector(".modal-backdrop");
  }

  function openPromptDialog({ title, defaultValue = "" }) {
    return new Promise((resolve) => {
      const { backdrop, dialog } = _createModal();
      _addLabel(dialog, title);
      const input = document.createElement("input");
      input.type = "text";
      input.className = "modal-input";
      input.value = defaultValue;
      dialog.appendChild(input);

      function close(value) {
        backdrop.remove();
        document.removeEventListener("keydown", onKey);
        resolve(value);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
      }
      // Enter on the input submits. Enter on a button uses the default browser
      // button-activation, so Tab→Enter on Cancel/OK also works as expected.
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); close(input.value); }
      });
      document.addEventListener("keydown", onKey);
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) close(null);
      });

      _addActions(dialog, [
        { label: "Cancel", onClick: () => close(null) },
        { label: "OK", primary: true, onClick: () => close(input.value) },
      ]);
      _trapFocus(dialog);

      document.body.appendChild(backdrop);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
  }

  function openConfirmDialog({ message, confirmLabel = "OK", danger = false }) {
    return new Promise((resolve) => {
      const { backdrop, dialog } = _createModal();
      _addLabel(dialog, message);

      function close(value) {
        backdrop.remove();
        document.removeEventListener("keydown", onKey);
        resolve(value);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(false); }
      }
      document.addEventListener("keydown", onKey);
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) close(false);
      });

      _addActions(dialog, [
        { label: "Cancel", onClick: () => close(false) },
        { label: confirmLabel, primary: true, danger, onClick: () => close(true) },
      ]);
      _trapFocus(dialog);

      document.body.appendChild(backdrop);
      requestAnimationFrame(() => {
        const primary = dialog.querySelector(".modal-btn.primary");
        if (primary) primary.focus();
      });
    });
  }

  function openAlertDialog({ message }) {
    return new Promise((resolve) => {
      const { backdrop, dialog } = _createModal();
      _addLabel(dialog, message);

      function close() {
        backdrop.remove();
        document.removeEventListener("keydown", onKey);
        resolve();
      }
      function onKey(e) {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          close();
        }
      }
      document.addEventListener("keydown", onKey);
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) close();
      });

      _addActions(dialog, [{ label: "OK", primary: true, onClick: close }]);
      _trapFocus(dialog);

      document.body.appendChild(backdrop);
      requestAnimationFrame(() => {
        const ok = dialog.querySelector(".modal-btn.primary");
        if (ok) ok.focus();
      });
    });
  }

  // ---------- timeline (history + rewind) ----------
  let timelineModalEl = null;

  async function fetchSnapshot(hash) {
    try {
      const r = await fetch(`/api/timeline/snapshot/${hash}`);
      if (!r.ok) return "";
      const data = await r.json();
      return data.content || "";
    } catch {
      return "";
    }
  }

  function renderDiffHtml(beforeText, afterText) {
    if (!window.Diff) {
      return '<div class="diff-loading">Loading diff…</div>';
    }
    const parts = window.Diff.diffLines(beforeText || "", afterText || "");
    let html = '<div class="diff-block">';
    for (const p of parts) {
      const cls = p.added ? "added" : p.removed ? "removed" : "context";
      const sign = p.added ? "+" : p.removed ? "-" : " ";
      const lines = p.value.split("\n");
      // Drop the trailing empty from a chunk ending in \n
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      for (const line of lines) {
        html +=
          `<div class="diff-line ${cls}">` +
          `<span class="diff-sign">${sign}</span>` +
          `<span class="diff-content">${escapeHtml(line || " ")}</span>` +
          "</div>";
      }
    }
    html += "</div>";
    return html;
  }

  async function doRewind(doc, hash) {
    const confirmed = await openConfirmDialog({
      message: `Rewind "${doc}" to this snapshot? Your current state is preserved as a "pre-rewind" entry, so you can come back to it.`,
      confirmLabel: "Rewind",
    });
    if (!confirmed) return;
    try {
      const r = await fetch("/api/timeline/rewind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc, hash }),
      });
      if (!r.ok) {
        const err = await r.text();
        await openAlertDialog({ message: "Rewind failed: " + err });
        return;
      }
      closeTimelineModal();
    } catch (e) {
      await openAlertDialog({ message: "Rewind failed: " + e.message });
    }
  }

  function formatTime(iso) {
    try {
      const d = new Date(iso);
      const today = new Date();
      const sameDay =
        d.getFullYear() === today.getFullYear() &&
        d.getMonth() === today.getMonth() &&
        d.getDate() === today.getDate();
      return sameDay
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : d.toLocaleString([], {
            month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit",
          });
    } catch {
      return iso || "";
    }
  }

  function renderTimelineEntry(entry, prevEntry) {
    const wrap = document.createElement("div");
    wrap.className = "timeline-entry";

    const row = document.createElement("div");
    row.className = "timeline-entry-row";

    const chev = document.createElement("span");
    chev.className = "timeline-chev";
    chev.textContent = "▸";
    row.appendChild(chev);

    const time = document.createElement("span");
    time.className = "timeline-time";
    time.textContent = formatTime(entry.ts);
    time.title = entry.ts;
    row.appendChild(time);

    const author = document.createElement("span");
    author.className = "timeline-author " + (entry.author === "agent" ? "agent" : "user");
    author.textContent = entry.author || "user";
    row.appendChild(author);

    const doc = document.createElement("span");
    doc.className = "timeline-doc";
    doc.textContent = entry.doc || "";
    doc.title = entry.doc || "";
    row.appendChild(doc);

    const trigger = document.createElement("span");
    trigger.className = "timeline-trigger";
    trigger.textContent = entry.trigger || "";
    row.appendChild(trigger);

    wrap.appendChild(row);

    const detail = document.createElement("div");
    detail.className = "timeline-detail";
    detail.hidden = true;
    wrap.appendChild(detail);

    let loaded = false;
    row.addEventListener("click", async () => {
      if (!detail.hidden) {
        detail.hidden = true;
        chev.textContent = "▸";
        return;
      }
      detail.hidden = false;
      chev.textContent = "▾";
      if (loaded) return;
      detail.innerHTML = '<div class="diff-loading">Loading diff…</div>';
      const [after, before] = await Promise.all([
        fetchSnapshot(entry.hash),
        prevEntry ? fetchSnapshot(prevEntry.hash) : Promise.resolve(""),
      ]);
      const diffHtml = renderDiffHtml(before, after);
      const note = prevEntry
        ? ""
        : '<div class="diff-meta">First snapshot for this doc — full content shown as additions.</div>';
      detail.innerHTML = note + diffHtml +
        `<div class="timeline-actions">` +
        `<button class="modal-btn primary rewind-btn" type="button">Rewind to this point</button>` +
        `</div>`;
      detail
        .querySelector(".rewind-btn")
        .addEventListener("click", () => doRewind(entry.doc, entry.hash));
      loaded = true;
    });

    return wrap;
  }

  async function openTimelineModal() {
    if (timelineModalEl) return;
    let data;
    try {
      const r = await fetch("/api/timeline?limit=200");
      if (!r.ok) throw new Error(await r.text());
      data = await r.json();
    } catch (e) {
      await openAlertDialog({ message: "Could not load history: " + e.message });
      return;
    }
    const entries = data.entries || [];
    const enabled = data.enabled !== false;

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "modal-dialog timeline-dialog";

    const header = document.createElement("div");
    header.className = "timeline-header";
    const title = document.createElement("div");
    title.className = "timeline-title";
    title.textContent = "History";
    const switchLabel = document.createElement("label");
    switchLabel.className = "timeline-switch";
    switchLabel.innerHTML =
      `<input type="checkbox" ${enabled ? "checked" : ""}>` +
      `<span class="track"><span class="thumb"></span></span>` +
      `<span class="switch-label">Recording</span>`;
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-btn timeline-close";
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    header.appendChild(title);
    header.appendChild(switchLabel);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = document.createElement("div");
    body.className = "timeline-body";
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "timeline-empty";
      empty.textContent =
        enabled
          ? "No history yet. Snapshots are taken on each successful render."
          : "Recording is off. Turn it on above to start collecting snapshots.";
      body.appendChild(empty);
    } else {
      // For each entry, find the previous snapshot for the same doc (older
      // index, since entries are newest-first).
      for (let i = 0; i < entries.length; i++) {
        let prev = null;
        for (let j = i + 1; j < entries.length; j++) {
          if (entries[j].doc === entries[i].doc) {
            prev = entries[j];
            break;
          }
        }
        body.appendChild(renderTimelineEntry(entries[i], prev));
      }
    }
    dialog.appendChild(body);

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    timelineModalEl = backdrop;

    function close() {
      if (!timelineModalEl) return;
      timelineModalEl.remove();
      timelineModalEl = null;
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    closeBtn.addEventListener("click", close);

    const cb = switchLabel.querySelector("input");
    cb.addEventListener("change", async (e) => {
      try {
        await fetch("/api/timeline/enabled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: e.target.checked }),
        });
      } catch (err) {
        console.warn("toggle failed", err);
      }
    });
  }

  function closeTimelineModal() {
    if (!timelineModalEl) return;
    timelineModalEl.remove();
    timelineModalEl = null;
  }

  timelineBtn.addEventListener("click", openTimelineModal);

  // ---------- INSPIRE-HEP cite modal ----------
  let citeModalEl = null;
  let citeSearchTimer = null;
  let citeLastQuery = "";

  function renderCiteResults(container, results) {
    if (!results.length) {
      container.innerHTML = '<div class="cite-empty">No matches.</div>';
      return;
    }
    container.replaceChildren();
    for (const r of results) {
      const row = document.createElement("div");
      row.className = "cite-result";
      const title = document.createElement("div");
      title.className = "cite-title";
      title.textContent = r.title || "(no title)";
      row.appendChild(title);
      const meta = document.createElement("div");
      meta.className = "cite-meta";
      const parts = [];
      const authorsBit =
        (r.authors || []).filter(Boolean).join(", ") +
        (r.n_more_authors ? `, +${r.n_more_authors} more` : "");
      if (authorsBit) parts.push(authorsBit);
      if (r.year) parts.push(String(r.year));
      if (r.arxiv_id) parts.push("arXiv:" + r.arxiv_id);
      if (typeof r.citation_count === "number") {
        parts.push(
          `${r.citation_count} citation${r.citation_count === 1 ? "" : "s"}`
        );
      }
      meta.textContent = parts.join(" · ");
      row.appendChild(meta);
      row.addEventListener("click", () => doCite(r));
      container.appendChild(row);
    }
  }

  function insertCiteAtCursor(key) {
    // Inserting \cite{...} only makes sense inside .tex or .md content; if
    // the active doc is the .bib itself (or any non-citing surface), the
    // bibtex has already been appended server-side and we're done.
    const af = activeName || "";
    if (af.endsWith(".bib") || af.endsWith(".txt")) return;
    const cursor = editor.getCursor();
    const text = `\\cite{${key}}`;
    editor.replaceRange(text, cursor);
    editor.setCursor({ line: cursor.line, ch: cursor.ch + text.length });
    editor.focus();
  }

  async function doCite(result) {
    try {
      const r = await fetch("/api/inspire/cite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recid: result.recid }),
      });
      if (!r.ok) {
        const err = await r.text();
        await openAlertDialog({ message: "Cite failed: " + err });
        return;
      }
      const data = await r.json();
      if (!data.key) {
        await openAlertDialog({ message: "Cite failed: no key returned" });
        return;
      }
      insertCiteAtCursor(data.key);
      closeCiteModal();
    } catch (e) {
      await openAlertDialog({ message: "Cite failed: " + e.message });
    }
  }

  async function openCiteModal() {
    if (citeModalEl) return;

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "modal-dialog cite-dialog";

    const header = document.createElement("div");
    header.className = "timeline-header";
    const title = document.createElement("div");
    title.className = "timeline-title";
    title.textContent = "Cite from INSPIRE-HEP";
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-btn timeline-close";
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    header.appendChild(title);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const searchWrap = document.createElement("div");
    searchWrap.className = "cite-search";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "modal-input";
    searchInput.placeholder = "Search by author, title, arXiv ID, INSPIRE key…";
    searchWrap.appendChild(searchInput);
    dialog.appendChild(searchWrap);

    const results = document.createElement("div");
    results.className = "cite-results";
    results.innerHTML = '<div class="cite-empty">Type to search.</div>';
    dialog.appendChild(results);

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    citeModalEl = backdrop;

    function close() {
      if (!citeModalEl) return;
      citeModalEl.remove();
      citeModalEl = null;
      document.removeEventListener("keydown", onKey);
      if (citeSearchTimer) clearTimeout(citeSearchTimer);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    closeBtn.addEventListener("click", close);

    async function doSearch(q) {
      if (!q.trim()) {
        results.innerHTML = '<div class="cite-empty">Type to search.</div>';
        return;
      }
      // Guard against out-of-order responses for stale queries.
      citeLastQuery = q;
      results.innerHTML = '<div class="cite-empty">Searching…</div>';
      try {
        const r = await fetch(
          `/api/inspire/search?q=${encodeURIComponent(q)}&limit=15`
        );
        if (citeLastQuery !== q) return;
        if (!r.ok) {
          results.innerHTML = '<div class="cite-empty">Search failed.</div>';
          return;
        }
        const data = await r.json();
        if (citeLastQuery !== q) return;
        renderCiteResults(results, data.results || []);
      } catch (e) {
        if (citeLastQuery !== q) return;
        results.innerHTML = `<div class="cite-empty">${escapeHtml(e.message)}</div>`;
      }
    }

    searchInput.addEventListener("input", () => {
      if (citeSearchTimer) clearTimeout(citeSearchTimer);
      const q = searchInput.value;
      citeSearchTimer = setTimeout(() => doSearch(q), 300);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (citeSearchTimer) clearTimeout(citeSearchTimer);
        doSearch(searchInput.value);
      }
    });

    requestAnimationFrame(() => searchInput.focus());
  }

  function closeCiteModal() {
    if (!citeModalEl) return;
    citeModalEl.remove();
    citeModalEl = null;
  }

  citeBtn.addEventListener("click", openCiteModal);

  // ---------- cite-as-you-type ----------
  // While the cursor is inside \cite{...}, surface local .bib keys + INSPIRE
  // results in a CodeMirror hint dropdown. Selecting an INSPIRE result also
  // appends the BibTeX entry to the active bib (via /api/inspire/cite).
  const CITE_MACRO_RE = /\\cite[a-z]*\*?(?:\[[^\]]*\])?\{([^}]*)$/i;
  let bibKeys = [];
  const inspireCache = new Map();

  async function refreshBibKeys() {
    try {
      const r = await fetch("/api/bibkeys");
      if (!r.ok) return;
      const data = await r.json();
      bibKeys = Array.isArray(data.keys) ? data.keys : [];
    } catch {
      // network hiccup; keep stale cache
    }
  }
  refreshBibKeys();

  function inspireSearch(q) {
    if (inspireCache.has(q)) return inspireCache.get(q);
    const p = fetch(`/api/inspire/search?q=${encodeURIComponent(q)}&limit=8`)
      .then((r) => (r.ok ? r.json() : { results: [] }))
      .then((d) => d.results || [])
      .catch(() => []);
    inspireCache.set(q, p);
    if (inspireCache.size > 64) {
      inspireCache.delete(inspireCache.keys().next().value);
    }
    return p;
  }

  function renderCiteHint(el, _data, completion) {
    el.classList.add("cite-hint-item");
    if (completion.source) el.classList.add("cite-hint-" + completion.source);
    const key = document.createElement("div");
    key.className = "cite-hint-key";
    key.textContent = completion.displayText || completion.text;
    el.appendChild(key);
    if (completion.subLabel) {
      const sub = document.createElement("div");
      sub.className = "cite-hint-sub";
      sub.textContent = completion.subLabel;
      el.appendChild(sub);
    }
  }

  function insertInspireCite(cm, self, data) {
    cm.replaceRange(data.text, self.from, self.to, "+complete");
    if (!data.recid) return;
    fetch("/api/inspire/cite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recid: data.recid }),
    }).catch((e) => console.warn("cite append failed", e));
  }

  function citeHint(cm, callback) {
    const cursor = cm.getCursor();
    const lineText = cm.getLine(cursor.line).slice(0, cursor.ch);
    const m = lineText.match(CITE_MACRO_RE);
    if (!m) {
      callback(null);
      return;
    }
    const argText = m[1];
    const lastComma = argText.lastIndexOf(",");
    const partial = argText.slice(lastComma + 1).replace(/^\s+/, "");
    const partialStart = {
      line: cursor.line,
      ch: cursor.ch - partial.length,
    };
    const needle = partial.toLowerCase();
    const local = bibKeys
      .filter((k) => !needle || k.key.toLowerCase().includes(needle))
      .slice(0, 10)
      .map((k) => ({
        text: k.key,
        displayText: k.key,
        subLabel: `local · ${k.file}`,
        source: "local",
        render: renderCiteHint,
      }));

    if (partial.length < 2) {
      callback({ list: local, from: partialStart, to: cursor });
      return;
    }

    inspireSearch(partial).then((results) => {
      const seen = new Set(local.map((l) => l.text));
      const inspire = results
        .filter((r) => r.texkey && !seen.has(r.texkey))
        .map((r) => {
          const authors = (r.authors || []).join(", ");
          const more = r.n_more_authors ? ` +${r.n_more_authors}` : "";
          const head = r.year ? `${r.year} · ` : "";
          return {
            text: r.texkey,
            displayText: r.texkey,
            subLabel: `inspire · ${head}${authors}${more}`.slice(0, 90),
            source: "inspire",
            recid: r.recid,
            render: renderCiteHint,
            hint: insertInspireCite,
          };
        });
      callback({
        list: [...local, ...inspire],
        from: partialStart,
        to: cursor,
      });
    });
  }
  citeHint.async = true;

  function maybeShowCiteHint() {
    if (!activeName || activeName.endsWith(".bib") || activeName.endsWith(".txt")) {
      return;
    }
    if (editor.state.completionActive) return;
    const cursor = editor.getCursor();
    const lineText = editor.getLine(cursor.line).slice(0, cursor.ch);
    if (!CITE_MACRO_RE.test(lineText)) return;
    editor.showHint({
      hint: citeHint,
      completeSingle: false,
      closeCharacters: /[\s}]/,
    });
  }

  let activeContextMenu = null;
  function closeContextMenu() {
    if (activeContextMenu) {
      activeContextMenu.remove();
      activeContextMenu = null;
    }
  }
  function showContextMenu(x, y, items) {
    closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "context-separator";
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.className = "context-item" + (item.danger ? " danger" : "");
      btn.type = "button";
      btn.textContent = item.label;
      btn.addEventListener("click", () => {
        closeContextMenu();
        item.action();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    activeContextMenu = menu;
    // Clamp to viewport so the menu never spills off-screen.
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = (window.innerWidth - rect.width - 4) + "px";
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = (window.innerHeight - rect.height - 4) + "px";
    }
  }
  document.addEventListener("click", (e) => {
    if (activeContextMenu && !activeContextMenu.contains(e.target)) closeContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeContextMenu) closeContextMenu();
  });
  window.addEventListener("blur", closeContextMenu);

  async function performMove(src, dest) {
    if (src === dest) return;
    try {
      const r = await fetch("/api/docs/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ src, dest }),
      });
      if (!r.ok) {
        const err = await r.text();
        await openAlertDialog({ message: "Move failed: " + err });
      }
    } catch (e) {
      await openAlertDialog({ message: "Move failed: " + e.message });
    }
  }

  async function renameItem(path, isDir) {
    const newPath = await openPromptDialog({
      title: isDir ? "Rename folder to:" : "Rename to:",
      defaultValue: path,
    });
    if (!newPath || newPath === path) return;
    await performMove(path, newPath);
  }

  // Drag state. Only the source row's path/kind matters globally; drop
  // handlers compute their own dest. Cleared on dragend.
  let draggedPath = null;
  let draggedIsDir = false;

  function clearDropHighlights() {
    document.querySelectorAll(".tree-row.drop-target").forEach((el) =>
      el.classList.remove("drop-target")
    );
    fileListEl.classList.remove("drop-target-root");
  }

  function isInvalidDirDrop(targetPath) {
    if (!draggedIsDir) return false;
    if (targetPath === draggedPath) return true;
    if (targetPath.startsWith(draggedPath + "/")) return true;
    return false;
  }

  function makeDraggable(row, path, isDir) {
    row.setAttribute("draggable", "true");
    row.addEventListener("dragstart", (e) => {
      draggedPath = path;
      draggedIsDir = isDir;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", path);
      closeContextMenu();
    });
    row.addEventListener("dragend", () => {
      draggedPath = null;
      draggedIsDir = false;
      clearDropHighlights();
    });
  }

  function makeFolderDropTarget(li, row, folderPath) {
    // 600ms hover-to-expand so users can drill into collapsed folders
    // mid-drag — a common pattern in file managers.
    let hoverExpandTimer = null;
    li.addEventListener("dragover", (e) => {
      if (draggedPath === null) return;
      if (isInvalidDirDrop(folderPath)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      // Only highlight the innermost folder under the cursor. Outer folders
      // that still match (because contains() bubbles) get cleared here.
      document.querySelectorAll(".tree-row.drop-target").forEach((el) => {
        if (el !== row) el.classList.remove("drop-target");
      });
      row.classList.add("drop-target");
      if (!li.classList.contains("open") && !hoverExpandTimer) {
        hoverExpandTimer = setTimeout(() => {
          expandedFolders.add(folderPath);
          li.classList.add("open");
          saveExpanded();
          hoverExpandTimer = null;
        }, 600);
      }
    });
    li.addEventListener("dragleave", (e) => {
      // dragleave fires every time the cursor crosses into a child; only
      // act when it's actually leaving the LI's bounds.
      if (li.contains(e.relatedTarget)) return;
      row.classList.remove("drop-target");
      if (hoverExpandTimer) {
        clearTimeout(hoverExpandTimer);
        hoverExpandTimer = null;
      }
    });
    li.addEventListener("drop", (e) => {
      if (draggedPath === null) return;
      if (isInvalidDirDrop(folderPath)) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove("drop-target");
      if (hoverExpandTimer) {
        clearTimeout(hoverExpandTimer);
        hoverExpandTimer = null;
      }
      const basename = draggedPath.split("/").pop();
      performMove(draggedPath, folderPath + "/" + basename);
    });
  }

  // Root drop target — anywhere in the file-list that isn't an inner folder
  // LI (those stopPropagation). One-time setup outside the per-render loop.
  fileListEl.addEventListener("dragover", (e) => {
    if (draggedPath === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Suppress the root highlight if a folder underneath is already eligible.
    if (!document.querySelector(".tree-row.drop-target")) {
      fileListEl.classList.add("drop-target-root");
    }
  });
  fileListEl.addEventListener("dragleave", (e) => {
    if (!fileListEl.contains(e.relatedTarget)) {
      fileListEl.classList.remove("drop-target-root");
    }
  });
  fileListEl.addEventListener("drop", (e) => {
    if (draggedPath === null) return;
    e.preventDefault();
    fileListEl.classList.remove("drop-target-root");
    const basename = draggedPath.split("/").pop();
    if (basename === draggedPath) return; // already at root
    performMove(draggedPath, basename);
  });

  async function deleteItem(path, isDir) {
    const msg = isDir
      ? `Delete folder "${path}" and everything inside it?`
      : `Delete "${path}"?`;
    const confirmed = await openConfirmDialog({
      message: msg,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      const url = isDir
        ? `/api/dirs/${encodePath(path)}?recursive=true`
        : `/api/docs/${encodePath(path)}`;
      const r = await fetch(url, { method: "DELETE" });
      if (!r.ok) {
        const err = await r.text();
        await openAlertDialog({ message: "Delete failed: " + err });
      }
    } catch (e) {
      await openAlertDialog({ message: "Delete failed: " + e.message });
    }
  }

  // Create helpers. folder="" means "at the root of docs/". Otherwise the
  // user's input is treated as relative to `folder` (the prompt label makes
  // the scope explicit so they don't re-type the folder prefix).
  async function createDocAt(folder) {
    const label = folder
      ? `New document in ${folder}:`
      : "New document path (e.g. notes.tex, chapters/intro.tex, refs.bib):";
    const input = await openPromptDialog({ title: label, defaultValue: "untitled.tex" });
    if (!input) return;
    const name = folder ? folder + "/" + input : input;
    try {
      const r = await fetch("/api/docs/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, activate: true }),
      });
      if (!r.ok) {
        const err = await r.text();
        await openAlertDialog({ message: "Could not create: " + err });
      }
    } catch (e) {
      await openAlertDialog({ message: "Could not create: " + e.message });
    }
  }

  async function createFolderAt(folder) {
    const label = folder ? `New folder in ${folder}:` : "New folder:";
    const input = await openPromptDialog({ title: label, defaultValue: "" });
    if (!input) return;
    const name = folder ? folder + "/" + input : input;
    try {
      const r = await fetch("/api/dirs/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const err = await r.text();
        await openAlertDialog({ message: "Could not create: " + err });
        return;
      }
      expandedFolders.add(name);
      ensureAncestorsExpanded(name + "/_placeholder");
      saveExpanded();
    } catch (e) {
      await openAlertDialog({ message: "Could not create: " + e.message });
    }
  }

  function openFileMenu(e, path) {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: "Rename…", action: () => renameItem(path, false) },
      { label: "Delete", danger: true, action: () => deleteItem(path, false) },
    ]);
  }

  function openFolderMenu(e, folderPath) {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: "New document…", action: () => createDocAt(folderPath) },
      { label: "New folder…", action: () => createFolderAt(folderPath) },
      { separator: true },
      { label: "Rename…", action: () => renameItem(folderPath, true) },
      { label: "Delete", danger: true, action: () => deleteItem(folderPath, true) },
    ]);
  }

  function openSidebarMenu(e) {
    // Right-click on a tree row uses the row-specific menu (their handlers
    // stopPropagation), so reaching here means the user clicked on empty
    // sidebar space — i.e. they want a "create at root" action.
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: "New document…", action: () => createDocAt("") },
      { label: "New folder…", action: () => createFolderAt("") },
    ]);
  }
  fileListEl.addEventListener("contextmenu", openSidebarMenu);

  if (lsGet("sidebarExpanded", false)) sidebarEl.classList.remove("collapsed");

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }
  let pdfScale = 1.0;
  const PDF_SCALE_MIN = 0.2;
  const PDF_SCALE_MAX = 8.0;
  // zoomFactor: multiplier on top of fit-to-pane. 1.0 = exactly fits.
  // > 1 overflows horizontally on purpose so the user can pan into the page.
  let zoomFactor = 1.0;
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 6.0;
  const PDF_PAGE_PAD = 24;
  let currentPdfUrl = null;
  let renderToken = 0;
  // visualScale: CSS-only multiplier on top of the last rendered pdfScale.
  // Lets us give snappy feedback during a wheel zoom; reset to 1.0 every
  // time renderPdf finishes since the canvases are now at the new pdfScale.
  let visualScale = 1.0;
  let lastPaneWidth = 0;

  async function renderPdf(url, anchor) {
    if (!window.pdfjsLib) {
      previewEl.textContent = "PDF.js failed to load";
      return;
    }
    previewEl.classList.remove("md");
    previewEl.classList.add("pdf");
    currentPdfUrl = url;
    downloadBtn.disabled = false;
    const myToken = ++renderToken;
    if (!anchor) {
      const sh = previewEl.scrollHeight;
      anchor = sh > 0
        ? { ratio: previewEl.scrollTop / sh, offset: 0 }
        : { ratio: 0, offset: 0 };
    }
    let pdf;
    try {
      pdf = await window.pdfjsLib.getDocument({ url }).promise;
    } catch (e) {
      if (myToken !== renderToken) return;
      previewEl.textContent = "Failed to load PDF: " + e.message;
      return;
    }
    if (myToken !== renderToken) return;
    // Fit-to-pane width based on first page natural dimensions.
    try {
      const page1 = await pdf.getPage(1);
      const naturalVp = page1.getViewport({ scale: 1.0 });
      const paneW = previewEl.clientWidth || 600;
      const fitScale = Math.max(0.05, (paneW - PDF_PAGE_PAD) / naturalVp.width);
      pdfScale = Math.max(PDF_SCALE_MIN, Math.min(PDF_SCALE_MAX, fitScale * zoomFactor));
    } catch (e) {
      // Fall back to last pdfScale if we can't measure
    }
    if (myToken !== renderToken) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = pdfScale * dpr;
    const canvases = new Array(pdf.numPages);
    await Promise.all(
      Array.from({ length: pdf.numPages }, (_, i) => (async () => {
        const page = await pdf.getPage(i + 1);
        if (myToken !== renderToken) return;
        const naturalVp = page.getViewport({ scale: 1.0 });
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.className = "pdf-page";
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const baseW = Math.floor(viewport.width / dpr);
        canvas.style.width = baseW + "px";
        // height intentionally unset — CSS .pdf-page { height: auto } keeps
        // the aspect ratio when max-width clamps a narrow pane.
        canvas.dataset.baseW = String(baseW);
        // Natural PDF user-space size (in points). Used by the synctex
        // click handler to map CSS pixels back to PDF coordinates.
        canvas.dataset.naturalW = String(naturalVp.width);
        canvas.dataset.naturalH = String(naturalVp.height);
        canvas.dataset.pageNum = String(i + 1);
        // Double-click for SyncTeX inverse — single click is reserved for
        // selection and would conflict with users dragging to read.
        canvas.addEventListener("dblclick", (e) => onPdfClick(canvas, e));
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        if (myToken !== renderToken) return;
        canvases[i] = canvas;
      })())
    );
    if (myToken !== renderToken) return;
    previewEl.replaceChildren(...canvases.filter(Boolean));
    visualScale = 1.0;
    const newScrollHeight = previewEl.scrollHeight;
    const target = anchor.ratio * newScrollHeight - anchor.offset;
    const maxScroll = Math.max(0, newScrollHeight - previewEl.clientHeight);
    previewEl.scrollTop = Math.max(0, Math.min(target, maxScroll));
  }

  function applyVisualScale() {
    const canvases = previewEl.querySelectorAll(".pdf-page");
    canvases.forEach((c) => {
      const baseW = parseFloat(c.dataset.baseW);
      if (baseW > 0) c.style.width = (baseW * visualScale) + "px";
    });
  }

  function renderMarkdown(text) {
    ++renderToken;
    currentPdfUrl = null;
    downloadBtn.disabled = true;
    visualScale = 1.0;
    lastPaneWidth = 0;
    const wasInMdMode = previewEl.classList.contains("md");
    previewEl.classList.remove("pdf");
    previewEl.classList.add("md");
    // Only reset scroll when transitioning into MD from another mode.
    // Re-renders within MD (e.g. switching to a .bib while MD is the
    // render target) should keep the user's scroll position.
    const prevTop = wasInMdMode ? previewEl.scrollTop : 0;
    const prevLeft = wasInMdMode ? previewEl.scrollLeft : 0;
    const html = window.marked ? window.marked.parse(text || "") : escapeHtml(text || "");
    previewEl.innerHTML = `<article class="md-body">${html}</article>`;
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(previewEl, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "\\[", right: "\\]", display: true },
            { left: "\\(", right: "\\)", display: false },
            { left: "$", right: "$", display: false },
          ],
          throwOnError: false,
        });
      } catch (e) {
        console.warn("KaTeX auto-render failed", e);
      }
    }
    // Restore scroll (clamped to new content height) so re-renders don't
    // jump the user back to the top.
    const maxTop = Math.max(0, previewEl.scrollHeight - previewEl.clientHeight);
    const maxLeft = Math.max(0, previewEl.scrollWidth - previewEl.clientWidth);
    previewEl.scrollTop = Math.min(prevTop, maxTop);
    previewEl.scrollLeft = Math.min(prevLeft, maxLeft);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  let suppressNextChange = false;
  let socket = null;
  let saveTimer = null;
  let streaming = false;
  let streamPos = 0;
  let unrendered = false;

  function setStatus(state, label) {
    statusEl.dataset.state = state;
    statusLabel.textContent = label;
  }

  function setError(text) {
    if (text) {
      errorEl.textContent = text;
      errorEl.hidden = false;
    } else {
      errorEl.hidden = true;
    }
  }

  const editor = CodeMirror.fromTextArea($("editor"), {
    mode: "stex",
    theme: "agentex",
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    tabSize: 2,
    matchBrackets: true,
    styleActiveLine: true,
    autofocus: true,
    gutters: ["agentex-marks", "CodeMirror-linenumbers"],
  });

  editor.on("change", (_cm, change) => {
    if (suppressNextChange) {
      suppressNextChange = false;
      return;
    }
    if (streaming) return;
    scheduleSave();
    unrendered = true;
    setStatus("modified", "modified");
    if (change && change.origin !== "+complete" && change.origin !== "setValue") {
      maybeShowCiteHint();
    }
  });

  function streamBegin(fromIndex, toIndex) {
    streaming = true;
    streamPos = fromIndex;
    setStatus("building", "streaming…");
    setError(null);
    if (toIndex != null && toIndex > fromIndex) {
      const a = editor.posFromIndex(fromIndex);
      const b = editor.posFromIndex(toIndex);
      editor.replaceRange("", a, b);
    }
    const pos = editor.posFromIndex(streamPos);
    editor.setCursor(pos);
    editor.scrollIntoView(pos, 80);
  }

  function streamChar(ch) {
    if (!streaming) return;
    const pos = editor.posFromIndex(streamPos);
    editor.replaceRange(ch, pos, pos);
    streamPos += ch.length;
    const newPos = editor.posFromIndex(streamPos);
    editor.setCursor(newPos);
    editor.scrollIntoView(newPos, 80);
  }

  function streamEnd() {
    streaming = false;
    setStatus("idle", "streamed");
  }

  function modeForDoc(name) {
    if (!name) return "stex";
    if (name.endsWith(".md")) return "markdown";
    if (name.endsWith(".bib")) return "text/plain";
    if (name.endsWith(".txt")) return "text/plain";
    return "stex";
  }

  // Dev helper: window.__layoutInfo() prints right-edge of every key container.
  // Useful for diagnosing the "right side not connected" layout bug.
  window.__layoutInfo = function () {
    const items = [
      ["html", document.documentElement],
      ["body", document.body],
      ["topbar", document.querySelector(".topbar")],
      ["layout", document.querySelector(".layout")],
      ["split", document.querySelector(".split")],
      ["editor-pane", document.querySelector(".editor-pane")],
      ["divider", document.querySelector(".divider")],
      ["preview-pane", document.querySelector(".preview-pane")],
      ["#preview", previewEl],
    ];
    console.log("window.innerWidth =", window.innerWidth);
    items.forEach(([k, el]) => {
      if (!el) return console.log(k, "(missing)");
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      console.log(
        `${k}: left=${r.left.toFixed(0)} right=${r.right.toFixed(0)} ` +
        `w=${r.width.toFixed(0)} sw=${el.scrollWidth} ` +
        `display=${cs.display} flex=${cs.flex} minW=${cs.minWidth}`
      );
    });
    console.log("preview class =", previewEl.className);
  };

  // editorActiveDoc tracks what's currently *loaded in the editor*, distinct
  // from `activeName` which can be updated by an early doc_list message
  // before the matching doc-content broadcast arrives. The cursor stash uses
  // this so a tab switch always captures the outgoing doc's state.
  let editorActiveDoc = null;
  const docViewState = new Map();
  function snapshotViewState(name) {
    if (!name) return;
    try {
      docViewState.set(name, {
        cursor: editor.getCursor(),
        scroll: editor.getScrollInfo(),
        selections: editor.listSelections(),
      });
    } catch {
      // editor not ready yet — fine to skip
    }
  }
  function restoreViewState(name) {
    const s = docViewState.get(name);
    if (!s) {
      editor.setCursor({ line: 0, ch: 0 });
      editor.scrollTo(0, 0);
      editor.focus();
      return;
    }
    // setCursor reliably lands the blinking caret. setSelections additionally
    // restores any range selection the user had. Scroll comes last so any
    // auto-scroll triggered by the cursor update gets overridden.
    if (s.cursor) {
      try {
        editor.setCursor(s.cursor);
      } catch {
        editor.setCursor({ line: 0, ch: 0 });
      }
    }
    if (s.selections && s.selections.length > 0) {
      const r = s.selections[0];
      if (r && r.anchor && r.head &&
          (r.anchor.line !== r.head.line || r.anchor.ch !== r.head.ch)) {
        try {
          editor.setSelections(s.selections);
        } catch {
          // fall through; cursor already restored above
        }
      }
    }
    if (s.scroll) editor.scrollTo(s.scroll.left, s.scroll.top);
    // CodeMirror only renders the blinking caret when the editor is focused.
    // Clicking a tab moves focus to the button — return it to the editor.
    editor.focus();
  }

  function applyDoc({ content, path }) {
    const switching = path && path !== editorActiveDoc;
    if (switching) {
      // Save the outgoing doc's cursor + scroll so coming back lands you
      // where you left off rather than at {0,0}.
      snapshotViewState(editorActiveDoc);
      activeName = path;
      ensureTab(path);
      renderTabs();
      renderFileList();
      editor.setOption("mode", modeForDoc(path));
      // CM caches an internal width — refresh after a mode swap so the
      // editor pane always reports the right size.
      setTimeout(() => editor.refresh(), 0);
    }
    const sameContent = editor.getValue() === content;
    if (!sameContent) {
      suppressNextChange = true;
      if (switching) {
        editor.setValue(content);
        restoreViewState(path);
      } else {
        // Same doc, content changed externally (agent edit, rewind, etc).
        // Preserve the user's current view rather than restoring a stash.
        const cursor = editor.getCursor();
        const scroll = editor.getScrollInfo();
        editor.setValue(content);
        editor.setCursor(cursor);
        editor.scrollTo(scroll.left, scroll.top);
      }
    }
    if (path) editorActiveDoc = path;
    // The gutter dots and sidebar are scoped to the active doc, so a switch
    // means re-rendering both even though `allComments` itself didn't change.
    if (switching) {
      applyCommentMarkers();
      renderCommentsPanel();
      updateCommentsBadge();
    }
    // If a synctex inverse-search asked us to jump to a different doc, the
    // switch + load arrives here. Fire the deferred jump now that the new
    // content is in place.
    if (pendingJump && pendingJump.file === path) {
      const { line } = pendingJump;
      pendingJump = null;
      requestAnimationFrame(() => doJumpEditor(line));
    }
  }

  function ensureTab(name) {
    if (!openTabs.includes(name)) {
      openTabs = [...openTabs, name];
      lsSet("openTabs", openTabs);
    }
  }

  function closeTab(name) {
    const idx = openTabs.indexOf(name);
    if (idx < 0) return;
    openTabs = openTabs.filter((n) => n !== name);
    lsSet("openTabs", openTabs);
    if (name === activeName) {
      const fallback = openTabs[idx] || openTabs[idx - 1] || allDocs[0];
      if (fallback) switchActive(fallback);
    } else {
      renderTabs();
    }
  }

  async function switchActive(name) {
    try {
      await fetch("/api/docs/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch (e) {
      console.error("switchActive failed", e);
    }
  }

  function tabLabel(name, allTabs) {
    const base = name.split("/").pop();
    const collides = allTabs.some(
      (n) => n !== name && n.split("/").pop() === base
    );
    if (!collides) return base;
    // On collision, show the last two segments (parent/base). The full path
    // is always available as a tooltip, so deeper disambiguation is rarely
    // worth the visual cost.
    const parts = name.split("/");
    return parts.length > 1 ? parts.slice(-2).join("/") : base;
  }

  function renderTabs() {
    const visible = openTabs.filter((n) => allDocs.includes(n));
    tabsEl.replaceChildren(
      ...visible.map((name) => {
        const el = document.createElement("button");
        el.className = "tab" + (name === activeName ? " active" : "");
        el.type = "button";
        el.role = "tab";
        el.title = name;
        const label = document.createElement("span");
        label.textContent = tabLabel(name, visible);
        el.appendChild(label);
        const close = document.createElement("span");
        close.className = "close";
        close.textContent = "×";
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          closeTab(name);
        });
        el.appendChild(close);
        el.addEventListener("click", () => {
          if (name !== activeName) switchActive(name);
        });
        el.addEventListener("contextmenu", (e) => openFileMenu(e, name));
        return el;
      })
    );
  }

  function buildTree(files, dirs) {
    const root = { type: "dir", path: "", name: "", children: [] };
    const byPath = new Map([["", root]]);
    // Insert all dirs first, shallow → deep, so parents exist when we attach
    // their children. This also guarantees empty folders appear in the tree.
    const sortedDirs = [...dirs].sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)
    );
    for (const d of sortedDirs) {
      const parts = d.split("/");
      const name = parts.pop();
      const parentPath = parts.join("/");
      const parent = byPath.get(parentPath) || root;
      const node = { type: "dir", path: d, name, children: [] };
      byPath.set(d, node);
      parent.children.push(node);
    }
    for (const f of files) {
      const parts = f.split("/");
      const name = parts.pop();
      const parentPath = parts.join("/");
      const parent = byPath.get(parentPath) || root;
      parent.children.push({ type: "file", path: f, name });
    }
    // Folders before files, alphabetical within each.
    (function sortRec(node) {
      if (node.type !== "dir") return;
      node.children.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortRec);
    })(root);
    return root;
  }

  function makeRow({ arrow, label, fullPath }) {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.title = fullPath;
    const arrowEl = document.createElement("span");
    arrowEl.className = "arrow";
    if (arrow) arrowEl.textContent = arrow;
    row.appendChild(arrowEl);
    const mark = document.createElement("span");
    mark.className = "target-mark";
    mark.textContent = "•";
    row.appendChild(mark);
    const labelEl = document.createElement("span");
    labelEl.className = "label";
    labelEl.textContent = label;
    row.appendChild(labelEl);
    return row;
  }

  function renderFileNode(node) {
    const li = document.createElement("li");
    li.className = "tree-file";
    li.dataset.path = node.path;
    if (node.path === activeName) li.classList.add("active");
    if (node.path === renderTargetName) li.classList.add("target");
    const row = makeRow({ arrow: "", label: node.name, fullPath: node.path });
    row.addEventListener("click", () => {
      ensureTab(node.path);
      if (node.path !== activeName) switchActive(node.path);
      else renderTabs();
    });
    row.addEventListener("contextmenu", (e) => openFileMenu(e, node.path));
    makeDraggable(row, node.path, false);
    li.appendChild(row);
    return li;
  }

  function renderFolderNode(node) {
    const li = document.createElement("li");
    li.className = "tree-folder";
    li.dataset.path = node.path;
    if (expandedFolders.has(node.path)) li.classList.add("open");
    const row = makeRow({ arrow: "▸", label: node.name, fullPath: node.path });
    row.addEventListener("click", () => {
      if (expandedFolders.has(node.path)) {
        expandedFolders.delete(node.path);
        li.classList.remove("open");
      } else {
        expandedFolders.add(node.path);
        li.classList.add("open");
      }
      saveExpanded();
    });
    row.addEventListener("contextmenu", (e) => openFolderMenu(e, node.path));
    makeDraggable(row, node.path, true);
    li.appendChild(row);
    const ul = document.createElement("ul");
    for (const child of node.children) {
      ul.appendChild(child.type === "dir" ? renderFolderNode(child) : renderFileNode(child));
    }
    li.appendChild(ul);
    makeFolderDropTarget(li, row, node.path);
    return li;
  }

  function renderFileList() {
    const tree = buildTree(allDocs, allDirs);
    fileListEl.replaceChildren(
      ...tree.children.map((c) =>
        c.type === "dir" ? renderFolderNode(c) : renderFileNode(c)
      )
    );
  }

  // src→dest rename came in over the WS. Remap any local state that's keyed
  // on the old path so a renamed tab doesn't flash through a "missing" state
  // (which would otherwise happen because the next doc_list will only contain
  // the new path).
  function applyRename(msg) {
    const { src, dest, is_dir: isDir } = msg;
    const remap = (name) => {
      if (name === src) return dest;
      if (isDir && name.startsWith(src + "/")) return dest + name.slice(src.length);
      return name;
    };
    openTabs = [...new Set(openTabs.map(remap))];
    lsSet("openTabs", openTabs);
    expandedFolders = new Set([...expandedFolders].map(remap));
    saveExpanded();
    activeName = remap(activeName);
    renderTargetName = remap(renderTargetName);
  }

  function applyDocList(msg) {
    allDocs = msg.names || [];
    allDirs = msg.dirs || [];
    const newActive = msg.active || activeName;
    if (newActive && newActive !== activeName) {
      ensureAncestorsExpanded(newActive);
    }
    activeName = newActive;
    renderTargetName = msg.render_target || renderTargetName;
    // Drop tabs whose files no longer exist
    openTabs = openTabs.filter((n) => allDocs.includes(n));
    if (activeName) ensureTab(activeName);
    lsSet("openTabs", openTabs);
    renderTabs();
    renderFileList();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(sendSave, 350);
  }

  function sendSave() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "save", content: editor.getValue() }));
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${proto}//${location.host}/ws`);
    socket.addEventListener("open", () => setStatus("idle", "connected"));
    socket.addEventListener("close", () => {
      setStatus("error", "disconnected");
      setTimeout(connect, 1000);
    });
    socket.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "doc" && typeof msg.path === "string" && msg.path.endsWith(".bib")) {
        refreshBibKeys();
      } else if (msg.type === "doc_list") {
        refreshBibKeys();
      }
      if (msg.type === "doc_list") {
        applyDocList(msg);
      } else if (msg.type === "rename") {
        applyRename(msg);
      } else if (msg.type === "doc") {
        applyDoc(msg);
      } else if (msg.type === "render_started") {
        setStatus("building", "rendering…");
        renderBtn.classList.add("spinning");
      } else if (msg.type === "rendered") {
        setStatus("ok", "rendered");
        setError(null);
        renderPdf(msg.url);
        unrendered = false;
        renderBtn.classList.remove("spinning");
        clearErrorMarkers();
      } else if (msg.type === "rendered_md") {
        setStatus("ok", "rendered");
        setError(null);
        renderMarkdown(msg.content);
        unrendered = false;
        renderBtn.classList.remove("spinning");
        clearErrorMarkers();
      } else if (msg.type === "render_failed") {
        setStatus("error", "build error");
        setError(msg.log || "tectonic failed");
        renderBtn.classList.remove("spinning");
        applyErrorMarkers(msg.errors || []);
      } else if (msg.type === "stream_begin") {
        streamBegin(msg.from_index, msg.to_index);
      } else if (msg.type === "stream_char") {
        streamChar(msg.ch);
      } else if (msg.type === "stream_end") {
        streamEnd();
      } else if (msg.type === "agent_edit_range") {
        markAgentEdit(msg.from_index, msg.to_index);
      } else if (msg.type === "comments") {
        applyComments(msg.comments || []);
      } else if (msg.type === "save_now") {
        // Server is about to do an agent-facing read; flush our debounce
        // timer immediately so any in-flight keystrokes hit disk first.
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "save", content: editor.getValue() }));
          socket.send(JSON.stringify({ type: "save_now_ack" }));
        }
      }
    });
  }

  const divider = $("divider");
  let dragging = false;
  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  const EDITOR_MIN = 220;
  const PREVIEW_MIN = 320;
  const DIVIDER_PX = 5;
  let dragRaf = 0;
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const split = document.querySelector(".split");
    const editorPane = document.querySelector(".editor-pane");
    const previewPane = document.querySelector(".preview-pane");
    const rect = split.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const maxLeft = Math.max(EDITOR_MIN, rect.width - PREVIEW_MIN - DIVIDER_PX);
    const leftPx = Math.max(EDITOR_MIN, Math.min(maxLeft, cursorX));
    editorPane.style.flex = `0 0 ${leftPx}px`;
    previewPane.style.flex = `1 1 0`;
    if (!dragRaf) {
      dragRaf = requestAnimationFrame(() => {
        dragRaf = 0;
        editor.refresh();
      });
    }
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    editor.refresh();
  });

  let zoomTimer = null;
  previewEl.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!previewEl.classList.contains("pdf")) return;
    e.preventDefault();
    // Trackpad pinches and mouse wheels both arrive here. Scale per tick so
    // pinch motion (many small deltas) feels continuous.
    const intensity = Math.min(0.25, Math.abs(e.deltaY) / 200);
    const factor = e.deltaY < 0 ? 1 + intensity : 1 / (1 + intensity);
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomFactor * factor));
    if (newZoom === zoomFactor) return;

    const rect = previewEl.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    const sw = previewEl.scrollWidth;
    const sh = previewEl.scrollHeight;
    const docX = previewEl.scrollLeft + cursorX;
    const docY = previewEl.scrollTop + cursorY;
    const xRatio = sw > 0 ? docX / sw : 0;
    const yRatio = sh > 0 ? docY / sh : 0;

    visualScale *= newZoom / zoomFactor;
    zoomFactor = newZoom;
    applyVisualScale();

    // Re-anchor both axes so the cursor stays over the same content.
    const newSw = previewEl.scrollWidth;
    const newSh = previewEl.scrollHeight;
    const tgtLeft = xRatio * newSw - cursorX;
    const tgtTop = yRatio * newSh - cursorY;
    const maxX = Math.max(0, newSw - previewEl.clientWidth);
    const maxY = Math.max(0, newSh - previewEl.clientHeight);
    previewEl.scrollLeft = Math.max(0, Math.min(tgtLeft, maxX));
    previewEl.scrollTop = Math.max(0, Math.min(tgtTop, maxY));

    if (zoomTimer) clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      if (!currentPdfUrl) return;
      const sh2 = previewEl.scrollHeight;
      const anchor = { ratio: sh2 > 0 ? previewEl.scrollTop / sh2 : 0, offset: 0 };
      renderPdf(currentPdfUrl, anchor);
    }, 140);
  }, { passive: false });

  // Refit-on-resize: when the preview pane changes size (window/divider),
  // re-render so the canvas tracks fit-to-pane * zoomFactor. During the
  // debounce window we apply visualScale so the canvas tracks the new pane
  // width immediately — avoids a transient empty gap or overflow.
  let paneResizeTimer = 0;
  let paneResizeRaf = 0;
  const paneResizeObserver = new ResizeObserver(() => {
    if (paneResizeRaf) return;
    paneResizeRaf = requestAnimationFrame(() => {
      paneResizeRaf = 0;
      if (!currentPdfUrl) return;
      const w = previewEl.clientWidth;
      if (w === lastPaneWidth || w <= 0) return;
      lastPaneWidth = w;
      const firstCanvas = previewEl.querySelector(".pdf-page");
      if (firstCanvas) {
        const baseW = parseFloat(firstCanvas.dataset.baseW);
        if (baseW > 0) {
          visualScale = ((w - PDF_PAGE_PAD) * zoomFactor) / baseW;
          applyVisualScale();
        }
      }
      if (paneResizeTimer) clearTimeout(paneResizeTimer);
      paneResizeTimer = setTimeout(() => {
        if (!currentPdfUrl) return;
        renderPdf(currentPdfUrl);
      }, 180);
    });
  });
  paneResizeObserver.observe(previewEl);

  // ---------- comments ----------
  // Server-authored comments (currently agent-only). Each comment is anchored
  // to a range, a line, or the whole doc, and surfaces in two places: the
  // editor gutter (a yellow dot on the line) and the right-side sidebar.
  let allComments = [];

  function openCommentInSidebar(id) {
    commentsPanel.hidden = false;
    renderCommentsPanel();
    requestAnimationFrame(() => {
      const row = commentsListEl.querySelector(
        `.comment-row[data-comment-id="${CSS.escape(id)}"]`,
      );
      if (!row) return;
      const msg = row.querySelector(".comment-msg");
      const more = row.querySelector(".comment-show-more");
      if (msg && msg.classList.contains("clamped")) {
        msg.classList.remove("clamped");
        if (more) more.textContent = "Show less";
      }
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("comment-row-flash");
      setTimeout(() => row.classList.remove("comment-row-flash"), 900);
    });
  }

  function applyCommentMarkers() {
    // Comments share the gutter with tectonic errors. Delegate to
    // applyLineMarks so each line gets ONE marker reflecting the union of
    // both annotation types — single dot, overlapping pair, or hollow ring.
    applyLineMarks();
  }

  function flashCommentRange(c) {
    if (c.kind === "range" &&
        typeof c.from_line === "number" && typeof c.to_line === "number") {
      const from = { line: c.from_line - 1, ch: c.from_ch || 0 };
      const to = { line: c.to_line - 1, ch: c.to_ch || 0 };
      const mark = editor.markText(from, to, { className: "synctex-flash" });
      editor.setCursor(from);
      editor.scrollIntoView(from, 80);
      setTimeout(() => mark.clear(), 1100);
    } else if (c.kind === "line" && typeof c.line === "number") {
      const pos = { line: c.line - 1, ch: 0 };
      editor.setCursor(pos);
      editor.scrollIntoView(pos, 80);
      const handle = editor.getLineHandle(c.line - 1);
      if (handle) {
        editor.addLineClass(handle, "background", "synctex-flash");
        setTimeout(
          () => editor.removeLineClass(handle, "background", "synctex-flash"),
          1100,
        );
      }
    }
    editor.focus();
  }

  function commentAnchorPreview(c) {
    if (c.orphaned) return "(orphaned)";
    if (c.kind === "range") {
      const s = c.excerpt || "";
      return s.length > 70 ? s.slice(0, 67) + "…" : s;
    }
    if (c.kind === "line") {
      const t = (c.line_text || "").trim();
      const head = t.length > 70 ? t.slice(0, 67) + "…" : t;
      return `line ${c.line}${head ? ` · ${head}` : ""}`;
    }
    return "(doc-level)";
  }

  async function resolveCommentRequest(id, resolved) {
    try {
      await fetch(`/api/comments/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved }),
      });
    } catch (e) {
      console.warn("resolve comment failed", e);
    }
  }
  async function deleteCommentRequest(id) {
    try {
      await fetch(`/api/comments/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) {
      console.warn("delete comment failed", e);
    }
  }

  async function postReply(parentId, message) {
    if (!message.trim()) return;
    try {
      await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          parent_id: parentId,
          author: "user",
        }),
      });
    } catch (e) {
      console.warn("reply failed", e);
    }
  }

  function buildCommentRow(c, depth) {
    const row = document.createElement("div");
    row.className = "comment-row" + (c.resolved ? " resolved" : "") +
      (c.orphaned ? " orphaned" : "") +
      (depth > 0 ? " comment-reply" : "");
    row.dataset.commentId = c.id;
    if (depth > 0) row.style.marginLeft = depth * 14 + "px";

    const head = document.createElement("div");
    head.className = "comment-row-head";
    if (depth === 0) {
      const anchor = document.createElement("button");
      anchor.className = "comment-anchor";
      anchor.type = "button";
      anchor.textContent = commentAnchorPreview(c);
      anchor.addEventListener("click", () => flashCommentRange(c));
      head.appendChild(anchor);
    } else {
      const tag = document.createElement("span");
      tag.className = "comment-reply-tag";
      tag.textContent = "↪ reply";
      head.appendChild(tag);
    }
    const actions = document.createElement("div");
    actions.className = "comment-actions";
    if (depth === 0) {
      const resolveBtn = document.createElement("button");
      resolveBtn.className = "comment-action-btn";
      resolveBtn.type = "button";
      resolveBtn.textContent = c.resolved ? "Re-open" : "Resolve";
      resolveBtn.addEventListener("click", () =>
        resolveCommentRequest(c.id, !c.resolved),
      );
      actions.appendChild(resolveBtn);
    }
    // Surface "Ask Claude" on any user-authored comment when the direct-API
    // path is enabled — it's the way to get a synchronous agent reply
    // without going through your Claude Code chat.
    if (apiResponseEnabled && c.author === "user") {
      const askBtn = document.createElement("button");
      askBtn.className = "comment-action-btn ask-claude";
      askBtn.type = "button";
      askBtn.textContent = "Ask Claude";
      askBtn.addEventListener("click", () => requestApiResponse(c.id));
      actions.appendChild(askBtn);
    }
    const replyBtn = document.createElement("button");
    replyBtn.className = "comment-action-btn";
    replyBtn.type = "button";
    replyBtn.textContent = "Reply";
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "comment-action-btn delete";
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteCommentRequest(c.id));
    actions.appendChild(replyBtn);
    actions.appendChild(deleteBtn);
    head.appendChild(actions);
    row.appendChild(head);

    const msg = document.createElement("div");
    msg.className = "comment-msg clamped";
    msg.textContent = c.message;
    row.appendChild(msg);
    const more = document.createElement("button");
    more.type = "button";
    more.className = "comment-show-more";
    more.textContent = "Show more";
    more.hidden = true;
    more.addEventListener("click", () => {
      const expanded = msg.classList.toggle("clamped") === false;
      more.textContent = expanded ? "Show less" : "Show more";
    });
    row.appendChild(more);
    requestAnimationFrame(() => {
      if (msg.scrollHeight > msg.clientHeight + 1) more.hidden = false;
    });
    const meta = document.createElement("div");
    meta.className = "comment-meta";
    const tsStr = c.ts ? new Date(c.ts).toLocaleString() : "";
    meta.textContent = [c.author || "agent", tsStr].filter(Boolean).join(" · ");
    row.appendChild(meta);

    // Reply input — hidden until the reply button is clicked.
    const replyForm = document.createElement("form");
    replyForm.className = "comment-reply-form";
    replyForm.hidden = true;
    const replyInput = document.createElement("textarea");
    replyInput.className = "comment-reply-input";
    replyInput.placeholder = "Write a reply…";
    replyInput.rows = 2;
    const replySubmit = document.createElement("button");
    replySubmit.className = "comment-action-btn";
    replySubmit.type = "submit";
    replySubmit.textContent = "Post";
    const replyCancel = document.createElement("button");
    replyCancel.className = "comment-action-btn";
    replyCancel.type = "button";
    replyCancel.textContent = "Cancel";
    replyCancel.addEventListener("click", () => {
      replyForm.hidden = true;
      replyInput.value = "";
    });
    const replyActions = document.createElement("div");
    replyActions.className = "comment-reply-actions";
    replyActions.appendChild(replySubmit);
    replyActions.appendChild(replyCancel);
    replyForm.appendChild(replyInput);
    replyForm.appendChild(replyActions);
    replyForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = replyInput.value;
      replyInput.value = "";
      replyForm.hidden = true;
      postReply(c.id, text);
    });
    replyBtn.addEventListener("click", () => {
      const showing = !replyForm.hidden;
      replyForm.hidden = showing;
      if (!showing) {
        requestAnimationFrame(() => replyInput.focus());
      }
    });
    row.appendChild(replyForm);
    return row;
  }

  function renderCommentsPanel() {
    const showResolved = commentsShowResolved.checked;
    const docComments = allComments.filter((c) => c.doc === editorActiveDoc);
    // Build a parent -> [replies] map. Top-level = comments without parent_id.
    const byParent = new Map();
    const tops = [];
    for (const c of docComments) {
      if (c.parent_id) {
        if (!byParent.has(c.parent_id)) byParent.set(c.parent_id, []);
        byParent.get(c.parent_id).push(c);
      } else {
        tops.push(c);
      }
    }
    // Sort top-level by resolved-then-line.
    tops.sort((a, b) => {
      const ar = a.resolved ? 1 : 0;
      const br = b.resolved ? 1 : 0;
      if (ar !== br) return ar - br;
      const al = a.kind === "range" ? a.from_line : (a.kind === "line" ? a.line : 0);
      const bl = b.kind === "range" ? b.from_line : (b.kind === "line" ? b.line : 0);
      return al - bl;
    });
    // Sort replies within each thread by timestamp ascending.
    for (const replies of byParent.values()) {
      replies.sort((a, b) => Date.parse(a.ts || "") - Date.parse(b.ts || ""));
    }
    commentsListEl.replaceChildren();
    let rendered = 0;
    function emit(c, depth) {
      if (!showResolved && c.resolved && depth === 0) return;
      commentsListEl.appendChild(buildCommentRow(c, depth));
      rendered++;
      const kids = byParent.get(c.id) || [];
      for (const k of kids) emit(k, depth + 1);
    }
    for (const t of tops) emit(t, 0);
    commentsEmptyEl.hidden = rendered > 0;
  }

  function updateCommentsBadge() {
    const n = allComments.filter(
      (c) => c.doc === editorActiveDoc && !c.resolved,
    ).length;
    if (n > 0) {
      commentsBadge.textContent = String(n);
      commentsBadge.hidden = false;
    } else {
      commentsBadge.hidden = true;
    }
  }

  function applyComments(comments) {
    allComments = Array.isArray(comments) ? comments : [];
    applyCommentMarkers();
    renderCommentsPanel();
    updateCommentsBadge();
  }

  // ---------- direct-API response (uses ANTHROPIC_API_KEY on the server) ----------
  let apiResponseEnabled = false;
  fetch("/api/config")
    .then((r) => (r.ok ? r.json() : {}))
    .then((cfg) => {
      apiResponseEnabled = !!cfg.api_response_enabled;
    })
    .catch(() => {});

  async function requestApiResponse(commentId) {
    try {
      const r = await fetch(
        `/api/comments/${encodeURIComponent(commentId)}/respond`,
        { method: "POST" },
      );
      if (!r.ok) {
        const err = await r.text();
        if (r.status === 503) {
          alert("ANTHROPIC_API_KEY isn't set on the server. Either configure it and restart, or ask Claude Code to respond to the pending comment manually.");
        } else {
          alert(`API reply failed (${r.status}): ${err.slice(0, 200)}`);
        }
      }
    } catch (e) {
      alert(`API reply failed: ${e}`);
    }
  }

  // ---------- Cmd+K inline prompt ----------
  // Highlight text in the editor, hit Cmd+K (or Ctrl+K) to drop a user
  // comment anchored to the selection. The popup floats over the editor
  // near the selection. Comment is created with author=user.
  let cmdkPromptEl = null;
  function closeCmdkPrompt() {
    if (cmdkPromptEl) {
      cmdkPromptEl.remove();
      cmdkPromptEl = null;
    }
  }
  async function postUserComment(excerpt, message) {
    if (!message.trim()) return null;
    try {
      const r = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          excerpt,
          message: message.trim(),
          author: "user",
        }),
      });
      if (!r.ok) {
        const err = await r.text();
        alert(`Comment failed: ${err.slice(0, 200)}`);
        return null;
      }
      const data = await r.json();
      return data?.comment?.id || null;
    } catch (e) {
      console.warn("user comment failed", e);
      return null;
    }
  }

  function openCmdkPrompt() {
    if (cmdkPromptEl) return;
    const sel = editor.getSelection();
    if (!sel || !sel.trim()) return;
    // Position the popup near the cursor head.
    const headPos = editor.getCursor("head");
    const coords = editor.charCoords(headPos, "window");
    const box = document.createElement("div");
    box.className = "cmdk-prompt";
    const snippet = document.createElement("div");
    snippet.className = "cmdk-prompt-snippet";
    snippet.textContent = sel.length > 240 ? sel.slice(0, 237) + "…" : sel;
    box.appendChild(snippet);
    const input = document.createElement("textarea");
    input.className = "cmdk-prompt-input";
    input.placeholder = "Ask, suggest, or note — leaves a comment anchored to the selection.";
    box.appendChild(input);
    const actions = document.createElement("div");
    actions.className = "cmdk-prompt-actions";
    const hint = document.createElement("span");
    hint.className = "cmdk-prompt-hint";
    hint.textContent = "↩ to send · esc to cancel";
    actions.appendChild(hint);
    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "6px";
    const cancel = document.createElement("button");
    cancel.className = "comment-action-btn";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => closeCmdkPrompt());
    const send = document.createElement("button");
    send.className = "comment-action-btn";
    send.type = "button";
    send.textContent = "Comment";
    send.addEventListener("click", () => {
      const message = input.value;
      closeCmdkPrompt();
      postUserComment(sel, message);
    });
    right.appendChild(cancel);
    right.appendChild(send);
    if (apiResponseEnabled) {
      const sendAndAsk = document.createElement("button");
      sendAndAsk.className = "comment-action-btn cmdk-ask";
      sendAndAsk.type = "button";
      sendAndAsk.textContent = "Comment + ask Claude";
      sendAndAsk.addEventListener("click", async () => {
        const message = input.value;
        closeCmdkPrompt();
        const id = await postUserComment(sel, message);
        if (id) await requestApiResponse(id);
      });
      right.appendChild(sendAndAsk);
    }
    actions.appendChild(right);
    box.appendChild(actions);
    document.body.appendChild(box);
    cmdkPromptEl = box;
    // Place below the cursor; if it'd overflow, place above.
    const top = coords.bottom + 6;
    const left = Math.min(coords.left, window.innerWidth - 380);
    box.style.left = Math.max(8, left) + "px";
    box.style.top = top + "px";
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeCmdkPrompt();
      } else if (e.key === "Enter" && !e.shiftKey) {
        // Plain Enter posts the comment.
        // Cmd/Ctrl+Enter additionally asks Claude (if API enabled).
        e.preventDefault();
        const message = input.value;
        const wantApi = (e.metaKey || e.ctrlKey) && apiResponseEnabled;
        closeCmdkPrompt();
        const id = await postUserComment(sel, message);
        if (wantApi && id) await requestApiResponse(id);
      }
    });
    requestAnimationFrame(() => input.focus());
  }

  editor.setOption("extraKeys", {
    ...(editor.getOption("extraKeys") || {}),
    "Cmd-K": () => openCmdkPrompt(),
    "Ctrl-K": () => openCmdkPrompt(),
  });

  commentsBtn.addEventListener("click", () => {
    commentsPanel.hidden = !commentsPanel.hidden;
    if (!commentsPanel.hidden) renderCommentsPanel();
  });
  commentsCloseBtn.addEventListener("click", () => {
    commentsPanel.hidden = true;
  });
  commentsShowResolved.addEventListener("change", renderCommentsPanel);

  // ---------- agent edit highlights ----------
  // After each agent edit, tint the touched span so the user can scan
  // "where did Claude just write?". Cap at the last N and time them out so
  // the highlights don't accumulate into noise.
  const AGENT_EDIT_LIMIT = 5;
  const AGENT_EDIT_TTL_MS = 15000;
  const agentEdits = [];

  function clearAgentEdit(entry) {
    const i = agentEdits.indexOf(entry);
    if (i >= 0) agentEdits.splice(i, 1);
    if (entry.mark) entry.mark.clear();
    if (entry.timer) clearTimeout(entry.timer);
  }
  function markAgentEdit(fromIdx, toIdx) {
    if (typeof fromIdx !== "number" || typeof toIdx !== "number") return;
    if (toIdx <= fromIdx) return;
    const a = editor.posFromIndex(fromIdx);
    const b = editor.posFromIndex(toIdx);
    const mark = editor.markText(a, b, {
      className: "cm-agent-edit",
      inclusiveLeft: false,
      inclusiveRight: false,
    });
    const entry = { mark, timer: null };
    agentEdits.push(entry);
    while (agentEdits.length > AGENT_EDIT_LIMIT) clearAgentEdit(agentEdits[0]);
    entry.timer = setTimeout(() => clearAgentEdit(entry), AGENT_EDIT_TTL_MS);
  }

  // ---------- line marks (unified errors + comments gutter) ----------
  // One gutter column, one marker per annotated line. The marker's visual
  // is determined by the COMBINED set of errors + open comments on that
  // line: single filled dot for one annotation (red for error, yellow for
  // comment), two overlapping filled dots for two (each in its own color),
  // hollow ring for three or more (red if any error involved, else yellow).
  let currentErrorsData = [];
  let currentErrorLines = [];
  let linePopupHideTimer = null;

  function hideLinePopup() {
    linePopupEl.hidden = true;
  }

  function showLinePopup(target, info) {
    clearTimeout(linePopupHideTimer);
    linePopupEl.replaceChildren();
    for (const err of info.errors) {
      const block = document.createElement("div");
      block.className = "line-popup-block line-popup-error";
      const msg = document.createElement("div");
      msg.className = "error-popup-msg";
      msg.textContent = err.message || "LaTeX error";
      block.appendChild(msg);
      if (err.snippet) {
        const code = document.createElement("pre");
        code.className = "error-popup-snippet";
        code.textContent = err.snippet;
        block.appendChild(code);
      }
      linePopupEl.appendChild(block);
    }
    for (const c of info.comments) {
      const block = document.createElement("div");
      block.className = "line-popup-block line-popup-comment";
      const msg = document.createElement("div");
      msg.className = "comment-popup-msg clamped";
      msg.textContent = c.message;
      block.appendChild(msg);
      const more = document.createElement("button");
      more.type = "button";
      more.className = "comment-popup-more";
      more.textContent = "Show more in sidebar →";
      more.hidden = true;
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        hideLinePopup();
        openCommentInSidebar(c.id);
      });
      block.appendChild(more);
      if (c.author) {
        const meta = document.createElement("div");
        meta.className = "comment-popup-meta";
        meta.textContent = `— ${c.author}`;
        block.appendChild(meta);
      }
      linePopupEl.appendChild(block);
      requestAnimationFrame(() => {
        if (msg.scrollHeight > msg.clientHeight + 1) more.hidden = false;
      });
    }
    linePopupEl.hidden = false;
    const rect = target.getBoundingClientRect();
    linePopupEl.style.left = rect.right + 8 + "px";
    linePopupEl.style.top = rect.top + "px";
  }

  linePopupEl.addEventListener("mouseenter", () => {
    clearTimeout(linePopupHideTimer);
  });
  linePopupEl.addEventListener("mouseleave", () => {
    linePopupHideTimer = setTimeout(hideLinePopup, 120);
  });

  // Compose a per-line marker from the (errors, comments) tuple. See the
  // section header above for the shape rules.
  function appendSolo(root, classes) {
    const dot = document.createElement("span");
    dot.className = "mark-dot " + classes;
    root.appendChild(dot);
  }
  function appendPair(root, leftClasses, rightClasses) {
    const left = document.createElement("span");
    left.className = "mark-dot pos-left " + leftClasses;
    const right = document.createElement("span");
    right.className = "mark-dot pos-right " + rightClasses;
    root.appendChild(left);
    root.appendChild(right);
  }
  function appendOnePositioned(root, typeClass, posClass) {
    const dot = document.createElement("span");
    dot.className = "mark-dot " + posClass + " " + typeClass;
    root.appendChild(dot);
  }
  function shapeFor(n) {
    // When both types are present, each type's circle is either a filled
    // dot (count=1) or a hollow ring (count>=2). The standalone "two
    // overlapping filled" representation is reserved for the single-type
    // case so it doesn't fight for room with the other type's circle.
    return n === 1 ? "" : "ring ";
  }

  function makeLineMarker(info) {
    const root = document.createElement("div");
    root.className = "agentex-mark";
    const e = info.errors.length;
    const c = info.comments.length;

    if (e === 0) {
      if (c === 1) appendSolo(root, "is-comment");
      else if (c === 2) appendPair(root, "is-comment", "is-comment");
      else appendSolo(root, "ring is-comment");
    } else if (c === 0) {
      if (e === 1) appendSolo(root, "is-error");
      else if (e === 2) appendPair(root, "is-error", "is-error");
      else appendSolo(root, "ring is-error");
    } else if (e === 1 && c === 1) {
      // Visually identical to the 2c case (same geometry, same z-stacking
      // structure): pos-left appended first, pos-right appended second so
      // the right circle paints on top. The only thing that differs from
      // 2c is the color of the LEFT circle (red vs yellow).
      appendOnePositioned(root, "is-error", "pos-left");
      appendOnePositioned(root, "is-comment", "pos-right");
    } else if (e === 1 && c >= 2) {
      // Multiple yellows + one red would crowd the gutter. Collapse to a
      // single circle: red fill, yellow border. Covers BOTH the 1e+2c
      // and 1e+3+c cases.
      appendSolo(root, "combined fill-is-error border-is-comment");
    } else if (e >= 2 && c === 1) {
      // Mirror collapse: yellow fill, red border.
      appendSolo(root, "combined fill-is-comment border-is-error");
    } else {
      appendPair(
        root,
        shapeFor(e) + "is-error",
        shapeFor(c) + "is-comment",
      );
    }
    root.addEventListener("mouseenter", () => showLinePopup(root, info));
    root.addEventListener("mouseleave", () => {
      linePopupHideTimer = setTimeout(hideLinePopup, 120);
    });
    root.addEventListener("click", () => {
      hideLinePopup();
      if (info.comments.length) {
        openCommentInSidebar(info.comments[0].id);
      }
    });
    return root;
  }

  function clearErrorTints() {
    for (const line of currentErrorLines) {
      const handle = editor.getLineHandle(line - 1);
      if (handle) editor.removeLineClass(handle, "background", "cm-error-bg");
    }
    currentErrorLines = [];
  }

  function applyLineMarks() {
    editor.clearGutter("agentex-marks");
    clearErrorTints();
    if (!editorActiveDoc && !currentErrorsData.length) return;
    const byLine = new Map();
    for (const e of currentErrorsData) {
      if (typeof e.line !== "number") continue;
      if (!byLine.has(e.line)) byLine.set(e.line, { errors: [], comments: [] });
      byLine.get(e.line).errors.push(e);
    }
    for (const c of allComments) {
      if (c.doc !== editorActiveDoc) continue;
      if (c.resolved) continue;
      if (c.kind === "doc") continue;
      if (c.kind === "reply") continue; // replies live nested under parents
      const line = c.kind === "range" ? c.from_line : c.line;
      if (typeof line !== "number") continue;
      if (!byLine.has(line)) byLine.set(line, { errors: [], comments: [] });
      byLine.get(line).comments.push(c);
    }
    for (const [line, info] of byLine) {
      const handle = editor.getLineHandle(line - 1);
      if (!handle) continue;
      if (info.errors.length) {
        editor.addLineClass(handle, "background", "cm-error-bg");
        currentErrorLines.push(line);
      }
      editor.setGutterMarker(line - 1, "agentex-marks", makeLineMarker(info));
    }
  }

  function applyErrorMarkers(errors) {
    currentErrorsData = Array.isArray(errors) ? errors : [];
    applyLineMarks();
  }
  function clearErrorMarkers() {
    currentErrorsData = [];
    applyLineMarks();
    hideLinePopup();
  }

  // ---------- SyncTeX bidirectional navigation ----------
  // When inverse search lands on a different file, we have to switch active
  // first, then jump after the new doc's content actually arrives over the WS.
  // pendingJump holds that intent across applyDoc.
  let pendingJump = null; // { file: <rel-path>, line: <1-indexed> }

  function flashEditorLine(line0) {
    const handle = editor.getLineHandle(line0);
    if (!handle) return;
    editor.addLineClass(handle, "background", "synctex-flash");
    setTimeout(
      () => editor.removeLineClass(handle, "background", "synctex-flash"),
      1100
    );
  }

  function doJumpEditor(line) {
    const pos = { line: Math.max(0, line - 1), ch: 0 };
    editor.setCursor(pos);
    editor.scrollIntoView(pos, 80);
    flashEditorLine(pos.line);
    editor.focus();
  }

  async function jumpEditorToLine(line, fileRel) {
    if (!fileRel || fileRel === activeName) {
      doJumpEditor(line);
      return;
    }
    // Different file — queue the jump for after the WS doc message lands.
    pendingJump = { file: fileRel, line };
    switchActive(fileRel);
  }

  async function onPdfClick(canvas, evt) {
    const pageNum = parseInt(canvas.dataset.pageNum || "0", 10);
    const naturalW = parseFloat(canvas.dataset.naturalW);
    const naturalH = parseFloat(canvas.dataset.naturalH);
    if (!pageNum || !naturalW || !naturalH) return;
    const rect = canvas.getBoundingClientRect();
    const cssX = evt.clientX - rect.left;
    const cssY = evt.clientY - rect.top;
    const pdfX = (cssX / rect.width) * naturalW;
    const pdfY = (cssY / rect.height) * naturalH;
    try {
      const r = await fetch(
        `/api/synctex/inverse?page=${pageNum}&x=${pdfX}&y=${pdfY}`
      );
      if (!r.ok) {
        const msg = await r.text();
        console.warn("synctex inverse:", r.status, msg);
        return;
      }
      const data = await r.json();
      if (typeof data.line === "number") await jumpEditorToLine(data.line, data.file);
    } catch (e) {
      console.warn("synctex inverse failed", e);
    }
  }

  function flashPdfMarker(canvas, xCss, yCss) {
    const canvasRect = canvas.getBoundingClientRect();
    const marker = document.createElement("div");
    marker.className = "synctex-pdf-marker";
    marker.style.left = canvasRect.left + xCss - 7 + "px";
    marker.style.top = canvasRect.top + yCss - 7 + "px";
    document.body.appendChild(marker);
    requestAnimationFrame(() => marker.classList.add("fade-out"));
    setTimeout(() => marker.remove(), 550);
  }

  async function forwardSearch(line) {
    try {
      const r = await fetch(`/api/synctex/forward?line=${line}`);
      if (!r.ok) return;
      const data = await r.json();
      const positions = data.positions || [];
      if (!positions.length) return;
      const { page, x: pdfX, y: pdfY } = positions[0];
      const canvas = previewEl.children[page - 1];
      if (!canvas) return;
      const naturalW = parseFloat(canvas.dataset.naturalW);
      const naturalH = parseFloat(canvas.dataset.naturalH);
      if (!naturalW || !naturalH) return;
      const rect = canvas.getBoundingClientRect();
      const xCss = (pdfX / naturalW) * rect.width;
      const yCss = (pdfY / naturalH) * rect.height;
      // Scroll the preview so the target row lands near the top of the pane.
      const previewRect = previewEl.getBoundingClientRect();
      const targetScrollTop =
        previewEl.scrollTop + (rect.top - previewRect.top + yCss) - 60;
      previewEl.scrollTop = Math.max(0, targetScrollTop);
      // Wait one frame for the scroll to settle, then flash a marker.
      requestAnimationFrame(() => {
        const r2 = canvas.getBoundingClientRect();
        const x2 = (pdfX / naturalW) * r2.width;
        const y2 = (pdfY / naturalH) * r2.height;
        flashPdfMarker(canvas, x2, y2);
      });
    } catch (e) {
      console.warn("synctex forward failed", e);
    }
  }

  // Cmd/Ctrl-click in the editor → forward search. Standard TeXShop binding.
  editor.on("mousedown", (cm, e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    // Skip when the click is on the gutter (line-number column).
    const target = e.target;
    if (target && target.classList && target.classList.contains("CodeMirror-linenumber")) {
      return;
    }
    e.preventDefault();
    const pos = cm.coordsChar({ left: e.clientX, top: e.clientY }, "page");
    if (!pos) return;
    forwardSearch(pos.line + 1);
  });

  function requestRender() {
    if (!unrendered) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      sendSave();
    }
    socket.send(JSON.stringify({ type: "render" }));
  }

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      // Don't fire Cmd+S → render when a dialog is open; the user almost
      // certainly isn't asking to render the editor underneath.
      if (modalIsOpen()) return;
      requestRender();
    }
  });

  renderBtn.addEventListener("click", () => {
    requestRender();
    editor.focus();
  });

  downloadBtn.addEventListener("click", () => {
    if (!currentPdfUrl) return;
    // Build a sensible filename from the render target's basename. Browsers
    // strip slashes from the download attribute, so just use the leaf name
    // with the suffix swapped to .pdf.
    const base = (renderTargetName || "document").split("/").pop();
    const dot = base.lastIndexOf(".");
    const filename = (dot >= 0 ? base.slice(0, dot) : base) + ".pdf";
    const a = document.createElement("a");
    a.href = currentPdfUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  sidebarToggle.addEventListener("click", () => {
    sidebarEl.classList.toggle("collapsed");
    lsSet("sidebarExpanded", !sidebarEl.classList.contains("collapsed"));
    setTimeout(() => editor.refresh(), 0);
  });

  newDocBtn.addEventListener("click", () => createDocAt(""));
  newFolderBtn.addEventListener("click", () => createFolderAt(""));

  connect();
  window.addEventListener("resize", () => editor.refresh());
})();
