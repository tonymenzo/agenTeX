import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { EditorState, Compartment } from "https://esm.sh/@codemirror/state@6.4.1";
import { StreamLanguage } from "https://esm.sh/@codemirror/language@6.10.2";
import { stex } from "https://esm.sh/@codemirror/legacy-modes@6.4.0/mode/stex";
import { oneDark } from "https://esm.sh/@codemirror/theme-one-dark@6.1.2";
import { keymap } from "https://esm.sh/@codemirror/view@6.28.6";
import { indentWithTab } from "https://esm.sh/@codemirror/commands@6.6.0";

const $ = (id) => document.getElementById(id);

const filenameEl = $("filename");
const statusEl = $("status");
const statusLabel = statusEl.querySelector(".label");
const previewEl = $("preview");
const errorEl = $("error");
const templatesEl = $("templates");

let currentHash = "";
let suppressNextChange = false;

function setStatus(stateName, label) {
  statusEl.dataset.state = stateName;
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

const view = new EditorView({
  parent: $("editor"),
  state: EditorState.create({
    doc: "",
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      StreamLanguage.define(stex),
      oneDark,
      EditorView.theme({
        "&": { backgroundColor: "var(--bg)" },
        ".cm-content": { caretColor: "var(--accent)" },
        ".cm-cursor": { borderLeftColor: "var(--accent)" },
        ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.025)" },
        ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
        ".cm-selectionBackground, ::selection": { backgroundColor: "rgba(139,158,255,0.22) !important" },
      }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        if (suppressNextChange) {
          suppressNextChange = false;
          return;
        }
        scheduleSave();
      }),
    ],
  }),
});

function applyDoc({ content, path, hash }) {
  if (path) filenameEl.textContent = path;
  if (hash) currentHash = hash;
  if (view.state.doc.toString() === content) return;
  suppressNextChange = true;
  const sel = view.state.selection;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    selection: sel,
    scrollIntoView: false,
  });
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(sendSave, 350);
}
function sendSave() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "save", content: view.state.doc.toString() }));
}

let socket = null;
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
    } else if (msg.type === "render_failed") {
      setStatus("error", "build error");
      setError(msg.log || "tectonic failed");
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
  } catch (e) {
    // silent — templates list is best-effort
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

loadTemplates();
connect();
