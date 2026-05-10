import asyncio
import hashlib
import json
import logging
import os
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
ACTIVE_DOC = DOCS / "current.tex"
RENDER_DEBOUNCE = 0.4

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
        if event.is_directory:
            return
        if Path(event.src_path).resolve() != ACTIVE_DOC.resolve():
            return
        if state.loop is None:
            return
        asyncio.run_coroutine_threadsafe(handle_disk_change(), state.loop)


async def handle_disk_change() -> None:
    if not ACTIVE_DOC.exists():
        return
    data = ACTIVE_DOC.read_bytes()
    h = sha(data)
    if h == state.last_hash:
        return
    log.info("disk change: %s -> %s", state.last_hash[:8] or "(empty)", h[:8])
    state.last_hash = h
    content = data.decode("utf-8", errors="replace")
    await state.broadcast({"type": "doc", "content": content, "path": ACTIVE_DOC.name, "hash": h})
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
    if not ACTIVE_DOC.exists():
        return
    await state.broadcast({"type": "render_started"})
    proc = await asyncio.create_subprocess_exec(
        "tectonic",
        "-X",
        "compile",
        "--outdir",
        str(BUILD),
        "--keep-logs",
        str(ACTIVE_DOC),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        err = (stderr or stdout).decode("utf-8", errors="replace")
        log.warning("render failed (rc=%d)", proc.returncode)
        await state.broadcast({"type": "render_failed", "log": err})
        return
    out = BUILD / (ACTIVE_DOC.stem + ".pdf")
    if not out.exists():
        await state.broadcast({"type": "render_failed", "log": "tectonic produced no output"})
        return
    h = sha(out.read_bytes())
    state.last_pdf_hash = h
    log.info("rendered: %s", h[:8])
    await state.broadcast({"type": "rendered", "url": f"/api/pdf?h={h}"})


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.loop = asyncio.get_running_loop()
    if ACTIVE_DOC.exists():
        state.last_hash = sha(ACTIVE_DOC.read_bytes())
    observer = PollingObserver(timeout=0.3)
    observer.schedule(DocWatcher(), str(DOCS), recursive=False)
    observer.start()
    log.info("watching %s (polling)", DOCS)
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
    if not ACTIVE_DOC.exists():
        return {"path": ACTIVE_DOC.name, "content": "", "hash": ""}
    data = ACTIVE_DOC.read_bytes()
    return {
        "path": ACTIVE_DOC.name,
        "content": data.decode("utf-8", errors="replace"),
        "hash": sha(data),
    }


@app.get("/api/doc/agent")
async def get_doc_agent() -> dict:
    """Agent-side doc fetch. Returns content, hash, and user_edited_since
    flag, then resets the flag (the agent has now seen the user's edits)."""
    flag = consume_user_edit_flag()
    if not ACTIVE_DOC.exists():
        return {
            "path": ACTIVE_DOC.name,
            "content": "",
            "hash": "",
            "user_edited_since": flag,
        }
    data = ACTIVE_DOC.read_bytes()
    return {
        "path": ACTIVE_DOC.name,
        "content": data.decode("utf-8", errors="replace"),
        "hash": sha(data),
        "user_edited_since": flag,
    }


@app.get("/api/templates")
async def list_templates() -> list[str]:
    return sorted(p.name for p in TEMPLATES.glob("*.tex"))


@app.post("/api/load-template/{name}")
async def load_template(name: str) -> dict:
    if "/" in name or ".." in name:
        raise HTTPException(400, "invalid name")
    src = TEMPLATES / name
    if not src.is_file():
        raise HTTPException(404, "template not found")
    data = src.read_bytes()
    ACTIVE_DOC.write_bytes(data)
    state.last_hash = sha(data)
    content = data.decode("utf-8", errors="replace")
    await state.broadcast({"type": "doc", "content": content, "path": ACTIVE_DOC.name, "hash": state.last_hash})
    schedule_render()
    return {"ok": True}


@app.get("/api/pdf")
async def pdf() -> FileResponse:
    out = BUILD / (ACTIVE_DOC.stem + ".pdf")
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

    if not ACTIVE_DOC.exists():
        raise HTTPException(404, "no active doc")
    content = ACTIVE_DOC.read_text(encoding="utf-8")
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
    ACTIVE_DOC.write_bytes(new_bytes)
    await state.broadcast(
        {"type": "stream_end", "content": new_content, "hash": state.last_hash}
    )
    # Also send a canonical doc message so any client that missed chars
    # (or doesn't speak the stream_* protocol) lands on the right content.
    await state.broadcast(
        {
            "type": "doc",
            "content": new_content,
            "path": ACTIVE_DOC.name,
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
    ACTIVE_DOC.write_bytes(new_bytes)
    await state.broadcast(
        {"type": "doc", "content": new_content, "path": ACTIVE_DOC.name, "hash": h}
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

    if not ACTIVE_DOC.exists():
        raise HTTPException(404, "no active doc")
    content = ACTIVE_DOC.read_text(encoding="utf-8")
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
        if ACTIVE_DOC.exists():
            data = ACTIVE_DOC.read_bytes()
            await ws.send_json(
                {
                    "type": "doc",
                    "content": data.decode("utf-8", errors="replace"),
                    "path": ACTIVE_DOC.name,
                    "hash": sha(data),
                }
            )
        out = BUILD / (ACTIVE_DOC.stem + ".pdf")
        if out.exists():
            pdf_hash = state.last_pdf_hash or sha(out.read_bytes())
            state.last_pdf_hash = pdf_hash
            await ws.send_json({"type": "rendered", "url": f"/api/pdf?h={pdf_hash}"})
        while True:
            msg = await ws.receive_json()
            kind = msg.get("type")
            if kind == "save":
                content = msg.get("content", "")
                data = content.encode("utf-8")
                if sha(data) == state.last_hash:
                    continue
                ACTIVE_DOC.write_bytes(data)
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
