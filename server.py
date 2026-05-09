import asyncio
import hashlib
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

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
        self.render_task: asyncio.Task | None = None
        self.loop: asyncio.AbstractEventLoop | None = None

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
    state.last_hash = h
    content = data.decode("utf-8", errors="replace")
    await state.broadcast({"type": "doc", "content": content, "path": ACTIVE_DOC.name, "hash": h})
    schedule_render()


def schedule_render() -> None:
    if state.render_task and not state.render_task.done():
        state.render_task.cancel()
    state.render_task = asyncio.create_task(render_after_delay())


async def render_after_delay() -> None:
    try:
        await asyncio.sleep(RENDER_DEBOUNCE)
    except asyncio.CancelledError:
        return
    await run_render()


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
        log = (stderr or stdout).decode("utf-8", errors="replace")
        await state.broadcast({"type": "render_failed", "log": log})
        return
    out = BUILD / (ACTIVE_DOC.stem + ".pdf")
    if not out.exists():
        await state.broadcast({"type": "render_failed", "log": "tectonic produced no output"})
        return
    h = sha(out.read_bytes())
    await state.broadcast({"type": "rendered", "url": f"/api/pdf?h={h}"})


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.loop = asyncio.get_running_loop()
    if ACTIVE_DOC.exists():
        state.last_hash = sha(ACTIVE_DOC.read_bytes())
    observer = Observer()
    observer.schedule(DocWatcher(), str(DOCS), recursive=False)
    observer.start()
    schedule_render()
    try:
        yield
    finally:
        observer.stop()
        observer.join()


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/doc")
async def get_doc() -> dict:
    if not ACTIVE_DOC.exists():
        return {"path": ACTIVE_DOC.name, "content": "", "hash": ""}
    data = ACTIVE_DOC.read_bytes()
    return {
        "path": ACTIVE_DOC.name,
        "content": data.decode("utf-8", errors="replace"),
        "hash": sha(data),
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
                schedule_render()
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
