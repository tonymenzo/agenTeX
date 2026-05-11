import asyncio
import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timezone
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
AGENTEX = ROOT / ".agentex"
SNAPSHOTS = AGENTEX / "snapshots"
TIMELINE_LOG = AGENTEX / "timeline.jsonl"
AGENTEX_CONFIG = AGENTEX / "config.json"
DEFAULT_DOC_NAME = "current.tex"
RENDER_DEBOUNCE = 0.4
# A relative path under DOCS made of slash-separated segments. Each segment
# matches [A-Za-z0-9._-]+; the final segment must end in one of the allowed
# suffixes. ".." segments are rejected by _check_segments below.
DOC_NAME_RE = re.compile(r"^(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\.(tex|bib|md|txt)$")
DIR_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$")
DOC_GLOBS = ("**/*.tex", "**/*.bib", "**/*.md", "**/*.txt")
RENDERABLE_SUFFIXES = (".tex", ".md")


def _check_segments(name: str) -> bool:
    """Reject '.' and '..' segments. The regexes allow them through because
    both match [A-Za-z0-9._-]+; this is the explicit no-escape check."""
    return all(seg not in (".", "..") for seg in name.split("/"))


def list_doc_names() -> list[str]:
    names: set[str] = set()
    docs_resolved = DOCS.resolve()
    for pattern in DOC_GLOBS:
        for p in DOCS.glob(pattern):
            try:
                rel = p.resolve().relative_to(docs_resolved)
            except ValueError:
                continue
            names.add(rel.as_posix())
    return sorted(names)


def list_doc_dirs() -> list[str]:
    """Every subdirectory of DOCS, as forward-slash relative paths. Empty
    string (DOCS itself) is excluded — the frontend treats it as the root."""
    out: list[str] = []
    docs_resolved = DOCS.resolve()
    for p in DOCS.rglob("*"):
        if not p.is_dir():
            continue
        try:
            rel = p.resolve().relative_to(docs_resolved)
        except ValueError:
            continue
        out.append(rel.as_posix())
    return sorted(out)


def rel_name(p: Path) -> str:
    """Return a doc's path relative to DOCS, with forward slashes. This is
    the canonical identifier used in WebSocket messages and the frontend."""
    try:
        return p.resolve().relative_to(DOCS.resolve()).as_posix()
    except ValueError:
        return p.name


def doc_path(name: str) -> Path:
    if not DOC_NAME_RE.match(name) or not _check_segments(name):
        raise HTTPException(400, "invalid doc name")
    p = (DOCS / name).resolve()
    try:
        p.relative_to(DOCS.resolve())
    except ValueError:
        raise HTTPException(400, "invalid doc path")
    return p


def dir_path(name: str) -> Path:
    if not DIR_NAME_RE.match(name) or not _check_segments(name):
        raise HTTPException(400, "invalid directory name")
    p = (DOCS / name).resolve()
    try:
        p.relative_to(DOCS.resolve())
    except ValueError:
        raise HTTPException(400, "invalid directory path")
    return p

for p in (DOCS, TEMPLATES, BUILD, AGENTEX, SNAPSHOTS):
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
        # Timeline: who made the most recent edit since the last snapshot.
        # Set by /api/edit and /api/stream (-> "agent") and the WS save handler
        # (-> "user"). Read by run_render when it emits a snapshot.
        self.last_edit_author: str = "user"
        # Per-doc last-snapshotted hash. Used to skip identical snapshots.
        self.last_snapshot_hash: dict[str, str] = {}
        # Toggle for snapshot collection. Loaded from .agentex/config.json at
        # startup, persisted there when changed via the UI.
        self.timeline_enabled: bool = True

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
        if state.loop is None:
            return
        # Directory events (create/delete a subfolder) always refresh the list.
        if event.is_directory:
            asyncio.run_coroutine_threadsafe(broadcast_doc_list(), state.loop)
            return
        # For file events, only refresh if the path (relative to DOCS) would
        # actually appear in the listing. Avoids spurious broadcasts from
        # editor scratch files or hidden dotfiles.
        try:
            rel = Path(event.src_path).resolve().relative_to(DOCS.resolve()).as_posix()
        except ValueError:
            return
        if not DOC_NAME_RE.match(rel) or not _check_segments(rel):
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
            "dirs": list_doc_dirs(),
            "active": rel_name(state.active_doc),
            "render_target": rel_name(state.render_target),
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
    await state.broadcast({"type": "doc", "content": content, "path": rel_name(state.active_doc), "hash": h})
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


def pdf_path_for(target: Path) -> Path:
    """Mirror the source layout under BUILD so docs/chapters/intro.tex and
    docs/appendix/intro.tex don't collide on a flat BUILD/intro.pdf."""
    rel = Path(rel_name(target))
    return BUILD / rel.with_suffix(".pdf")


def _migrate_path(p: Path, src: Path, dest: Path, is_dir: bool) -> Path:
    """Where does p end up after src has been renamed to dest? Handles both
    the exact-match case (file rename) and the under-prefix case (the file
    lives inside a renamed directory)."""
    if is_dir:
        try:
            rel = p.relative_to(src)
            return dest if str(rel) == "." else dest / rel
        except ValueError:
            return p
    return dest if p == src else p


def _pick_fallback() -> tuple[Path, Path] | tuple[None, None]:
    """Pick the next sensible active_doc / render_target when the current
    one has been deleted out from under us. Returns (None, None) when docs/
    is empty — caller should re-bootstrap."""
    names = list_doc_names()
    if not names:
        return None, None
    active = DOCS / names[0]
    renderables = [n for n in names if Path(n).suffix in RENDERABLE_SUFFIXES]
    render = DOCS / renderables[0] if renderables else active
    return active, render


# ---------- timeline / snapshots ----------
def load_timeline_pref() -> bool:
    if not AGENTEX_CONFIG.exists():
        return True
    try:
        with AGENTEX_CONFIG.open("r", encoding="utf-8") as f:
            cfg = json.load(f) or {}
        return bool(cfg.get("timeline_enabled", True))
    except (json.JSONDecodeError, OSError):
        return True


def save_timeline_pref(enabled: bool) -> None:
    try:
        cfg: dict = {}
        if AGENTEX_CONFIG.exists():
            with AGENTEX_CONFIG.open("r", encoding="utf-8") as f:
                cfg = json.load(f) or {}
        cfg["timeline_enabled"] = enabled
        with AGENTEX_CONFIG.open("w", encoding="utf-8") as f:
            json.dump(cfg, f)
    except OSError:
        pass


def take_snapshot(doc_path: Path, author: str, trigger: str) -> dict | None:
    """Persist a content-addressable snapshot of `doc_path` and append a
    timeline entry. Returns the entry, or None if skipped (timeline disabled,
    doc missing, or content unchanged since the last snapshot)."""
    if not state.timeline_enabled:
        return None
    if not doc_path.exists():
        return None
    content = doc_path.read_bytes()
    if not content:
        return None
    h = sha(content)
    doc_rel = rel_name(doc_path)
    if state.last_snapshot_hash.get(doc_rel) == h:
        return None
    state.last_snapshot_hash[doc_rel] = h
    snapshot_file = SNAPSHOTS / f"{h}.txt"
    if not snapshot_file.exists():
        try:
            snapshot_file.write_bytes(content)
        except OSError:
            return None
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "doc": doc_rel,
        "author": author,
        "trigger": trigger,
        "hash": h,
        "bytes": len(content),
    }
    try:
        with TIMELINE_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        return None
    return entry


def read_timeline(limit: int = 200) -> list[dict]:
    if not TIMELINE_LOG.exists():
        return []
    try:
        with TIMELINE_LOG.open("r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return []
    out: list[dict] = []
    for line in lines[-limit:][::-1]:  # newest first
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


async def _broadcast_active_doc() -> None:
    """Push the active doc's current content + render state to all clients.
    Used after delete/move so the editor lands on the new doc without
    waiting for a separate doc fetch."""
    if state.active_doc.exists():
        data = state.active_doc.read_bytes()
        state.last_hash = sha(data)
        state.user_edits_pending = False
        await state.broadcast(
            {
                "type": "doc",
                "content": data.decode("utf-8", errors="replace"),
                "path": rel_name(state.active_doc),
                "hash": state.last_hash,
            }
        )
    await broadcast_existing_render()


_TECTONIC_LINE_RE = re.compile(r"^l\.(\d+)\s*(.*)$")


def parse_tectonic_errors(log_text: str) -> list[dict]:
    """Extract {line, message, snippet} from tectonic's stderr/stdout.

    Errors look like:
        ! Undefined control sequence.
        l.42 \\unknownmacro

    We track the most recent '! ...' message and pair it with the next 'l.NN'.
    Covers the ~80% case; obscure multi-line traces fall through silently."""
    errors: list[dict] = []
    last_bang = None
    for raw in log_text.splitlines():
        line = raw.rstrip()
        if line.startswith("! "):
            last_bang = line[2:].rstrip(".")
            continue
        m = _TECTONIC_LINE_RE.match(line)
        if not m:
            continue
        try:
            ln = int(m.group(1))
        except ValueError:
            continue
        errors.append(
            {
                "line": ln,
                "message": last_bang or "LaTeX error",
                "snippet": (m.group(2) or "").strip(),
            }
        )
        last_bang = None
    return errors


async def run_render() -> None:
    target = state.render_target
    if not target.exists():
        return
    target_rel = rel_name(target)
    if target.suffix == ".md":
        await state.broadcast({"type": "render_started"})
        log.info("rendered (md): %s", target_rel)
        await state.broadcast(
            {
                "type": "rendered_md",
                "content": target.read_text(encoding="utf-8"),
                "target": target_rel,
            }
        )
        take_snapshot(target, state.last_edit_author, "render")
        return
    if target.suffix != ".tex":
        return
    out = pdf_path_for(target)
    out_dir = out.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    await state.broadcast({"type": "render_started"})
    proc = await asyncio.create_subprocess_exec(
        "tectonic",
        "-X",
        "compile",
        "--outdir",
        str(out_dir),
        "--keep-logs",
        "--synctex",
        str(target),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        err = (stderr or stdout).decode("utf-8", errors="replace")
        log.warning("render failed (rc=%d)", proc.returncode)
        errors = parse_tectonic_errors(err)
        await state.broadcast(
            {"type": "render_failed", "log": err, "errors": errors}
        )
        return
    if not out.exists():
        await state.broadcast({"type": "render_failed", "log": "tectonic produced no output"})
        return
    h = sha(out.read_bytes())
    state.last_pdf_hash = h
    log.info("rendered: %s -> %s", target_rel, h[:8])
    await state.broadcast({"type": "rendered", "url": f"/api/pdf?h={h}", "target": target_rel})
    take_snapshot(target, state.last_edit_author, "render")


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

    renderables = [n for n in names if Path(n).suffix in RENDERABLE_SUFFIXES]

    active_name = (
        DEFAULT_DOC_NAME if DEFAULT_DOC_NAME in names
        else (renderables[0] if renderables else names[0])
    )
    target_name = (
        DEFAULT_DOC_NAME if DEFAULT_DOC_NAME in renderables
        else (renderables[0] if renderables else active_name)
    )
    state.active_doc = DOCS / active_name
    state.render_target = DOCS / target_name


# ---------- SyncTeX ----------
# Tectonic emits a .synctex.gz sibling to each .pdf when --synctex is on.
# We parse it once per file and cache by mtime; the parsed tree is just a
# {page: [boxes]} structure, where each box is (file_idx, line, x, y, w, h)
# in scaled points (1 sp = 1/65536 pt).
_SP_PER_PT = 65536
_synctex_cache: dict[Path, tuple[float, dict]] = {}


def _parse_synctex_record(line: str):
    """Parse one box/atom record. Returns (file_idx, line_num, x, y, w, h)
    in scaled points, or None if the line is not a positional record."""
    if not line or line[0] not in "([hvxkg$rb":
        return None
    rest = line[1:]
    try:
        head, _, tail = rest.partition(":")
        if not head or not tail:
            return None
        head_parts = head.split(",")
        if len(head_parts) < 2:
            return None
        file_idx = int(head_parts[0])
        line_num = int(head_parts[1])
        if ":" in tail:
            pos, _, size = tail.partition(":")
        else:
            pos, size = tail, ""
        pos_parts = pos.split(",")
        if len(pos_parts) < 2:
            return None
        x = int(pos_parts[0])
        y = int(pos_parts[1])
        if size:
            size_parts = size.split(",")
            w = int(size_parts[0]) if len(size_parts) >= 1 else 0
            h = int(size_parts[1]) if len(size_parts) >= 2 else 0
        else:
            w, h = 0, 0
        return (file_idx, line_num, x, y, w, h)
    except (ValueError, IndexError):
        return None


def parse_synctex_file(path: Path) -> dict:
    files: dict[int, str] = {}
    pages: dict[int, list] = {}
    current_page = None
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\r\n")
            if not line:
                continue
            if line.startswith("Input:"):
                rest = line[len("Input:"):]
                idx_str, _, file_path = rest.partition(":")
                try:
                    files[int(idx_str)] = file_path
                except ValueError:
                    pass
                continue
            # Pages are delimited by `{N ... }N`. Tectonic writes the page
            # number after the closing brace too, so check startswith.
            if line.startswith("{"):
                rest = line[1:].strip()
                if rest.isdigit():
                    current_page = int(rest)
                    pages.setdefault(current_page, [])
                continue
            if line.startswith("}"):
                current_page = None
                continue
            if current_page is None:
                continue
            rec = _parse_synctex_record(line)
            if rec is not None:
                pages[current_page].append(rec)
    return {"files": files, "pages": pages}


def get_synctex(synctex_path: Path) -> dict | None:
    if not synctex_path.exists():
        return None
    try:
        mtime = synctex_path.stat().st_mtime
    except OSError:
        return None
    cached = _synctex_cache.get(synctex_path)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        parsed = parse_synctex_file(synctex_path)
    except OSError:
        return None
    _synctex_cache[synctex_path] = (mtime, parsed)
    return parsed


def synctex_inverse(parsed: dict, page: int, x_pt: float, y_pt: float) -> dict | None:
    """PDF (x, y) in points → {file, line} of the most specific source
    location whose rendered output contains that point.

    SyncTeX boxes: origin top-left of page, y grows downward. (bx, by) is
    the bottom-left of the box's rectangle, so the rectangle covers
    x ∈ [bx, bx+bw] and y ∈ [by-bh, by]. Thin atoms (h, k, g) have bw/bh = 0
    and just mark a position.

    Algorithm:
      1. Find the smallest positive-area box that contains the click.
      2. Look inside that box for thin atoms (or smaller boxes) with a
         *smaller* line number — TeX reports paragraph-level boxes at the
         line of the paragraph break, but the actual content sits at the
         lines before. Those interior atoms tell us what the user really
         clicked on.
      3. Fall back to the nearest record by Euclidean distance if no
         positive-area box contains the click."""
    boxes = parsed["pages"].get(page, [])
    if not boxes:
        return None
    x = x_pt * _SP_PER_PT
    y = y_pt * _SP_PER_PT

    container = None
    container_area = float("inf")
    for rec in boxes:
        f, ln, bx, by, bw, bh = rec
        if bw <= 0 or bh <= 0:
            continue
        if not (bx <= x <= bx + bw):
            continue
        if not (by - bh <= y <= by):
            continue
        area = bw * bh
        if area < container_area:
            container_area = area
            container = rec

    if container is not None:
        cf, cln, cbx, cby, cbw, cbh = container
        best_line = cln
        # Look for inner atoms (same file, smaller line, inside the container's
        # rect) that pinpoint the actual content line.
        for (f2, ln2, bx2, by2, bw2, bh2) in boxes:
            if f2 != cf or ln2 >= best_line:
                continue
            if bx2 < cbx or bx2 > cbx + cbw:
                continue
            if by2 < cby - cbh or by2 > cby:
                continue
            best_line = ln2
        return {"file": parsed["files"].get(cf, ""), "line": best_line}

    # No box contains the click — fall back to nearest by record position.
    # Use the record's anchor point (bx, by), not its center: box centers can
    # be far from the actual content for tall paragraph boxes.
    best = None
    best_d = float("inf")
    for (f, ln, bx, by, bw, bh) in boxes:
        dx = bx - x
        dy = by - y
        d = dx * dx + dy * dy
        if d < best_d:
            best_d = d
            best = (f, ln)
    if best is None:
        return None
    f, ln = best
    return {"file": parsed["files"].get(f, ""), "line": ln}


def synctex_forward(parsed: dict, source_file: str, line: int) -> list[dict]:
    try:
        target_resolved = str(Path(source_file).resolve())
    except OSError:
        target_resolved = source_file
    src_idx = None
    for idx, p in parsed["files"].items():
        try:
            if str(Path(p).resolve()) == target_resolved:
                src_idx = idx
                break
        except OSError:
            pass
        if p == source_file or p == target_resolved:
            src_idx = idx
            break
    if src_idx is None:
        return []
    out = []
    for page_num, boxes in parsed["pages"].items():
        for (f, ln, bx, by, bw, bh) in boxes:
            if f == src_idx and ln == line:
                out.append(
                    {
                        "page": page_num,
                        "x": bx / _SP_PER_PT,
                        "y": by / _SP_PER_PT,
                        "w": bw / _SP_PER_PT,
                        "h": bh / _SP_PER_PT,
                    }
                )
    return out


def _source_stem_for_build(rel: Path) -> Path | None:
    """For a .build/-relative artifact (.pdf, .log, .synctex.gz), return the
    source-doc-relative path *without* extension, so callers can probe for
    `<stem>.tex` and `<stem>.md` in docs/."""
    name = rel.name
    if name.endswith(".synctex.gz"):
        stem_name = name[: -len(".synctex.gz")]
    elif name.endswith(".pdf") or name.endswith(".log"):
        stem_name = rel.stem
    else:
        return None
    return rel.parent / stem_name


def gc_build_dir() -> None:
    """Sweep .build/ for orphans — .pdf/.log/.synctex.gz files whose source
    doc no longer exists under docs/. Move/delete handlers keep the mirror
    aligned during a session; this catches anything left behind from earlier
    sessions (or from docs that were removed via the shell while the server
    was down)."""
    if not BUILD.exists():
        return
    build_resolved = BUILD.resolve()
    removed = 0
    for p in BUILD.rglob("*"):
        if not p.is_file():
            continue
        name = p.name
        if not (
            name.endswith(".pdf") or name.endswith(".log") or name.endswith(".synctex.gz")
        ):
            continue
        try:
            rel = p.resolve().relative_to(build_resolved)
        except ValueError:
            continue
        stem = _source_stem_for_build(rel)
        if stem is None:
            continue
        if (DOCS / stem.with_suffix(".tex")).exists():
            continue
        if (DOCS / stem.with_suffix(".md")).exists():
            continue
        try:
            p.unlink()
            removed += 1
        except OSError:
            pass
    # Bottom-up sweep so empty parents drop after their (now-empty) children.
    dirs = sorted(
        (p for p in BUILD.rglob("*") if p.is_dir()),
        key=lambda x: len(x.parts),
        reverse=True,
    )
    for d in dirs:
        try:
            d.rmdir()
        except OSError:
            pass  # not empty — leave alone
    if removed:
        log.info("gc: removed %d orphan build file(s)", removed)


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.loop = asyncio.get_running_loop()
    _bootstrap_active_and_target()
    gc_build_dir()
    state.timeline_enabled = load_timeline_pref()
    if state.active_doc.exists():
        state.last_hash = sha(state.active_doc.read_bytes())
    observer = PollingObserver(timeout=0.3)
    observer.schedule(DocWatcher(), str(DOCS), recursive=True)
    observer.start()
    log.info(
        "watching %s (polling, recursive); active=%s target=%s",
        DOCS, rel_name(state.active_doc), rel_name(state.render_target),
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
    active_rel = rel_name(state.active_doc)
    if not state.active_doc.exists():
        return {"path": active_rel, "content": "", "hash": ""}
    data = state.active_doc.read_bytes()
    return {
        "path": active_rel,
        "content": data.decode("utf-8", errors="replace"),
        "hash": sha(data),
    }


@app.get("/api/doc/agent")
async def get_doc_agent() -> dict:
    """Agent-side doc fetch. Returns content, hash, and user_edited_since
    flag, then resets the flag (the agent has now seen the user's edits)."""
    flag = consume_user_edit_flag()
    active_rel = rel_name(state.active_doc)
    if not state.active_doc.exists():
        return {
            "path": active_rel,
            "content": "",
            "hash": "",
            "user_edited_since": flag,
        }
    data = state.active_doc.read_bytes()
    return {
        "path": active_rel,
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
        "dirs": list_doc_dirs(),
        "active": rel_name(state.active_doc),
        "render_target": rel_name(state.render_target),
    }


async def set_active(name: str) -> dict:
    p = doc_path(name)
    if not p.exists():
        raise HTTPException(404, f"doc not found: {name}")
    state.active_doc = p
    if p.suffix in RENDERABLE_SUFFIXES:
        state.render_target = p
    data = p.read_bytes()
    state.last_hash = sha(data)
    state.user_edits_pending = False

    await broadcast_doc_list()
    await state.broadcast(
        {
            "type": "doc",
            "content": data.decode("utf-8", errors="replace"),
            "path": rel_name(p),
            "hash": state.last_hash,
        }
    )
    await broadcast_existing_render()
    return {"ok": True, "active": rel_name(p), "render_target": rel_name(state.render_target)}


async def broadcast_existing_render(ws: WebSocket | None = None) -> None:
    target = state.render_target
    target_rel = rel_name(target)
    sender = ws.send_json if ws is not None else state.broadcast
    if target.suffix == ".tex":
        out = pdf_path_for(target)
        if out.exists():
            # Recompute the hash from the actual file. Reusing state.last_pdf_hash
            # here would send a stale cache-buster when switching between two .tex
            # docs that both have built PDFs — the browser would serve the previous
            # doc's cached PDF for the unchanged URL.
            pdf_hash = sha(out.read_bytes())
            state.last_pdf_hash = pdf_hash
            await sender(
                {"type": "rendered", "url": f"/api/pdf?h={pdf_hash}", "target": target_rel}
            )
        else:
            # No build yet for this target — kick one off so the preview catches
            # up instead of leaving the previous doc's PDF on screen.
            schedule_render()
    elif target.suffix == ".md" and target.exists():
        await sender(
            {
                "type": "rendered_md",
                "content": target.read_text(encoding="utf-8"),
                "target": target_rel,
            }
        )


@app.post("/api/docs/active")
async def post_set_active(payload: dict) -> dict:
    name = payload.get("name")
    if not isinstance(name, str):
        raise HTTPException(400, "name required")
    return await set_active(name)


_TEMPLATE_TEX = "\\documentclass[11pt]{article}\n\\begin{document}\n\n\\end{document}\n"
_TEMPLATE_BIB = "% references\n"
_TEMPLATE_MD = "# Untitled\n\nWrite your notes here.\n"
_TEMPLATE_TXT = ""


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
    elif p.suffix == ".md":
        content = _TEMPLATE_MD
    elif p.suffix == ".txt":
        content = _TEMPLATE_TXT
    else:
        content = _TEMPLATE_TEX

    # Auto-create parent dirs so the agent (or the New doc prompt) can request
    # "chapters/intro.tex" without a separate mkdir step.
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    if activate:
        return await set_active(name)
    await broadcast_doc_list()
    return {"ok": True, "name": name}


@app.post("/api/dirs/new")
async def post_new_dir(payload: dict) -> dict:
    name = payload.get("name")
    if not isinstance(name, str):
        raise HTTPException(400, "name required")
    p = dir_path(name)
    if p.exists():
        if p.is_dir():
            # Idempotent: re-creating an existing folder is a no-op.
            return {"ok": True, "name": name, "existed": True}
        raise HTTPException(409, f"path exists but is not a directory: {name}")
    p.mkdir(parents=True, exist_ok=False)
    await broadcast_doc_list()
    return {"ok": True, "name": name, "existed": False}


@app.post("/api/docs/move")
async def post_move(payload: dict) -> dict:
    """Rename or move a file or directory under docs/. Works for both —
    Path.rename handles directories in one call, so the only difference
    between the cases is which regex we validate against."""
    src_name = payload.get("src")
    dest_name = payload.get("dest")
    if not isinstance(src_name, str) or not isinstance(dest_name, str):
        raise HTTPException(400, "src and dest required")

    # Determine whether the source is a file or a directory before we run
    # validation, so we apply the appropriate regex on both ends.
    src_probe = (DOCS / src_name).resolve()
    try:
        src_probe.relative_to(DOCS.resolve())
    except ValueError:
        raise HTTPException(400, "invalid src path")
    if not src_probe.exists():
        raise HTTPException(404, f"not found: {src_name}")
    is_dir = src_probe.is_dir()

    if is_dir:
        src_abs = dir_path(src_name)
        dest_abs = dir_path(dest_name)
    else:
        src_abs = doc_path(src_name)
        dest_abs = doc_path(dest_name)

    if src_abs == dest_abs:
        return {"ok": True, "src": src_name, "dest": dest_name, "noop": True}
    if dest_abs.exists():
        raise HTTPException(409, f"destination already exists: {dest_name}")
    if is_dir:
        try:
            dest_abs.relative_to(src_abs)
            raise HTTPException(400, "cannot move a directory into itself or a descendant")
        except ValueError:
            pass

    dest_abs.parent.mkdir(parents=True, exist_ok=True)
    src_abs.rename(dest_abs)

    # Keep the BUILD mirror aligned with the new layout. For a directory move
    # we move the whole subtree; for a file move we follow the pdf + log.
    if is_dir:
        build_src = BUILD / src_name
        build_dest = BUILD / dest_name
        if build_src.exists():
            build_dest.parent.mkdir(parents=True, exist_ok=True)
            build_src.rename(build_dest)
    else:
        for suffix in (".pdf", ".log", ".synctex.gz"):
            b_old = BUILD / Path(src_name).with_suffix(suffix)
            b_new = BUILD / Path(dest_name).with_suffix(suffix)
            if b_old.exists() and not b_new.exists():
                b_new.parent.mkdir(parents=True, exist_ok=True)
                b_old.rename(b_new)

    state.active_doc = _migrate_path(state.active_doc, src_abs, dest_abs, is_dir)
    state.render_target = _migrate_path(state.render_target, src_abs, dest_abs, is_dir)

    await state.broadcast(
        {"type": "rename", "src": src_name, "dest": dest_name, "is_dir": is_dir}
    )
    await broadcast_doc_list()
    return {"ok": True, "src": src_name, "dest": dest_name, "is_dir": is_dir}


@app.delete("/api/docs/{name:path}")
async def post_delete_doc(name: str) -> dict:
    p = doc_path(name)
    if not p.exists():
        raise HTTPException(404, f"doc not found: {name}")
    was_active = p.resolve() == state.active_doc.resolve()
    was_target = p.resolve() == state.render_target.resolve()
    p.unlink()

    # Clean up the BUILD mirror so an orphaned pdf/log/synctex doesn't linger.
    for suffix in (".pdf", ".log", ".synctex.gz"):
        b = BUILD / Path(name).with_suffix(suffix)
        if b.exists():
            b.unlink()

    if was_active or was_target:
        fallback_active, fallback_target = _pick_fallback()
        if fallback_active is None:
            _bootstrap_active_and_target()
        else:
            if was_active:
                state.active_doc = fallback_active
            if was_target:
                state.render_target = fallback_target

    await broadcast_doc_list()
    if was_active:
        await _broadcast_active_doc()
    return {"ok": True}


@app.delete("/api/dirs/{name:path}")
async def post_delete_dir(name: str, recursive: bool = False) -> dict:
    p = dir_path(name)
    if not p.exists():
        raise HTTPException(404, f"directory not found: {name}")
    if not p.is_dir():
        raise HTTPException(400, f"not a directory: {name}")

    has_contents = any(p.iterdir())
    if has_contents and not recursive:
        raise HTTPException(409, "directory is not empty; pass recursive=true to delete")

    # Defense in depth: refuse to recurse outside DOCS even if dir_path lets
    # it through somehow (the regex + relative_to should already prevent it).
    p_resolved = p.resolve()
    try:
        p_resolved.relative_to(DOCS.resolve())
    except ValueError:
        raise HTTPException(400, "directory escapes docs/")

    def _under(p_to_check: Path) -> bool:
        try:
            p_to_check.resolve().relative_to(p_resolved)
            return True
        except ValueError:
            return False

    was_active_under = _under(state.active_doc)
    was_target_under = _under(state.render_target)

    if has_contents:
        shutil.rmtree(p)
    else:
        p.rmdir()

    build_p = BUILD / name
    if build_p.exists():
        if build_p.is_dir():
            shutil.rmtree(build_p)
        else:
            build_p.unlink()

    if was_active_under or was_target_under:
        fallback_active, fallback_target = _pick_fallback()
        if fallback_active is None:
            _bootstrap_active_and_target()
        else:
            if was_active_under:
                state.active_doc = fallback_active
            if was_target_under:
                state.render_target = fallback_target

    await broadcast_doc_list()
    if was_active_under:
        await _broadcast_active_doc()
    return {"ok": True}


@app.get("/api/pdf")
async def pdf() -> FileResponse:
    out = pdf_path_for(state.render_target)
    if not out.exists():
        raise HTTPException(404, "no pdf yet")
    return FileResponse(out, media_type="application/pdf")


# ---------- INSPIRE-HEP citation flow ----------
INSPIRE_BASE = "https://inspirehep.net/api"
_BIBTEX_KEY_RE = re.compile(r"@\w+\{([^,\s]+)\s*,", re.IGNORECASE)


async def _http_get(url: str, accept: str = "application/json") -> tuple[int, bytes]:
    """Synchronous urllib in a worker thread — avoids pulling in httpx/aiohttp
    just for two endpoints."""
    def _do():
        req = urllib.request.Request(
            url, headers={"Accept": accept, "User-Agent": "aTeXi/1.0"}
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except urllib.error.URLError:
            return -1, b""

    return await asyncio.to_thread(_do)


async def inspire_search(query: str, limit: int = 10) -> list[dict]:
    params = urllib.parse.urlencode(
        {
            "q": query,
            "size": str(min(max(limit, 1), 25)),
            "fields": "titles,authors,arxiv_eprints,citation_count,publication_info,texkeys",
        }
    )
    status, body = await _http_get(f"{INSPIRE_BASE}/literature?{params}")
    if status != 200:
        return []
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return []
    hits = data.get("hits", {}).get("hits", []) or []
    out: list[dict] = []
    for hit in hits:
        m = (hit.get("metadata") or {})
        titles = m.get("titles") or []
        title = titles[0].get("title", "(no title)") if titles else "(no title)"
        authors = m.get("authors") or []
        author_names = [a.get("full_name", "") for a in authors[:3]]
        n_more = max(0, len(authors) - 3)
        arxiv_eprints = m.get("arxiv_eprints") or []
        arxiv_id = arxiv_eprints[0].get("value", "") if arxiv_eprints else ""
        texkeys = m.get("texkeys") or []
        pub = m.get("publication_info") or []
        year = pub[0].get("year") if pub else None
        out.append(
            {
                "recid": str(hit.get("id", "")),
                "title": title,
                "authors": author_names,
                "n_more_authors": n_more,
                "year": year,
                "arxiv_id": arxiv_id,
                "texkey": texkeys[0] if texkeys else "",
                "citation_count": m.get("citation_count", 0),
            }
        )
    return out


async def inspire_bibtex(recid: str) -> str | None:
    url = f"{INSPIRE_BASE}/literature/{urllib.parse.quote(recid)}?format=bibtex"
    status, body = await _http_get(url, accept="application/x-bibtex")
    if status != 200:
        return None
    return body.decode("utf-8", errors="replace")


def _pick_bib_destination() -> Path:
    """Active .bib if open; else docs/ref.bib (created on demand)."""
    if state.active_doc.suffix == ".bib" and state.active_doc.exists():
        return state.active_doc
    default = DOCS / "ref.bib"
    if not default.exists():
        default.write_text(_TEMPLATE_BIB, encoding="utf-8")
    return default


@app.get("/api/inspire/search")
async def get_inspire_search(q: str = "", limit: int = 10) -> dict:
    q = (q or "").strip()
    if not q:
        return {"results": []}
    results = await inspire_search(q, limit)
    return {"results": results}


@app.post("/api/inspire/cite")
async def post_inspire_cite(payload: dict) -> dict:
    """Fetch BibTeX for `recid`, append to the destination .bib if the key
    isn't already there, and return the cite key so the frontend can insert
    \\cite{KEY} at the cursor. Idempotent: re-citing the same paper is a
    no-op append-wise."""
    recid = payload.get("recid")
    if not isinstance(recid, str) or not recid.strip():
        raise HTTPException(400, "recid required")
    bibtex = await inspire_bibtex(recid.strip())
    if not bibtex:
        raise HTTPException(404, "no bibtex for recid")
    m = _BIBTEX_KEY_RE.search(bibtex)
    if not m:
        raise HTTPException(502, "could not parse bibtex key from inspire response")
    key = m.group(1)

    dest = _pick_bib_destination()
    existing = dest.read_text(encoding="utf-8") if dest.exists() else ""
    already = (
        re.search(r"@\w+\{" + re.escape(key) + r"\s*,", existing, re.IGNORECASE) is not None
    )
    appended = False
    if not already:
        sep = "" if (not existing or existing.endswith("\n")) else "\n"
        new_content = existing + sep + ("\n" if existing else "") + bibtex.strip() + "\n"
        dest.write_text(new_content, encoding="utf-8")
        appended = True
        # If the .bib being updated is the active doc, broadcast new content
        # so the editor reflects the addition immediately.
        if dest.resolve() == state.active_doc.resolve():
            state.last_hash = sha(new_content.encode("utf-8"))
            state.last_edit_author = "user"
            await state.broadcast(
                {
                    "type": "doc",
                    "content": new_content,
                    "path": rel_name(dest),
                    "hash": state.last_hash,
                }
            )
        # Trigger a re-render if the render target depends on bib (any .tex).
        if state.render_target.suffix == ".tex":
            schedule_render()

    return {
        "ok": True,
        "key": key,
        "bib": rel_name(dest),
        "appended": appended,
        "bibtex": bibtex,
    }


@app.get("/api/timeline")
async def get_timeline(limit: int = 200) -> dict:
    return {
        "entries": read_timeline(limit=min(max(limit, 1), 1000)),
        "enabled": state.timeline_enabled,
    }


_HASH_RE = re.compile(r"^[a-f0-9]{64}$")


@app.get("/api/timeline/snapshot/{h}")
async def get_timeline_snapshot(h: str) -> dict:
    if not _HASH_RE.match(h):
        raise HTTPException(400, "invalid hash")
    snap = SNAPSHOTS / f"{h}.txt"
    if not snap.exists():
        raise HTTPException(404, "snapshot not found")
    return {"hash": h, "content": snap.read_text(encoding="utf-8", errors="replace")}


@app.post("/api/timeline/rewind")
async def post_rewind(payload: dict) -> dict:
    """Restore `doc` to the content stored under `hash`. The current state
    is snapshotted first (attributed to "user", trigger "pre-rewind") so the
    rewind itself is undoable. If `doc` is the active doc, broadcast new
    content. If it's the render target, schedule a re-render."""
    doc = payload.get("doc")
    h = payload.get("hash")
    if not isinstance(doc, str) or not isinstance(h, str):
        raise HTTPException(400, "doc and hash required")
    if not _HASH_RE.match(h):
        raise HTTPException(400, "invalid hash")
    snap = SNAPSHOTS / f"{h}.txt"
    if not snap.exists():
        raise HTTPException(404, "snapshot not found")
    p = doc_path(doc)
    if not p.exists():
        raise HTTPException(404, f"doc not found: {doc}")

    # Snapshot the current state pre-rewind. Force a snapshot even if the
    # content is unchanged from the last hash by temporarily clearing the
    # dedup key — we want a clear "this is where you were" marker.
    if state.timeline_enabled:
        state.last_snapshot_hash.pop(rel_name(p), None)
        take_snapshot(p, "user", "pre-rewind")

    content = snap.read_bytes()
    p.write_bytes(content)

    if p.resolve() == state.active_doc.resolve():
        state.last_hash = sha(content)
        state.user_edits_pending = False
        await state.broadcast(
            {
                "type": "doc",
                "content": content.decode("utf-8", errors="replace"),
                "path": rel_name(p),
                "hash": state.last_hash,
            }
        )

    if p.resolve() == state.render_target.resolve():
        state.last_edit_author = "user"
        schedule_render()

    if state.timeline_enabled:
        # Record the rewind itself in the timeline so it appears as a step
        # too. Dedup will skip if content matches an earlier snapshot.
        take_snapshot(p, "user", f"rewind:{h[:8]}")

    return {"ok": True, "doc": rel_name(p), "hash": h}


@app.post("/api/timeline/enabled")
async def post_timeline_enabled(payload: dict) -> dict:
    enabled = bool(payload.get("enabled", True))
    state.timeline_enabled = enabled
    save_timeline_pref(enabled)
    return {"enabled": enabled}


@app.get("/api/synctex/inverse")
async def get_synctex_inverse(page: int, x: float, y: float) -> dict:
    """PDF→source: click at (x, y) in PDF points on page N → {file, line}.
    file is a docs/-relative posix path, or null if the source is outside
    docs/ (e.g. a system .sty)."""
    target = state.render_target
    if target.suffix != ".tex":
        raise HTTPException(404, "render target is not .tex")
    synctex_path = pdf_path_for(target).with_suffix(".synctex.gz")
    parsed = get_synctex(synctex_path)
    if parsed is None:
        raise HTTPException(404, "no synctex (render first)")
    result = synctex_inverse(parsed, page, x, y)
    if result is None:
        raise HTTPException(404, "no box matched")
    try:
        rel = Path(result["file"]).resolve().relative_to(DOCS.resolve()).as_posix()
        return {"file": rel, "line": result["line"]}
    except (ValueError, OSError):
        return {"file": None, "line": result["line"]}


@app.get("/api/synctex/forward")
async def get_synctex_forward(line: int) -> dict:
    """source→PDF: a line in the currently-active doc → list of PDF positions
    where that line is rendered. Empty if the doc isn't \\input by the
    render target, or if synctex hasn't been built."""
    target = state.render_target
    if target.suffix != ".tex":
        raise HTTPException(404, "render target is not .tex")
    synctex_path = pdf_path_for(target).with_suffix(".synctex.gz")
    parsed = get_synctex(synctex_path)
    if parsed is None:
        raise HTTPException(404, "no synctex (render first)")
    source = str(state.active_doc.resolve())
    return {"positions": synctex_forward(parsed, source, line)}


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
    state.last_edit_author = "agent"
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
            "path": rel_name(state.active_doc),
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
    state.last_edit_author = "agent"
    state.active_doc.write_bytes(new_bytes)
    await state.broadcast(
        {"type": "doc", "content": new_content, "path": rel_name(state.active_doc), "hash": h}
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
                "dirs": list_doc_dirs(),
                "active": rel_name(state.active_doc),
                "render_target": rel_name(state.render_target),
            }
        )
        if state.active_doc.exists():
            data = state.active_doc.read_bytes()
            await ws.send_json(
                {
                    "type": "doc",
                    "content": data.decode("utf-8", errors="replace"),
                    "path": rel_name(state.active_doc),
                    "hash": sha(data),
                }
            )
        await broadcast_existing_render(ws=ws)
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
                state.last_edit_author = "user"
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
