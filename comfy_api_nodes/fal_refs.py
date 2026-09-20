"""Minimal fal.ai queue client for video models whose provider is 'fal'.

Mirrors the shape of replicate_refs.py. fal's queue REST API:
  POST  queue.fal.run/{app}/{fn}            -> {request_id, status, ...}
  GET   queue.fal.run/{app}/requests/{rid}/status
  GET   queue.fal.run/{app}/requests/{rid}  -> result payload

Auth is 'Authorization: Key <id:secret>'. The app namespace is two segments
(e.g. 'bytedance/seedance-2.0'); the function is the trailing segment
(e.g. 'reference-to-video'). Status/result are polled under the APP base
(queue.fal.run/{app}/requests/...), NOT under the function path.
"""
import asyncio
import os
import time

import aiohttp

FAL_QUEUE_BASE = "https://queue.fal.run"
_TOKEN_CACHE: str | None = None


def _dotenv_paths() -> list[str]:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    return [os.path.join(root, "frontend", ".env"), os.path.join(root, ".env")]


def _read_token_from_dotenv() -> str | None:
    for path in _dotenv_paths():
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    for name in ("FAL_KEY", "NUXT_FAL_TOKEN"):
                        if line.startswith(name + "="):
                            v = line.split("=", 1)[1].strip().strip('"').strip("'")
                            if v:
                                return v
        except OSError:
            continue
    return None


def get_fal_token() -> str:
    global _TOKEN_CACHE
    if _TOKEN_CACHE:
        return _TOKEN_CACHE
    for env_name in ("FAL_KEY", "NUXT_FAL_TOKEN"):
        token = os.environ.get(env_name, "").strip()
        if token:
            _TOKEN_CACHE = token
            return token
    token = _read_token_from_dotenv()
    if token:
        _TOKEN_CACHE = token
        return token
    raise RuntimeError(
        "fal API token not found. Set FAL_KEY (or NUXT_FAL_TOKEN) in your shell, "
        "or add FAL_KEY=<id:secret> to frontend/.env. See https://fal.ai/dashboard/keys"
    )


def first_fal_video_url(result: dict) -> str:
    url = ((result or {}).get("video") or {}).get("url")
    if not url:
        raise RuntimeError(f"fal result had no video url: {result!r}")
    return url


def first_fal_image_url(result: dict) -> str:
    """First image URL from an fal image result (e.g. flux-pro/kontext), which
    returns {images: [{url, width, height, ...}, ...]}."""
    images = (result or {}).get("images") or []
    url = images[0].get("url") if images and isinstance(images[0], dict) else None
    if not url:
        raise RuntimeError(f"fal result had no image url: {result!r}")
    return url


def all_fal_image_urls(result: dict) -> list[str]:
    """Every image URL from an fal image result, in order — the batch-aware
    counterpart of first_fal_image_url (num_images>1 returns N images)."""
    images = (result or {}).get("images") or []
    return [
        img["url"]
        for img in images
        if isinstance(img, dict) and isinstance(img.get("url"), str)
    ]


def _poll_delay(attempt: int) -> float:
    """Seconds to wait before status poll number `attempt` (0-based).

    Ramps 0.35s → 2s. The old flat 2s meant a sub-second job (flux-schnell
    renders a 4-up 512px batch in ~1s) spent more wall clock waiting for the
    poll than for the model, while a long video job barely notices the handful
    of extra calls the ramp adds.
    """
    return min(2.0, 0.35 * (1.5 ** attempt))


async def run_fal_prediction(
    app: str, fn: str, input_dict: dict, *, poll_deadline_sec: int = 900,
) -> dict:
    token = get_fal_token()
    headers = {"Authorization": f"Key {token}", "Content-Type": "application/json"}
    app_base = f"{FAL_QUEUE_BASE}/{app}"
    # Most apps have a trailing function segment (e.g. seedance .../text-to-video);
    # single-endpoint apps (e.g. fal-ai/wizper) pass fn="" and submit to the app base.
    submit_url = f"{app_base}/{fn}" if fn else app_base

    async with aiohttp.ClientSession() as session:
        # Submit.
        for attempt in range(3):
            async with session.post(submit_url, headers=headers, json=input_dict) as r:
                if r.status in (200, 201):
                    submit = await r.json()
                    break
                if r.status == 429 and attempt < 2:
                    await asyncio.sleep(5.5)
                    continue
                raise RuntimeError(f"fal submit HTTP {r.status}: {await r.text()}")
        else:
            raise RuntimeError("fal submit rate-limited; gave up")

        rid = submit["request_id"]
        # fal returns authoritative status/response URLs in the submit body; prefer
        # them — they carry the correct poll base for sub-endpoint apps (e.g.
        # veo3.1/fast) where a constructed {app}/requests path can be wrong.
        status_url = submit.get("status_url") or f"{app_base}/requests/{rid}/status"
        result_url = submit.get("response_url") or f"{app_base}/requests/{rid}"

        deadline = time.time() + poll_deadline_sec
        consecutive_errors = 0
        polls = 0
        while time.time() < deadline:
            await asyncio.sleep(_poll_delay(polls))
            polls += 1
            async with session.get(status_url, headers=headers) as r:
                # fal's queue status endpoint returns 202 while a job is
                # IN_QUEUE/IN_PROGRESS and 200 once COMPLETED — both carry the
                # authoritative `status` field. Only a genuine error code is a
                # problem: 4xx is unrecoverable (bad rid / revoked key), other
                # non-2xx (5xx) is transient up to a cap.
                if r.status in (200, 202):
                    consecutive_errors = 0
                    status = await r.json()
                else:
                    body = await r.text()
                    if 400 <= r.status < 500:
                        raise RuntimeError(
                            f"fal status poll {rid} got HTTP {r.status} (not retryable): {body}"
                        )
                    consecutive_errors += 1
                    if consecutive_errors >= 10:
                        raise RuntimeError(
                            f"fal status poll {rid} failed {consecutive_errors}× "
                            f"(last HTTP {r.status}): {body}"
                        )
                    continue
            state = status.get("status")
            if state in ("IN_QUEUE", "IN_PROGRESS"):
                continue
            if state == "COMPLETED":
                inf = (status.get("metrics") or {}).get("inference_time")
                async with session.get(result_url, headers=headers) as r:
                    if r.status == 200:
                        return await r.json()
                    body = await r.text()
                    if isinstance(inf, (int, float)) and inf < 1.0:
                        raise RuntimeError(
                            f"fal request {rid} completed in {inf:.2f}s with no result "
                            f"(HTTP {r.status}) — likely a bad app/function path "
                            f"({app}/{fn}): {body}"
                        )
                    raise RuntimeError(f"fal request {rid} failed (HTTP {r.status}): {body}")
            raise RuntimeError(f"fal request {rid} ended: {status}")

    raise RuntimeError(f"fal request timed out after {poll_deadline_sec}s (id={rid})")
