import asyncio
import hashlib
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from watchdog.events import FileSystemEventHandler
from watchdog.observers.polling import PollingObserver

log = logging.getLogger("atexi")

ROOT = Path(__file__).parent
DOCS = ROOT / "docs"
TEMPLATES = ROOT / "templates"
BUILD = ROOT / ".build"
STATIC = ROOT / "static"
DEFAULT_DOC_NAME = "current.tex"
RENDER_DEBOUNCE = 0.4
DOC_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.(tex|bib)$")
DOC_GLOBS = ("*.tex", "*.bib")


def list_doc_names() -> list[str]:
    names: set[str] = set()
    for pattern in DOC_GLOBS:
        names.update(p.name for p in DOCS.glob(pattern))
    return sorted(names)


def doc_path(name: str) -> Path:
    if not DOC_NAME_RE.match(name):
        raise HTTPException(400, "invalid doc name")
    p = (DOCS / name).resolve()
    try:
        p.relative_to(DOCS.resolve())
    except ValueError:
        raise HTTPException(400, "invalid doc path")
    return p

for p in (DOCS, TEMPLATES, BUILD):
    p.mkdir(exist_ok=True)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class State:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.last_hash: str = ""
        self.last_pdf_hash: str = ""
        self.render_trigger: asyncio.Event = asyncio.Event()
        self.daemon_task: asyncio.Task | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        # The doc currently shown in the editor (can be .tex OR .bib).
        self.active_doc: Path = DOCS / DEFAULT_DOC_NAME
        # The .tex file the Render button compiles. Stays put when the user
        # switches to a .bib so that editing references still recompiles the
        # main draft.
        self.render_target: Path = DOCS / DEFAULT_DOC_NAME
        # True when the user has typed/saved in the browser since the last
        # agent tool call. Consumed (and reset) by every agent-facing endpoint.
        self.user_edits_pending: bool = False

    async def broadcast(self, message: dict) -> None:
        dead = []
        for ws in self.clients:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


state = State()


def consume_user_edit_flag() -> bool:
    flag = state.user_edits_pending
    state.user_edits_pending = False
    return flag


class DocWatcher(FileSystemEventHandler):
    def on_modified(self, event) -> None:
        if event.is_directory or state.loop is None:
            return
        if Path(event.src_path).resolve() == state.active_doc.resolve():
            asyncio.run_coroutine_threadsafe(handle_disk_change(), state.loop)

    def _list_change(self, event) -> None:
        if event.is_directory or state.loop is None:
            return
        if not DOC_NAME_RE.match(Path(event.src_path).name):
            return
        asyncio.run_coroutine_threadsafe(broadcast_doc_list(), state.loop)

    def on_created(self, event) -> None:
        self._list_change(event)

    def on_deleted(self, event) -> None:
        self._list_change(event)


async def broadcast_doc_list() -> None:
    await state.broadcast(
        {
            "type": "doc_list",
            "names": list_doc_names(),
            "active": state.active_doc.name,
            "render_target": state.render_target.name,
        }
    )


async def handle_disk_change() -> None:
    if not state.active_doc.exists():
        return
    data = state.active_doc.read_bytes()
    h = sha(data)
    if h == state.last_hash:
        return
    log.info("disk change: %s -> %s", state.last_hash[:8] or "(empty)", h[:8])
    state.last_hash = h
    content = data.decode("utf-8", errors="replace")
    await state.broadcast({"type": "doc", "content": content, "path": state.active_doc.name, "hash": h})
    schedule_render()


def schedule_render() -> None:
    state.render_trigger.set()


async def render_daemon() -> None:
    while True:
        await state.render_trigger.wait()
        state.render_trigger.clear()
        try:
            await asyncio.sleep(RENDER_DEBOUNCE)
        except asyncio.CancelledError:
            return
        # Absorb any triggers that arrived during the debounce window
        state.render_trigger.clear()
        try:
            await run_render()
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("render daemon: unexpected error")


async def run_render() -> None:
    target = state.render_target
    if not target.exists() or target.suffix != ".tex":
        return
    await state.broadcast({"type": "render_started"})
    proc = await asyncio.create_subprocess_exec(
        "tectonic",
        "-X",
        "compile",
        "--outdir",
        str(BUILD),
        "--keep-logs",
        str(target),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        err = (stderr or stdout).decode("utf-8", errors="replace")
        log.warning("render failed (rc=%d)", proc.returncode)
        await state.broadcast({"type": "render_failed", "log": err})
        return
    out = BUILD / (target.stem + ".pdf")
    if not out.exists():
        await state.broadcast({"type": "render_failed", "log": "tectonic produced no output"})
        return
    h = sha(out.read_bytes())
    state.last_pdf_hash = h
    log.info("rendered: %s -> %s", target.name, h[:8])
    await state.broadcast({"type": "rendered", "url": f"/api/pdf?h={h}", "target": target.name})


def _bootstrap_active_and_target() -> None:
    """Pick a sane active_doc and render_target on startup based on what
    exists in docs/. Creates the default doc if the directory is empty."""
    names = list_doc_names()
    if not names:
        default = DOCS / DEFAULT_DOC_NAME
        default.write_text(
            "\\documentclass[11pt]{article}\n"
            "\\begin{document}\n\n\\end{document}\n",
            encoding="utf-8",
        )
        names = [DEFAULT_DOC_NAME]

    tex_names = [n for n in names if n.endswith(".tex")]

    active_name = (
        DEFAULT_DOC_NAME if DEFAULT_DOC_NAME in names
        else (tex_names[0] if tex_names else names[0])
    )
    target_name = (
        DEFAULT_DOC_NAME if DEFAULT_DOC_NAME in tex_names
        else (tex_names[0] if tex_names else active_name)
    )
    state.active_doc = DOCS / active_name
    state.render_target = DOCS / target_name


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.loop = asyncio.get_running_loop()
    _bootstrap_active_and_target()
    if state.active_doc.exists():
        state.last_hash = sha(state.active_doc.read_bytes())
    observer = PollingObserver(timeout=0.3)
    observer.schedule(DocWatcher(), str(DOCS), recursive=False)
    observer.start()
    log.info(
        "watching %s (polling); active=%s target=%s",
        DOCS, state.active_doc.name, state.render_target.name,
    )
    state.daemon_task = asyncio.create_task(render_daemon())
    schedule_render()
    try:
        yield
    finally:
        if state.daemon_task:
            state.daemon_task.cancel()
        observer.stop()
        observer.join()


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/doc")
async def get_doc() -> dict:
    """Read-only doc fetch (used by the browser). Does not consume the user
    edit flag --- agents should use /api/doc/agent instead."""
    if not state.active_doc.exists():
        return {"path": state.active_doc.name, "content": "", "hash": ""}
    data = state.active_doc.read_bytes()
    return {
        "path": state.active_doc.name,
        "content": data.decode("utf-8", errors="replace"),
        "hash": sha(data),
    }


@app.get("/api/doc/agent")
async def get_doc_agent() -> dict:
    """Agent-side doc fetch. Returns content, hash, and user_edited_since
    flag, then resets the flag (the agent has now seen the user's edits)."""
    flag = consume_user_edit_flag()
    if not state.active_doc.exists():
        return {
            "path": state.active_doc.name,
            "content": "",
            "hash": "",
            "user_edited_since": flag,
        }
    data = state.active_doc.read_bytes()
    return {
        "path": state.active_doc.name,
        "content": data.decode("utf-8", errors="replace"),
        "hash": sha(data),
        "user_edited_since": flag,
    }


@app.get("/api/templates")
async def list_templates() -> list[str]:
    return sorted(p.name for p in TEMPLATES.glob("*.tex"))


@app.get("/api/docs")
async def get_docs() -> dict:
    return {
        "names": list_doc_names(),
        "active": state.active_doc.name,
        "render_target": state.render_target.name,
    }


async def set_active(name: str) -> dict:
    p = doc_path(name)
    if not p.exists():
        raise HTTPException(404, f"doc not found: {name}")
    state.active_doc = p
    if p.suffix == ".tex":
        state.render_target = p
    data = p.read_bytes()
    state.last_hash = sha(data)
    state.user_edits_pending = False

    await broadcast_doc_list()
    await state.broadcast(
        {
            "type": "doc",
            "content": data.decode("utf-8", errors="replace"),
            "path": p.name,
            "hash": state.last_hash,
        }
    )
    out = BUILD / (state.render_target.stem + ".pdf")
    if out.exists():
        pdf_hash = sha(out.read_bytes())
        state.last_pdf_hash = pdf_hash
        await state.broadcast(
            {"type": "rendered", "url": f"/api/pdf?h={pdf_hash}", "target": state.render_target.name}
        )
    return {"ok": True, "active": p.name, "render_target": state.render_target.name}


@app.post("/api/docs/active")
async def post_set_active(payload: dict) -> dict:
    name = payload.get("name")
    if not isinstance(name, str):
        raise HTTPException(400, "name required")
    return await set_active(name)


_TEMPLATE_TEX = "\\documentclass[11pt]{article}\n\\begin{document}\n\n\\end{document}\n"
_TEMPLATE_BIB = "% references\n"


@app.post("/api/docs/new")
async def post_new_doc(payload: dict) -> dict:
    name = payload.get("name")
    if not isinstance(name, str):
        raise HTTPException(400, "name required")
    template = payload.get("template")
    activate = bool(payload.get("activate", True))
    p = doc_path(name)
    if p.exists():
        raise HTTPException(409, f"doc already exists: {name}")

    if isinstance(template, str) and template:
        if "/" in template or ".." in template:
            raise HTTPException(400, "invalid template name")
        src = TEMPLATES / template
        if not src.is_file():
            raise HTTPException(404, f"template not found: {template}")
        content = src.read_text(encoding="utf-8")
    elif p.suffix == ".bib":
        content = _TEMPLATE_BIB
    else:
        content = _TEMPLATE_TEX

    p.write_text(content, encoding="utf-8")
    if activate:
        return await set_active(name)
    await broadcast_doc_list()
    return {"ok": True, "name": name}


@app.delete("/api/docs/{name}")
async def post_delete_doc(name: str) -> dict:
    p = doc_path(name)
    if not p.exists():
        raise HTTPException(404, f"doc not found: {name}")
    if p.resolve() == state.active_doc.resolve():
        raise HTTPException(409, "cannot delete the active doc; switch first")
    p.unlink()
    await broadcast_doc_list()
    return {"ok": True}


@app.get("/api/pdf")
async def pdf() -> FileResponse:
    out = BUILD / (state.render_target.stem + ".pdf")
    if not out.exists():
        raise HTTPException(404, "no pdf yet")
    return FileResponse(out, media_type="application/pdf")


def _resolve_insert_index(content: str, after_line: int | None) -> int:
    if after_line is None or after_line < 0:
        return len(content)
    lines = content.split("\n")
    if after_line >= len(lines):
        return len(content)
    return sum(len(line) + 1 for line in lines[: after_line + 1])


@app.post("/api/stream")
async def stream(payload: dict) -> dict:
    text = payload.get("text", "")
    if not isinstance(text, str):
        raise HTTPException(400, "text must be a string")
    delay_ms = max(0, int(payload.get("delay_ms", 15)))
    after_line = payload.get("after_line")
    if after_line is not None:
        try:
            after_line = int(after_line)
        except (TypeError, ValueError):
            raise HTTPException(400, "after_line must be an int")

    if not state.active_doc.exists():
        raise HTTPException(404, "no active doc")
    content = state.active_doc.read_text(encoding="utf-8")
    insert_index = _resolve_insert_index(content, after_line)

    log.info("stream: %d chars at index %d (delay=%dms)", len(text), insert_index, delay_ms)
    await state.broadcast({"type": "stream_begin", "from_index": insert_index})
    delay = delay_ms / 1000.0
    for ch in text:
        await state.broadcast({"type": "stream_char", "ch": ch})
        if delay:
            await asyncio.sleep(delay)

    new_content = content[:insert_index] + text + content[insert_index:]
    new_bytes = new_content.encode("utf-8")
    state.last_hash = sha(new_bytes)
    state.active_doc.write_bytes(new_bytes)
    await state.broadcast(
        {"type": "stream_end", "content": new_content, "hash": state.last_hash}
    )
    # Also send a canonical doc message so any client that missed chars
    # (or doesn't speak the stream_* protocol) lands on the right content.
    await state.broadcast(
        {
            "type": "doc",
            "content": new_content,
            "path": state.active_doc.name,
            "hash": state.last_hash,
        }
    )
    schedule_render()
    return {
        "ok": True,
        "chars": len(text),
        "insert_index": insert_index,
        "user_edited_since": consume_user_edit_flag(),
    }


async def _commit_and_broadcast(new_content: str) -> str:
    new_bytes = new_content.encode("utf-8")
    h = sha(new_bytes)
    state.last_hash = h
    state.active_doc.write_bytes(new_bytes)
    await state.broadcast(
        {"type": "doc", "content": new_content, "path": state.active_doc.name, "hash": h}
    )
    schedule_render()
    return h


@app.post("/api/edit")
async def edit_doc(payload: dict) -> dict:
    """Replace a unique occurrence of `find` with `replace` in the active doc.

    Broadcasts the change directly over the WebSocket -- never relies on the
    file watcher to detect agent edits. If `stream` is true, the replacement
    is animated character-by-character.
    """
    find_text = payload.get("find")
    replace_text = payload.get("replace", "")
    if not isinstance(find_text, str) or not find_text:
        raise HTTPException(400, "find required")
    if not isinstance(replace_text, str):
        raise HTTPException(400, "replace must be a string")
    stream_mode = bool(payload.get("stream", False))
    delay_ms = max(0, int(payload.get("delay_ms", 15)))

    if not state.active_doc.exists():
        raise HTTPException(404, "no active doc")
    content = state.active_doc.read_text(encoding="utf-8")
    idx = content.find(find_text)
    if idx < 0:
        raise HTTPException(404, "find not found in document")
    if content.find(find_text, idx + 1) >= 0:
        raise HTTPException(409, "find is not unique; provide more context")
    end_idx = idx + len(find_text)
    new_content = content[:idx] + replace_text + content[end_idx:]

    if stream_mode:
        log.info(
            "edit (stream): replace %d chars at %d with %d (delay=%dms)",
            len(find_text),
            idx,
            len(replace_text),
            delay_ms,
        )
        await state.broadcast(
            {"type": "stream_begin", "from_index": idx, "to_index": end_idx}
        )
        delay = delay_ms / 1000.0
        for ch in replace_text:
            await state.broadcast({"type": "stream_char", "ch": ch})
            if delay:
                await asyncio.sleep(delay)
        h = await _commit_and_broadcast(new_content)
        await state.broadcast({"type": "stream_end", "content": new_content, "hash": h})
    else:
        log.info(
            "edit: replace %d chars at %d with %d",
            len(find_text),
            idx,
            len(replace_text),
        )
        await _commit_and_broadcast(new_content)

    return {
        "ok": True,
        "from_index": idx,
        "to_index": end_idx,
        "chars": len(replace_text),
        "user_edited_since": consume_user_edit_flag(),
    }


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    state.clients.add(ws)
    try:
        await ws.send_json(
            {
                "type": "doc_list",
                "names": list_doc_names(),
                "active": state.active_doc.name,
                "render_target": state.render_target.name,
            }
        )
        if state.active_doc.exists():
            data = state.active_doc.read_bytes()
            await ws.send_json(
                {
                    "type": "doc",
                    "content": data.decode("utf-8", errors="replace"),
                    "path": state.active_doc.name,
                    "hash": sha(data),
                }
            )
        out = BUILD / (state.render_target.stem + ".pdf")
        if out.exists():
            pdf_hash = state.last_pdf_hash or sha(out.read_bytes())
            state.last_pdf_hash = pdf_hash
            await ws.send_json(
                {"type": "rendered", "url": f"/api/pdf?h={pdf_hash}", "target": state.render_target.name}
            )
        while True:
            msg = await ws.receive_json()
            kind = msg.get("type")
            if kind == "save":
                content = msg.get("content", "")
                data = content.encode("utf-8")
                if sha(data) == state.last_hash:
                    continue
                state.active_doc.write_bytes(data)
                state.last_hash = sha(data)
                state.user_edits_pending = True
                # Deliberately NOT scheduling a render here. The user must
                # press Cmd/Ctrl-S in the browser to trigger one (we get a
                # 'render' message), so typing doesn't thrash tectonic.
            elif kind == "render":
                schedule_render()
            elif kind == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        state.clients.discard(ws)


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("ATEXI_HOST", "127.0.0.1")
    port = int(os.environ.get("ATEXI_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, log_level="info")
