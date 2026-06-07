import asyncio
import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

# When this file is run via `python server.py` it loads as __main__, so a
# later `import server` from in-process tools would re-execute the file
# as a SECOND module — fresh `state`, no lifespan, no event loop. Alias
# the running module under both names so `import server` always returns
# this instance regardless of launch method.
sys.modules.setdefault("server", sys.modules[__name__])
sys.modules.setdefault("agentex.server", sys.modules[__name__])

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from watchdog.events import FileSystemEventHandler
from watchdog.observers.polling import PollingObserver

log = logging.getLogger("agentex")

ROOT = Path(__file__).parent

# ----- Layered .env loading + `set`/`unset` subcommands ---------------------
# Precedence (highest first): shell env, project/.env, ~/.config/agentex/env.
# Snapshotting the shell env up front lets us layer the two files without
# ever clobbering something the user already exported.
_SHELL_ENV_KEYS = frozenset(os.environ.keys())
_USER_ENV_PATH = (
    Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config"))
    / "agentex"
    / "env"
)
_SECRET_KEY_HINTS = ("_API_KEY", "_ACCESS_KEY", "_SECRET", "_TOKEN")
_KEY_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")


def _load_env_file(path: Path, *, override_user: bool = False) -> None:
    """Pull values from a .env into os.environ.

    Shell env (anything present at process start) always wins. When
    override_user=True the file can overwrite values previously loaded
    from the user-level file — used for project/.env so per-project
    settings beat global defaults.
    """
    try:
        from dotenv import dotenv_values  # type: ignore
    except ImportError:
        return
    for k, v in dotenv_values(path).items():
        if v is None or k in _SHELL_ENV_KEYS:
            continue
        if not override_user and k in os.environ:
            continue
        os.environ[k] = v


def _redact(key: str, value: str) -> str:
    if not any(h in key for h in _SECRET_KEY_HINTS) or not value:
        return value
    if len(value) <= 8:
        return "***"
    return f"{value[:4]}…{value[-4:]}"


def _handle_config_subcommand(cmd: str, args: list[str]) -> int:
    try:
        from dotenv import dotenv_values, set_key, unset_key  # type: ignore
    except ImportError:
        print(
            "agenTeX: `set`/`unset` require python-dotenv.\n"
            "  pip install python-dotenv",
            file=sys.stderr,
        )
        return 2
    _USER_ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    _USER_ENV_PATH.touch(exist_ok=True)
    if cmd == "unset":
        if len(args) != 1:
            print("usage: server.py unset KEY", file=sys.stderr)
            return 2
        unset_key(str(_USER_ENV_PATH), args[0])
        print(f"unset {args[0]} in {_USER_ENV_PATH}")
        return 0
    if not args:
        values = dotenv_values(_USER_ENV_PATH)
        print(f"# {_USER_ENV_PATH}")
        for k, v in sorted(values.items()):
            print(f"{k}={_redact(k, v or '')}")
        return 0
    if len(args) == 1 and "=" in args[0]:
        key, _, value = args[0].partition("=")
    elif len(args) == 2:
        key, value = args
    else:
        print(
            "usage:\n"
            "  server.py set                # list current values (secrets redacted)\n"
            "  server.py set KEY=value      # write a value\n"
            "  server.py set KEY value      # same, space-separated\n"
            "  server.py unset KEY          # remove a value",
            file=sys.stderr,
        )
        return 2
    key = key.strip()
    if not _KEY_NAME_RE.match(key):
        print(f"agenTeX: refusing to set {key!r} — keys must be UPPER_SNAKE_CASE",
              file=sys.stderr)
        return 2
    set_key(str(_USER_ENV_PATH), key, value, quote_mode="auto")
    print(f"set {key} in {_USER_ENV_PATH}")
    return 0


# Load user-level config first so AGENTEX_PROJECT can be defined there.
_load_env_file(_USER_ENV_PATH)

# `python server.py set ...` / `unset ...` operate on the user-level file
# and exit; no server is started.
if len(sys.argv) > 1 and sys.argv[1] in ("set", "unset"):
    sys.exit(_handle_config_subcommand(sys.argv[1], sys.argv[2:]))
# ---------------------------------------------------------------------------

# Project root. Positional CLI arg → AGENTEX_PROJECT env → cwd. Used as
# the docs tree root that the editor surfaces, the LaTeX build input, and
# the parent of .agentex / .build. Treating cwd as the project (rather
# than cwd/docs) matches git/npm/cargo: agentex serves whatever directory
# you're in. A deny-list below refuses obvious foot-guns like ~ or /.


def _resolve_project_path() -> Path:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if args:
        return Path(args[0]).expanduser()
    env = os.environ.get("AGENTEX_PROJECT") or os.environ.get("AGENTEX_DOCS")
    if env:
        return Path(env).expanduser()
    return Path.cwd()


def _refuse_if_too_wide(path: Path) -> None:
    """Bail when the project root is somewhere we shouldn't index in bulk.

    Walking ~ or / would trigger a recursive watchdog scan over thousands
    of files and drop .agentex/ + .build/ in the wrong place. We refuse
    the obvious cases (filesystem root, $HOME, top-level system dirs like
    /Users, /opt, /var) and tell the user to cd into a real project dir.
    """
    reason: str | None = None
    if str(path) == path.anchor:
        reason = "the filesystem root"
    elif path == Path.home():
        reason = "your home directory"
    elif path.parent == Path(path.anchor):
        # Top-level dirs: /Users, /opt, /var, /tmp, /private, /usr, /home, ...
        reason = f"a top-level system directory ({path})"
    if reason is None:
        return
    print(
        f"agenTeX: refusing to run on {reason}.\n"
        f"  Walking it would index every nested file and drop .agentex/\n"
        f"  and .build/ in the wrong place. cd into a project directory\n"
        f"  first, or pass one explicitly:  agentex /path/to/project",
        file=sys.stderr,
    )
    sys.exit(2)


DOCS = _resolve_project_path().resolve()
if not DOCS.is_dir():
    print(
        f"agenTeX: project path is not a directory: {DOCS}\n"
        f"  pass an existing dir as the first arg or via AGENTEX_PROJECT.",
        file=sys.stderr,
    )
    sys.exit(2)
_refuse_if_too_wide(DOCS)
# Per-project .env overrides the user-level file; shell env beats both.
_load_env_file(DOCS / ".env", override_user=True)
# State + builds live INSIDE the project so multiple projects don't
# share comments or build artifacts.
AGENTEX = DOCS / ".agentex"
BUILD = DOCS / ".build"

TEMPLATES = ROOT / "templates"
STATIC = ROOT / "static"
SNAPSHOTS = AGENTEX / "snapshots"
TIMELINE_LOG = AGENTEX / "timeline.jsonl"
AGENTEX_CONFIG = AGENTEX / "config.json"
COMMENTS_FILE = AGENTEX / "comments.json"
SPEND_LOG = AGENTEX / "spend.jsonl"
COMMENT_CONTEXT_CHARS = 40  # chars of prefix/suffix stored for reanchoring
DEFAULT_DOC_NAME = "current.tex"
RENDER_DEBOUNCE = 0.4
# A relative path under DOCS made of slash-separated segments. Each segment
# matches [A-Za-z0-9._-]+ — no spaces, no special chars. The suffix check is
# separate (against TEXT_SUFFIXES) so it can be expanded without touching
# the path regex. ".." segments are rejected by _check_segments below.
from agentex._suffixes import RENDERABLE_SUFFIXES, TEXT_SUFFIXES

_DOC_PATH_RE = re.compile(r"^(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$")
DIR_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$")
# Fast lookup sets used by the project-listing walk. Suffix membership is
# checked once per file during traversal; keep them frozen for clarity.
_TEXT_SUFFIX_SET = frozenset(s.lower() for s in TEXT_SUFFIXES)
_ASSET_SUFFIX_SET = frozenset((
    ".pdf", ".png", ".jpg", ".jpeg", ".svg", ".eps", ".gif", ".webp",
))
# Directory names pruned in addition to anything starting with ".". These
# never contain user-editable content but ARE common in real projects;
# walking into them is the dominant unnecessary cost on a deep tree.
_IGNORE_DIR_NAMES = frozenset((
    "build", "dist", "node_modules", "__pycache__",
    "venv", "env",  # ".X" forms already pruned by the leading-dot check
))


def _check_segments(name: str) -> bool:
    """Reject '.' and '..' segments. The regexes allow them through because
    both match [A-Za-z0-9._-]+; this is the explicit no-escape check."""
    return all(seg not in (".", "..") for seg in name.split("/"))


def is_valid_doc_name(name: str) -> bool:
    """A path under DOCS pointing at an editable text file. Combines the
    path-shape regex, the no-`..` check, and the suffix allowlist into one
    helper used at every input boundary (create, rename, watcher filter)."""
    if not _DOC_PATH_RE.match(name) or not _check_segments(name):
        return False
    return Path(name).suffix.lower() in _TEXT_SUFFIX_SET


# ---- Project listing -------------------------------------------------------
# Three list_*() helpers share one tree walk, cached until a file event
# invalidates it. Without the cache, every UI action that calls
# broadcast_doc_list (file switch, save, render, reconnect) would re-walk
# the project — fine when DOCS = ./docs/ with a handful of files,
# unacceptable now that DOCS = cwd with thousands.

_listing_cache: tuple[list[str], list[str], list[str]] | None = None


def _is_pruneable_dir(name: str) -> bool:
    """True for any directory we shouldn't descend into during the walk:
    hidden dirs (.git, .agentex, .build, ...), well-known build / cache
    dirs (build/, dist/, node_modules/, ...), and Python egg-info packages."""
    if name.startswith("."):
        return True
    if name in _IGNORE_DIR_NAMES:
        return True
    if name.endswith(".egg-info"):
        return True
    return False


def _compute_project_listing() -> tuple[list[str], list[str], list[str]]:
    """One pass over the project tree producing (docs, dirs, assets).
    Directories are pruned in-place during os.walk so we never descend
    into .git/, node_modules/, etc. — that pruning is the dominant
    speed-up vs. globbing the tree N times."""
    docs_root = DOCS.resolve()
    docs_root_str = str(docs_root)
    docs: list[str] = []
    dirs: list[str] = []
    assets: list[str] = []

    def _on_error(err: OSError) -> None:
        log.debug("walk error: %s", err)

    for root, sub_dirs, files in os.walk(
        docs_root_str, followlinks=False, onerror=_on_error
    ):
        # Prune in-place — os.walk respects mutation.
        sub_dirs[:] = [d for d in sub_dirs if not _is_pruneable_dir(d)]
        if root == docs_root_str:
            rel_prefix = ""
        else:
            # os.walk yields absolute roots; convert by string slicing to
            # avoid the cost of Path() construction per directory.
            rel_root = root[len(docs_root_str) + 1:].replace(os.sep, "/")
            dirs.append(rel_root)
            rel_prefix = rel_root + "/"
        for fname in files:
            if fname.startswith("."):
                continue
            dot = fname.rfind(".")
            if dot == -1:
                continue
            suffix = fname[dot:].lower()
            if suffix in _TEXT_SUFFIX_SET:
                docs.append(rel_prefix + fname)
            elif suffix in _ASSET_SUFFIX_SET:
                assets.append(rel_prefix + fname)
    docs.sort()
    dirs.sort()
    assets.sort()
    return docs, dirs, assets


def _get_project_listing() -> tuple[list[str], list[str], list[str]]:
    global _listing_cache
    if _listing_cache is None:
        _listing_cache = _compute_project_listing()
    return _listing_cache


def invalidate_project_listing() -> None:
    """Drop the cached listing. Called from the file watcher when anything
    under DOCS appears, disappears, or gets renamed."""
    global _listing_cache
    _listing_cache = None


def list_doc_names() -> list[str]:
    return _get_project_listing()[0]


def list_doc_dirs() -> list[str]:
    return _get_project_listing()[1]


def list_asset_names() -> list[str]:
    return _get_project_listing()[2]


def rel_name(p: Path) -> str:
    """Return a doc's path relative to DOCS, with forward slashes. This is
    the canonical identifier used in WebSocket messages and the frontend."""
    try:
        return p.resolve().relative_to(DOCS.resolve()).as_posix()
    except ValueError:
        return p.name


def doc_path(name: str) -> Path:
    if not is_valid_doc_name(name):
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
        # Set when a client acks a save_now flush request. flush_clients()
        # creates a fresh Event and awaits it (with timeout) so agent-facing
        # reads see the user's in-flight keystrokes, not stale disk content.
        self.flush_ack: asyncio.Event | None = None
        # Persistent agent-authored comments, loaded from .agentex/comments.json.
        # Each entry: {id, doc, kind, message, ts, author, resolved, ...anchor}
        # where anchor depends on kind:
        #   kind="range": from_line, to_line, from_ch, to_ch, excerpt, prefix, suffix
        #   kind="line":  line, line_text
        #   kind="doc":   (no positional fields)
        # Edits on a doc trigger a reanchor pass which may set orphaned=True.
        self.comments: list[dict] = []
        # Monotonically incremented counter for comment IDs within a session.
        # IDs are prefixed with a short random tag so they don't collide if
        # the server is restarted mid-session.
        self.comment_seq: int = 0

    async def broadcast(self, message: dict) -> None:
        dead = []
        for ws in self.clients:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def flush_clients(self, timeout: float = 0.1) -> None:
        """Ask any connected browser to commit its in-memory editor state to
        disk before an agent-facing read. Closes the ~350ms debounced-save
        race window between the user's keystrokes and an agent edit.

        Returns when one client acks or after `timeout` seconds. No-op when
        no clients are connected (nothing to flush)."""
        if not self.clients:
            return
        self.flush_ack = asyncio.Event()
        try:
            await self.broadcast({"type": "save_now"})
            try:
                await asyncio.wait_for(self.flush_ack.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                # No client responded in time. Could be the connection is
                # stale, or the client has nothing pending. Proceed anyway.
                pass
        finally:
            self.flush_ack = None


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
            invalidate_project_listing()
            asyncio.run_coroutine_threadsafe(broadcast_doc_list(), state.loop)
            return
        # For file events, only refresh if the path (relative to DOCS) would
        # actually appear in the listing. Avoids spurious broadcasts from
        # editor scratch files or hidden dotfiles.
        try:
            rel = Path(event.src_path).resolve().relative_to(DOCS.resolve()).as_posix()
        except ValueError:
            return
        # Always invalidate so the next listing reflects reality (cheap);
        # only re-broadcast if the changed file is one the editor surfaces.
        invalidate_project_listing()
        if not is_valid_doc_name(rel):
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
            "assets": list_asset_names(),
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


# ---------- comments ----------
def load_comments() -> tuple[list[dict], int]:
    """Return (comments, next_seq). Tolerates missing or malformed file."""
    if not COMMENTS_FILE.exists():
        return [], 0
    try:
        data = json.loads(COMMENTS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return [], 0
    if not isinstance(data, dict):
        return [], 0
    comments = data.get("comments", [])
    if not isinstance(comments, list):
        comments = []
    seq = int(data.get("next_seq", 0) or 0)
    return comments, seq


def save_comments() -> None:
    AGENTEX.mkdir(parents=True, exist_ok=True)
    payload = {"next_seq": state.comment_seq, "comments": state.comments}
    tmp = COMMENTS_FILE.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(COMMENTS_FILE)
    except OSError:
        pass


def next_comment_id() -> str:
    state.comment_seq += 1
    return f"c{state.comment_seq:04d}"


def line_index_to_linecol(content: str, idx: int) -> tuple[int, int]:
    """Convert a 0-based char offset to (1-based line, 0-based ch)."""
    if idx <= 0:
        return 1, 0
    nl = content.count("\n", 0, idx)
    line_start = content.rfind("\n", 0, idx) + 1
    return nl + 1, idx - line_start


def reanchor_comments_for_doc(doc_rel: str, content: str) -> bool:
    """Re-find each non-doc-level comment for `doc_rel` in `content`. Updates
    position fields in place. Returns True if any comment changed (so the
    caller can broadcast)."""
    changed = False
    for c in state.comments:
        if c.get("doc") != doc_rel:
            continue
        if c.get("kind") == "doc":
            continue
        if c.get("resolved"):
            # Skip resolved — they're hidden by default; positions can drift.
            continue
        if c.get("kind") == "range":
            excerpt = c.get("excerpt") or ""
            prefix = c.get("prefix") or ""
            suffix = c.get("suffix") or ""
            needle = prefix + excerpt + suffix
            idx = content.find(needle) if needle else -1
            if idx >= 0:
                idx += len(prefix)
            elif excerpt:
                # Fall back to excerpt-only match; only accept if unique.
                first = content.find(excerpt)
                second = content.find(excerpt, first + 1) if first >= 0 else -1
                idx = first if (first >= 0 and second < 0) else -1
            if idx < 0:
                if not c.get("orphaned"):
                    c["orphaned"] = True
                    changed = True
                continue
            from_line, from_ch = line_index_to_linecol(content, idx)
            to_line, to_ch = line_index_to_linecol(content, idx + len(excerpt))
            if (c.get("from_line") != from_line or c.get("from_ch") != from_ch
                    or c.get("to_line") != to_line or c.get("to_ch") != to_ch
                    or c.get("orphaned")):
                c["from_line"] = from_line
                c["from_ch"] = from_ch
                c["to_line"] = to_line
                c["to_ch"] = to_ch
                c["orphaned"] = False
                changed = True
        elif c.get("kind") == "line":
            line_text = c.get("line_text") or ""
            cur_line = int(c.get("line", 1))
            lines = content.split("\n")
            new_line = None
            if 1 <= cur_line <= len(lines) and lines[cur_line - 1] == line_text:
                new_line = cur_line
            else:
                # Look for the exact line text uniquely
                hits = [i + 1 for i, ln in enumerate(lines) if ln == line_text]
                if len(hits) == 1:
                    new_line = hits[0]
            if new_line is None:
                if not c.get("orphaned"):
                    c["orphaned"] = True
                    changed = True
                continue
            if c.get("line") != new_line or c.get("orphaned"):
                c["line"] = new_line
                c["orphaned"] = False
                changed = True
    return changed


async def broadcast_comments() -> None:
    await state.broadcast({"type": "comments", "comments": state.comments})


async def reanchor_and_broadcast(doc_rel: str, content: str) -> None:
    """Convenience wrapper: reanchor for one doc, persist + broadcast if any
    comment changed."""
    if not any(c.get("doc") == doc_rel for c in state.comments):
        return
    if reanchor_comments_for_doc(doc_rel, content):
        save_comments()
        await broadcast_comments()


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
        # tectonic v2 -X compile prints a terse summary to stderr; the
        # canonical LaTeX errors (! ... / l.NN ...) live in the .log
        # sibling produced by --keep-logs.
        parseable = err
        log_path = out.with_suffix(".log")
        if log_path.exists():
            try:
                parseable = log_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                pass
        errors = parse_tectonic_errors(parseable)
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
    state.comments, state.comment_seq = load_comments()
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
    # Pre-warm the LLM model catalog in a background thread. Importing
    # orchestral.llm.anthropic.model_details cold takes ~7s (it transitively
    # loads the Anthropic SDK); doing this lazily inside the GET handler
    # blocks the event loop and freezes every concurrent WebSocket message.
    asyncio.create_task(asyncio.to_thread(_prewarm_model_catalog))
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
    await state.flush_clients()
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
        "assets": list_asset_names(),
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
            url, headers={"Accept": accept, "User-Agent": "agentex/1.0"}
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
    """Active .bib if open; else a ref.bib next to the active doc (created
    on demand). LaTeX resolves \\bibliography relative to the .tex file,
    so co-locating the bib is what users expect when citing from a doc
    nested under the project root (e.g. docs/papers/foo/paper.tex picks
    up docs/papers/foo/ref.bib, not docs/ref.bib)."""
    if state.active_doc.suffix == ".bib" and state.active_doc.exists():
        return state.active_doc
    # Fall back to the project root only if we somehow have no active doc.
    parent = state.active_doc.parent if state.active_doc else DOCS
    default = parent / "ref.bib"
    if not default.exists():
        default.write_text(_TEMPLATE_BIB, encoding="utf-8")
    return default


@app.get("/api/bibkeys")
async def get_bibkeys() -> dict:
    """Return every BibTeX key across all .bib files under docs/. Used by the
    editor's cite-as-you-type hint to surface local entries before INSPIRE."""
    keys: list[dict] = []
    for name in list_doc_names():
        if not name.endswith(".bib"):
            continue
        p = DOCS / name
        try:
            text = p.read_text(encoding="utf-8")
        except OSError:
            continue
        for m in _BIBTEX_KEY_RE.finditer(text):
            keys.append({"key": m.group(1), "file": name})
    return {"keys": keys}


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


def _recompute_last_snapshot_hashes(lines: list[str]) -> dict[str, str]:
    """Rebuild the per-doc latest-hash map from the on-disk timeline order
    (oldest first). Used after deletes so the dedup gate doesn't think the
    most recent snapshot still exists."""
    latest: dict[str, str] = {}
    for line in lines:
        line = line.rstrip("\n")
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        doc = entry.get("doc")
        h = entry.get("hash")
        if isinstance(doc, str) and isinstance(h, str):
            latest[doc] = h
    return latest


@app.post("/api/timeline/entry/delete")
async def post_timeline_delete_entry(payload: dict) -> dict:
    """Remove a single timeline entry, identified by (ts, hash). Garbage-
    collects the underlying snapshot file iff no remaining entry references
    that hash — same content snapshotted twice shares one file."""
    ts = payload.get("ts")
    h = payload.get("hash")
    if not isinstance(ts, str) or not isinstance(h, str):
        raise HTTPException(400, "ts and hash required")
    if not _HASH_RE.match(h):
        raise HTTPException(400, "invalid hash")
    if not TIMELINE_LOG.exists():
        raise HTTPException(404, "entry not found")
    try:
        with TIMELINE_LOG.open("r", encoding="utf-8") as f:
            raw = f.readlines()
    except OSError as e:
        raise HTTPException(500, f"timeline read failed: {e}")
    kept: list[str] = []
    removed = 0
    referenced_hashes: set[str] = set()
    for line in raw:
        stripped = line.rstrip("\n")
        if not stripped:
            continue
        try:
            entry = json.loads(stripped)
        except json.JSONDecodeError:
            kept.append(stripped)
            continue
        if removed == 0 and entry.get("ts") == ts and entry.get("hash") == h:
            removed += 1
            continue
        kept.append(stripped)
        eh = entry.get("hash")
        if isinstance(eh, str):
            referenced_hashes.add(eh)
    if removed == 0:
        raise HTTPException(404, "entry not found")
    tmp = TIMELINE_LOG.with_suffix(".jsonl.tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            for line in kept:
                f.write(line + "\n")
        tmp.replace(TIMELINE_LOG)
    except OSError as e:
        raise HTTPException(500, f"timeline write failed: {e}")
    snapshot_removed = False
    if h not in referenced_hashes:
        snap = SNAPSHOTS / f"{h}.txt"
        try:
            snap.unlink()
            snapshot_removed = True
        except FileNotFoundError:
            snapshot_removed = True  # already gone, treat as success
        except OSError:
            pass
    # Rebuild the dedup map so the next render after this delete actually
    # writes a new snapshot if it would otherwise have matched the just-
    # removed latest entry.
    state.last_snapshot_hash = _recompute_last_snapshot_hashes(kept)
    return {"ok": True, "removed": removed, "snapshot_removed": snapshot_removed}


@app.post("/api/timeline/clear")
async def post_timeline_clear() -> dict:
    """Wipe the entire history: timeline.jsonl + every snapshot file. The
    `recording` toggle is preserved — if it was on, the next render starts
    a fresh history. Clears the in-memory dedup map so the next snapshot
    isn't skipped against a now-deleted hash."""
    entries_removed = 0
    if TIMELINE_LOG.exists():
        try:
            with TIMELINE_LOG.open("r", encoding="utf-8") as f:
                entries_removed = sum(1 for line in f if line.strip())
        except OSError:
            pass
        try:
            TIMELINE_LOG.unlink()
        except OSError:
            pass
    snapshots_removed = 0
    if SNAPSHOTS.exists():
        for snap in SNAPSHOTS.glob("*.txt"):
            try:
                snap.unlink()
                snapshots_removed += 1
            except OSError:
                pass
    state.last_snapshot_hash.clear()
    return {
        "ok": True,
        "entries_removed": entries_removed,
        "snapshots_removed": snapshots_removed,
    }


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

    await state.flush_clients()
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
    await state.broadcast(
        {
            "type": "agent_edit_range",
            "from_index": insert_index,
            "to_index": insert_index + len(text),
        }
    )
    await reanchor_and_broadcast(rel_name(state.active_doc), new_content)
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
    await reanchor_and_broadcast(rel_name(state.active_doc), new_content)
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

    await state.flush_clients()
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

    await state.broadcast(
        {
            "type": "agent_edit_range",
            "from_index": idx,
            "to_index": idx + len(replace_text),
        }
    )
    return {
        "ok": True,
        "from_index": idx,
        "to_index": end_idx,
        "chars": len(replace_text),
        "user_edited_since": consume_user_edit_flag(),
    }


# ---------- comments API ----------
@app.get("/api/comments")
async def get_comments(
    doc: str = "",
    include_resolved: bool = True,
    author: str = "",
    pending_only: bool = False,
) -> dict:
    """List comments.

    `pending_only` returns only comments that don't yet have a child reply
    by ANY other author. Combined with `author="user"`, this is the
    "what's waiting for me to answer" view for the agent.
    """
    items = state.comments
    if doc:
        items = [c for c in items if c.get("doc") == doc]
    if author:
        items = [c for c in items if c.get("author") == author]
    if not include_resolved:
        items = [c for c in items if not c.get("resolved")]
    if pending_only:
        # A comment is "pending" when no reply by a different author exists.
        has_reply_by_other = {}
        for c in state.comments:
            pid = c.get("parent_id")
            if not pid:
                continue
            parent_author = next(
                (p.get("author") for p in state.comments if p.get("id") == pid),
                None,
            )
            if parent_author and c.get("author") != parent_author:
                has_reply_by_other[pid] = True
        items = [c for c in items if not has_reply_by_other.get(c.get("id"))]
    return {"comments": items}


@app.post("/api/comments")
async def post_comment(payload: dict) -> dict:
    """Create a new comment. Anchor is determined by what fields are given:
      - excerpt set: find unique occurrence in the active doc -> range anchor
      - line set (>=1): line anchor
      - neither: doc-level anchor
    For range and line anchors, doc defaults to state.active_doc; can override
    by passing `doc` explicitly.
    """
    message = payload.get("message")
    if not isinstance(message, str) or not message.strip():
        raise HTTPException(400, "message required")
    message = message.strip()
    doc_rel = payload.get("doc") or rel_name(state.active_doc)
    if not isinstance(doc_rel, str):
        raise HTTPException(400, "doc must be a string")
    target = DOCS / doc_rel
    if not target.exists() or not target.is_file():
        raise HTTPException(404, f"no such doc: {doc_rel}")
    excerpt = payload.get("excerpt")
    line_arg = payload.get("line")
    author = payload.get("author") or "agent"
    parent_id = payload.get("parent_id")

    # Replies inherit their anchor from the parent comment. The thread
    # follows the parent's text; replies don't get their own gutter dot.
    parent = None
    if isinstance(parent_id, str) and parent_id:
        for cm in state.comments:
            if cm.get("id") == parent_id:
                parent = cm
                break
        if parent is None:
            raise HTTPException(404, f"parent comment {parent_id} not found")
        if parent.get("doc") != doc_rel:
            # Force doc to match the parent's
            doc_rel = parent["doc"]
            target = DOCS / doc_rel

    content = target.read_text(encoding="utf-8")
    entry: dict = {
        "id": next_comment_id(),
        "doc": doc_rel,
        "message": message,
        "author": author,
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "resolved": False,
        "orphaned": False,
        "parent_id": parent_id if parent else None,
    }

    if parent is not None:
        # Replies inherit kind + anchor from the parent so they travel
        # together if the parent re-anchors later. Replies are never
        # surfaced in the gutter; sidebar shows them indented.
        entry["kind"] = "reply"
        entry["parent_kind"] = parent.get("kind")
    elif isinstance(excerpt, str) and excerpt:
        idx = content.find(excerpt)
        if idx < 0:
            raise HTTPException(404, "excerpt not found in document")
        if content.find(excerpt, idx + 1) >= 0:
            raise HTTPException(409, "excerpt is not unique; add more context")
        prefix = content[max(0, idx - COMMENT_CONTEXT_CHARS):idx]
        suffix = content[idx + len(excerpt):idx + len(excerpt) + COMMENT_CONTEXT_CHARS]
        from_line, from_ch = line_index_to_linecol(content, idx)
        to_line, to_ch = line_index_to_linecol(content, idx + len(excerpt))
        entry.update({
            "kind": "range",
            "excerpt": excerpt,
            "prefix": prefix,
            "suffix": suffix,
            "from_line": from_line,
            "from_ch": from_ch,
            "to_line": to_line,
            "to_ch": to_ch,
        })
    elif isinstance(line_arg, int) and line_arg >= 1:
        lines = content.split("\n")
        if line_arg > len(lines):
            raise HTTPException(404, f"line {line_arg} out of range (doc has {len(lines)} lines)")
        entry.update({
            "kind": "line",
            "line": line_arg,
            "line_text": lines[line_arg - 1],
        })
    else:
        entry["kind"] = "doc"

    state.comments.append(entry)
    save_comments()
    await broadcast_comments()
    return {"ok": True, "comment": entry}


@app.post("/api/comments/{comment_id}/resolve")
async def post_resolve_comment(comment_id: str, payload: dict | None = None) -> dict:
    resolved = True
    if isinstance(payload, dict) and "resolved" in payload:
        resolved = bool(payload["resolved"])
    for c in state.comments:
        if c.get("id") == comment_id:
            c["resolved"] = resolved
            save_comments()
            await broadcast_comments()
            return {"ok": True, "comment": c}
    raise HTTPException(404, "comment not found")


def _find_comment(comment_id: str) -> dict | None:
    for c in state.comments:
        if c.get("id") == comment_id:
            return c
    return None


@app.get("/api/comments/{comment_id}")
async def get_comment_by_id(comment_id: str) -> dict:
    """Fetch a single comment by id, plus any replies to it.

    Saves the agent from listing every comment in the project just to
    address one — `list_comments` payloads on busy docs blow past tool-
    result size limits and force a workaround search.
    """
    c = _find_comment(comment_id)
    if c is None:
        raise HTTPException(404, f"comment {comment_id} not found")
    replies = [r for r in state.comments if r.get("parent_id") == comment_id]
    return {"comment": c, "replies": replies}


def _thread_root_id(comment_id: str) -> str:
    """Walk parent_id chain up to the root. Cycles are guarded by max depth."""
    current = comment_id
    for _ in range(32):
        c = _find_comment(current)
        if not c:
            return current
        parent = c.get("parent_id")
        if not parent:
            return current
        current = parent
    return current


def _format_thread_for_prompt(root_id: str, target_id: str) -> str:
    thread = [c for c in state.comments
              if c.get("id") == root_id or c.get("parent_id") == root_id]
    thread.sort(key=lambda c: c.get("ts", ""))
    lines: list[str] = []
    for c in thread:
        marker = "  [respond to this]" if c.get("id") == target_id else ""
        author = c.get("author", "?")
        lines.append(f"{author}: {c.get('message', '')}{marker}")
    return "\n".join(lines)


def _format_anchor_for_prompt(root: dict, doc_content: str) -> str:
    kind = root.get("kind")
    if kind == "range":
        return f"anchored to the passage: {root.get('excerpt', '')!r}"
    if kind == "line":
        return f"anchored to line {root.get('line')}: {root.get('line_text', '')!r}"
    return "anchored to the document as a whole"


# Each entry describes how to construct an orchestral LLM client for the
# provider. "native" providers map directly to an orchestral.llm class.
# "openai_compatible" providers (vLLM, LiteLLM) share a wire protocol and
# are built via _build_openai_compatible_client below.
#
#   kind="native":  needs orchestral_attr + key_env (key_env can be "" for
#                   local providers like Ollama).
#   kind="openai":  needs host_env + key_env (key_fallback is used when
#                   key_env is unset, e.g. "dummy" for vLLM servers
#                   launched without --api-key).
_LLM_PROVIDERS: dict[str, dict] = {
    "anthropic": {
        "kind": "native", "orchestral_attr": "Claude",
        "default_model": "claude-sonnet-4-5",
        "key_env": "ANTHROPIC_API_KEY",
    },
    "openai": {
        "kind": "native", "orchestral_attr": "GPT",
        "default_model": "gpt-4o-mini",
        "key_env": "OPENAI_API_KEY",
    },
    "google": {
        "kind": "native", "orchestral_attr": "Gemini",
        "default_model": "gemini-2.5-flash",
        "key_env": "GOOGLE_API_KEY",
    },
    "groq": {
        "kind": "native", "orchestral_attr": "Groq",
        "default_model": "llama-3.3-70b-versatile",
        "key_env": "GROQ_API_KEY",
    },
    "mistral": {
        "kind": "native", "orchestral_attr": "MistralAI",
        "default_model": "mistral-large-latest",
        "key_env": "MISTRAL_API_KEY",
    },
    "ollama": {
        "kind": "native", "orchestral_attr": "Ollama",
        "default_model": "llama3.1",
        "key_env": "",  # local
    },
    "bedrock": {
        "kind": "native", "orchestral_attr": "Bedrock",
        "default_model": "anthropic.claude-3-5-sonnet-20241022-v2:0",
        "key_env": "AWS_ACCESS_KEY_ID",
    },
    "vllm": {
        "kind": "openai", "default_model": "",
        "host_env": "AGENTEX_VLLM_HOST",
        "key_env": "VLLM_API_KEY", "key_fallback": "dummy",
    },
    "litellm": {
        "kind": "openai", "default_model": "",
        "host_env": "AGENTEX_LITELLM_HOST",
        "key_env": "LITELLM_API_KEY", "key_fallback": "",
    },
}


def _provider_spec(provider: str) -> dict:
    spec = _LLM_PROVIDERS.get(provider.lower())
    if not spec:
        raise ValueError(
            f"unknown provider {provider!r}; valid: "
            f"{', '.join(sorted(_LLM_PROVIDERS))}"
        )
    return spec


# Model-id prefixes that unambiguously name a provider. Used to infer the
# provider when the user sets a model (via picker or AGENTEX_API_MODEL) but
# never set AGENTEX_API_PROVIDER — otherwise we'd default to anthropic and
# demand ANTHROPIC_API_KEY for, say, a gemini-* model.
_MODEL_PROVIDER_PREFIXES: tuple[tuple[tuple[str, ...], str], ...] = (
    (("claude",), "anthropic"),
    (("gpt", "o1", "o3", "o4", "chatgpt"), "openai"),
    (("gemini",), "google"),
    (("mistral", "magistral", "mixtral", "codestral"), "mistral"),
)


def _provider_for_model(model: str) -> str | None:
    """Best-effort provider inference from a model id. Returns None when the
    name doesn't unambiguously belong to one provider (e.g. llama-*, which
    could be groq or ollama)."""
    m = (model or "").lower()
    for prefixes, provider in _MODEL_PROVIDER_PREFIXES:
        if m.startswith(prefixes):
            return provider
    return None


def _resolve_provider(override: str | None = None) -> str:
    if override:
        return override.lower()
    env = os.environ.get("AGENTEX_API_PROVIDER")
    if env:
        return env.lower()
    # No explicit provider. Infer from an explicitly-configured model id...
    model = os.environ.get("AGENTEX_API_MODEL")
    if model:
        inferred = _provider_for_model(model)
        if inferred:
            return inferred
    # ...otherwise pick the first provider whose key/host is configured, so a
    # user who only set GOOGLE_API_KEY gets google rather than a dead anthropic
    # default. Skip ollama (local, always "present") to avoid auto-selecting it.
    for name in _LLM_PROVIDERS:
        if name == "ollama":
            continue
        if _api_key_present(name):
            return name
    return "anthropic"


def _resolve_model(provider: str, override: str | None = None) -> str:
    if override:
        return override
    # AGENTEX_API_MODEL is a single model id, so it only makes sense for
    # the currently-selected default provider. Returning "claude-sonnet-4-5"
    # as Ollama's default (for example) would just mislead the picker UI.
    env_default = os.environ.get("AGENTEX_API_MODEL")
    if env_default and provider == _resolve_provider():
        return env_default
    return _provider_spec(provider)["default_model"]


def _resolve_host(provider: str, override: str | None = None) -> str:
    spec = _provider_spec(provider)
    if spec["kind"] != "openai":
        return ""
    if override:
        return override
    return os.environ.get(spec["host_env"]) or ""


def _api_key_present(provider: str) -> bool:
    """True when the provider can be used without further config (key
    present, or none required)."""
    spec = _provider_spec(provider)
    if spec["kind"] == "openai":
        # openai-compatible needs at least a host; key can fall back.
        return bool(_resolve_host(provider))
    key_env = spec["key_env"]
    if not key_env:
        return True  # local provider (Ollama)
    return bool(os.environ.get(key_env))


def _build_openai_compatible_client(*, host: str, model: str, api_key: str, label: str):
    """Construct an orchestral GPT instance pointed at an OpenAI-compatible
    endpoint (vLLM, LiteLLM, or any server speaking the OpenAI wire format).
    Bypasses GPT.__init__'s model-name validation by hand-building the
    instance. Ported from heptapod-stk/heptapod/llm/utils.py."""
    import openai
    from orchestral.llm import GPT
    from orchestral.llm.base.llm import LLM

    if not host:
        raise ValueError(f"no {label} host configured (set AGENTEX_{label.upper()}_HOST)")
    if not model:
        raise ValueError(f"no {label} model specified (pass model=... or set AGENTEX_API_MODEL)")

    gpt = GPT.__new__(GPT)
    LLM.__init__(gpt, tools=None)
    gpt.model = model
    gpt.api_key = api_key
    gpt.client = openai.Client(api_key=api_key, base_url=host, timeout=60.0)
    return gpt


def _make_llm_client(provider: str, model: str, host: str = ""):
    """Lazily construct an orchestral LLM client for the given selection."""
    spec = _provider_spec(provider)
    try:
        import orchestral.llm as ollm  # noqa: F401  (lazy load)
    except ImportError as e:
        raise ValueError(f"orchestral not installed: {e}")

    if spec["kind"] == "openai":
        api_key = os.environ.get(spec["key_env"], "") or spec.get("key_fallback", "")
        return _build_openai_compatible_client(
            host=host, model=model, api_key=api_key, label=provider,
        )

    Provider = getattr(ollm, spec["orchestral_attr"])
    return Provider(model=model)


# ---------- spend tracking ----------
_SESSION_SPEND_USD = 0.0


def _record_spend(provider: str, model: str, usage, comment_id: str) -> None:
    """Append a spend entry to .agentex/spend.jsonl. Best-effort: a write
    failure must not break the response."""
    global _SESSION_SPEND_USD
    cost = float(getattr(usage, "cost", 0.0) or 0.0)
    tokens = getattr(usage, "tokens", {}) or {}
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "provider": provider,
        "model": model,
        "comment_id": comment_id,
        "cost_usd": cost,
        "tokens": tokens,
    }
    _SESSION_SPEND_USD += cost
    try:
        AGENTEX.mkdir(parents=True, exist_ok=True)
        with SPEND_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def _read_spend_log() -> list[dict]:
    if not SPEND_LOG.exists():
        return []
    out: list[dict] = []
    try:
        for line in SPEND_LOG.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except OSError:
        pass
    return out


def _spend_totals() -> dict:
    today = datetime.now(timezone.utc).date().isoformat()
    entries = _read_spend_log()
    daily = sum(e.get("cost_usd", 0.0) for e in entries if e.get("ts", "").startswith(today))
    all_time = sum(e.get("cost_usd", 0.0) for e in entries)
    return {
        "session_usd": round(_SESSION_SPEND_USD, 6),
        "today_usd": round(daily, 6),
        "all_time_usd": round(all_time, 6),
        "n_calls": len(entries),
    }


def _spend_limits() -> dict:
    daily = os.environ.get("AGENTEX_SPEND_LIMIT_DAILY")
    session = os.environ.get("AGENTEX_SPEND_LIMIT_SESSION")
    return {
        "daily_usd": float(daily) if daily else None,
        "session_usd": float(session) if session else None,
    }


def _check_spend_limits() -> None:
    """Raise HTTPException(402) if a spend limit would be exceeded by another
    call. Conservative: we don't pre-deduct, just block once we're over."""
    limits = _spend_limits()
    totals = _spend_totals()
    if limits["daily_usd"] is not None and totals["today_usd"] >= limits["daily_usd"]:
        raise HTTPException(
            402,
            f"daily spend limit reached "
            f"(${totals['today_usd']:.2f} / ${limits['daily_usd']:.2f}); "
            f"set AGENTEX_SPEND_LIMIT_DAILY higher or wait until tomorrow",
        )
    if limits["session_usd"] is not None and totals["session_usd"] >= limits["session_usd"]:
        raise HTTPException(
            402,
            f"session spend limit reached "
            f"(${totals['session_usd']:.2f} / ${limits['session_usd']:.2f}); "
            f"restart the server or raise AGENTEX_SPEND_LIMIT_SESSION",
        )


@app.post("/api/comments/{comment_id}/respond")
async def respond_to_comment(comment_id: str, payload: dict | None = None) -> dict:
    """Generate an agent reply to a user comment via the configured LLM
    provider (orchestral). The reply is posted as a thread reply under
    the conversation's root comment.

    Optional body overrides for per-request A/B testing across providers
    and models without restarting the server:
      {"provider": "openai", "model": "gpt-4o", "host": "..."}
    Any field omitted falls back to the env-driven default.
    """
    payload = payload or {}
    try:
        provider = _resolve_provider(payload.get("provider"))
        model = _resolve_model(provider, payload.get("model"))
        host = _resolve_host(provider, payload.get("host"))
        if not _api_key_present(provider):
            spec = _provider_spec(provider)
            if spec["kind"] == "openai":
                raise HTTPException(503, f"no host configured for {provider!r}")
            key_env = spec["key_env"] or "API key"
            raise HTTPException(503, f"{key_env} not set for provider {provider!r}")
    except ValueError as e:
        raise HTTPException(400, str(e))

    _check_spend_limits()

    target = _find_comment(comment_id)
    if not target:
        raise HTTPException(404, f"comment {comment_id} not found")

    doc_rel = target.get("doc", "")
    doc_path = DOCS / doc_rel
    doc_content = doc_path.read_text(encoding="utf-8") if doc_path.exists() else ""

    root_id = _thread_root_id(comment_id)
    root = _find_comment(root_id) or target
    anchor_desc = _format_anchor_for_prompt(root, doc_content)
    thread_text = _format_thread_for_prompt(root_id, comment_id)

    from agentex._guide import load_agent_guide

    system_prompt = (
        load_agent_guide()
        + "\n\n---\n\n"
        + "## Naming note\n\n"
        "In this in-process binding, the tools above are exposed in "
        "snake_case (`list_docs`, `edit_doc`, `add_comment`, …) rather than "
        "the PascalCase form the guide uses. Same tools, same semantics.\n\n"
        "## Your current task\n\n"
        "The user has left a comment in this agenTeX session and wants your "
        "reply. Respond DIRECTLY to the user's message marked [respond to "
        "this] below — not a summary of the anchored passage or the document "
        "at large. The reply becomes a comment thread post.\n\n"
        "Be conservative about edits: only modify the doc when the user "
        "explicitly asks for a textual change. Otherwise discuss in your "
        "reply and let the user decide.\n\n"
        "Keep replies concise (a few sentences to a short paragraph)."
    )

    # Find the target comment's message text so we can foreground it. The
    # full thread + doc still go into the prompt as context, but they live
    # below the explicit user request to keep the model focused.
    target_msg = (target.get("message") or "").strip()

    user_prompt = (
        "USER'S MESSAGE (respond to this):\n"
        f"{target_msg!r}\n\n"
        "---\n"
        f"Context — comment thread {anchor_desc}.\n\n"
        f"Full thread (newest message marked [respond to this]):\n"
        f"{thread_text}\n\n"
        f"---\n"
        f"Document (path={doc_rel!r}):\n"
        f"{doc_content}"
    )

    try:
        from orchestral import Agent
        from orchestral.context import Context
        from agentex.tools.in_process_tools import AGENT_TOOLS
        client = _make_llm_client(provider, model, host)
    except (ImportError, ValueError) as e:
        raise HTTPException(503, str(e))

    # Tool-driven agent: the model can call ListDocs / ReadDoc / ListComments
    # mid-response to gather more context than the initial prompt carries.
    # Tools run in-process (tools/in_process_tools.py) so latency is ~µs not ms.
    ctx = Context(system_prompt=system_prompt)

    # Create a placeholder reply BEFORE streaming so the frontend can render
    # an empty row and fill it in as chunks arrive. `events` is the
    # chronological log of what the agent produced — text segments and
    # tool calls in the order they happened. `tool_calls` is kept as a
    # filtered view for older consumers; `message` is the concatenated
    # text for plain-text use.
    reply_entry = {
        "id": next_comment_id(),
        "doc": doc_rel,
        "message": "",
        "author": "agent",
        "provider": provider,
        "model": model,
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "resolved": False,
        "orphaned": False,
        "parent_id": root_id,
        "kind": "reply",
        "parent_kind": root.get("kind"),
        "streaming": True,
        "events": [],
        "tool_calls": [],
    }
    state.comments.append(reply_entry)
    await broadcast_comments()

    loop = asyncio.get_running_loop()
    reply_id = reply_entry["id"]

    def _emit(payload: dict) -> None:
        """Schedule a WS broadcast from the worker thread."""
        asyncio.run_coroutine_threadsafe(state.broadcast(payload), loop)

    # Subclass Agent on the fly to capture tool-call lifecycle. We do this
    # rather than the bundled tool_stream_callback because we want one
    # event when the tool STARTS (so the UI can show a pill in "running"
    # state) and a second when it COMPLETES (with result + runtime).
    class _StreamingAgent(Agent):
        def _handle_tool_call(self, tool_call):
            args = dict(getattr(tool_call, "arguments", {}) or {})
            _emit({
                "type": "agent_tool_call_start",
                "comment_id": reply_id,
                "call_id": tool_call.id,
                "tool_name": tool_call.tool_name,
                "args": args,
            })
            super()._handle_tool_call(tool_call)
            last = self.context.messages[-1] if self.context.messages else None
            result_text = (getattr(last, "text", "") or "")[:1500]
            failed = bool(getattr(last, "failed", False))
            runtime_ms = float(
                (getattr(last, "metadata", {}) or {}).get("runtime_ms", 0.0) or 0.0
            )
            record = {
                "id": tool_call.id,
                "name": tool_call.tool_name,
                "args": args,
                "result": result_text,
                "failed": failed,
                "runtime_ms": runtime_ms,
            }
            reply_entry["tool_calls"].append(record)
            reply_entry["events"].append({"type": "tool_call", **record})
            _emit({
                "type": "agent_tool_call_end",
                "comment_id": reply_id,
                "call_id": tool_call.id,
                "tool_name": tool_call.tool_name,
                "result": result_text,
                "failed": failed,
                "runtime_ms": runtime_ms,
            })

    def _stream_worker() -> tuple[str, float]:
        """Drive the agent loop in a worker thread, with both streaming AND
        tool calls. orchestral's `stream_text_message` only streams one
        LLM call (no tool loop); `Agent.run` has the tool loop but no
        streaming. We compose them: stream the response, add it to
        context, run any tool calls, repeat.

        Returns (accumulated_text, total_cost_usd).
        """
        from orchestral.context.message import Message

        agent = _StreamingAgent(
            llm=client,
            context=ctx,
            system_prompt=system_prompt,
            tools=list(AGENT_TOOLS),
            max_tool_interations=6,
        )
        # Seed the user turn once; subsequent LLM turns re-use the same
        # context with tool-result messages appended in between.
        agent.context.add_message(Message(role="user", text=user_prompt))

        accumulated = ""
        current_segment = ""  # text within the current LLM turn

        def _flush_text():
            nonlocal current_segment
            if current_segment:
                reply_entry["events"].append({
                    "type": "text", "text": current_segment,
                })
                current_segment = ""

        max_rounds = 7  # 1 initial + up to 6 tool-iteration rounds
        for _ in range(max_rounds):
            gen = agent.llm.stream_response(agent.context)
            response = None
            try:
                while True:
                    chunk = next(gen)
                    if not chunk:
                        continue
                    accumulated += chunk
                    current_segment += chunk
                    _emit({
                        "type": "agent_stream_chunk",
                        "comment_id": reply_id,
                        "text": chunk,
                    })
            except StopIteration as stop:
                response = stop.value
            if response is None:
                break
            # The Response goes into context BEFORE handling tool calls
            # (handler reads context.messages[-1] to find the latest).
            agent.context.add_message(response)
            tool_calls = getattr(response.message, "tool_calls", None) or []
            # Flush text-so-far as an event BEFORE any tool calls, so the
            # event log preserves "text -> tool -> next text" ordering.
            _flush_text()
            if not tool_calls:
                break
            agent._handle_tool_calls()  # fires _handle_tool_call (appends tool_call events)
        _flush_text()  # final tail of text, if any
        return accumulated, agent.get_total_cost()

    # On any error inside the agent loop we keep the placeholder (with
    # whatever text + tool calls it accumulated) and surface the failure
    # inline. Deleting the row hides what just happened — losing the pills
    # the user was watching — which makes debugging impossible.
    error_text: str | None = None
    accumulated = ""
    total_cost = 0.0
    try:
        accumulated, total_cost = await asyncio.to_thread(_stream_worker)
    except Exception as e:
        log.exception("agent loop failed (comment %s)", reply_id)
        error_text = f"{type(e).__name__}: {e}"

    reply_text = (accumulated or "").strip()
    if error_text:
        # Append the error onto whatever streamed so far, mark the comment
        # as failed, and broadcast. No HTTPException — the comment itself
        # carries the failure state, so the UI can render it.
        msg = reply_text + ("\n\n" if reply_text else "")
        msg += f"[error] agent loop failed: {error_text}"
        reply_entry["message"] = msg
        reply_entry["streaming"] = False
        reply_entry["failed"] = True
        reply_entry["error"] = error_text
        save_comments()
        await broadcast_comments()
        await state.broadcast({
            "type": "agent_stream_end",
            "comment_id": reply_id,
        })
        return {"ok": False, "comment": reply_entry, "error": error_text}

    if not reply_text:
        # Loop succeeded but the model never emitted text (only tool calls
        # that returned nothing useful, or empty final turn). Mark failed
        # rather than silently dropping the row.
        reply_entry["message"] = "[error] agent finished without emitting reply text."
        reply_entry["streaming"] = False
        reply_entry["failed"] = True
        save_comments()
        await broadcast_comments()
        await state.broadcast({
            "type": "agent_stream_end",
            "comment_id": reply_id,
        })
        return {"ok": False, "comment": reply_entry, "error": "empty reply"}

    # Record spend from the agent's accumulated cost across all LLM turns
    # (not just the last one). Fabricate a minimal Usage-shaped object.
    class _AggUsage:
        def __init__(self, cost: float):
            self.cost = cost
            self.tokens: dict = {}
    _record_spend(provider, model, _AggUsage(total_cost), comment_id)

    reply_entry["message"] = reply_text
    reply_entry["streaming"] = False
    save_comments()
    await broadcast_comments()
    await state.broadcast({
        "type": "agent_stream_end",
        "comment_id": reply_id,
    })
    return {"ok": True, "comment": reply_entry}


@app.get("/api/config")
async def get_config() -> dict:
    """Feature flags + LLM selection surfaced to the frontend. Returns
    enablement per provider so the picker UI can grey out unconfigured
    ones."""
    default_provider = _resolve_provider()
    providers = {}
    for name in _LLM_PROVIDERS:
        try:
            spec = _provider_spec(name)
            providers[name] = {
                "available": _api_key_present(name),
                "default_model": _resolve_model(name),
                "kind": spec["kind"],
                "key_env": spec.get("key_env", ""),
                "host_env": spec.get("host_env", ""),
                "host": _resolve_host(name) if spec["kind"] == "openai" else "",
            }
        except ValueError:
            providers[name] = {"available": False}
    return {
        "default_provider": default_provider,
        "default_model": _resolve_model(default_provider),
        "providers": providers,
        "api_response_enabled": any(p.get("available") for p in providers.values()),
        "spend": _spend_totals(),
        "spend_limits": _spend_limits(),
    }


_DATED_MODEL_RE = re.compile(r"-\d{8}$")

# Models retired by their provider — the catalog upstream (orchestral)
# still lists them, but the API returns 404 if you try to call them. We
# filter these out at the picker so users can't accidentally pick a dead
# id. Cross-checked against Anthropic's live /v1/models endpoint; add
# (provider, model_id) tuples as they're retired.
_RETIRED_MODELS: set[tuple[str, str]] = {
    # Claude 3 Haiku — retired 2025
    ("anthropic", "claude-3-haiku-20240307"),
    # Claude 3.5 Haiku — retired
    ("anthropic", "claude-3-5-haiku-20241022"),
    ("anthropic", "claude-3-5-haiku-latest"),
    # Claude 3.7 Sonnet — retired
    ("anthropic", "claude-3-7-sonnet-20250219"),
    ("anthropic", "claude-3-7-sonnet-latest"),
    # Stale date in orchestral's catalog: the live id is 20251001, not
    # 20251015. The non-dated `claude-haiku-4-5` alias routes correctly.
    ("anthropic", "claude-haiku-4-5-20251015"),
}


_MODEL_CATALOG_CACHE: dict | None = None
_MODEL_CATALOG_LOCK = asyncio.Lock()


def _prewarm_model_catalog() -> None:
    """Populate _MODEL_CATALOG_CACHE on a worker thread. Safe to call once
    at startup; idempotent — later calls find the cache and return."""
    global _MODEL_CATALOG_CACHE
    if _MODEL_CATALOG_CACHE is not None:
        return
    try:
        catalog = _build_model_catalog()
    except Exception:
        log.exception("model catalog pre-warm failed")
        return
    _MODEL_CATALOG_CACHE = catalog


def _build_model_catalog() -> dict:
    """Sync builder for the model catalog. Imports orchestral.llm.<name>.model_details
    for each configured provider — Anthropic's costs ~7s, Bedrock ~2s, so this
    must NOT run inline in an async handler or it stalls the event loop (and
    every WebSocket message with it). Callers should wrap in asyncio.to_thread."""
    providers: dict[str, list] = {}
    for name in _LLM_PROVIDERS:
        if not _api_key_present(name):
            continue
        try:
            mod = __import__(
                f"orchestral.llm.{name}.model_details",
                fromlist=["MODEL_DETAILS"],
            )
        except ImportError:
            continue
        chosen: dict[str, dict] = {}
        order: list[str] = []
        for model_id, details in (mod.MODEL_DETAILS or {}).items():
            if (name, model_id) in _RETIRED_MODELS:
                continue
            friendly = details.get("friendly_name", model_id)
            entry = {
                "model_id": model_id,
                "friendly_name": friendly,
                "context_window": details.get("context_window", 0),
                "output_limit": details.get("output_limit", 0),
            }
            existing = chosen.get(friendly)
            if existing is None:
                chosen[friendly] = entry
                order.append(friendly)
                continue
            existing_dated = bool(_DATED_MODEL_RE.search(existing["model_id"]))
            new_dated = bool(_DATED_MODEL_RE.search(model_id))
            if existing_dated and not new_dated:
                chosen[friendly] = entry
        providers[name] = [chosen[fr] for fr in order]
    return {"providers": providers}


@app.get("/api/config/models")
async def get_available_models() -> dict:
    """Catalog of provider + model entries for the frontend picker.

    Only loads catalogs for providers that have keys configured. Cached on
    first build; pre-warmed at lifespan startup. The build is run in a
    worker thread because the underlying SDK imports (anthropic, bedrock)
    take seconds and would otherwise freeze the event loop.

    Dedup rule: when two model_ids share a friendly_name (e.g.
    `claude-sonnet-4-5` and `claude-sonnet-4-5-20250929` both surface as
    "Claude Sonnet 4.5"), prefer the alias (no -YYYYMMDD suffix). The
    alias auto-tracks the current stable and is what `AGENTEX_API_MODEL`
    defaults expect.
    """
    global _MODEL_CATALOG_CACHE
    if _MODEL_CATALOG_CACHE is not None:
        return _MODEL_CATALOG_CACHE
    async with _MODEL_CATALOG_LOCK:
        if _MODEL_CATALOG_CACHE is None:
            _MODEL_CATALOG_CACHE = await asyncio.to_thread(_build_model_catalog)
    return _MODEL_CATALOG_CACHE


@app.get("/api/spend")
async def get_spend() -> dict:
    """Spend rollup: session, today, all-time, plus the configured limits."""
    return {"totals": _spend_totals(), "limits": _spend_limits()}


@app.delete("/api/comments/{comment_id}")
async def delete_comment(comment_id: str) -> dict:
    for i, c in enumerate(state.comments):
        if c.get("id") == comment_id:
            removed = state.comments.pop(i)
            save_comments()
            await broadcast_comments()
            return {"ok": True, "removed": removed["id"]}
    raise HTTPException(404, "comment not found")


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
                "assets": list_asset_names(),
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
        await ws.send_json({"type": "comments", "comments": state.comments})
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
                await reanchor_and_broadcast(rel_name(state.active_doc), content)
                state.user_edits_pending = True
                state.last_edit_author = "user"
                # Deliberately NOT scheduling a render here. The user must
                # press Cmd/Ctrl-S in the browser to trigger one (we get a
                # 'render' message), so typing doesn't thrash tectonic.
            elif kind == "render":
                schedule_render()
            elif kind == "save_now_ack":
                if state.flush_ack is not None:
                    state.flush_ack.set()
            elif kind == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        state.clients.discard(ws)


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import socket
    import uvicorn

    host = os.environ.get("AGENTEX_HOST", "127.0.0.1")
    requested_port = int(os.environ.get("AGENTEX_PORT", "8000"))

    def _find_free_port(start: int, host: str, max_offset: int = 20) -> int:
        """Probe up to max_offset+1 ports starting at `start`. SO_REUSEADDR
        matches uvicorn's bind options so the probe sees the same address
        space (without it, TIME_WAIT sockets would falsely report a port
        as taken)."""
        for offset in range(max_offset + 1):
            p = start + offset
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    s.bind((host, p))
                    return p
                except OSError:
                    continue
        raise RuntimeError(
            f"agenTeX: no free port in {start}..{start + max_offset}"
        )

    port = _find_free_port(requested_port, host)
    if port != requested_port:
        print(
            f"agenTeX: port {requested_port} in use; using {port} instead",
            file=sys.stderr,
        )
    # Surface where the editor is rooted so the user sees instantly whether
    # the positional arg / AGENTEX_PROJECT resolved as expected.
    print(f"agenTeX: docs    = {DOCS}", file=sys.stderr)
    print(f"agenTeX: state   = {AGENTEX}", file=sys.stderr)
    print(f"agenTeX: build   = {BUILD}", file=sys.stderr)
    print(f"agenTeX: listening on http://{host}:{port}", file=sys.stderr)
    # Stash the bound port so MCP tools (and any other peer tied to this
    # project) can find this instance without a hard-coded port. Read by
    # tools/agentex.py:_resolve_agentex_base.
    try:
        AGENTEX.mkdir(parents=True, exist_ok=True)
        (AGENTEX / "port").write_text(str(port), encoding="utf-8")
    except OSError:
        pass
    uvicorn.run(app, host=host, port=port, log_level="info")
