"""Shared model-bundle registry + SSE download endpoint used by the toolbox.

Each ML node file (`nodes_face.py`, `nodes_bg_remove.py`, …) registers one
bundle at import time, declaring which files it needs on disk and where to
fetch them. The toolbox calls a single set of endpoints regardless of which
bundle is involved.
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any


# A single file inside a bundle. We track size + url-list (mirrors) per file
# so a dead URL doesn't break a bundle, and a status probe is just a stat call.
@dataclasses.dataclass
class ModelFile:
    name: str
    path: str
    size: int                       # expected size in bytes; used for verification
    urls: list[str]                 # mirrors, tried in order


# A logical bundle (= what's behind one toolbox card). May contain multiple
# files. May also have a `prepare_fn` that runs *after* downloads finish — e.g.
# warm a model into memory once its files are on disk.
#
# `ready_check_fn`, if set, overrides the default "all files exist on disk"
# check. Useful when the bundle is managed by an opaque cache (faster-whisper,
# demucs etc.) and we can't enumerate filenames up front — the check just
# pings the library: "do you have what you need?".
@dataclasses.dataclass
class ModelBundle:
    key: str                        # toolbox-visible id, e.g. 'faceswap'
    label: str                      # shown in the progress toast
    files: list[ModelFile]
    prepare_fn: Callable[[], None] | None = None
    ready_check_fn: Callable[[], bool] | None = None


_REGISTRY: dict[str, ModelBundle] = {}


def register_bundle(bundle: ModelBundle) -> None:
    _REGISTRY[bundle.key] = bundle


def get_bundle(key: str) -> ModelBundle | None:
    return _REGISTRY.get(key)


def bundle_status(key: str) -> dict:
    """{ready: bool, missing: [{name, size}], total_size}

    A file is considered present if it exists AND either (a) its size matches
    the declared `size`, or (b) `size <= 0` meaning we didn't know the exact
    byte count when registering the bundle and a non-empty file is enough.
    """
    bundle = _REGISTRY.get(key)
    if bundle is None:
        return {"ready": False, "missing": [], "total_size": 0, "error": f"unknown bundle '{key}'"}

    def _present(f: ModelFile) -> bool:
        if not os.path.isfile(f.path):
            return False
        actual = os.path.getsize(f.path)
        if f.size > 0:
            return actual == f.size
        return actual > 0  # unknown size — accept any non-empty download

    # Library-managed bundles (whisper, demucs, depth) have no enumerable files,
    # so the callback is AUTHORITATIVE: its result decides readiness. We must not
    # fall through to the file check below — an empty `files` list would yield an
    # empty `missing` and falsely report ready=True for an un-downloaded bundle.
    if bundle.ready_check_fn is not None:
        try:
            ready = bool(bundle.ready_check_fn())
        except Exception:
            ready = False  # treat probe failure as not-ready; the download path handles it
        total = sum(max(f.size, 0) for f in bundle.files)
        return {
            "ready": ready,
            # Surface a single bundle-level entry when not ready so the UI knows
            # there is something to fetch (the download runs via prepare_fn).
            "missing": [] if ready else [{"name": bundle.label, "size": total}],
            "total_size": total,
            "label": bundle.label,
        }

    missing = [
        {"name": f.name, "size": f.size}
        for f in bundle.files
        if not _present(f)
    ]
    return {
        "ready": len(missing) == 0,
        "missing": missing,
        "total_size": sum(max(f.size, 0) for f in bundle.files),
        "label": bundle.label,
    }


_DL_TIMEOUT = 60          # socket read timeout (s) — generous for big-file stalls
_DL_ATTEMPTS = 4          # tries per mirror, with HTTP-Range resume + backoff


def _download_file(file: ModelFile, progress_cb: Callable[[int, int], None]) -> None:
    """Stream `file` to disk trying each mirror in order. Resumable: a stalled
    read is retried with an HTTP Range request that continues from the bytes
    already on disk (`.part`), so a flaky connection doesn't restart a 200 MB
    download from zero. Raises only if every mirror exhausts its attempts."""
    os.makedirs(os.path.dirname(file.path), exist_ok=True)
    tmp_path = file.path + ".part"
    errors: list[str] = []

    for url in file.urls:
        host = url.split("/")[2]
        for attempt in range(_DL_ATTEMPTS):
            have = os.path.getsize(tmp_path) if os.path.exists(tmp_path) else 0
            headers = {"User-Agent": "Sailor/1.0"}
            if have:
                headers["Range"] = f"bytes={have}-"
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=_DL_TIMEOUT) as resp:
                    code = resp.getcode()
                    # 206 = server honored our resume; 200 = it ignored Range and
                    # is sending the whole file, so start the .part over.
                    resuming = have > 0 and code == 206
                    mode = "ab" if resuming else "wb"
                    downloaded = have if resuming else 0
                    crange = resp.headers.get("Content-Range")
                    if crange and "/" in crange:
                        total = int(crange.rsplit("/", 1)[-1])
                    else:
                        clen = int(resp.headers.get("Content-Length") or file.size)
                        total = (downloaded + clen) if resuming else (clen or file.size)
                    chunk = 1 << 20  # 1 MiB
                    with open(tmp_path, mode) as f:
                        while True:
                            buf = resp.read(chunk)
                            if not buf:
                                break
                            f.write(buf)
                            downloaded += len(buf)
                            progress_cb(downloaded, total)
                # Guard against a silently-truncated stream.
                if file.size > 0 and os.path.getsize(tmp_path) < file.size:
                    raise OSError(f"incomplete: {os.path.getsize(tmp_path)}/{file.size} bytes")
                os.replace(tmp_path, file.path)
                return
            except (urllib.error.URLError, OSError) as e:
                errors.append(f"{host} (try {attempt + 1}/{_DL_ATTEMPTS}): {e}")
                # A stale/oversized .part makes the server reject the Range (416);
                # drop it so the next attempt re-fetches from scratch.
                if isinstance(e, urllib.error.HTTPError) and e.code == 416:
                    try:
                        os.remove(tmp_path)
                    except OSError:
                        pass
                # Otherwise keep .part so the next attempt resumes where we stalled.
                if attempt < _DL_ATTEMPTS - 1:
                    time.sleep(min(2 ** attempt, 8))   # 1s, 2s, 4s backoff

    raise RuntimeError(f"All mirrors failed for {file.name}:\n  - " + "\n  - ".join(errors))


# Optional: per-bundle in-process loaders cache. Nodes can stash their loaded
# model objects here keyed by bundle.key + ':' + role so multiple node instances
# share one initialization.
_LOADER_CACHE: dict[str, Any] = {}


def loader_cache() -> dict[str, Any]:
    return _LOADER_CACHE


# ---------------------------------------------------------------------------
# HTTP routes — generic. Registered once on first import.
# ---------------------------------------------------------------------------

try:
    from aiohttp import web

    from server import PromptServer

    _routes_registered = False

    def _register_routes() -> None:
        global _routes_registered
        if _routes_registered:
            return
        _routes_registered = True

        @PromptServer.instance.routes.get("/sailor/models/status")
        async def _status_route(request):
            key = request.query.get("key", "")
            return web.json_response(bundle_status(key))

        @PromptServer.instance.routes.get("/sailor/models/download")
        async def _download_route(request):
            """SSE stream of `data: {phase, file, downloaded, total}` lines."""
            key = request.query.get("key", "")
            response = web.StreamResponse(
                status=200,
                headers={
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",
                },
            )
            await response.prepare(request)

            async def send(payload: dict) -> None:
                await response.write(f"data: {json.dumps(payload)}\n\n".encode())

            bundle = _REGISTRY.get(key)
            if bundle is None:
                await send({"phase": "error", "message": f"Unknown model bundle '{key}'"})
                return response

            await send({"phase": "start", "label": bundle.label})

            try:
                status = bundle_status(key)
                missing_names = {m["name"] for m in status["missing"]}

                # Run each missing file's download in a thread so the SSE loop
                # can pump progress without blocking aiohttp's event loop.
                for file in bundle.files:
                    if file.name not in missing_names:
                        continue
                    await send({"phase": "downloading", "file": file.name, "downloaded": 0, "total": file.size})
                    q: queue.Queue = queue.Queue()
                    error_box: list[BaseException] = []

                    def worker(f=file, q_=q, eb=error_box):
                        try:
                            _download_file(f, lambda d, t: q_.put(("p", d, t)))
                            q_.put(("done", 0, 0))
                        except BaseException as e:
                            eb.append(e)
                            q_.put(("err", 0, 0))

                    threading.Thread(target=worker, daemon=True).start()

                    while True:
                        try:
                            kind, d, t = q.get(timeout=0.05)
                        except queue.Empty:
                            await asyncio.sleep(0.05)
                            continue
                        if kind == "p":
                            await send({"phase": "downloading", "file": file.name, "downloaded": d, "total": t})
                        elif kind == "err":
                            await send({"phase": "error", "message": str(error_box[0]) if error_box else "download failed"})
                            return response
                        else:
                            break

                if bundle.prepare_fn is not None:
                    await send({"phase": "preparing", "file": bundle.label})
                    # Run in a thread too; some preparers download more files.
                    err_box: list[BaseException] = []

                    def prep():
                        try:
                            bundle.prepare_fn()
                        except BaseException as e:
                            err_box.append(e)

                    t = threading.Thread(target=prep, daemon=True)
                    t.start()
                    while t.is_alive():
                        await asyncio.sleep(0.1)
                    if err_box:
                        await send({"phase": "error", "message": str(err_box[0])})
                        return response

                await send({"phase": "done"})
            except BaseException as e:
                await send({"phase": "error", "message": str(e)})
            return response

    _register_routes()

except Exception:  # noqa: BLE001 — outside the server, PromptServer.instance may be unset (AttributeError)
    pass
