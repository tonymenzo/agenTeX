(() => {
  const $ = (id) => document.getElementById(id);
  const filenameEl = $("filename");
  const statusEl = $("status");
  const statusLabel = statusEl.querySelector(".label");
  const previewEl = $("preview");
  const errorEl = $("error");
  const templatesEl = $("templates");

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
    theme: "atexi",
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    tabSize: 2,
    matchBrackets: true,
    styleActiveLine: true,
    autofocus: true,
  });

  editor.on("change", () => {
    if (suppressNextChange) {
      suppressNextChange = false;
      return;
    }
    if (streaming) return;
    scheduleSave();
    unrendered = true;
    setStatus("modified", "⌘S to render");
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

  function applyDoc({ content, path }) {
    if (path) filenameEl.textContent = path;
    if (editor.getValue() === content) return;
    suppressNextChange = true;
    const cursor = editor.getCursor();
    const scroll = editor.getScrollInfo();
    editor.setValue(content);
    editor.setCursor(cursor);
    editor.scrollTo(scroll.left, scroll.top);
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
      if (msg.type === "doc") {
        applyDoc(msg);
      } else if (msg.type === "render_started") {
        setStatus("building", "rendering…");
      } else if (msg.type === "rendered") {
        setStatus("ok", "rendered");
        setError(null);
        previewEl.src = msg.url;
        unrendered = false;
      } else if (msg.type === "render_failed") {
        setStatus("error", "build error");
        setError(msg.log || "tectonic failed");
      } else if (msg.type === "stream_begin") {
        streamBegin(msg.from_index, msg.to_index);
      } else if (msg.type === "stream_char") {
        streamChar(msg.ch);
      } else if (msg.type === "stream_end") {
        streamEnd();
      }
    });
  }

  async function loadTemplates() {
    try {
      const r = await fetch("/api/templates");
      const names = await r.json();
      templatesEl.innerHTML = '<option value="">Templates…</option>';
      for (const n of names) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n;
        templatesEl.appendChild(o);
      }
    } catch (_) {
      // best-effort
    }
  }

  templatesEl.addEventListener("change", async () => {
    const name = templatesEl.value;
    if (!name) return;
    templatesEl.value = "";
    if (!confirm(`Replace current document with "${name}"?`)) return;
    await fetch(`/api/load-template/${encodeURIComponent(name)}`, { method: "POST" });
  });

  const divider = $("divider");
  let dragging = false;
  divider.addEventListener("mousedown", () => {
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const split = document.querySelector(".split");
    const rect = split.getBoundingClientRect();
    const ratio = Math.max(0.15, Math.min(0.85, (e.clientX - rect.left) / rect.width));
    split.style.gridTemplateColumns = `${ratio}fr 1px ${1 - ratio}fr`;
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
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
      requestRender();
    }
  });

  loadTemplates();
  connect();
  window.addEventListener("resize", () => editor.refresh());
})();
