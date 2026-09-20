"""Tests for the fal.ai queue client used by FilmShotNode when a video model's
provider is 'fal'. fal uses a two-segment app namespace (bytedance/seedance-2.0)
plus a function (reference-to-video), auth header 'Key <id:secret>', and returns
{"video": {"url": ...}}. A request that completes in <1s with no fetchable result
is a routing no-op, not a success.
"""
import json as jsonlib

import pytest
from comfy_api_nodes import fal_refs


@pytest.fixture
def chdir_repo_root_missing_env(monkeypatch, tmp_path):
    # Make dotenv lookup resolve to an empty dir so no real FAL_KEY leaks in.
    monkeypatch.setattr(fal_refs, "_dotenv_paths", lambda: [str(tmp_path / ".env")])
    yield


def test_first_fal_video_url_extracts():
    assert fal_refs.first_fal_video_url(
        {"video": {"url": "https://v3b.fal.media/x/video.mp4"}}
    ) == "https://v3b.fal.media/x/video.mp4"


def test_first_fal_video_url_raises_on_missing():
    with pytest.raises(RuntimeError):
        fal_refs.first_fal_video_url({"seed": 1})
    with pytest.raises(RuntimeError):
        fal_refs.first_fal_video_url({"video": {}})


def test_get_fal_token_from_env(monkeypatch):
    monkeypatch.setenv("FAL_KEY", "abc:def")
    fal_refs._TOKEN_CACHE = None
    assert fal_refs.get_fal_token() == "abc:def"


def test_get_fal_token_missing_raises(monkeypatch, tmp_path, chdir_repo_root_missing_env):
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.delenv("NUXT_FAL_TOKEN", raising=False)
    fal_refs._TOKEN_CACHE = None
    with pytest.raises(RuntimeError, match="fal"):
        fal_refs.get_fal_token()


# ---------------------------------------------------------------------------
# run_fal_prediction — mock aiohttp session
# ---------------------------------------------------------------------------

class _FakeResponse:
    """Stand-in for an aiohttp response, usable as an async context manager."""

    def __init__(self, status: int, json_body=None, text_body: str | None = None):
        self.status = status
        self._json_body = json_body
        self._text_body = text_body if text_body is not None else jsonlib.dumps(json_body or {})

    async def json(self):
        return self._json_body

    async def text(self):
        return self._text_body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeSession:
    """Stand-in for aiohttp.ClientSession. `post_responses` and
    `get_responses` are queues of _FakeResponse consumed in call order for
    POST and GET respectively (status poll + result fetch share the GET
    queue, in the order the real client would issue them)."""

    def __init__(self, post_responses, get_responses):
        self._post_responses = list(post_responses)
        self._get_responses = list(get_responses)
        self.get_calls = []

    def post(self, url, headers=None, json=None):
        return self._post_responses.pop(0)

    def get(self, url, headers=None):
        self.get_calls.append(url)
        return self._get_responses.pop(0)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _patch_session(monkeypatch, session):
    class _SessionFactory:
        def __call__(self, *args, **kwargs):
            return session

    monkeypatch.setattr(fal_refs.aiohttp, "ClientSession", _SessionFactory())


def _patch_no_sleep(monkeypatch):
    async def _fast_sleep(_seconds):
        return None

    monkeypatch.setattr(fal_refs.asyncio, "sleep", _fast_sleep)


@pytest.fixture(autouse=True)
def _fal_token(monkeypatch):
    monkeypatch.setenv("FAL_KEY", "abc:def")
    fal_refs._TOKEN_CACHE = None
    yield
    fal_refs._TOKEN_CACHE = None


@pytest.mark.asyncio
async def test_run_fal_prediction_happy_path(monkeypatch):
    _patch_no_sleep(monkeypatch)
    result = {"video": {"url": "https://v3b.fal.media/x/video.mp4"}}
    session = _FakeSession(
        post_responses=[_FakeResponse(200, {"request_id": "rid-1"})],
        get_responses=[
            _FakeResponse(200, {"status": "IN_PROGRESS"}),
            _FakeResponse(200, {"status": "COMPLETED", "metrics": {"inference_time": 12.3}}),
            _FakeResponse(200, result),
        ],
    )
    _patch_session(monkeypatch, session)

    out = await fal_refs.run_fal_prediction(
        "bytedance/seedance-2.0", "text-to-video", {"prompt": "x"}, poll_deadline_sec=60,
    )
    assert out == result


@pytest.mark.asyncio
async def test_run_fal_prediction_slow_completion_non200_result_is_neutral_error(monkeypatch):
    _patch_no_sleep(monkeypatch)
    session = _FakeSession(
        post_responses=[_FakeResponse(200, {"request_id": "rid-2"})],
        get_responses=[
            _FakeResponse(200, {"status": "COMPLETED", "metrics": {"inference_time": 200.0}}),
            _FakeResponse(422, text_body="moderation: rejected content"),
        ],
    )
    _patch_session(monkeypatch, session)

    with pytest.raises(RuntimeError) as exc_info:
        await fal_refs.run_fal_prediction(
            "bytedance/seedance-2.0", "text-to-video", {"prompt": "x"}, poll_deadline_sec=60,
        )
    msg = str(exc_info.value)
    assert "failed (HTTP" in msg
    assert "bad app/function path" not in msg


@pytest.mark.asyncio
async def test_run_fal_prediction_instant_completion_non200_result_blames_app_path(monkeypatch):
    _patch_no_sleep(monkeypatch)
    session = _FakeSession(
        post_responses=[_FakeResponse(200, {"request_id": "rid-3"})],
        get_responses=[
            _FakeResponse(200, {"status": "COMPLETED", "metrics": {"inference_time": 0.06}}),
            _FakeResponse(404, text_body="not found"),
        ],
    )
    _patch_session(monkeypatch, session)

    with pytest.raises(RuntimeError, match="bad app/function path"):
        await fal_refs.run_fal_prediction(
            "bytedance/seedance-2.0", "text-to-video", {"prompt": "x"}, poll_deadline_sec=60,
        )


@pytest.mark.asyncio
async def test_run_fal_prediction_202_in_progress_is_not_an_error(monkeypatch):
    # fal's queue status endpoint returns HTTP 202 (not 200) while a job is
    # IN_QUEUE/IN_PROGRESS — those polls must be treated as normal, not counted
    # toward the consecutive-error cap. Regression for a live-smoke bug where
    # 15 normal 202 polls aborted the run after 10.
    _patch_no_sleep(monkeypatch)
    result = {"video": {"url": "https://v3b.fal.media/x/video.mp4"}}
    session = _FakeSession(
        post_responses=[_FakeResponse(200, {"request_id": "rid-202"})],
        get_responses=[
            _FakeResponse(202, {"status": "IN_QUEUE"}),
            _FakeResponse(202, {"status": "IN_PROGRESS"}),
            _FakeResponse(202, {"status": "IN_PROGRESS"}),
            _FakeResponse(200, {"status": "COMPLETED", "metrics": {"inference_time": 42.0}}),
            _FakeResponse(200, result),
        ],
    )
    _patch_session(monkeypatch, session)

    out = await fal_refs.run_fal_prediction(
        "bytedance/seedance-2.0", "reference-to-video", {"prompt": "x"}, poll_deadline_sec=60,
    )
    assert out == result


@pytest.mark.asyncio
async def test_run_fal_prediction_status_poll_4xx_fails_fast(monkeypatch):
    _patch_no_sleep(monkeypatch)
    session = _FakeSession(
        post_responses=[_FakeResponse(200, {"request_id": "rid-4"})],
        get_responses=[_FakeResponse(401, text_body="unauthorized")],
    )
    _patch_session(monkeypatch, session)

    with pytest.raises(RuntimeError, match="not retryable"):
        await fal_refs.run_fal_prediction(
            "bytedance/seedance-2.0", "text-to-video", {"prompt": "x"}, poll_deadline_sec=1800,
        )
    # Fails on the very first status poll — must not have looped waiting on
    # the 1800s deadline for repeated retries.
    assert len(session.get_calls) == 1


def test_poll_delay_starts_fast_and_settles_at_the_old_two_seconds():
    # A one-second job used to wait a flat 2s for its first status check. The ramp
    # checks early, never polls faster than the first step, and never slower than before.
    delays = [fal_refs._poll_delay(i) for i in range(12)]
    assert delays[0] == pytest.approx(0.35)
    assert delays == sorted(delays)
    assert max(delays) == 2.0
    assert sum(delays[:3]) < 2.0  # three checks inside the old first wait
