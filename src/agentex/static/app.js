(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const statusLabel = statusEl.querySelector(".label");
  const previewEl = $("preview");
  const pdfGutterEl = $("pdf-gutter");
  const zoomOutBtn = $("zoom-out-btn");
  const zoomInBtn = $("zoom-in-btn");
  const zoomPctBtn = $("zoom-pct-btn");
  const zoomFitBtn = $("zoom-fit-btn");
  const zoomActualBtn = $("zoom-actual-btn");
  const pdfPageIndicator = $("pdf-page-indicator");
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
  const filterRenderableEl = $("filter-renderable");

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
  let allAssets = [];
  let expandedFolders = new Set(lsGet("expandedFolders", []));
  // When true, hide everything except files agentex can preview to a PDF /
  // HTML pane (.tex, .md). Other text files (.py, .sh, .json, ...) are still
  // editable from the API; the toggle just declutters the tree.
  let renderableOnly = lsGet("renderableOnly", false);
  const RENDERABLE_SUFFIXES_JS = [".tex", ".md"];

  function saveExpanded() {
    lsSet("expandedFolders", Array.from(expandedFolders));
  }

  function updateFilterToggleUI() {
    if (!filterRenderableEl) return;
    filterRenderableEl.textContent = renderableOnly ? ".tex/.md" : "All";
    filterRenderableEl.setAttribute("aria-pressed", renderableOnly ? "true" : "false");
  }
  if (filterRenderableEl) {
    updateFilterToggleUI();
    filterRenderableEl.addEventListener("click", () => {
      renderableOnly = !renderableOnly;
      lsSet("renderableOnly", renderableOnly);
      updateFilterToggleUI();
      renderFileList();
    });
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

  // Git-style hunked diff: 3 lines of context on each side of every change,
  // long unchanged runs collapsed into a "… N unchanged lines …" placeholder.
  // Scales to 100-page docs because only the changed regions are rendered.
  const DIFF_CONTEXT_LINES = 3;

  function renderDiffHtml(beforeText, afterText) {
    if (!window.Diff) {
      return '<div class="diff-loading">Loading diff…</div>';
    }
    const parts = window.Diff.diffLines(beforeText || "", afterText || "");
    // Flatten chunks → per-line records so we can reason about distance-to-
    // nearest-change. Each record: {type: "added"|"removed"|"context", text}.
    const lines = [];
    for (const p of parts) {
      const type = p.added ? "added" : p.removed ? "removed" : "context";
      const raw = p.value.split("\n");
      // Drop the trailing empty produced by chunks that end in "\n".
      if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
      for (const text of raw) lines.push({ type, text });
    }

    if (lines.length === 0) {
      return '<div class="diff-block"><div class="diff-meta">No changes.</div></div>';
    }
    // If nothing changed at all, surface that explicitly instead of dumping
    // the whole doc as context.
    if (!lines.some((l) => l.type !== "context")) {
      return (
        '<div class="diff-block">' +
        `<div class="diff-line gap">` +
        `<span class="diff-sign"> </span>` +
        `<span class="diff-content">… ${lines.length} unchanged line${lines.length === 1 ? "" : "s"} (no changes) …</span>` +
        `</div></div>`
      );
    }

    // Mark which lines to show: anything within DIFF_CONTEXT_LINES of a
    // changed line. Walk twice (forward + backward) to splay the context
    // window symmetrically.
    const show = new Array(lines.length).fill(false);
    let dist = Infinity;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].type !== "context") dist = 0;
      else dist++;
      if (dist <= DIFF_CONTEXT_LINES) show[i] = true;
    }
    dist = Infinity;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].type !== "context") dist = 0;
      else dist++;
      if (dist <= DIFF_CONTEXT_LINES) show[i] = true;
    }

    // Emit. Runs of hidden lines collapse into one gap row carrying the
    // skipped count.
    let html = '<div class="diff-block">';
    let hidden = 0;
    const flushGap = () => {
      if (hidden > 0) {
        html +=
          `<div class="diff-line gap">` +
          `<span class="diff-sign"> </span>` +
          `<span class="diff-content">… ${hidden} unchanged line${hidden === 1 ? "" : "s"} …</span>` +
          `</div>`;
        hidden = 0;
      }
    };
    for (let i = 0; i < lines.length; i++) {
      if (!show[i]) {
        hidden++;
        continue;
      }
      flushGap();
      const l = lines[i];
      const sign = l.type === "added" ? "+" : l.type === "removed" ? "-" : " ";
      html +=
        `<div class="diff-line ${l.type}">` +
        `<span class="diff-sign">${sign}</span>` +
        `<span class="diff-content">${escapeHtml(l.text || " ")}</span>` +
        `</div>`;
    }
    flushGap();
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
        `<button class="modal-btn delete-entry-btn" type="button">Delete this snapshot</button>` +
        `<button class="modal-btn primary rewind-btn" type="button">Rewind to this point</button>` +
        `</div>`;
      detail
        .querySelector(".rewind-btn")
        .addEventListener("click", () => doRewind(entry.doc, entry.hash));
      detail
        .querySelector(".delete-entry-btn")
        .addEventListener("click", () => doDeleteEntry(entry));
      loaded = true;
    });

    return wrap;
  }

  async function doDeleteEntry(entry) {
    const confirmed = await openConfirmDialog({
      message: `Delete this snapshot of "${entry.doc}" from ${formatTime(entry.ts)}? The diff cannot be recovered.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    try {
      const r = await fetch("/api/timeline/entry/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts: entry.ts, hash: entry.hash }),
      });
      if (!r.ok) {
        const err = await r.text();
        await openAlertDialog({ message: "Delete failed: " + err });
        return;
      }
      await refreshTimelineModal();
    } catch (e) {
      await openAlertDialog({ message: "Delete failed: " + e.message });
    }
  }

  async function doClearTimeline() {
    const confirmed = await openConfirmDialog({
      message:
        "Clear ALL history? Every snapshot will be deleted and cannot be recovered. The recording toggle is preserved.",
      confirmLabel: "Clear all",
      danger: true,
    });
    if (!confirmed) return;
    try {
      const r = await fetch("/api/timeline/clear", { method: "POST" });
      if (!r.ok) {
        const err = await r.text();
        await openAlertDialog({ message: "Clear failed: " + err });
        return;
      }
      await refreshTimelineModal();
    } catch (e) {
      await openAlertDialog({ message: "Clear failed: " + e.message });
    }
  }

  // Re-render the modal in place after a delete/clear. Cheaper than
  // closing-and-reopening because the user is mid-task — preserve focus.
  async function refreshTimelineModal() {
    if (!timelineModalEl) return;
    closeTimelineModal();
    await openTimelineModal();
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
    const clearBtn = document.createElement("button");
    clearBtn.className = "modal-btn timeline-clear";
    clearBtn.type = "button";
    clearBtn.textContent = "Clear all";
    clearBtn.disabled = entries.length === 0;
    clearBtn.title = clearBtn.disabled
      ? "Nothing to clear"
      : "Delete every snapshot and timeline entry";
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-btn timeline-close";
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    header.appendChild(title);
    header.appendChild(switchLabel);
    header.appendChild(clearBtn);
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
    clearBtn.addEventListener("click", () => {
      if (clearBtn.disabled) return;
      doClearTimeline();
    });

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
  // Keyboard-navigation state for the modal. Updated by Arrow keys + mouse
  // hover; consumed by Enter to pick a result. Reset on each new render.
  let citeResults = [];
  let citeActiveIndex = -1;
  // When the modal was opened with a selected key (Shift+Cmd+K over a
  // highlighted \cite{key} or bare texkey), this holds that key. Cleared
  // as soon as the user types into the search input — at that point they
  // own the query and we no longer auto-confirm on a texkey match.
  let citePrefilledKey = null;

  // Pull a candidate INSPIRE texkey out of a selection. Strips a wrapping
  // \cite{...}, \citep{...}, etc., and picks the first key if the user
  // selected a multi-key citation (\cite{A,B,C}). Returns empty string
  // when the selection isn't useful.
  function extractKeyFromSelection(text) {
    if (!text) return "";
    text = text.trim();
    const m = text.match(/\\cite[a-z]*\{([^}]+)\}/i);
    if (m) text = m[1];
    if (text.includes(",")) text = text.split(",")[0].trim();
    return text;
  }

  function applyCiteActive(container) {
    const rows = container.querySelectorAll(".cite-result");
    rows.forEach((row, idx) => {
      row.classList.toggle("active", idx === citeActiveIndex);
    });
    if (citeActiveIndex >= 0 && rows[citeActiveIndex]) {
      rows[citeActiveIndex].scrollIntoView({ block: "nearest" });
    }
  }

  function renderCiteResults(container, results) {
    citeResults = results || [];
    citeActiveIndex = citeResults.length > 0 ? 0 : -1;

    // When the modal was opened with a prefilled key (Shift+Cmd+K over a
    // highlighted \cite{key}), surface the exact texkey match — if any —
    // as the active row so a single Enter keypress confirms it. Picking
    // is still explicit; nothing fires silently.
    if (citePrefilledKey && citeResults.length > 0) {
      const target = citePrefilledKey.toLowerCase();
      const exactIdx = citeResults.findIndex(
        (r) => String(r.texkey || "").toLowerCase() === target,
      );
      if (exactIdx >= 0) citeActiveIndex = exactIdx;
    }

    if (!results.length) {
      container.innerHTML = '<div class="cite-empty">No matches.</div>';
      return;
    }
    container.replaceChildren();
    results.forEach((r, idx) => {
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
      // Mouse hover syncs the keyboard-active selection so the two
      // input modes don't fight each other.
      row.addEventListener("mouseenter", () => {
        if (idx !== citeActiveIndex) {
          citeActiveIndex = idx;
          applyCiteActive(container);
        }
      });
      container.appendChild(row);
    });
    applyCiteActive(container);
  }

  function insertCiteAtCursor(key) {
    // Inserting \cite{...} only makes sense inside .tex or .md content; if
    // the active doc is the .bib itself (or any non-citing surface), the
    // bibtex has already been appended server-side and we're done.
    const af = activeName || "";
    if (af.endsWith(".bib") || af.endsWith(".txt")) return;
    const cursor = editor.getCursor();

    // If the cursor sits inside an open \cite[a-z]*{...} on the current
    // line, append to its multi-key chain rather than starting a new
    // citation. Smart-insert:
    //   {│}          → KEY          (right after the brace; no comma)
    //   {A,│}        → KEY          (user already typed the comma)
    //   {A,  │}      → KEY          (comma + whitespace)
    //   {A│}         → ,KEY         (no comma yet; supply it)
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const ciOpenRe = /\\cite[a-z]*\{/gi;
    let lastOpenEnd = -1;
    let m;
    while ((m = ciOpenRe.exec(before)) !== null) {
      lastOpenEnd = m.index + m[0].length;
    }
    const insideCite =
      lastOpenEnd !== -1 && !before.slice(lastOpenEnd).includes("}");

    let text;
    if (insideCite) {
      const tail = before.slice(lastOpenEnd).replace(/\s+$/, "");
      text = (tail === "" || tail.endsWith(",")) ? key : "," + key;
    } else {
      text = `\\cite{${key}}`;
    }
    editor.replaceRange(text, cursor);
    editor.setCursor({ line: cursor.line, ch: cursor.ch + text.length });
    editor.focus();
  }

  async function doCite(result) {
    // Skip the \cite{} insertion when the picked result's texkey matches
    // the key the modal was opened with — the user already has the cite
    // in their doc and just needs ref.bib populated; re-inserting would
    // duplicate. When there's no prefill (modal opened blank, user typed
    // a free query), the normal insertion path fires.
    let skipInsert = false;
    if (citePrefilledKey) {
      const target = citePrefilledKey.toLowerCase();
      if (String(result.texkey || "").toLowerCase() === target) {
        skipInsert = true;
      }
    }
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
      if (!skipInsert) insertCiteAtCursor(data.key);
      closeCiteModal();
    } catch (e) {
      await openAlertDialog({ message: "Cite failed: " + e.message });
    }
  }

  async function openCiteModal(prefillText) {
    if (citeModalEl) return;
    // Fresh open — make sure keyboard-nav state isn't carrying over.
    citeResults = [];
    citeActiveIndex = -1;
    citePrefilledKey = null;

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
      // User took over the query — no longer in auto-confirm mode.
      citePrefilledKey = null;
      if (citeSearchTimer) clearTimeout(citeSearchTimer);
      const q = searchInput.value;
      citeSearchTimer = setTimeout(() => doSearch(q), 300);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        if (citeResults.length === 0) return;
        e.preventDefault();
        citeActiveIndex = Math.min(citeActiveIndex + 1, citeResults.length - 1);
        applyCiteActive(results);
      } else if (e.key === "ArrowUp") {
        if (citeResults.length === 0) return;
        e.preventDefault();
        citeActiveIndex = Math.max(citeActiveIndex - 1, 0);
        applyCiteActive(results);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (citeActiveIndex >= 0 && citeResults[citeActiveIndex]) {
          doCite(citeResults[citeActiveIndex]);
        } else {
          // No active row yet (still typing, or zero matches). Force an
          // immediate search rather than waiting on the debounce.
          if (citeSearchTimer) clearTimeout(citeSearchTimer);
          doSearch(searchInput.value);
        }
      }
    });

    if (typeof prefillText === "string" && prefillText.trim()) {
      const q = prefillText.trim();
      citePrefilledKey = q;
      searchInput.value = q;
      // Fire the search immediately (bypass the input-debounce path).
      doSearch(q);
    }

    requestAnimationFrame(() => {
      searchInput.focus();
      // Selecting the prefill makes it easy to overwrite with the
      // keyboard if INSPIRE didn't have it.
      if (searchInput.value) searchInput.select();
    });
  }

  function closeCiteModal() {
    if (!citeModalEl) return;
    citeModalEl.remove();
    citeModalEl = null;
  }

  citeBtn.addEventListener("click", () => {
    openCiteModal(extractKeyFromSelection(editor.getSelection()));
  });

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
  // PDF page tracking — used to populate the gutter's "p N/M" indicator
  // and the saturated-zoom hint. Set when renderPdf finishes; updated as
  // the user scrolls (throttled with rAF).
  let pdfTotalPages = 0;
  let pdfCurrentPage = 1;
  // Cached fit-scale (paneW / naturalVp.width). Lets the "1:1" gutter
  // button compute the zoomFactor that produces actual-size rendering.
  let lastFitScale = 1.0;
  let zoomTimer = null;

  // Rendered-canvas cache, keyed by the /api/pdf?h=<hash> URL. Switching
  // between an .md and a .tex preview otherwise re-fetches and re-parses
  // the PDF and re-rasterizes every page (the expensive bit) — round
  // trips a user can feel. Capped low because each canvas holds a backing
  // bitmap of a few MB. URL changes on every re-render (hash in query) so
  // stale entries can't masquerade as fresh.
  const _pdfCanvasCache = new Map();
  const PDF_CACHE_MAX = 4;
  function _stashCurrentPdfScroll() {
    if (currentPdfUrl == null) return;
    const entry = _pdfCanvasCache.get(currentPdfUrl);
    if (!entry) return;
    const sh = previewEl.scrollHeight;
    entry.scroll = sh > 0
      ? { ratio: previewEl.scrollTop / sh, offset: 0 }
      : { ratio: 0, offset: 0 };
  }
  function _evictOldestPdfsIfNeeded() {
    while (_pdfCanvasCache.size > PDF_CACHE_MAX) {
      const oldest = _pdfCanvasCache.keys().next().value;
      _pdfCanvasCache.delete(oldest);
    }
  }

  async function renderPdf(url, anchor) {
    if (!window.pdfjsLib) {
      previewEl.textContent = "PDF.js failed to load";
      return;
    }
    const paneW = previewEl.clientWidth || 600;
    // Cache hit: reattach the previously-rendered canvases. Skips the
    // network fetch, the PDF parse, AND the per-page rasterize. Only valid
    // when the pane width hasn't changed — different width means a new
    // pdfScale, which means stale bitmaps.
    const cached = _pdfCanvasCache.get(url);
    if (cached && cached.paneW === paneW) {
      const myToken = ++renderToken;
      previewEl.classList.remove("md");
      previewEl.classList.add("pdf");
      showPdfGutter(true);
      currentPdfUrl = url;
      downloadBtn.disabled = false;
      pdfScale = cached.pdfScale;
      visualScale = 1.0;
      lastPaneWidth = paneW;
      previewEl.replaceChildren(...cached.canvases);
      pdfTotalPages = cached.canvases.length;
      lastFitScale = cached.fitScale || 1.0;
      pdfCurrentPage = computeCurrentPdfPage();
      updatePdfPageIndicator();
      updateZoomPctDisplay();
      // LRU touch — re-insert moves it to the end of Map's iteration order.
      _pdfCanvasCache.delete(url);
      _pdfCanvasCache.set(url, cached);
      const a = anchor || cached.scroll || { ratio: 0, offset: 0 };
      const sh = previewEl.scrollHeight;
      const target = a.ratio * sh - a.offset;
      const maxScroll = Math.max(0, sh - previewEl.clientHeight);
      previewEl.scrollTop = Math.max(0, Math.min(target, maxScroll));
      if (myToken !== renderToken) return;
      return;
    }
    previewEl.classList.remove("md");
    previewEl.classList.add("pdf");
    showPdfGutter(true);
    currentPdfUrl = url;
    downloadBtn.disabled = false;
    const myToken = ++renderToken;
    if (!anchor) {
      // Prefer the persisted per-target scroll ratio (loaded from
      // localStorage at startup) so a page reload lands where you left
      // off. Fall back to the current scrollTop ratio for in-session
      // re-renders.
      const saved = renderTargetName ? previewScrollByTarget.get(renderTargetName) : null;
      if (saved && typeof saved.ratio === "number") {
        anchor = { ratio: saved.ratio, offset: 0 };
      } else {
        const sh = previewEl.scrollHeight;
        anchor = sh > 0
          ? { ratio: previewEl.scrollTop / sh, offset: 0 }
          : { ratio: 0, offset: 0 };
      }
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
      lastFitScale = fitScale;
      pdfScale = Math.max(PDF_SCALE_MIN, Math.min(PDF_SCALE_MAX, fitScale * zoomFactor));
    } catch (e) {
      // Fall back to last pdfScale if we can't measure
    }
    pdfTotalPages = pdf.numPages;
    updatePdfPageIndicator();
    updateZoomPctDisplay();
    if (myToken !== renderToken) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = pdfScale * dpr;
    const pageWraps = new Array(pdf.numPages);
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
        // Wrap canvas in a positioned container so an overlay link layer
        // (refs, eqs, external URLs) sits at the right rects on top.
        const wrap = document.createElement("div");
        wrap.className = "pdf-page-wrap";
        wrap.dataset.pageNum = String(i + 1);
        wrap.style.width = baseW + "px";
        wrap.appendChild(canvas);
        try {
          const layer = await renderLinkLayer(page, viewport, baseW, dpr, pdf);
          if (layer && myToken === renderToken) wrap.appendChild(layer);
        } catch (e) {
          console.warn("pdf link layer failed for page " + (i + 1), e);
        }
        if (myToken !== renderToken) return;
        pageWraps[i] = wrap;
      })())
    );
    if (myToken !== renderToken) return;
    const finalCanvases = pageWraps.filter(Boolean);
    previewEl.replaceChildren(...finalCanvases);
    visualScale = 1.0;
    const newScrollHeight = previewEl.scrollHeight;
    const target = anchor.ratio * newScrollHeight - anchor.offset;
    const maxScroll = Math.max(0, newScrollHeight - previewEl.clientHeight);
    previewEl.scrollTop = Math.max(0, Math.min(target, maxScroll));
    // Stash for the next switch-back. The URL encodes a content hash, so
    // a re-render after Cmd+S produces a new URL and a fresh entry; the
    // old one ages out via the LRU cap.
    _pdfCanvasCache.set(url, {
      canvases: finalCanvases,
      paneW,
      pdfScale,
      fitScale: lastFitScale,
      scroll: null,
    });
    _evictOldestPdfsIfNeeded();
  }

  function applyVisualScale() {
    // Scale both the canvas and its wrap. Wrap explicit width lets the
    // overlay link layer (position: absolute; inset: 0) follow correctly.
    const canvases = previewEl.querySelectorAll(".pdf-page");
    canvases.forEach((c) => {
      const baseW = parseFloat(c.dataset.baseW);
      if (!(baseW > 0)) return;
      const scaled = baseW * visualScale;
      c.style.width = scaled + "px";
      if (c.parentElement && c.parentElement.classList.contains("pdf-page-wrap")) {
        c.parentElement.style.width = scaled + "px";
      }
    });
  }

  // Render an overlay div with one <a> per Link annotation on the page.
  // External URLs open in a new tab; internal destinations scroll the
  // preview to the target page. Positions are stored as percentages of
  // the layer so visualScale (CSS-only zoom) carries them along.
  async function renderLinkLayer(page, viewport, baseW, dpr, pdf) {
    let annotations;
    try {
      annotations = await page.getAnnotations({ intent: "display" });
    } catch (e) {
      return null;
    }
    const links = annotations.filter(
      (a) => a.subtype === "Link" && (a.url || a.dest),
    );
    if (!links.length) return null;
    const layer = document.createElement("div");
    layer.className = "pdf-link-layer";
    const baseH = viewport.height / dpr;
    for (const ann of links) {
      // ann.rect is in PDF user space (origin bottom-left). The viewport
      // helper converts to viewport coordinates with the y-axis flipped
      // to match CSS (origin top-left).
      const rect = viewport.convertToViewportRectangle(ann.rect);
      const x = Math.min(rect[0], rect[2]) / dpr;
      const y = Math.min(rect[1], rect[3]) / dpr;
      const w = Math.abs(rect[2] - rect[0]) / dpr;
      const h = Math.abs(rect[3] - rect[1]) / dpr;
      const a = document.createElement("a");
      a.style.left = (x / baseW * 100) + "%";
      a.style.top = (y / baseH * 100) + "%";
      a.style.width = (w / baseW * 100) + "%";
      a.style.height = (h / baseH * 100) + "%";
      if (ann.url) {
        a.href = ann.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = ann.url;
      } else if (ann.dest) {
        a.href = "#";
        const dest = ann.dest;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          navigateToPdfDest(pdf, dest);
        });
      }
      layer.appendChild(a);
    }
    return layer;
  }

  async function navigateToPdfDest(pdf, dest) {
    let destArray = dest;
    if (typeof destArray === "string") {
      try {
        destArray = await pdf.getDestination(destArray);
      } catch (e) {
        return;
      }
    }
    if (!Array.isArray(destArray) || destArray.length === 0) return;
    let pageIdx;
    try {
      pageIdx = await pdf.getPageIndex(destArray[0]);
    } catch (e) {
      return;
    }
    const wrap = previewEl.querySelector(
      `.pdf-page-wrap[data-page-num="${pageIdx + 1}"]`,
    );
    if (!wrap) return;
    // Use bounding-rect math so we work correctly regardless of which
    // ancestor is the canvas's offsetParent.
    const containerRect = previewEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const targetTop = previewEl.scrollTop + (wrapRect.top - containerRect.top) - 20;
    previewEl.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  }

  // ---------- PDF zoom + gutter ----------
  // setZoomFactor is the single funnel through which zoom changes. It
  // clamps, updates state, applies the visual scale immediately for
  // snappy feedback, refreshes the gutter UI, and schedules a sharp
  // re-render at the new scale once the user pauses. Callers that want
  // to keep the cursor pinned during a wheel-zoom use zoomAtPoint
  // (which wraps setZoomFactor with pre/post anchor math).
  function setZoomFactor(z) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (Math.abs(clamped - zoomFactor) < 1e-6) {
      updateZoomPctDisplay();
      return false;
    }
    const ratio = clamped / zoomFactor;
    zoomFactor = clamped;
    visualScale *= ratio;
    applyVisualScale();
    updateZoomPctDisplay();
    if (currentPdfUrl) {
      if (zoomTimer) clearTimeout(zoomTimer);
      zoomTimer = setTimeout(() => {
        if (!currentPdfUrl) return;
        // Invalidate the cache entry for this URL — it was rasterized at
        // the OLD zoom factor, and the cache hit branch in renderPdf
        // would otherwise silently revert our zoom by restoring those
        // canvases. Dropping the entry forces a fresh render at the
        // current zoomFactor.
        _pdfCanvasCache.delete(currentPdfUrl);
        const sh2 = previewEl.scrollHeight;
        const anchor = { ratio: sh2 > 0 ? previewEl.scrollTop / sh2 : 0, offset: 0 };
        renderPdf(currentPdfUrl, anchor);
      }, 180);
    }
    return true;
  }

  function zoomAtPoint(newZoom, clientX, clientY) {
    const target = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
    if (Math.abs(target - zoomFactor) < 1e-6) {
      flashSaturated();
      return;
    }
    const rect = previewEl.getBoundingClientRect();
    const cursorX = (clientX != null) ? clientX - rect.left : previewEl.clientWidth / 2;
    const cursorY = (clientY != null) ? clientY - rect.top : previewEl.clientHeight / 2;
    const sw = previewEl.scrollWidth;
    const sh = previewEl.scrollHeight;
    const xRatio = sw > 0 ? (previewEl.scrollLeft + cursorX) / sw : 0;
    const yRatio = sh > 0 ? (previewEl.scrollTop + cursorY) / sh : 0;
    if (!setZoomFactor(target)) return;
    const newSw = previewEl.scrollWidth;
    const newSh = previewEl.scrollHeight;
    const tgtLeft = xRatio * newSw - cursorX;
    const tgtTop = yRatio * newSh - cursorY;
    const maxX = Math.max(0, newSw - previewEl.clientWidth);
    const maxY = Math.max(0, newSh - previewEl.clientHeight);
    previewEl.scrollLeft = Math.max(0, Math.min(tgtLeft, maxX));
    previewEl.scrollTop = Math.max(0, Math.min(tgtTop, maxY));
  }

  function updateZoomPctDisplay() {
    if (!zoomPctBtn) return;
    zoomPctBtn.textContent = Math.round(zoomFactor * 100) + "%";
    const atMin = zoomFactor <= ZOOM_MIN + 1e-6;
    const atMax = zoomFactor >= ZOOM_MAX - 1e-6;
    zoomPctBtn.classList.toggle("saturated", atMin || atMax);
    if (zoomOutBtn) zoomOutBtn.disabled = atMin;
    if (zoomInBtn) zoomInBtn.disabled = atMax;
  }

  let _saturatedFlashTimer = null;
  function flashSaturated() {
    if (!zoomPctBtn) return;
    zoomPctBtn.classList.add("saturated");
    if (_saturatedFlashTimer) clearTimeout(_saturatedFlashTimer);
    _saturatedFlashTimer = setTimeout(() => {
      // Only drop the class if we're not actually saturated.
      const atMin = zoomFactor <= ZOOM_MIN + 1e-6;
      const atMax = zoomFactor >= ZOOM_MAX - 1e-6;
      if (!atMin && !atMax) zoomPctBtn.classList.remove("saturated");
    }, 250);
  }

  function updatePdfPageIndicator() {
    if (!pdfPageIndicator) return;
    const numEl = pdfPageIndicator.querySelector(".pdf-gutter-pages-num");
    const totEl = pdfPageIndicator.querySelector(".pdf-gutter-pages-total");
    if (numEl) numEl.textContent = String(pdfCurrentPage);
    if (totEl) totEl.textContent = String(pdfTotalPages || 1);
  }

  function computeCurrentPdfPage() {
    // Iterate the wrap divs (each carries data-page-num). Use bounding
    // rect math so it works regardless of which ancestor is the
    // offsetParent — the wrap is position:relative, which means its
    // contained canvas's offsetTop is 0, not what we want here.
    const wraps = previewEl.querySelectorAll(".pdf-page-wrap");
    if (!wraps.length) return 1;
    const containerRect = previewEl.getBoundingClientRect();
    const viewportCenter = previewEl.clientHeight / 2;
    let closest = 1;
    let closestDist = Infinity;
    wraps.forEach((w) => {
      const r = w.getBoundingClientRect();
      const center = (r.top - containerRect.top) + r.height / 2;
      const d = Math.abs(center - viewportCenter);
      if (d < closestDist) {
        closestDist = d;
        closest = parseInt(w.dataset.pageNum || "1", 10);
      }
    });
    return closest;
  }

  function showPdfGutter(show) {
    if (!pdfGutterEl) return;
    pdfGutterEl.hidden = !show;
  }

  function renderMarkdown(text) {
    // Save the PDF's last scroll so a switch back to the same .tex
    // restores where the user was reading.
    _stashCurrentPdfScroll();
    ++renderToken;
    currentPdfUrl = null;
    downloadBtn.disabled = true;
    visualScale = 1.0;
    lastPaneWidth = 0;
    showPdfGutter(false);
    const wasInMdMode = previewEl.classList.contains("md");
    previewEl.classList.remove("pdf");
    previewEl.classList.add("md");
    // Re-renders within MD mode preserve the current scrollTop. On a
    // transition from PDF or from a fresh page load, prefer the persisted
    // per-target ratio; otherwise start at the top.
    const prevTop = wasInMdMode ? previewEl.scrollTop : 0;
    const prevLeft = wasInMdMode ? previewEl.scrollLeft : 0;
    const savedRatio = !wasInMdMode && renderTargetName
      ? (previewScrollByTarget.get(renderTargetName) || {}).ratio
      : null;
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
    const sh = previewEl.scrollHeight;
    const persistedTop = (typeof savedRatio === "number" && sh > 0)
      ? Math.round(savedRatio * sh)
      : null;
    previewEl.scrollTop = Math.min(persistedTop != null ? persistedTop : prevTop, maxTop);
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

  // CodeMirror keeps its selection in a dedicated layer (`display.selectionDiv`
  // — the only child of lineSpace with `z-index: 1`, holding just the
  // `.CodeMirror-selected` rects, separate from the text). We style that
  // container directly to fix two rendering issues at once:
  //
  //  1. Safari/WebKit fails to repaint the area vacated by the translucent
  //     full-width selection rectangles when a selection shrinks, leaving the
  //     right side of no-longer-selected lines tinted. `translateZ(0)` promotes
  //     the layer to its own GPU backing store so WebKit re-rasters it as a unit.
  //  2. For a wrapped line CM emits overlapping rects (a per-row rect plus a
  //     spanning block). With a translucent fill those stack into a brighter
  //     band on the continuation rows. We instead fill the rects SOLID (in CSS)
  //     and apply the translucency ONCE as group opacity here, so the overlap
  //     flattens to a single solid shape before the alpha is applied.
  //
  // Both touch only the selection layer — text and cursor are separate siblings,
  // so no subpixel-AA blur. No-op on Blink/Gecko, which already render correctly.
  (function promoteSelectionLayer() {
    const sel = editor
      .getWrapperElement()
      .querySelector('.CodeMirror-lines div[style*="z-index: 1"]');
    if (sel) {
      sel.style.transform = "translateZ(0)";
      sel.style.opacity = "0.22";
    }
  })();

  // Safari fix: CodeMirror suppresses its own dummy drag image on Safari (an
  // ancient ~6.0.2 setDragImage segfault that no longer applies), so dragging
  // selected text shows the ENTIRE editor as the drag ghost instead of moving
  // just the text. Supply the same 1×1 transparent image CM uses on every other
  // browser, restoring normal drag-to-move behavior. (Harmless elsewhere — it
  // just re-sets the transparent image CM already uses.)
  const blankDragImage = new Image();
  blankDragImage.src =
    "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  editor.getScrollerElement().addEventListener("dragstart", (e) => {
    if (e.dataTransfer && e.dataTransfer.setDragImage) {
      e.dataTransfer.setDragImage(blankDragImage, 0, 0);
    }
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
    // For .md targets, keep the preview live as text streams in. The
    // server doesn't broadcast `rendered_md` until after stream_end +
    // a 0.4s debounce, so on a large insert the preview otherwise sits
    // on the pre-edit content for the entire streaming duration. We
    // throttle to ~5 Hz so marked + KaTeX don't bog down the page.
    scheduleLocalMdPreviewRender();
  }

  function streamEnd() {
    streaming = false;
    setStatus("idle", "streamed");
    // One last local render so the preview matches the final editor
    // content immediately, instead of waiting for the server's debounced
    // `rendered_md` to arrive ~0.4s later.
    flushLocalMdPreviewRender();
  }

  let mdPreviewRenderTimer = null;
  function isMdRenderTarget() {
    return !!renderTargetName && renderTargetName.endsWith(".md");
  }
  function scheduleLocalMdPreviewRender() {
    if (!isMdRenderTarget()) return;
    if (mdPreviewRenderTimer) return;
    mdPreviewRenderTimer = setTimeout(() => {
      mdPreviewRenderTimer = null;
      if (!isMdRenderTarget()) return;
      renderMarkdown(editor.getValue());
    }, 200);
  }
  function flushLocalMdPreviewRender() {
    if (mdPreviewRenderTimer) {
      clearTimeout(mdPreviewRenderTimer);
      mdPreviewRenderTimer = null;
    }
    if (!isMdRenderTarget()) return;
    renderMarkdown(editor.getValue());
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
  // Per-source-doc preview scroll ratio. Keyed by renderTargetName (the
  // .tex/.md doc that produces the preview), since the PDF URL changes
  // on every Cmd+S re-render and isn't a stable key across reloads.
  const previewScrollByTarget = new Map();

  // --- Persistent scroll state ---------------------------------------------
  // docViewState + previewScrollByTarget are in-memory; persist them so a
  // page reload doesn't drop you back at the top of every doc.
  const SCROLL_STATE_KEY = "scrollStateV1";
  const SCROLL_PERSIST_DEBOUNCE = 1200;
  let _persistScrollTimer = null;

  function _captureCurrentPreviewScroll() {
    if (!renderTargetName) return;
    const sh = previewEl.scrollHeight;
    if (sh <= 0) return;
    previewScrollByTarget.set(renderTargetName, {
      ratio: previewEl.scrollTop / sh,
    });
  }

  function persistScrollState() {
    snapshotViewState(editorActiveDoc);
    _captureCurrentPreviewScroll();
    const ed = {};
    for (const [name, s] of docViewState) {
      if (!s) continue;
      ed[name] = {
        cursor: s.cursor ? { line: s.cursor.line, ch: s.cursor.ch } : null,
        scroll: s.scroll ? { top: s.scroll.top, left: s.scroll.left } : null,
      };
    }
    const pv = {};
    for (const [name, s] of previewScrollByTarget) {
      if (s && typeof s.ratio === "number") pv[name] = { ratio: s.ratio };
    }
    lsSet(SCROLL_STATE_KEY, { editor: ed, preview: pv });
  }

  function schedulePersistScroll() {
    if (_persistScrollTimer) clearTimeout(_persistScrollTimer);
    _persistScrollTimer = setTimeout(persistScrollState, SCROLL_PERSIST_DEBOUNCE);
  }

  function loadPersistedScrollState() {
    const state = lsGet(SCROLL_STATE_KEY, null);
    if (!state || typeof state !== "object") return;
    if (state.editor && typeof state.editor === "object") {
      for (const [name, s] of Object.entries(state.editor)) {
        if (s && typeof s === "object") docViewState.set(name, s);
      }
    }
    if (state.preview && typeof state.preview === "object") {
      for (const [name, s] of Object.entries(state.preview)) {
        if (s && typeof s.ratio === "number") previewScrollByTarget.set(name, s);
      }
    }
  }
  loadPersistedScrollState();

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
        // For .md targets, render the preview locally now rather than
        // waiting ~0.4s for the server's debounced `rendered_md` to
        // arrive. Skip during streaming — streamChar's throttled renderer
        // is already running and the canonical broadcast at stream_end
        // will re-render anyway.
        if (
          !streaming &&
          path &&
          path === renderTargetName &&
          path.endsWith(".md")
        ) {
          renderMarkdown(content);
        }
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

  // ---- Tab drag-and-drop reordering -------------------------------------
  // Native HTML5 DnD. Tabs are draggable buttons; the container delegates
  // dragover/drop. A thin vertical bar is inserted between the existing
  // tabs to show where the drop will land; on drop we splice openTabs and
  // animate every moved tab from its old position to its new one (FLIP).
  let _draggingTabName = null;
  let _dropBeforeName = null;
  let _dropIndicator = null;

  function _ensureDropIndicator() {
    if (_dropIndicator) return _dropIndicator;
    _dropIndicator = document.createElement("div");
    _dropIndicator.className = "tab-drop-indicator";
    _dropIndicator.setAttribute("aria-hidden", "true");
    return _dropIndicator;
  }
  function _clearDropIndicator() {
    if (_dropIndicator && _dropIndicator.parentNode) {
      _dropIndicator.parentNode.removeChild(_dropIndicator);
    }
    _dropBeforeName = null;
  }
  function _onTabDragStart(e, name) {
    // Grabbing the × shouldn't initiate a drag — the close click still works.
    if (e.target && (e.target.classList?.contains("close")
        || e.target.closest?.(".close"))) {
      e.preventDefault();
      return;
    }
    _draggingTabName = name;
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", name);
    } catch {}
    // Defer the .dragging class so the browser captures its drag image
    // BEFORE the source goes transparent.
    setTimeout(() => {
      const el = tabsEl.querySelector(`.tab[data-name="${CSS.escape(name)}"]`);
      if (el) el.classList.add("dragging");
    }, 0);
  }
  function _onTabDragEnd() {
    for (const el of tabsEl.querySelectorAll(".tab.dragging")) {
      el.classList.remove("dragging");
    }
    _clearDropIndicator();
    _draggingTabName = null;
  }
  function _onTabsDragOver(e) {
    if (!_draggingTabName) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch {}
    const tabs = Array.from(tabsEl.querySelectorAll(".tab:not(.dragging)"));
    const x = e.clientX;
    let beforeName = null;
    for (const t of tabs) {
      const rect = t.getBoundingClientRect();
      if (x < rect.left + rect.width / 2) {
        beforeName = t.dataset.name;
        break;
      }
    }
    if (beforeName === _dropBeforeName
        && _dropIndicator && _dropIndicator.parentNode === tabsEl) return;
    _dropBeforeName = beforeName;
    const indicator = _ensureDropIndicator();
    if (beforeName) {
      const target = tabsEl.querySelector(`.tab[data-name="${CSS.escape(beforeName)}"]`);
      if (target) tabsEl.insertBefore(indicator, target);
    } else {
      tabsEl.appendChild(indicator);
    }
  }
  function _onTabsDragLeave(e) {
    // dragleave fires when crossing into children; only clear when truly leaving.
    if (e.relatedTarget && tabsEl.contains(e.relatedTarget)) return;
    _clearDropIndicator();
  }
  function _onTabsDrop(e) {
    if (!_draggingTabName) return;
    e.preventDefault();
    const src = _draggingTabName;
    const before = _dropBeforeName;
    _clearDropIndicator();

    // Snapshot pre-mutation positions so we can FLIP-animate the slide.
    const beforeRects = new Map();
    for (const t of tabsEl.querySelectorAll(".tab")) {
      beforeRects.set(t.dataset.name, t.getBoundingClientRect().left);
    }

    const visible = openTabs.filter((n) => allDocs.includes(n));
    const hidden = openTabs.filter((n) => !allDocs.includes(n));
    const withoutSrc = visible.filter((n) => n !== src);
    let newVisible;
    if (before == null) {
      newVisible = [...withoutSrc, src];
    } else {
      const idx = withoutSrc.indexOf(before);
      newVisible = idx < 0
        ? [...withoutSrc, src]
        : [...withoutSrc.slice(0, idx), src, ...withoutSrc.slice(idx)];
    }
    if (newVisible.join("|") === visible.join("|")) return;
    openTabs = [...newVisible, ...hidden];
    lsSet("openTabs", openTabs);
    renderTabs();

    // FLIP: translate each moved tab from its old position back to where
    // it WAS, then RAF removes the transform with a transition so it
    // slides forward to its new home.
    for (const t of tabsEl.querySelectorAll(".tab")) {
      const oldLeft = beforeRects.get(t.dataset.name);
      if (oldLeft == null) continue;
      const newLeft = t.getBoundingClientRect().left;
      const dx = oldLeft - newLeft;
      if (Math.abs(dx) < 0.5) continue;
      t.style.transition = "none";
      t.style.transform = `translateX(${dx}px)`;
      requestAnimationFrame(() => {
        t.style.transition = "transform 160ms cubic-bezier(0.2, 0, 0, 1)";
        t.style.transform = "";
      });
      setTimeout(() => {
        t.style.transition = "";
        t.style.transform = "";
      }, 220);
    }
  }
  tabsEl.addEventListener("dragover", _onTabsDragOver);
  tabsEl.addEventListener("dragleave", _onTabsDragLeave);
  tabsEl.addEventListener("drop", _onTabsDrop);

  function renderTabs() {
    const visible = openTabs.filter((n) => allDocs.includes(n));
    tabsEl.replaceChildren(
      ...visible.map((name) => {
        const el = document.createElement("button");
        el.className = "tab" + (name === activeName ? " active" : "");
        el.type = "button";
        el.role = "tab";
        el.title = name;
        el.dataset.name = name;
        el.draggable = true;
        el.addEventListener("dragstart", (e) => _onTabDragStart(e, name));
        el.addEventListener("dragend", _onTabDragEnd);
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

  function buildTree(files, dirs, assets = []) {
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
    const place = (path, type) => {
      const parts = path.split("/");
      const name = parts.pop();
      const parentPath = parts.join("/");
      const parent = byPath.get(parentPath) || root;
      parent.children.push({ type, path, name });
    };
    for (const f of files) place(f, "file");
    for (const a of assets) place(a, "asset");
    // Folders first; within children, editables before assets; alphabetical
    // within each rank.
    const rank = (t) => (t === "dir" ? 0 : t === "file" ? 1 : 2);
    (function sortRec(node) {
      if (node.type !== "dir") return;
      node.children.sort((a, b) => {
        const ra = rank(a.type), rb = rank(b.type);
        if (ra !== rb) return ra - rb;
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

  function renderAssetNode(node) {
    // Non-editable: shown grayed-out so the user sees their figs/ tree
    // alongside .tex files but can't accidentally try to open a binary.
    // No click handler, no drag — purely informational.
    const li = document.createElement("li");
    li.className = "tree-file tree-asset";
    li.dataset.path = node.path;
    const row = makeRow({ arrow: "", label: node.name, fullPath: node.path });
    row.classList.add("asset");
    row.title = `${node.path} — binary asset, not editable`;
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
      ul.appendChild(
        child.type === "dir" ? renderFolderNode(child)
          : child.type === "asset" ? renderAssetNode(child)
          : renderFileNode(child),
      );
    }
    li.appendChild(ul);
    makeFolderDropTarget(li, row, node.path);
    return li;
  }

  function renderFileList() {
    let docs = allDocs;
    let dirs = allDirs;
    let assets = allAssets;
    if (renderableOnly) {
      docs = docs.filter((d) => {
        const s = d.toLowerCase();
        return RENDERABLE_SUFFIXES_JS.some((suf) => s.endsWith(suf));
      });
      // Hide any folder that no longer contains a renderable descendant.
      const needed = new Set();
      for (const d of docs) {
        const parts = d.split("/");
        parts.pop();
        let acc = "";
        for (const p of parts) {
          acc = acc ? acc + "/" + p : p;
          needed.add(acc);
        }
      }
      dirs = dirs.filter((d) => needed.has(d));
      assets = [];
    }
    const tree = buildTree(docs, dirs, assets);
    fileListEl.replaceChildren(
      ...tree.children.map((c) =>
        c.type === "dir" ? renderFolderNode(c)
          : c.type === "asset" ? renderAssetNode(c)
          : renderFileNode(c)
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
    allAssets = msg.assets || [];
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
      } else if (msg.type === "agent_stream_chunk") {
        appendAgentStreamChunk(msg.comment_id, msg.text);
      } else if (msg.type === "agent_tool_call_start") {
        upsertToolCallPill(msg.comment_id, {
          call_id: msg.call_id,
          name: msg.tool_name,
          args: msg.args,
          state: "running",
        });
      } else if (msg.type === "agent_tool_call_end") {
        upsertToolCallPill(msg.comment_id, {
          call_id: msg.call_id,
          name: msg.tool_name,
          result: msg.result,
          failed: !!msg.failed,
          runtime_ms: msg.runtime_ms,
          state: msg.failed ? "failed" : "done",
        });
      } else if (msg.type === "agent_stream_end") {
        // Final comments broadcast immediately follows with the canonical
        // content; release the streaming buffer once it has.
        streamingText.delete(msg.comment_id);
        const row = commentsListEl.querySelector(
          `.comment-row[data-comment-id="${CSS.escape(msg.comment_id)}"]`,
        );
        if (row) row.classList.remove("comment-streaming");
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

  // Comments panel resize handle: drag the left edge to widen/narrow the
  // panel. Mirrors the editor/preview divider — minimum width keeps the
  // panel readable; maximum caps at ~70% of viewport so the editor doesn't
  // collapse to nothing.
  const COMMENTS_MIN = 240;
  const COMMENTS_MAX_RATIO = 0.7;
  const COMMENTS_WIDTH_KEY = "commentsWidth";
  const savedCommentsWidth = lsGet(COMMENTS_WIDTH_KEY, null);
  if (typeof savedCommentsWidth === "number" && savedCommentsWidth > 0) {
    commentsPanel.style.width = savedCommentsWidth + "px";
  }
  const commentsResize = $("comments-resize-handle");
  let commentsDragging = false;
  let commentsDragRaf = 0;
  commentsResize.addEventListener("mousedown", (e) => {
    e.preventDefault();
    commentsDragging = true;
    commentsResize.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e) => {
    if (!commentsDragging) return;
    const vw = window.innerWidth;
    const maxW = Math.max(COMMENTS_MIN, vw * COMMENTS_MAX_RATIO);
    const newWidth = Math.max(COMMENTS_MIN, Math.min(maxW, vw - e.clientX));
    commentsPanel.style.width = newWidth + "px";
    if (!commentsDragRaf) {
      commentsDragRaf = requestAnimationFrame(() => {
        commentsDragRaf = 0;
        editor.refresh();
      });
    }
  });
  window.addEventListener("mouseup", () => {
    if (!commentsDragging) return;
    commentsDragging = false;
    commentsResize.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    editor.refresh();
    const px = parseInt(commentsPanel.style.width, 10);
    if (px > 0) lsSet(COMMENTS_WIDTH_KEY, px);
  });

  // Trackpad pinches arrive as wheel events with ctrlKey:true; mouse-wheel
  // zooming requires the user to hold Ctrl. We deliberately don't honor
  // Cmd-wheel because (a) trackpad pinch already covers Mac, and (b) Cmd
  // is a system-level modifier we'd rather leave alone.
  previewEl.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    if (!previewEl.classList.contains("pdf")) return;
    e.preventDefault();
    const intensity = Math.min(0.25, Math.abs(e.deltaY) / 200);
    const factor = e.deltaY < 0 ? 1 + intensity : 1 / (1 + intensity);
    zoomAtPoint(zoomFactor * factor, e.clientX, e.clientY);
  }, { passive: false });

  // Gutter buttons. − / + step zoom by ~15% per click. The percentage
  // chip is also a button that resets to fit-width (i.e. zoomFactor=1).
  // "1:1" resolves Actual Size against the cached fit scale: at the
  // computed zoomFactor, fitScale * zoomFactor == 1, so a PDF point
  // renders as one CSS pixel.
  if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => zoomAtPoint(zoomFactor / 1.15));
  if (zoomInBtn) zoomInBtn.addEventListener("click", () => zoomAtPoint(zoomFactor * 1.15));
  if (zoomPctBtn) zoomPctBtn.addEventListener("click", () => setZoomFactor(1.0));
  if (zoomFitBtn) zoomFitBtn.addEventListener("click", () => setZoomFactor(1.0));
  if (zoomActualBtn) zoomActualBtn.addEventListener("click", () => {
    if (!lastFitScale || lastFitScale <= 0) return;
    setZoomFactor(1.0 / lastFitScale);
  });

  // Page indicator: update as the user scrolls. rAF-throttled so a fast
  // scroll fires at most one recompute per frame.
  let _pageScrollRaf = 0;
  previewEl.addEventListener("scroll", () => {
    schedulePersistScroll();
    if (!previewEl.classList.contains("pdf")) return;
    if (_pageScrollRaf) return;
    _pageScrollRaf = requestAnimationFrame(() => {
      _pageScrollRaf = 0;
      const p = computeCurrentPdfPage();
      if (p !== pdfCurrentPage) {
        pdfCurrentPage = p;
        updatePdfPageIndicator();
      }
    });
  }, { passive: true });

  // Persist editor cursor + scroll on activity. CM fires `scroll` per
  // wheel/keyboard scroll; `cursorActivity` covers cursor moves that
  // don't scroll.
  editor.on("scroll", schedulePersistScroll);
  editor.on("cursorActivity", schedulePersistScroll);

  // Make sure unsaved scroll state survives reload / tab close. pagehide
  // fires more reliably than beforeunload on modern browsers; both are
  // hooked for redundancy. visibilitychange covers the case where the
  // user switches to a different tab and we want to checkpoint.
  window.addEventListener("pagehide", persistScrollState);
  window.addEventListener("beforeunload", persistScrollState);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistScrollState();
  });

  // Editor font zoom: same Cmd/Ctrl + +/-/0 keys as the PDF zoom, routed
  // by whichever pane the user is actively in. Persisted in localStorage
  // so the size sticks across reloads.
  const EDITOR_FONT_DEFAULT = 13;
  const EDITOR_FONT_MIN = 9;
  const EDITOR_FONT_MAX = 28;
  const EDITOR_FONT_KEY = "editorFontSize";
  let editorFontSize = Number(lsGet(EDITOR_FONT_KEY, EDITOR_FONT_DEFAULT)) || EDITOR_FONT_DEFAULT;
  function applyEditorFontSize() {
    const wrap = editor.getWrapperElement();
    if (!wrap) return;
    wrap.style.fontSize = editorFontSize + "px";
    editor.refresh();
  }
  function bumpEditorFontSize(delta) {
    const next = Math.max(EDITOR_FONT_MIN,
                          Math.min(EDITOR_FONT_MAX, editorFontSize + delta));
    if (next === editorFontSize) return;
    editorFontSize = next;
    applyEditorFontSize();
    lsSet(EDITOR_FONT_KEY, editorFontSize);
  }
  // Initial application — only writes the CSS if the user has previously
  // bumped from default; otherwise leaves the stylesheet rule in charge.
  if (editorFontSize !== EDITOR_FONT_DEFAULT) applyEditorFontSize();

  // Comments panel zoom: scales the whole panel via the CSS `zoom`
  // property (well-supported in Chrome/Safari/Firefox). Smaller surface
  // area than the editor + PDF case so a coarser step (15%) per press
  // feels right.
  const COMMENTS_ZOOM_DEFAULT = 1.0;
  const COMMENTS_ZOOM_MIN = 0.7;
  const COMMENTS_ZOOM_MAX = 1.8;
  const COMMENTS_ZOOM_STEP = 0.1;
  const COMMENTS_ZOOM_KEY = "commentsZoom";
  let commentsZoom = Number(lsGet(COMMENTS_ZOOM_KEY, COMMENTS_ZOOM_DEFAULT)) || COMMENTS_ZOOM_DEFAULT;
  function applyCommentsZoom() {
    if (!commentsPanel) return;
    commentsPanel.style.zoom = String(commentsZoom);
  }
  function bumpCommentsZoom(delta) {
    const next = Math.max(COMMENTS_ZOOM_MIN,
                          Math.min(COMMENTS_ZOOM_MAX,
                                   commentsZoom + delta * COMMENTS_ZOOM_STEP));
    if (Math.abs(next - commentsZoom) < 1e-6) return;
    commentsZoom = next;
    applyCommentsZoom();
    lsSet(COMMENTS_ZOOM_KEY, commentsZoom);
  }
  if (commentsZoom !== COMMENTS_ZOOM_DEFAULT) applyCommentsZoom();

  // Track whether the mouse is currently over the comments panel.
  // Combined with focus below, this is the main "is the panel the
  // user's current attention?" signal — pointing at the panel is the
  // gesture that should make Cmd+= zoom it.
  let commentsHovered = false;
  if (commentsPanel) {
    commentsPanel.addEventListener("mouseenter", () => { commentsHovered = true; });
    commentsPanel.addEventListener("mouseleave", () => { commentsHovered = false; });
  }
  // True when the user is either pointing at the panel or has keyboard
  // focus inside it (textarea, button). Hover alone is enough — you can
  // be typing in the editor and still zoom comments by moving the
  // cursor over the panel and hitting Cmd+=, no click required.
  function commentsPanelIsTarget() {
    if (!commentsPanel || commentsPanel.hidden) return false;
    if (commentsHovered) return true;
    const a = document.activeElement;
    return !!a && a !== document.body && commentsPanel.contains(a);
  }

  // Cmd/Ctrl + +/-/0 zooms whichever pane the user is currently
  // attending to. Priority: comments panel (hovered or focused) →
  // editor (focused) → PDF (showing). Hover-wins for comments lets
  // the user point at the panel and zoom without giving up editor
  // focus or clicking into the sidebar first. Always pre-empts the
  // browser's page-zoom default when one of these branches fires.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    let handled = false;
    const commentsActive = commentsPanelIsTarget();
    const editorActive = editor.hasFocus();
    const pdfShowing = previewEl.classList.contains("pdf");
    if (e.key === "=" || e.key === "+") {
      if (commentsActive) { bumpCommentsZoom(+1); handled = true; }
      else if (editorActive) { bumpEditorFontSize(+1); handled = true; }
      else if (pdfShowing) { zoomAtPoint(zoomFactor * 1.15); handled = true; }
    } else if (e.key === "-" || e.key === "_") {
      if (commentsActive) { bumpCommentsZoom(-1); handled = true; }
      else if (editorActive) { bumpEditorFontSize(-1); handled = true; }
      else if (pdfShowing) { zoomAtPoint(zoomFactor / 1.15); handled = true; }
    } else if (e.key === "0") {
      if (commentsActive) {
        commentsZoom = COMMENTS_ZOOM_DEFAULT;
        applyCommentsZoom();
        lsSet(COMMENTS_ZOOM_KEY, commentsZoom);
        handled = true;
      } else if (editorActive) {
        editorFontSize = EDITOR_FONT_DEFAULT;
        applyEditorFontSize();
        lsSet(EDITOR_FONT_KEY, editorFontSize);
        handled = true;
      } else if (pdfShowing) {
        setZoomFactor(1.0);
        handled = true;
      }
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

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

  // Threads collapsed by the user. Keyed by the root comment id. Lives in
  // memory only — collapse state is a viewing preference, not persistent
  // data, and comment ids don't survive across sessions anyway.
  const collapsedThreads = new Set();

  function rootCommentIdFor(id) {
    let cur = allComments.find((c) => c.id === id);
    while (cur && cur.parent_id) {
      const next = allComments.find((c) => c.id === cur.parent_id);
      if (!next || next === cur) break;
      cur = next;
    }
    return cur ? cur.id : id;
  }

  function openCommentInSidebar(id) {
    commentsPanel.hidden = false;
    // If the target lives inside a collapsed thread, expand it so the row
    // becomes visible and scrollable.
    collapsedThreads.delete(rootCommentIdFor(id));
    renderCommentsPanel();
    requestAnimationFrame(() => {
      const row = commentsListEl.querySelector(
        `.comment-row[data-comment-id="${CSS.escape(id)}"]`,
      );
      if (!row) return;
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

  // In-progress streaming buffer per comment id. If something triggers
  // renderCommentsPanel mid-stream (another comment lands, etc.) we want
  // the streaming row to keep the text it's accumulated so far rather
  // than re-render with the empty placeholder body from `allComments`.
  const streamingText = new Map();

  // ---------- agent tool-call pills ----------
  // Each agent reply can carry a list of tool calls (ListDocs, ReadDoc, …)
  // the model made while composing its answer. We render them as pills
  // below the message body; click toggles the args/result detail.
  function _truncate(s, n) {
    if (typeof s !== "string") return "";
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function _summarizeArgs(args) {
    if (!args || typeof args !== "object") return "";
    const parts = [];
    for (const [k, v] of Object.entries(args)) {
      const sv = typeof v === "string" ? v : JSON.stringify(v);
      parts.push(`${k}=${_truncate(String(sv), 30)}`);
    }
    return parts.join(", ");
  }
  // Tools that return `{"ok": False, ...}` (or JSON-style `false`) signal a
  // logical failure without raising — the backend's `failed` flag only
  // catches exceptions, so sniff the result string so the pill still goes
  // red. Matches Python repr style (`'ok': False`) and JSON style
  // (`"ok": false`).
  function _resultIndicatesFailure(result) {
    if (typeof result !== "string" || !result) return false;
    return /['"]ok['"]\s*:\s*[fF]alse\b/.test(result);
  }
  function upsertToolCallPill(commentId, info, rowOverride) {
    if (!commentId || !info.call_id) return;
    // During buildCommentRow's events replay the row hasn't been
    // appended to commentsListEl yet, so we can't find it via querySelector.
    // The caller passes the row reference directly in that case.
    const row = rowOverride || commentsListEl.querySelector(
      `.comment-row[data-comment-id="${CSS.escape(commentId)}"]`,
    );
    if (!row) return;
    const flow = row.querySelector(".comment-msg-flow");
    if (!flow) return;
    let pill = flow.querySelector(
      `.tool-pill[data-call-id="${CSS.escape(info.call_id)}"]`,
    );
    if (!pill) {
      pill = document.createElement("div");
      pill.className = "tool-pill";
      pill.dataset.callId = info.call_id;
      const head = document.createElement("button");
      head.type = "button";
      head.className = "tool-pill-head";
      head.addEventListener("click", () => pill.classList.toggle("expanded"));
      const body = document.createElement("div");
      body.className = "tool-pill-body";
      pill.appendChild(head);
      pill.appendChild(body);
      flow.appendChild(pill);
    }
    const state = (info.state === "done" && _resultIndicatesFailure(info.result))
      ? "failed"
      : info.state;
    pill.classList.remove("running", "done", "failed");
    pill.classList.add(state);
    const head = pill.querySelector(".tool-pill-head");
    const argSummary = _summarizeArgs(info.args);
    const rtTag =
      info.runtime_ms != null
        ? `${info.runtime_ms < 10 ? info.runtime_ms.toFixed(1) : info.runtime_ms.toFixed(0)}ms`
        : "…";
    head.innerHTML = "";
    const stateDot = document.createElement("span");
    stateDot.className = "tool-pill-state";
    head.appendChild(stateDot);
    const nameEl = document.createElement("span");
    nameEl.className = "tool-pill-name";
    nameEl.textContent = info.name || "tool";
    head.appendChild(nameEl);
    if (argSummary) {
      const argsEl = document.createElement("span");
      argsEl.className = "tool-pill-args";
      argsEl.textContent = `(${argSummary})`;
      head.appendChild(argsEl);
    }
    const rtEl = document.createElement("span");
    rtEl.className = "tool-pill-rt";
    rtEl.textContent = rtTag;
    head.appendChild(rtEl);

    const body = pill.querySelector(".tool-pill-body");
    body.replaceChildren();
    if (info.args && Object.keys(info.args).length) {
      const argsBlock = document.createElement("pre");
      argsBlock.className = "tool-pill-detail";
      argsBlock.textContent = JSON.stringify(info.args, null, 2);
      body.appendChild(argsBlock);
    }
    if (info.result) {
      const sep = document.createElement("div");
      sep.className = "tool-pill-sep";
      sep.textContent = "→";
      body.appendChild(sep);
      const resultBlock = document.createElement("pre");
      resultBlock.className = "tool-pill-detail";
      resultBlock.textContent = info.result;
      body.appendChild(resultBlock);
    }
  }

  // Comment text supports inline TeX math via KaTeX's auto-render. Same
  // delimiters as the markdown preview so users can paste a snippet from
  // their .tex doc into a comment and have it render the same way.
  // Streaming chunks stay plain text — partial math like `$x +` would
  // parse-fail; renderCommentsPanel re-renders the row from state once
  // the stream ends, at which point this runs on the finalized text.
  function renderCommentTextWithMath(el, text) {
    // Stash the raw markdown source so streaming chunks can re-render
    // from "everything so far" instead of trying to append into the
    // already-rendered HTML (where textContent != source).
    el.dataset.raw = text || "";
    if (window.marked && text) {
      // breaks: true → single newlines become <br> so an agent that
      // writes one line per thought still looks right without forcing
      // them to leave blank lines between every line.
      el.innerHTML = window.marked.parse(text, { breaks: true });
    } else {
      el.textContent = text || "";
    }
    if (!window.renderMathInElement || !text) return;
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "\\(", right: "\\)", display: false },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
      });
    } catch (e) {
      console.warn("KaTeX comment render failed", e);
    }
  }

  function appendAgentStreamChunk(commentId, text) {
    if (!commentId || !text) return;
    streamingText.set(commentId, (streamingText.get(commentId) || "") + text);
    const row = commentsListEl.querySelector(
      `.comment-row[data-comment-id="${CSS.escape(commentId)}"]`,
    );
    if (!row) return;
    const flow = row.querySelector(".comment-msg-flow");
    if (!flow) return;
    // Append text to the LAST text segment in the flow. If the most
    // recent block is a pill (i.e. a tool just ran), start a new text
    // segment so the order reads "text → tool → text".
    let last = flow.lastElementChild;
    if (!last || !last.classList.contains("comment-text-segment")) {
      last = document.createElement("div");
      last.className = "comment-text-segment";
      flow.appendChild(last);
    }
    // Re-render from "all source seen so far" rather than appending to
    // textContent — once marked has rendered the segment to HTML the
    // textContent is the *visible* text, not the markdown source, so
    // a plain += would silently drop the formatting.
    const raw = (last.dataset.raw || "") + text;
    renderCommentTextWithMath(last, raw);
    row.classList.add("comment-streaming");
  }

  async function postReply(parentId, message) {
    if (!message.trim()) return null;
    try {
      const r = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          parent_id: parentId,
          author: "user",
        }),
      });
      if (!r.ok) return null;
      const data = await r.json();
      return data?.comment?.id || null;
    } catch (e) {
      console.warn("reply failed", e);
      return null;
    }
  }

  function formatCommentTime(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    const now = Date.now();
    const diffSec = (now - d.getTime()) / 1000;
    if (diffSec < 45) return "now";
    if (diffSec < 3600) return Math.floor(diffSec / 60) + "m";
    if (diffSec < 86400) return Math.floor(diffSec / 3600) + "h";
    if (diffSec < 7 * 86400) return Math.floor(diffSec / 86400) + "d";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function buildAgentTogglePill(rootId) {
    const toggle = document.createElement("button");
    toggle.className = "thread-agent-toggle";
    toggle.type = "button";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = "agent";
    toggle.appendChild(dot);
    toggle.appendChild(label);
    const refresh = () => {
      const on = isAgentEnabledForThread(rootId);
      toggle.dataset.state = on ? "on" : "off";
      toggle.title = on
        ? "Agent on for this thread — Enter posts and asks. Click to disable."
        : "Agent off for this thread — Enter posts a note. Click to enable.";
    };
    refresh();
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const on = isAgentEnabledForThread(rootId);
      setAgentEnabledForThread(rootId, !on);
      refresh();
      // Update the affected reply forms in-place. A full
      // renderCommentsPanel() would wipe any text the user has already
      // typed into a reply textarea in this thread.
      const newOn = isAgentEnabledForThread(rootId);
      const threadEl = commentsListEl.querySelector(
        `.comment-thread[data-thread-id="${CSS.escape(rootId)}"]`,
      );
      if (threadEl) {
        threadEl
          .querySelectorAll(".comment-reply-form button[type=submit]")
          .forEach((btn) => {
            btn.className = newOn
              ? "comment-action-btn ask-agent"
              : "comment-action-btn";
            btn.textContent = newOn ? "Ask Agent" : "Post";
          });
      }
    });
    toggle.addEventListener("dblclick", (e) => e.stopPropagation());
    return toggle;
  }

  // Small monospace pill that surfaces the comment's stable id (e.g. #c0007).
  // Click to copy — gives the user a handle they can paste into an external
  // agent ("look at #c0007") that resolves back via the comment MCP tools.
  function buildCommentIdChip(id) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "comment-id-chip";
    chip.textContent = "#" + id;
    chip.title = `Comment id ${id} — click to copy`;
    chip.setAttribute("aria-label", `Copy comment id ${id}`);
    chip.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(id);
      } catch {
        // Older browsers / insecure contexts — fall back to a hidden textarea.
        const ta = document.createElement("textarea");
        ta.value = id;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch {}
        document.body.removeChild(ta);
      }
      chip.classList.add("copied");
      const prev = chip.textContent;
      chip.textContent = "copied";
      setTimeout(() => {
        chip.textContent = prev;
        chip.classList.remove("copied");
      }, 900);
    });
    return chip;
  }

  function buildCommentRow(c, depth, autoOpenReply = false, rootId = null) {
    // Reply / Post behavior is governed by the THREAD's agent toggle, not
    // the row's. For top-level comments rootId === c.id.
    const threadRootId = rootId || c.id;
    const threadAgentOn = isAgentEnabledForThread(threadRootId);
    const row = document.createElement("div");
    row.className = "comment-row" + (c.resolved ? " resolved" : "") +
      (c.orphaned ? " orphaned" : "") +
      (c.failed ? " comment-failed" : "") +
      (depth > 0 ? " comment-reply" : "");
    row.dataset.commentId = c.id;

    // Top meta line: author chip, optional model, relative timestamp, then
    // hover-revealed action buttons on the right. The anchor preview lives
    // in the thread header — no need to repeat it here.
    const head = document.createElement("div");
    head.className = "comment-row-head";

    const authorTag = document.createElement("span");
    authorTag.className = "comment-author" +
      (c.author === "agent" ? " is-agent" : " is-user");
    authorTag.textContent = c.author || "user";
    head.appendChild(authorTag);

    head.appendChild(buildCommentIdChip(c.id));

    if (c.author === "agent" && c.model) {
      const modelTag = document.createElement("span");
      modelTag.className = "comment-model";
      modelTag.textContent = c.provider ? `${c.provider}/${c.model}` : c.model;
      head.appendChild(modelTag);
    }

    if (c.ts) {
      const tsTag = document.createElement("span");
      tsTag.className = "comment-ts";
      tsTag.textContent = formatCommentTime(c.ts);
      tsTag.title = new Date(c.ts).toLocaleString();
      head.appendChild(tsTag);
    }

    const spacer = document.createElement("span");
    spacer.className = "comment-head-spacer";
    head.appendChild(spacer);

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

    // Chronological flow: text segments and tool pills appear in the
    // order the agent produced them. Replaces the old "one text block +
    // pills below" layout.
    const flow = document.createElement("div");
    flow.className = "comment-msg-flow";
    row.appendChild(flow);
    const events = Array.isArray(c.events) ? c.events : null;
    if (events && events.length) {
      for (const ev of events) {
        if (ev.type === "text" && ev.text) {
          const seg = document.createElement("div");
          seg.className = "comment-text-segment";
          renderCommentTextWithMath(seg, ev.text);
          flow.appendChild(seg);
        } else if (ev.type === "tool_call") {
          upsertToolCallPill(c.id, {
            call_id: ev.id,
            name: ev.name,
            args: ev.args,
            result: ev.result,
            failed: !!ev.failed,
            runtime_ms: ev.runtime_ms,
            state: ev.failed ? "failed" : "done",
          }, row);
        }
      }
    } else if (c.message) {
      // Backward-compat for comments without an events log (older agent
      // replies, or user-authored comments which never have events).
      const seg = document.createElement("div");
      seg.className = "comment-text-segment";
      renderCommentTextWithMath(seg, c.message);
      flow.appendChild(seg);
    }
    if (c.streaming || streamingText.has(c.id)) {
      row.classList.add("comment-streaming");
    }
    // Author / model / timestamp now live in the top meta line; tool
    // calls replay is handled inline above via the `events` log, which
    // preserves their position relative to text segments.

    // Reply input — hidden until the reply button is clicked, OR
    // auto-opened when this row is the latest in its thread so the user
    // can just start typing the next message.
    const replyForm = document.createElement("form");
    replyForm.className = "comment-reply-form";
    replyForm.hidden = !autoOpenReply;
    const replyInput = document.createElement("textarea");
    replyInput.className = "comment-reply-input";
    replyInput.placeholder = "Write a reply…";
    replyInput.rows = 2;
    // Submit button. When the thread's agent toggle is on, this is the
    // primary "Ask Agent" action — same gold styling as the per-row
    // button used to have, so the action stands out from neutral Cancel.
    // When agent is off, it's a plain "Post" (just records a note).
    const replySubmit = document.createElement("button");
    replySubmit.className = threadAgentOn
      ? "comment-action-btn ask-agent"
      : "comment-action-btn";
    replySubmit.type = "submit";
    replySubmit.textContent = threadAgentOn ? "Ask Agent" : "Post";
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
    replyForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = replyInput.value;
      // Snapshot the thread's mode at submit time — by the time the POST
      // returns the user may have toggled the thread.
      const wantAgent = isAgentEnabledForThread(threadRootId);
      const hasText = !!text.trim();
      // Empty text + "Post" is a no-op; keep the form open so the user
      // can type. Empty text + "Ask Agent" is the natural retry gesture
      // (e.g. they just deleted a failed agent reply): re-request the
      // agent against this row's comment without creating a new one.
      if (!hasText && !wantAgent) return;
      replyInput.value = "";
      replyForm.hidden = true;
      let targetId = c.id;
      if (hasText) {
        const newId = await postReply(c.id, text);
        if (!newId) return;
        targetId = newId;
      }
      if (wantAgent) await requestApiResponse(targetId);
    });
    // Enter submits the reply; Shift+Enter inserts a newline. Other
    // modifier combos (Cmd/Ctrl/Alt+Enter) fall through to the textarea's
    // default behavior so they don't fight system-level shortcuts.
    replyInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (typeof replyForm.requestSubmit === "function") {
        replyForm.requestSubmit();
      } else {
        replyForm.dispatchEvent(new Event("submit", { cancelable: true }));
      }
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

  function countDescendants(rootId, byParent) {
    let n = 0;
    const stack = [rootId];
    while (stack.length) {
      const kids = byParent.get(stack.pop()) || [];
      n += kids.length;
      for (const k of kids) stack.push(k.id);
    }
    return n;
  }

  function buildCommentThread(root, byParent) {
    const thread = document.createElement("div");
    thread.className = "comment-thread";
    if (root.resolved) thread.classList.add("resolved");
    if (root.orphaned) thread.classList.add("orphaned");
    if (collapsedThreads.has(root.id)) thread.classList.add("collapsed");
    thread.dataset.threadId = root.id;

    const header = document.createElement("div");
    header.className = "comment-thread-header";
    header.title = "Click to collapse / expand";

    // Larger triangle, dedicated hit target. Clicking it ALWAYS toggles
    // collapse — never flashes the editor — so the user has a precise
    // affordance for collapse independent of the single/double-click
    // distinction on the rest of the bar.
    const chev = document.createElement("button");
    chev.className = "thread-chev";
    chev.type = "button";
    chev.setAttribute("aria-label", "Toggle thread");
    chev.title = "Collapse / expand thread";
    header.appendChild(chev);

    const anchorPreview = document.createElement("span");
    anchorPreview.className = "thread-anchor-preview";
    anchorPreview.textContent = commentAnchorPreview(root);
    header.appendChild(anchorPreview);

    // Streaming indicator: if any comment in the thread is mid-stream,
    // show a pulsing dot in the header so the user knows even when the
    // thread is collapsed.
    const threadIsStreaming = (function () {
      const stack = [root];
      while (stack.length) {
        const c = stack.pop();
        if (c.streaming || streamingText.has(c.id)) return true;
        const kids = byParent.get(c.id) || [];
        for (const k of kids) stack.push(k);
      }
      return false;
    })();
    if (threadIsStreaming) {
      const dot = document.createElement("span");
      dot.className = "thread-streaming-dot";
      dot.setAttribute("aria-hidden", "true");
      header.appendChild(dot);
    }

    const replyCount = countDescendants(root.id, byParent);
    if (replyCount > 0) {
      const count = document.createElement("span");
      count.className = "thread-reply-count";
      count.textContent = String(replyCount);
      count.title = `${replyCount} repl${replyCount === 1 ? "y" : "ies"}`;
      header.appendChild(count);
    }

    // "Show in editor" — explicit affordance, replaces the previous
    // double-click-on-header gesture so the single click on the header
    // can be an instant collapse with no disambiguation delay.
    const locateBtn = document.createElement("button");
    locateBtn.className = "thread-locate-btn";
    locateBtn.type = "button";
    locateBtn.title = "Show in editor";
    locateBtn.setAttribute("aria-label", "Show in editor");
    locateBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M 8 7 H 17 V 16"/><path d="M 7 17 L 17 7"/></svg>';
    locateBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      flashCommentRange(root);
    });
    locateBtn.addEventListener("dblclick", (e) => e.stopPropagation());
    header.appendChild(locateBtn);

    // Per-thread agent toggle in the header — controls the gold
    // "Ask Agent" affordance inside that thread's reply form.
    if (apiResponseEnabled) {
      header.appendChild(buildAgentTogglePill(root.id));
    }

    const toggleCollapsed = () => {
      const collapsed = thread.classList.toggle("collapsed");
      if (collapsed) collapsedThreads.add(root.id);
      else collapsedThreads.delete(root.id);
    };

    chev.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCollapsed();
    });
    chev.addEventListener("dblclick", (e) => {
      // Don't bubble — header dblclick would re-toggle and cancel.
      e.stopPropagation();
    });

    // Single click anywhere on the header collapses / expands. No
    // disambiguation delay — the "show in editor" affordance is a
    // dedicated button now, so there's no second gesture to wait for.
    header.addEventListener("click", (e) => {
      if (e.target.closest(".thread-chev, .thread-locate-btn, .thread-agent-toggle, .comment-action-btn")) return;
      toggleCollapsed();
    });

    thread.appendChild(header);

    const body = document.createElement("div");
    body.className = "comment-thread-body";
    thread.appendChild(body);

    return { thread, body };
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
    for (const t of tops) {
      if (!showResolved && t.resolved) continue;
      // Pick the latest comment in the thread (by timestamp) so we can
      // auto-open its reply box — the user almost always wants to type
      // the next message after a reply lands, so save them the click.
      // Skip auto-open on resolved threads: those are archived, not
      // active conversations.
      //
      // Tie-break: server timestamps have only second precision, so the
      // agent's streaming reply (created at run start) and a same-run
      // `add_comment` (fired ~ms later) often share a timestamp. When
      // they tie we want the LATER-INSERTED row to win — `state.comments`
      // is append-only, so iteration index in `docComments` is a
      // reliable tiebreaker (matches the conversation's actual order).
      let latestId = null;
      if (!t.resolved) {
        const threadIds = new Set([t.id]);
        const queue = [t.id];
        while (queue.length) {
          const id = queue.shift();
          for (const k of byParent.get(id) || []) {
            if (!threadIds.has(k.id)) {
              threadIds.add(k.id);
              queue.push(k.id);
            }
          }
        }
        let latestTs = -Infinity;
        let latestIdx = -1;
        for (let i = 0; i < docComments.length; i++) {
          const c = docComments[i];
          if (!threadIds.has(c.id)) continue;
          const ts = Date.parse(c.ts || "") || 0;
          if (ts > latestTs || (ts === latestTs && i > latestIdx)) {
            latestTs = ts;
            latestId = c.id;
            latestIdx = i;
          }
        }
      }
      const { thread, body } = buildCommentThread(t, byParent);
      function emit(c, depth) {
        body.appendChild(
          buildCommentRow(c, depth, c.id === latestId, t.id),
        );
        rendered++;
        const kids = byParent.get(c.id) || [];
        for (const k of kids) emit(k, depth + 1);
      }
      emit(t, 0);
      commentsListEl.appendChild(thread);
    }
    commentsEmptyEl.hidden = rendered > 0;
  }

  function updateCommentsBadge() {
    // Count top-level threads only — a "comment" in the user's mental
    // model is a thread, not each individual reply inside it. Resolving
    // the root of a thread is treated by the sidebar as resolving the
    // whole thread (it hides until "Show resolved" is toggled), so the
    // badge should drop by exactly that amount.
    const n = allComments.filter(
      (c) =>
        c.doc === editorActiveDoc &&
        !c.resolved &&
        !c.parent_id,
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

  // ---------- direct-API response (orchestral multi-provider) ----------
  // Server-side config: which providers are available (keys configured),
  // their default models, current spend, and any caps. Refreshed on demand
  // when an API call completes (so the indicator updates without polling).
  let apiResponseEnabled = false;
  let apiConfig = null;
  let modelCatalog = null; // { providers: { anthropic: [{model_id, friendly_name, …}], … } }
  const PICKER_STORAGE_KEY = "modelPick"; // "provider:model"

  // Per-thread agent toggle. Some threads are conversations with the
  // agent (Enter on reply = post + ask). Others are notes-to-self (Enter
  // = post only). We persist only the OFF threads — new threads default
  // to agent-on so the direct-API path acts the expected way.
  const AGENT_DISABLED_THREADS_KEY = "agentDisabledThreads";
  const agentDisabledThreads = new Set(
    lsGet(AGENT_DISABLED_THREADS_KEY, []),
  );
  function isAgentEnabledForThread(rootId) {
    return apiResponseEnabled && !agentDisabledThreads.has(rootId);
  }
  function setAgentEnabledForThread(rootId, enabled) {
    if (enabled) agentDisabledThreads.delete(rootId);
    else agentDisabledThreads.add(rootId);
    lsSet(AGENT_DISABLED_THREADS_KEY, Array.from(agentDisabledThreads));
  }

  function getPickedProviderModel() {
    if (!apiConfig) return null;
    const stored = lsGet(PICKER_STORAGE_KEY, null);
    if (stored && typeof stored === "string" && stored.includes(":")) {
      const [provider, ...rest] = stored.split(":");
      const model = rest.join(":");
      if (apiConfig.providers?.[provider]?.available) {
        return { provider, model };
      }
    }
    return {
      provider: apiConfig.default_provider,
      model: apiConfig.default_model,
    };
  }

  function setPickedProviderModel(provider, model) {
    lsSet(PICKER_STORAGE_KEY, `${provider}:${model}`);
  }

  function renderSpendIndicator() {
    const ind = $("spend-indicator");
    if (!ind || !apiConfig) return;
    const today = apiConfig.spend?.today_usd ?? 0;
    const session = apiConfig.spend?.session_usd ?? 0;
    const dailyLimit = apiConfig.spend_limits?.daily_usd;
    const sessionLimit = apiConfig.spend_limits?.session_usd;
    ind.textContent = `$${today.toFixed(today < 1 ? 4 : 2)} today`;
    ind.title =
      `Today: $${today.toFixed(4)}\n` +
      `Session: $${session.toFixed(4)}` +
      (dailyLimit != null ? `\nDaily limit: $${dailyLimit.toFixed(2)}` : "") +
      (sessionLimit != null ? `\nSession limit: $${sessionLimit.toFixed(2)}` : "");
    // Warn visually as we approach a limit.
    ind.classList.remove("spend-warn", "spend-over");
    if (dailyLimit != null) {
      if (today >= dailyLimit) ind.classList.add("spend-over");
      else if (today >= dailyLimit * 0.8) ind.classList.add("spend-warn");
    }
  }

  function renderModelPicker() {
    const picker = $("model-picker");
    const bar = $("comments-llm-bar");
    if (!picker || !bar || !apiConfig) return;
    if (!apiResponseEnabled) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const picked = getPickedProviderModel();
    picker.replaceChildren();

    const wantValue = picked ? `${picked.provider}:${picked.model}` : null;
    let firstAvailableValue = null;
    let exactMatchFound = false;

    const allProviders = Object.keys(apiConfig.providers || {});
    const configured = allProviders.filter(
      (n) => apiConfig.providers[n].available,
    );
    const unconfigured = allProviders.filter(
      (n) => !apiConfig.providers[n].available,
    );

    // === Configured providers: show full model list per provider. ===
    for (const name of configured) {
      const meta = apiConfig.providers[name];
      const group = document.createElement("optgroup");
      group.label = name;
      let options = [];
      const catModels = modelCatalog?.providers?.[name] || [];
      if (catModels.length) {
        options = catModels.map((m) => ({
          id: m.model_id,
          label: m.friendly_name || m.model_id,
        }));
      } else if (meta.default_model) {
        // Pre-catalog placeholder — instant render before lazy fetch.
        options = [{ id: meta.default_model, label: meta.default_model }];
      }
      for (const o of options) {
        const value = `${name}:${o.id}`;
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = o.label;
        if (value === wantValue) {
          opt.selected = true;
          exactMatchFound = true;
        }
        group.appendChild(opt);
        if (firstAvailableValue === null) firstAvailableValue = value;
      }
      if (options.length) picker.appendChild(group);
    }

    // === Unconfigured providers: ONE disabled hint per provider. Placed
    // as top-level <option> elements (no wrapping <optgroup>) so they
    // render at the same indentation as the configured optgroup labels
    // rather than being browser-indented as group children. ===
    if (unconfigured.length) {
      const sep = document.createElement("option");
      sep.disabled = true;
      sep.textContent = "set a key to enable —";
      picker.appendChild(sep);
      for (const name of unconfigured) {
        const meta = apiConfig.providers[name];
        const opt = document.createElement("option");
        opt.value = `__unconfigured:${name}`;
        opt.disabled = true;
        const needs = meta.kind === "openai"
          ? `set ${meta.host_env}`
          : `set ${meta.key_env || "API key"}`;
        opt.textContent = `${name} — ${needs}`;
        picker.appendChild(opt);
      }
    }

    if (!exactMatchFound && firstAvailableValue) {
      const fallback = picker.querySelector(
        `option[value="${CSS.escape(firstAvailableValue)}"]`,
      );
      if (fallback) fallback.selected = true;
    }
    picker.onchange = () => {
      const [provider, ...rest] = picker.value.split(":");
      if (provider === "__unconfigured") {
        // Bounce back to a real choice rather than persist a phantom.
        const fallback = firstAvailableValue ? picker.querySelector(
          `option[value="${CSS.escape(firstAvailableValue)}"]`,
        ) : null;
        if (fallback) {
          fallback.selected = true;
          const [p, ...r] = firstAvailableValue.split(":");
          setPickedProviderModel(p, r.join(":"));
        }
        return;
      }
      setPickedProviderModel(provider, rest.join(":"));
    };
    picker.addEventListener("focus", ensureModelCatalog, { once: true });
    picker.addEventListener("mousedown", ensureModelCatalog, { once: true });
  }

  async function refreshApiConfig() {
    try {
      const r = await fetch("/api/config");
      if (!r.ok) return;
      apiConfig = await r.json();
      apiResponseEnabled = !!apiConfig.api_response_enabled;
      renderModelPicker();
      renderSpendIndicator();
      renderCommentsPanel();
      // Eagerly fetch the full model catalog so the picker is populated
      // before the user opens it. The endpoint only walks configured
      // providers (~ms), so there's no SDK-import penalty.
      if (apiResponseEnabled) ensureModelCatalog();
    } catch {
      // ignore
    }
  }
  let catalogFetchInFlight = null;
  async function ensureModelCatalog() {
    if (modelCatalog) return modelCatalog;
    if (catalogFetchInFlight) return catalogFetchInFlight;
    catalogFetchInFlight = fetch("/api/config/models")
      .then((r) => (r.ok ? r.json() : { providers: {} }))
      .then((data) => {
        modelCatalog = data;
        renderModelPicker();
        return data;
      })
      .catch(() => ({ providers: {} }))
      .finally(() => {
        catalogFetchInFlight = null;
      });
    return catalogFetchInFlight;
  }
  refreshApiConfig();

  async function requestApiResponse(commentId) {
    const picked = getPickedProviderModel() || {};
    const body = picked.provider
      ? { provider: picked.provider, model: picked.model }
      : {};
    try {
      const r = await fetch(
        `/api/comments/${encodeURIComponent(commentId)}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) {
        const err = await r.text();
        if (r.status === 402) {
          alert(`Spend limit reached. ${err.slice(0, 300)}`);
        } else if (r.status === 503) {
          alert(`Provider unavailable on the server: ${err.slice(0, 300)}`);
        } else {
          alert(`API reply failed (${r.status}): ${err.slice(0, 200)}`);
        }
      }
    } catch (e) {
      alert(`API reply failed: ${e}`);
    }
    // Refresh totals after the call so the indicator reflects new spend.
    refreshApiConfig();
  }

  // ---------- Cmd+K inline prompt ----------
  // Highlight text in the editor, hit Cmd+K (or Ctrl+K) to drop a user
  // comment anchored to the selection. The popup floats over the editor
  // near the selection. Comment is created with author=user.
  let cmdkPromptEl = null;
  let cmdkOutsideHandler = null;
  function closeCmdkPrompt() {
    if (cmdkPromptEl) {
      cmdkPromptEl.remove();
      cmdkPromptEl = null;
    }
    if (cmdkOutsideHandler) {
      document.removeEventListener("mousedown", cmdkOutsideHandler, true);
      cmdkOutsideHandler = null;
    }
  }
  async function postUserComment(anchor, message) {
    if (!message.trim()) return null;
    const base = { message: message.trim(), author: "user" };
    const tryPost = (body) =>
      fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const body = { ...base };
    if (anchor && anchor.type === "selection" && anchor.excerpt) {
      body.excerpt = anchor.excerpt;
    } else if (anchor && anchor.type === "line" && anchor.line) {
      body.line = anchor.line;
    }
    try {
      let r = await tryPost(body);
      // Server requires the excerpt to appear EXACTLY ONCE for range
      // anchors (so the agent can re-anchor after edits). When that
      // fails — non-unique (409) or not found (404) — silently fall back
      // to a line anchor at the selection's start so the user's comment
      // still posts instead of throwing an opaque error.
      if (!r.ok && (r.status === 409 || r.status === 404)
          && anchor && anchor.line) {
        r = await tryPost({ ...base, line: anchor.line });
      }
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
    // Prefer a selection as the anchor; fall back to the current line so
    // Cmd+K is useful even without selecting first. We also always
    // capture the line the selection starts on so postUserComment can
    // fall back to a line anchor if the excerpt isn't unique in the doc.
    let sel = (editor.getSelection() || "").trim();
    let anchor;
    if (sel) {
      const from = editor.getCursor("from");
      anchor = {
        type: "selection",
        excerpt: sel,
        line: from.line + 1,
        lineText: editor.getLine(from.line) || "",
      };
    } else {
      const head = editor.getCursor("head");
      const lineText = editor.getLine(head.line) || "";
      anchor = { type: "line", excerpt: "", line: head.line + 1, lineText };
    }
    // Position the popup near the cursor head.
    const headPos = editor.getCursor("head");
    const coords = editor.charCoords(headPos, "window");
    const box = document.createElement("div");
    box.className = "cmdk-prompt";
    const snippet = document.createElement("div");
    snippet.className = "cmdk-prompt-snippet";
    if (anchor.type === "selection") {
      snippet.textContent = sel.length > 240 ? sel.slice(0, 237) + "…" : sel;
    } else {
      const lt = (anchor.lineText || "").trim();
      snippet.textContent = lt
        ? `line ${anchor.line}: ${lt.length > 200 ? lt.slice(0, 197) + "…" : lt}`
        : `line ${anchor.line} (empty)`;
    }
    box.appendChild(snippet);
    const input = document.createElement("textarea");
    input.className = "cmdk-prompt-input";
    input.placeholder = "Ask, suggest, or note…";
    // Match the editor's live (zoomable) font size so the prompt reads at
    // the same scale as the text it's acting on, not a fixed 13px.
    input.style.fontSize = editorFontSize + "px";
    box.appendChild(input);
    // Action bar: equal-width buttons spanning the popup bottom. Each
    // button labels itself with its keyboard shortcut inline, so we don't
    // need a separate hint line. All three share one visual style — no
    // primary/secondary distinction.
    const actions = document.createElement("div");
    actions.className = "cmdk-prompt-actions";

    const makeBtn = (label, shortcut, onClick) => {
      const btn = document.createElement("button");
      btn.className = "cmdk-prompt-btn";
      btn.type = "button";
      const lab = document.createElement("span");
      lab.textContent = label;
      btn.appendChild(lab);
      const kbd = document.createElement("span");
      kbd.className = "cmdk-shortcut";
      // Unicode key glyphs (↩, ⇧↩) need a larger size to read; word
      // shortcuts like "esc" stay at the smaller default caption size.
      if (/[↩⇧⌘⌥⌃]/.test(shortcut)) kbd.classList.add("is-glyph");
      kbd.textContent = shortcut;
      btn.appendChild(kbd);
      btn.addEventListener("click", onClick);
      return btn;
    };

    // Both action paths sticky the new thread's agent toggle to match
    // intent: "Comment" → agent off (notes thread); "Ask agent" → agent
    // on. Mirrors the Enter / Shift+Enter keybinding semantics above.
    actions.appendChild(makeBtn("Cancel", "esc", () => closeCmdkPrompt()));
    actions.appendChild(makeBtn("Comment", "↩", async () => {
      const message = input.value;
      closeCmdkPrompt();
      const id = await postUserComment(anchor, message);
      if (id && apiResponseEnabled) {
        setAgentEnabledForThread(id, false);
        renderCommentsPanel();
      }
    }));
    if (apiResponseEnabled) {
      actions.appendChild(makeBtn("Ask agent", "⇧↩", async () => {
        const message = input.value;
        closeCmdkPrompt();
        const id = await postUserComment(anchor, message);
        if (id) {
          setAgentEnabledForThread(id, true);
          renderCommentsPanel();
          await requestApiResponse(id);
        }
      }));
    }
    box.appendChild(actions);
    document.body.appendChild(box);
    cmdkPromptEl = box;
    // Position relative to the cursor while keeping the popup inside the
    // viewport. Measure post-append so the height reflects how the snippet
    // text wrapped (width is fixed by CSS, height isn't). Prefer below the
    // cursor; flip above when below would overflow; clamp to the closest
    // edge if neither fits (rare — only when the popup is taller than the
    // visible window).
    const VIEWPORT_MARGIN = 8;
    const popupRect = box.getBoundingClientRect();
    const popupH = popupRect.height;
    const popupW = popupRect.width;
    const belowTop = coords.bottom + 6;
    const aboveTop = coords.top - popupH - 6;
    const fitsBelow = belowTop + popupH + VIEWPORT_MARGIN <= window.innerHeight;
    const top = (fitsBelow || aboveTop < VIEWPORT_MARGIN)
      ? Math.min(belowTop, window.innerHeight - popupH - VIEWPORT_MARGIN)
      : aboveTop;
    const left = Math.min(coords.left, window.innerWidth - popupW - VIEWPORT_MARGIN);
    box.style.left = Math.max(VIEWPORT_MARGIN, left) + "px";
    box.style.top = Math.max(VIEWPORT_MARGIN, top) + "px";
    // Close on click outside. Capture phase so we intercept the press
    // before any handler the click would have hit (e.g. focusing the
    // editor) — feels snappier than waiting for the full click. Cmd+K
    // opens the popup via keydown, so there's no risk of the very click
    // that just opened it closing it again.
    cmdkOutsideHandler = (e) => {
      if (cmdkPromptEl && !cmdkPromptEl.contains(e.target)) {
        closeCmdkPrompt();
      }
    };
    document.addEventListener("mousedown", cmdkOutsideHandler, true);
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeCmdkPrompt();
      } else if (e.key === "Enter") {
        // Enter posts a plain comment; Shift+Enter additionally asks the
        // agent (when the API path is enabled). Multi-line entry isn't
        // supported via the keyboard here — the popup is sized for a
        // sentence or two; long messages go through the sidebar reply
        // form instead.
        e.preventDefault();
        const message = input.value;
        const wantApi = e.shiftKey && apiResponseEnabled;
        closeCmdkPrompt();
        const id = await postUserComment(anchor, message);
        if (id) {
          // Sticky the new thread's agent toggle to match the user's
          // choice at creation: plain Enter → agent off (notes mode);
          // Shift+Enter → agent on. Avoids surprising the user when
          // they later reply in a "note" thread and Enter suddenly
          // invokes the agent. The user can flip it via the toggle pill
          // at any time.
          if (apiResponseEnabled) {
            setAgentEnabledForThread(id, wantApi);
            renderCommentsPanel();
          }
          if (wantApi) await requestApiResponse(id);
        }
      }
    });
    requestAnimationFrame(() => input.focus());
  }

  editor.setOption("extraKeys", {
    ...(editor.getOption("extraKeys") || {}),
    "Cmd-K": () => openCmdkPrompt(),
    "Ctrl-K": () => openCmdkPrompt(),
    "Shift-Cmd-K": () => openCiteModal(extractKeyFromSelection(editor.getSelection())),
    "Shift-Ctrl-K": () => openCiteModal(extractKeyFromSelection(editor.getSelection())),
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
      renderCommentTextWithMath(msg, c.message);
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
      // Skip orphaned comments — the line number stored on the comment is
      // the LAST place the anchor was seen, not where it lives now. Painting
      // a dot there points at whatever unrelated text now occupies that
      // line. The sidebar still surfaces the orphaned thread, so dropping
      // the gutter mark doesn't hide the comment, just stops misleading.
      if (c.orphaned) continue;
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
      // Each page is now a .pdf-page-wrap containing the canvas (so the
      // link layer can overlay it). Look up the canvas by data-page-num
      // to be robust regardless of wrap structure.
      const canvas = previewEl.querySelector(
        `.pdf-page[data-page-num="${page}"]`,
      );
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
