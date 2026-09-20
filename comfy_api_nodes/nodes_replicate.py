"""Replicate API nodes — BYOK suite for Sailor.

A parallel set to Comfy's official partner nodes, but pointed at Replicate
instead of Comfy's /proxy/ infrastructure. Goal: one API token
(REPLICATE_API_TOKEN), no Comfy billing dependency, distribution-ready.

Each node targets a single best-in-class model for a specific use-case so
the Generators panel can surface "Generate an image · Flux 1.1 Pro" style
cards without showing redundant alternatives. Add a new entry to the
USE_CASE_LABELS map in frontend/app/components/vue-canvas/GeneratorsPanel.vue
when you ship a new node so the card stays use-case-first.

Image
-  FluxLoRARemoteNode         — Generate an image with your trained LoRA
-  FluxProRemoteNode          — Generate an image · Flux 1.1 Pro (general photoreal)
-  IdeogramV3TurboNode        — Generate an image · Ideogram V3 Turbo (typography)
-  FluxKontextRemoteNode      — Edit an image · Flux Kontext Pro
-  ClarityUpscaleRemoteNode   — Upscale an image · Clarity
-  RemoveBackgroundRemoteNode — Remove background · 851-labs/background-remover
-  RestorePhotoRemoteNode     — Restore an old photo · flux-kontext-apps/restore-image
-  CodeformerRemoteNode       — Fix faces in a photo · CodeFormer
-  DescribeImageRemoteNode    — Describe an image · Moondream 2

Video
-  Seedance2RemoteNode      — Generate a video · Seedance 2.0 (best general quality)
-  Veo3RemoteNode           — Generate a video · Veo 3 (with synced audio)
-  KlingVideoRemoteNode     — Generate a video · Kling 2.1
-  FilmShotNode             — Direct a video · cinematic shot presets over the video-model registry
-  LipsyncRemoteNode        — Sync lips to audio · sync/lipsync-2-pro

Audio
-  WhisperRemoteNode        — Transcribe audio · Whisper large-v3 (fal wizper)
-  MusicGenRemoteNode       — Generate music · MusicGen
-  MiniMaxSpeechRemoteNode  — Generate speech · MiniMax Speech-02 HD

3D
-  Hunyuan3DRemoteNode      — Generate a 3D model · Hunyuan3D 2

All nodes route through one shared `_run_prediction` helper that handles
auth, version lookup, polling and error mapping.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import mimetypes
import os
import re
import time

import aiohttp
import numpy as np
import torch
from PIL import Image
from typing_extensions import override

import folder_paths
from comfy_api.latest import ComfyExtension, IO
from comfy_api_nodes.util.download_helpers import (
    download_url_to_image_tensor,
    download_url_to_video_output,
)
from comfy_extras._live_preview import save_live_preview, save_generation_output, save_image_to_input

# Pure money-path logic (token resolution, LoRA sidecar → runnable ref, output
# URL parsing) lives in replicate_refs so it can be unit-tested in isolation —
# importing this heavy module pulls in `server`, which only resolves under
# main.py. These names are re-exported here unchanged; all call sites below use
# them exactly as before.
from comfy_api_nodes.replicate_refs import (
    _all_output_urls,
    _bare_owner_model,
    _first_output_url,
    _get_token,
    _is_replicate_model_ref,
    _multilora_collect,
    _normalize_lora_ref,
    _read_lora_sidecar,
    _read_token_from_dotenv,
    _replicate_model_to_lora_ref,
    _resolve_lora_url,
    _resolve_lora_weights_url,
    _resolve_trained_model,
    build_enhance_input,
    build_restyle_instruction,
    build_flux_style_prompt,
    classify_style_answer,
    ENHANCE_ENGINES,
    resolve_flux_lora_plan,
    restyle_style_strength_to_knobs,
    RESTYLE_ANTIPHOTO_RETRY,
    sidecar_aesthetic,
)


# The taste wire's link type (moodboards Plan B, Task B4). IO.Custom types
# match by io_type STRING, so this pairs with the Moodboard twin's own
# IO.Custom("TASTE") output (comfy_extras/nodes_moodboard.py) without a
# cross-module import. TASTE is not a widget primitive, so a TASTE input is
# socket-only and occupies NO widgets_values slot (widgetOrder.ts contract).
_TASTE = IO.Custom("TASTE")

# ── prompt_in fold rule (Task B4 — ONE rule, both generators) ────────────────
# `prompt_in` (the Idea node's socket) joins AHEAD of the node's own prompt
# widget: final = prompt_in when the widget is empty, else
# f"{prompt_in} {prompt}". The widget text is never discarded — a wired idea
# leads, hand-typed refinement follows. Applied identically by
# FluxMultiLoRARemoteNode and GenerateImageNode.


def _fold_prompt_in(prompt: str, prompt_in: str) -> str:
    prompt_in = (prompt_in or "").strip()
    if not prompt_in:
        return prompt
    return prompt_in if not (prompt or "").strip() else f"{prompt_in} {prompt}"


REPLICATE_API_BASE = "https://api.replicate.com/v1"
_DEFAULT_POLL_DEADLINE_SEC = 5 * 60      # most image gen finishes well under this
_VIDEO_POLL_DEADLINE_SEC = 30 * 60       # Kling can take several minutes

# How many EXTRA times to re-run a prediction that terminates `failed` with a
# transient *platform* error (see `_is_transient_replicate_error`). 2 → up to 3
# total attempts. Failed predictions aren't billed by Replicate, so re-running
# them is cost-safe; this only trades a little latency (on the failing path) for
# not surfacing Replicate's intermittent Director hiccups 1:1 to the user.
_TRANSIENT_FAIL_RETRIES = 2

# Substrings (matched case-insensitively against Replicate's `error` field) that
# mark a failure as Replicate's own infrastructure choking *after* the prediction
# was accepted — as opposed to a genuine, deterministic failure (invalid input,
# NSFW rejection, model ValueError) that would just fail again on retry. Kept
# deliberately narrow so we never loop on a user-side error.
_TRANSIENT_REPLICATE_ERROR_MARKERS = (
    "unexpected error handling prediction",  # the E9828 message
    "e9828",
    "prediction interrupted",
    "internal error",
    "please try again",
)


def _is_transient_replicate_error(msg: str | None) -> bool:
    """True when a `failed` Replicate prediction looks like a retryable
    platform-side error rather than a deterministic input/model failure."""
    if not msg:
        return False
    m = msg.lower()
    return any(marker in m for marker in _TRANSIENT_REPLICATE_ERROR_MARKERS)


# ---------- Auth / LoRA refs / output parsing -------------------------------
#
# The token resolution, LoRA-sidecar lookup, model-ref detection, lora-ref
# normalization and prediction-output parsing all live in `replicate_refs` (a
# dependency-light, unit-tested module). They're imported at the top of this
# file and used below exactly as if defined here.


async def _autodetect_huggingface(ref: str) -> str:
    """Resolve the bare-path ambiguity in favor of HuggingFace when it fits.

    flux-dev-lora reads a bare '<owner>/<model>' as a *Replicate* model, but
    community Flux LoRAs overwhelmingly live on HuggingFace (Replicate-hosted
    ones arrive as full URLs via the sidecar). So for a bare ref we check the
    HuggingFace API and, if the repo exists, prefix it with 'huggingface.co/'.
    Full URLs and explicit hosts are left untouched — no false rerouting.
    """
    ref = (ref or "").strip()
    if not ref or "/" not in ref:
        return ref
    low = ref.lower()
    if low.startswith((
        "http://", "https://", "huggingface.co/", "civitai.com/", "replicate.com/",
    )):
        return ref
    repo = "/".join(ref.split("/")[:2])  # owner/model (drop any /file.safetensors)
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"https://huggingface.co/api/models/{repo}",
                timeout=aiohttp.ClientTimeout(total=8),
            ) as resp:
                if resp.status == 200:
                    return "huggingface.co/" + ref
    except Exception:
        pass
    return ref


# ---------- Image tensor → data URL ----------------------------------------

def _image_tensor_to_data_url(tensor: torch.Tensor) -> str:
    """Convert a Comfy IMAGE tensor (first frame) to a PNG data URL Replicate
    can accept as an input string."""
    if tensor is None:
        raise ValueError("input image is required")
    # [B, H, W, C] → take first frame, scale, convert to uint8
    if tensor.dim() == 4:
        tensor = tensor[0]
    arr = (tensor.clamp(0, 1) * 255.0).round().to(torch.uint8).cpu().numpy()
    if arr.ndim == 3 and arr.shape[2] in (1, 3, 4):
        img = Image.fromarray(arr)
    else:
        raise ValueError(f"unexpected image tensor shape: {tuple(tensor.shape)}")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"


# ---------- Shared prediction runner ----------------------------------------

async def _run_prediction(
    model: str,
    input_dict: dict,
    *,
    poll_deadline_sec: int = _DEFAULT_POLL_DEADLINE_SEC,
) -> dict:
    """Start a Replicate prediction for `model`, poll until terminal status,
    return the final prediction dict on success.

    Tries two endpoints in sequence:
      1. POST /v1/models/{owner}/{name}/predictions (official models;
         no version lookup needed).
      2. If that returns 404, fall back to looking up `latest_version` and
         POSTing to /v1/predictions with that version id (community models).
    Also retries 429s once with the server-suggested `retry_after`.
    """
    token = _get_token()
    headers = {"Authorization": f"Token {token}", "Content-Type": "application/json"}

    async def _post_create(session, url, body) -> dict:
        for attempt in range(3):
            async with session.post(url, headers=headers, json=body) as r:
                if r.status in (200, 201):
                    return await r.json()
                # 429 → wait then retry.
                if r.status == 429 and attempt < 2:
                    body_text = await r.text()
                    retry_after = 5
                    try:
                        import json as _json
                        retry_after = int((_json.loads(body_text).get("retry_after") or 5))
                    except Exception:
                        pass
                    await asyncio.sleep(retry_after + 0.5)
                    continue
                raise RuntimeError(
                    f"Replicate predictions API HTTP {r.status}: {await r.text()}"
                )
        raise RuntimeError("rate-limited; gave up after retries")

    async with aiohttp.ClientSession() as session:
        # Re-run the whole create→poll cycle on a transient platform failure
        # (E9828 & friends). `canceled`, deterministic model errors, timeouts
        # and create-time errors all bail immediately — see below.
        for attempt in range(_TRANSIENT_FAIL_RETRIES + 1):
            # Try model-aliased endpoint first (works for official models).
            url_aliased = f"{REPLICATE_API_BASE}/models/{model}/predictions"
            try:
                pred = await _post_create(session, url_aliased, {"input": input_dict})
            except RuntimeError as e:
                if "HTTP 404" not in str(e):
                    raise
                # Fall back: look up latest_version, POST to /v1/predictions.
                async with session.get(
                    f"{REPLICATE_API_BASE}/models/{model}", headers=headers,
                ) as r:
                    if r.status != 200:
                        raise RuntimeError(
                            f"Could not look up {model}: HTTP {r.status} — {await r.text()}"
                        ) from e
                    model_info = await r.json()
                version_id = (model_info.get("latest_version") or {}).get("id")
                if not version_id:
                    raise RuntimeError(f"No latest_version for {model}") from e
                pred = await _post_create(
                    session,
                    f"{REPLICATE_API_BASE}/predictions",
                    {"version": version_id, "input": input_dict},
                )
            prediction_id = pred["id"]

            # Poll until done. starting → processing → succeeded/failed/canceled.
            deadline = time.time() + poll_deadline_sec
            while time.time() < deadline:
                await asyncio.sleep(1.5)
                async with session.get(
                    f"{REPLICATE_API_BASE}/predictions/{prediction_id}",
                    headers=headers,
                ) as r:
                    if r.status != 200:
                        continue
                    pred = await r.json()
                status = pred.get("status")
                if status == "succeeded":
                    return pred
                if status in ("failed", "canceled"):
                    err = pred.get("error") or f"prediction {status}"
                    # Retry only Replicate-side transient failures, and only if
                    # attempts remain. `canceled` and genuine model/input errors
                    # fall through and raise immediately.
                    if attempt < _TRANSIENT_FAIL_RETRIES and _is_transient_replicate_error(err):
                        backoff = 2.0 * (attempt + 1)
                        print(
                            f"[Replicate] transient failure (model={model} "
                            f"id={prediction_id}): {err!r} — retrying in {backoff:.0f}s "
                            f"(attempt {attempt + 2}/{_TRANSIENT_FAIL_RETRIES + 1})",
                            flush=True,
                        )
                        await asyncio.sleep(backoff)
                        break  # → next attempt in the retry loop
                    raise RuntimeError(f"Replicate: {err}")
            else:
                # while-loop fell through without break → polling deadline hit.
                raise RuntimeError(
                    f"Replicate prediction timed out after {poll_deadline_sec}s "
                    f"(id={prediction_id})"
                )

    # Exhausted retries on transient failures.
    raise RuntimeError(f"Replicate: {pred.get('error') or 'prediction failed'}")


# Max number of EXTRA Nano Banana attempts when an illustration restyle washes
# out to a photo (so 1 initial + 2 re-rolls = 3 tries max). See RestyleWithLoRANode.
_RESTYLE_MAX_NB_RETRIES = 2

# Subject-ONLY caption prompt for the Moondream describe stage. The old "Describe
# this image in detail." produced long photographic prose (sky, lighting, "looking
# at the camera") that drowned the LoRA trigger in the Flux stage, so restyles came
# back near-photoreal (proven by calibration 2026-06-23). Asking for just the
# subject/clothing/pose/setting keeps the caption short so the style stays dominant.
_RESTYLE_DESCRIBE_PROMPT = (
    "In one short sentence, describe only the main subject, their clothing, pose "
    "and setting. Do not mention photography, the camera, lighting, colours, image "
    "quality, the sky or the weather."
)


async def _classify_image_style(image_url: str) -> str:
    """Ask Moondream whether ``image_url`` is a photo or an illustration.

    Cheap (~$0.001) and used to gate the restyle re-roll loop. Any failure
    degrades to ``"photo"`` so a flaky classifier never blocks a result or
    triggers needless re-rolls.
    """
    try:
        pred = await _run_prediction(
            "lucataco/moondream2",
            {
                "image": image_url,
                # Enumerating the illustration media explicitly is what makes
                # Moondream tag semi-realistic art (e.g. GTA-style) as an
                # illustration rather than a photo — the bare "photo or
                # illustration?" question called GTA a photograph, which disabled
                # the wash-out check. Validated GTA→illustration, real→photograph
                # (3/3 each) 2026-06-23.
                "prompt": (
                    "Classify the medium. If it is a real-life photo answer "
                    "'photograph'. If it is any kind of drawn, painted, cartoon, "
                    "comic, anime, cel-shaded or CGI/3D artwork answer "
                    "'illustration'. One word."
                ),
            },
        )
        out = pred.get("output")
        ans = "".join(str(x) for x in out) if isinstance(out, list) else str(out or "")
    except Exception:
        ans = ""
    return classify_style_answer(ans)


# ---------- Audio (Comfy AUDIO dict ↔ WAV data URL) ------------------------

def _audio_dict_to_wav_data_url(audio, max_seconds: float | None = None) -> str:
    """Encode a Comfy AUDIO `{waveform, sample_rate}` (mono or stereo) to a
    base64 data URL Replicate can ingest.

    Critical: PyAV's `from_ndarray` with format='s16' (packed) expects shape
    [1, channels*samples] interleaved, while format='s16p' (planar) expects
    [channels, samples]. We use s16p so stereo audio doesn't blow up — the
    encoder converts planar→packed when muxing into pcm_s16le.

    `max_seconds` caps the encoded duration. Replicate has a hard ~10 MB
    payload limit on data URLs; a full song easily blows past it. Callers
    that don't need full length (transcription, diarization, voice clone
    demo) can pass e.g. 30 to keep things tractable.
    """
    import av  # type: ignore
    waveform = audio.get("waveform") if isinstance(audio, dict) else audio.waveform  # type: ignore[attr-defined]
    sample_rate = int(audio.get("sample_rate", 44100)) if isinstance(audio, dict) else int(audio.sample_rate)  # type: ignore[attr-defined]
    if waveform.dim() == 3:
        waveform = waveform[0]                # [C, S]
    channels = int(waveform.shape[0])
    if max_seconds is not None and max_seconds > 0:
        max_samples = int(max_seconds * sample_rate)
        if waveform.shape[1] > max_samples:
            waveform = waveform[:, :max_samples]

    wav_buf = io.BytesIO()
    container = av.open(wav_buf, mode="w", format="wav")
    stream = container.add_stream("pcm_s16le", rate=sample_rate)
    stream.layout = "mono" if channels == 1 else "stereo"

    arr = (waveform.clamp(-1, 1) * 32767.0).to(torch.int16).cpu().numpy()
    # Ensure planar layout: [C, S], C-contiguous.
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    arr = np.ascontiguousarray(arr)
    frame = av.AudioFrame.from_ndarray(arr, format="s16p", layout=stream.layout)
    frame.sample_rate = sample_rate
    for packet in stream.encode(frame):
        container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()
    return "data:audio/wav;base64," + base64.b64encode(wav_buf.getvalue()).decode("ascii")


# ---------- Audio download → IO.Audio dict ---------------------------------

async def _download_url_to_audio_dict(url: str) -> dict:
    """Stream-download an audio URL and decode it to Comfy's AUDIO type
    `{waveform: [B, channels, samples] float tensor, sample_rate: int}`.

    Uses PyAV (already a dependency for video) so we don't pull in torchaudio.
    """
    import av  # type: ignore

    async with aiohttp.ClientSession() as session:
        async with session.get(url) as r:
            if r.status != 200:
                raise RuntimeError(f"audio download failed: HTTP {r.status}")
            raw = await r.read()

    container = av.open(io.BytesIO(raw), mode="r")
    try:
        stream = container.streams.audio[0]
    except IndexError as exc:
        container.close()
        raise RuntimeError("downloaded file has no audio stream") from exc

    chunks: list[np.ndarray] = []
    for frame in container.decode(stream):
        arr = frame.to_ndarray()
        # PyAV returns [channels, samples] for planar formats and
        # [1, channels * samples] interleaved otherwise. Normalize to [C, S].
        if arr.ndim == 1:
            arr = arr.reshape(1, -1)
        chunks.append(arr.astype(np.float32))
    sample_rate = int(stream.rate or 44100)
    container.close()

    if not chunks:
        raise RuntimeError("empty audio decode")

    # Concatenate along the samples axis (axis=1).
    full = np.concatenate(chunks, axis=1)
    # Normalize: PyAV may return int16/int32 ranges; scale by max abs value.
    peak = float(np.abs(full).max()) or 1.0
    if peak > 1.5:  # almost certainly integer-range; scale to [-1, 1]
        full = full / peak
    tensor = torch.from_numpy(full).unsqueeze(0)  # [1, C, S]
    return {"waveform": tensor, "sample_rate": sample_rate}


# =============================================================================
# Node: Flux Dev + LoRA inference (companion to the cloud trainer)
# =============================================================================

_FLUX_LORA_ASPECT_RATIOS = [
    "1:1", "16:9", "21:9", "3:2", "2:3", "4:5", "5:4", "3:4", "4:3", "9:16", "9:21",
]


class FluxLoRARemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="FluxLoRARemoteNode",
            display_name="Flux Dev + LoRA",
            category="api node/image/Replicate",
            description=(
                "Run Flux Dev with a LoRA in the cloud. Picks the LoRA "
                "by filename from models/loras/ (the cloud trainer writes a "
                "sidecar JSON with the public URL), or use the `lora_url` "
                "override for LoRAs hosted elsewhere. Requires "
                "REPLICATE_API_TOKEN in the environment."
            ),
            inputs=[
                IO.String.Input(
                    "prompt",
                    multiline=True,
                    default="",
                    tooltip="Text prompt. Include your LoRA's trigger word for character/style LoRAs.",
                ),
                IO.Combo.Input(
                    "lora_name",
                    options=folder_paths.get_filename_list("loras") + ["[None]"],
                    default="[None]",
                    tooltip=(
                        "Pick a locally-trained LoRA. Only works if it has a sidecar "
                        ".json with replicate_url (created automatically by the cloud trainer)."
                    ),
                    # Render a gallery launcher (WidgetLoraPicker) instead of a
                    # plain dropdown; the combo still serializes a filename string.
                    extra_dict={"sailor_widget": "lora_picker"},
                ),
                IO.String.Input(
                    "lora_url",
                    default="",
                    multiline=False,
                    tooltip=(
                        "Override LoRA source. Use a FULL form: "
                        "HuggingFace → 'huggingface.co/owner/model' (optionally "
                        "'/file.safetensors'); CivitAI → 'civitai.com/models/<id>'; "
                        "Replicate → 'owner/model'; or a direct .safetensors URL. "
                        "Note: a bare 'owner/model' is read as a Replicate model — "
                        "for HuggingFace LoRAs keep the 'huggingface.co/' prefix. "
                        "Wins over lora_name when set."
                    ),
                    advanced=True,
                ),
                IO.Float.Input(
                    "lora_scale",
                    default=1.0, min=0.0, max=1.5, step=0.05,
                    tooltip="LoRA strength. 1.0 is the trained level.",
                ),
                IO.Combo.Input(
                    "aspect_ratio",
                    options=_FLUX_LORA_ASPECT_RATIOS,
                    default="1:1",
                ),
                IO.Combo.Input(
                    "megapixels",
                    options=["1", "0.25"],
                    default="1",
                    tooltip="Output size. 1 ≈ 1024px on the long edge; 0.25 ≈ 512px.",
                    advanced=True,
                ),
                IO.Int.Input(
                    "num_inference_steps",
                    default=28, min=4, max=50,
                    tooltip="More steps = better detail, slower. 28 is the Flux Dev sweet spot.",
                    advanced=True,
                ),
                IO.Float.Input(
                    "guidance",
                    default=3.5, min=0.0, max=20.0, step=0.1,
                    tooltip="Flux Dev's prompt adherence. 3.5 is the canonical default.",
                    advanced=True,
                ),
                IO.Int.Input(
                    "seed",
                    default=0, min=0, max=0xFFFFFFFF,
                    tooltip="0 = random each run. Set a specific value for reproducible A/B tests.",
                ),
                IO.Image.Input(
                    "image",
                    optional=True,
                    tooltip=(
                        "Optional: apply the LoRA to THIS image (image-to-image) "
                        "instead of generating from scratch. Wire an image here to "
                        "restyle it with your LoRA. The input's aspect ratio is kept."
                    ),
                ),
                IO.Float.Input(
                    "prompt_strength",
                    default=0.8, min=0.0, max=1.0, step=0.05,
                    tooltip=(
                        "Image-to-image only: how far to push the input image. "
                        "0.2 = subtle restyle (keeps structure), 0.9 = strong "
                        "reinterpretation. Ignored when no image is wired."
                    ),
                    advanced=True,
                ),
            ],
            outputs=[
                IO.Image.Output(),
            ],
            price_badge=IO.PriceBadge(
                expr='{"type":"usd","usd":0.04,"format":{"approximate":true}}',
            ),
        )

    @classmethod
    async def execute(
        cls,
        prompt: str, lora_name: str, lora_url: str, lora_scale: float,
        aspect_ratio: str, megapixels: str,
        num_inference_steps: int, guidance: float,
        seed: int,
        image=None, prompt_strength: float = 0.8,
    ):
        lora_url = (lora_url or "").strip()
        # NOTE: the taste profile lives in the prompt itself (prepended by the
        # frontend when a LoRA is added). We deliberately do NOT add it as a
        # separate node input — that changes the ComfyUI schema, which the
        # embedded canvas caches and gets out of sync with (scrambling widget
        # positions). Keeping it in the prompt is schema-stable and robust.
        full_prompt = prompt

        # Two execution paths:
        #  (A) Our own trained LoRA → run that model DIRECTLY. It's a Flux fork
        #      with the LoRA baked in, runs private under our token, and needs no
        #      `lora_weights`. Triggered when lora_url is a trained-model ref
        #      (the cloud trainer fills it in this way), or — with no lora_url —
        #      when the selected lora_name has a trained-model sidecar.
        #  (B) External LoRA (a real URL / HF / CivitAI / .safetensors in
        #      lora_url, or a legacy sidecar) → run flux-dev-lora with `lora_weights`.
        plan = resolve_flux_lora_plan(lora_name, lora_url)
        trained_model = plan["trained_model"]

        input_dict: dict = {
            "prompt": full_prompt,
            "aspect_ratio": aspect_ratio,
            "megapixels": megapixels,
            "num_inference_steps": num_inference_steps,
            "num_outputs": 1,
            "output_format": "png",
            "disable_safety_checker": False,
        }
        if seed and seed > 0:
            input_dict["seed"] = seed

        # img2img: when an image is wired, restyle it instead of generating from
        # scratch. The model keeps the input's aspect ratio, so `aspect_ratio` is
        # ignored in this mode.
        img2img = image is not None
        if img2img:
            input_dict["image"] = _image_tensor_to_data_url(image)
            input_dict["prompt_strength"] = prompt_strength

        if trained_model:
            # The baked-in trainer model (ostris flux fork) names it `guidance_scale`.
            model = trained_model
            resolved_lora = trained_model
            input_dict["guidance_scale"] = guidance
            input_dict["lora_scale"] = lora_scale
        else:
            # flux-dev-lora names it `guidance`.
            input_dict["guidance"] = guidance
            resolved_lora = plan["lora_ref"]
            # A bare 'owner/model' is ambiguous — prefer HuggingFace if it exists.
            if resolved_lora:
                resolved_lora = await _autodetect_huggingface(resolved_lora)
                input_dict["lora_weights"] = resolved_lora
                input_dict["lora_scale"] = lora_scale
            model = "black-forest-labs/flux-dev-lora"

        pred = await _run_prediction(model, input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)

        # Drop any alpha channel — Replicate's img2img sometimes returns a
        # 4-channel PNG, and a spurious alpha routes the downstream Image node to
        # its transparent-preview path, which doesn't render in the canvas. A
        # generation is never actually transparent, so force RGB. [B,H,W,C].
        if tensor.dim() == 4 and tensor.shape[-1] == 4:
            tensor = tensor[..., :3].contiguous()

        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "flux_lora"))


# =============================================================================
# Node: Flux Dev + up to 4 LoRAs (stack a character LoRA + a style LoRA + accents)
# =============================================================================

# Module-level rotation counter for the multi-LoRA cache-bug workaround. Lives
# here (not as a class attribute) because ComfyUI locks the node class against
# attribute mutation at runtime. A mutable dict so we never rebind the global.
_MULTILORA_ROTATE = {"n": 0}


class FluxMultiLoRARemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        lora_options = folder_paths.get_filename_list("loras") + ["[None]"]
        return IO.Schema(
            node_id="FluxMultiLoRARemoteNode",
            display_name="Flux Dev + LoRAs",
            category="api node/image/Replicate",
            description=(
                "Stack up to FOUR LoRAs on Flux Dev in a single generation "
                "— e.g. a character "
                "LoRA + a style LoRA + accents, each with its own scale. Pick "
                "locally-trained LoRAs (uses the weights artifact from their "
                "sidecar) or override a slot with a HuggingFace / CivitAI / "
                ".safetensors reference. Empty slots are skipped. Requires "
                "REPLICATE_API_TOKEN."
            ),
            inputs=[
                IO.String.Input(
                    "prompt",
                    multiline=True,
                    default="",
                    tooltip="Text prompt. Include the trigger word of every LoRA you stack.",
                ),
                # ── Slot A (e.g. the character) ──
                IO.Combo.Input(
                    "lora_a",
                    options=lora_options,
                    default="[None]",
                    tooltip="First LoRA — the character. Opens your Characters gallery.",
                    extra_dict={"sailor_widget": "lora_picker", "lora_kind": "character"},
                ),
                IO.String.Input(
                    "lora_a_url",
                    default="",
                    multiline=False,
                    tooltip=(
                        "Override for slot A: HuggingFace 'huggingface.co/owner/model', "
                        "a CivitAI download URL, or a direct .safetensors URL. Wins over "
                        "lora_a. Note: a private Replicate model ref won't load here — "
                        "this model stacks weights, not models."
                    ),
                    advanced=True,
                ),
                IO.Float.Input(
                    "scale_a",
                    default=0.9, min=0.0, max=1.5, step=0.05,
                    tooltip="Strength of LoRA A. ~0.9 keeps a character identity strong.",
                ),
                # ── Slot B (e.g. the style) ──
                IO.Combo.Input(
                    "lora_b",
                    options=lora_options,
                    default="[None]",
                    tooltip="Second LoRA — e.g. the style.",
                    extra_dict={"sailor_widget": "lora_picker"},
                ),
                IO.String.Input(
                    "lora_b_url",
                    default="",
                    multiline=False,
                    tooltip="Override for slot B (same forms as slot A). Wins over lora_b.",
                    advanced=True,
                ),
                IO.Float.Input(
                    "scale_b",
                    default=0.8, min=0.0, max=1.5, step=0.05,
                    tooltip="Strength of LoRA B. ~0.8 applies a style without overpowering the character.",
                ),
                IO.Combo.Input(
                    "aspect_ratio",
                    options=_FLUX_LORA_ASPECT_RATIOS,
                    default="1:1",
                ),
                IO.Int.Input(
                    "num_inference_steps",
                    default=28, min=4, max=50,
                    tooltip="More steps = better detail, slower. 28 is the Flux Dev sweet spot.",
                    advanced=True,
                ),
                IO.Float.Input(
                    "guidance",
                    default=3.5, min=0.0, max=10.0, step=0.1,
                    tooltip="Prompt adherence. 3.5 is the canonical default; 2–5 brings out style.",
                    advanced=True,
                ),
                IO.Int.Input(
                    "seed",
                    default=0, min=0, max=0xFFFFFFFF,
                    tooltip="0 = random each run. Set a value for reproducible A/B tests.",
                ),
                IO.Image.Input(
                    "image",
                    optional=True,
                    tooltip=(
                        "Optional: apply the stacked LoRAs to THIS image (image-to-image) "
                        "instead of generating from scratch. The input's aspect ratio is kept."
                    ),
                ),
                IO.Float.Input(
                    "prompt_strength",
                    default=0.8, min=0.0, max=1.0, step=0.05,
                    tooltip=(
                        "Image-to-image only: 0.2 = subtle restyle (keeps structure), "
                        "0.9 = strong reinterpretation. Ignored when no image is wired."
                    ),
                    advanced=True,
                ),
                # ── Slots C/D MUST stay last ─────────────────────────────────
                # widgets_values is positional, and realignWidgetValues (the
                # frontend's saved-workflow migrator) pads a saved array by
                # LENGTH, not by name. Any new input inserted before an
                # existing one shifts every saved value after it onto the
                # wrong widget — that's what happened when these six were
                # first declared between scale_b and aspect_ratio. Future
                # slots must also be appended here, never inserted earlier.
                # ── Slot C (an accent — style, texture, lighting) ──
                IO.Combo.Input(
                    "lora_c",
                    options=lora_options,
                    default="[None]",
                    tooltip="Third LoRA — an accent on top of the character + style.",
                    extra_dict={"sailor_widget": "lora_picker"},
                ),
                IO.String.Input(
                    "lora_c_url",
                    default="",
                    multiline=False,
                    tooltip="Override for slot C (same forms as slot A). Wins over lora_c.",
                    advanced=True,
                ),
                IO.Float.Input(
                    "scale_c",
                    default=0.7, min=0.0, max=1.5, step=0.05,
                    tooltip="Strength of LoRA C. Lower than B — accents should not compete.",
                ),
                # ── Slot D (a second accent) ──
                IO.Combo.Input(
                    "lora_d",
                    options=lora_options,
                    default="[None]",
                    tooltip="Fourth LoRA — a second accent. Stacking this many adapters softens all of them.",
                    extra_dict={"sailor_widget": "lora_picker"},
                ),
                IO.String.Input(
                    "lora_d_url",
                    default="",
                    multiline=False,
                    tooltip="Override for slot D (same forms as slot A). Wins over lora_d.",
                    advanced=True,
                ),
                IO.Float.Input(
                    "scale_d",
                    default=0.6, min=0.0, max=1.5, step=0.05,
                    tooltip="Strength of LoRA D. The lightest slot by default.",
                ),
                # ── Taste wire + Idea socket (moodboards Plan B, Task B4) ────
                # APPENDED LAST per the contract above. Both are socket-only
                # (TASTE is not a widget primitive; prompt_in is force_input),
                # so NEITHER occupies a widgets_values slot — saved workflows
                # stay aligned (schema-order test asserts the widget count).
                _TASTE.Input(
                    "style_in",
                    optional=True,
                    tooltip=(
                        "Taste wire: a Moodboard node's compiled style block. "
                        "Prepends ahead of everything in the prompt."
                    ),
                ),
                IO.String.Input(
                    "prompt_in",
                    optional=True,
                    force_input=True,
                    tooltip=(
                        "Upstream prompt (the Idea node's socket). Joins ahead "
                        "of the prompt widget; the widget text is kept."
                    ),
                ),
            ],
            outputs=[
                IO.Image.Output(),
            ],
            price_badge=IO.PriceBadge(
                expr='{"type":"usd","usd":0.04,"format":{"approximate":true}}',
            ),
        )

    @classmethod
    async def execute(
        cls,
        prompt: str,
        lora_a: str, lora_a_url: str, scale_a: float,
        lora_b: str, lora_b_url: str, scale_b: float,
        aspect_ratio: str, num_inference_steps: int, guidance: float,
        seed: int,
        image=None, prompt_strength: float = 0.8,
        lora_c: str = "[None]", lora_c_url: str = "", scale_c: float = 0.7,
        lora_d: str = "[None]", lora_d_url: str = "", scale_d: float = 0.6,
        style_in: str = "", prompt_in: str = "",
    ):
        # Task B4 prompt composition — wire first: the folded prompt_in joins
        # ahead of the widget prompt (see _fold_prompt_in, the ONE shared
        # rule), then style_in prepends ahead of EVERYTHING (including the
        # client-injected LoRA style blocks already folded into the prompt
        # widget by styleInject.ts).
        prompt = _fold_prompt_in(prompt, prompt_in)
        style_in = (style_in or "").strip()
        if style_in:
            prompt = f"{style_in} {prompt}".strip()

        # Resolve each slot to a WEIGHTS reference flux-dev-multi-lora can load.
        # A picker selection → the trained LoRA's weights artifact (.tar) from its
        # sidecar (NOT the private model ref — this model stacks weights, not
        # models). A URL override → HF / CivitAI / .safetensors passed through
        # (bare owner/model is HF-autodetected, matching the single-LoRA node).
        async def _resolve_slot(lora_name: str, lora_url: str) -> str | None:
            lora_url = (lora_url or "").strip()
            if lora_url:
                return await _autodetect_huggingface(_normalize_lora_ref(lora_url))
            return _resolve_lora_weights_url(lora_name)

        resolved_slots = []
        for name, url, scale in (
            (lora_a, lora_a_url, scale_a),
            (lora_b, lora_b_url, scale_b),
            (lora_c, lora_c_url, scale_c),
            (lora_d, lora_d_url, scale_d),
        ):
            resolved_slots.append((await _resolve_slot(name, url), scale))

        loras, scales = _multilora_collect(resolved_slots)

        if not loras:
            raise RuntimeError(
                "No LoRAs resolved. Pick a locally-trained LoRA (needs a sidecar "
                ".json with replicate_url), or set a HuggingFace / CivitAI / "
                ".safetensors URL in at least one slot."
            )

        # ── Work around flux-dev-multi-lora's warm-container cache bug ──────
        # The model only (re)loads LoRAs when the request differs from the last
        # one a given container saw; its no-LoRA branch unloads adapters WITHOUT
        # resetting that memory. So on the shared public model, a stranger's
        # no-LoRA request can leave OUR next identical request running with no
        # LoRAs at all (vanilla Flux). We defend two ways:
        #  (1) alternate LoRA order every call (order doesn't change the result),
        #      so consecutive calls never look "the same" → forces a reload;
        #  (2) verify from the logs that a load actually happened and, if not,
        #      retry once with the order flipped (guaranteed to differ → reload).
        if len(loras) >= 2:
            _MULTILORA_ROTATE["n"] ^= 1
            if _MULTILORA_ROTATE["n"]:
                loras = list(reversed(loras))
                scales = list(reversed(scales))

        input_dict: dict = {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "num_inference_steps": num_inference_steps,
            "guidance_scale": guidance,   # multi-lora names it `guidance_scale`
            "hf_loras": loras,
            "lora_scales": scales,
            "num_outputs": 1,
            "output_format": "png",
            "disable_safety_checker": False,
        }
        if seed and seed > 0:
            input_dict["seed"] = seed

        # img2img: when an image is wired, restyle it instead of generating from
        # scratch. The model keeps the input's aspect ratio, so `aspect_ratio`
        # is ignored in this mode.
        img2img = image is not None
        if img2img:
            input_dict["image"] = _image_tensor_to_data_url(image)
            input_dict["prompt_strength"] = prompt_strength

        # The model prints "Downloading LoRA weights" once per LoRA it loads;
        # its absence (with LoRAs requested) means the container skipped loading.
        def _loaded(p: dict) -> bool:
            return "Downloading LoRA weights" in (p.get("logs") or "")

        pred = await _run_prediction("lucataco/flux-dev-multi-lora", input_dict)
        if loras and len(loras) >= 2 and not _loaded(pred):
            # Skipped on a warm container. Flip the order — now guaranteed to
            # differ from whatever it cached — and retry once to force a reload.
            loras = list(reversed(loras))
            scales = list(reversed(scales))
            input_dict["hf_loras"] = loras
            input_dict["lora_scales"] = scales
            pred = await _run_prediction("lucataco/flux-dev-multi-lora", input_dict)

        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)

        # Drop any alpha channel — a spurious alpha routes the downstream Image
        # node to its transparent-preview path, which doesn't render. [B,H,W,C].
        if tensor.dim() == 4 and tensor.shape[-1] == 4:
            tensor = tensor[..., :3].contiguous()

        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "flux_multilora"))


# =============================================================================
# Node: Flux 1.1 Pro
# =============================================================================

_FLUX_PRO_ASPECT_RATIOS = [
    "1:1", "16:9", "21:9", "3:2", "2:3", "4:5", "5:4", "3:4", "4:3", "9:16", "9:21", "custom",
]


class FluxProRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="FluxProRemoteNode",
            display_name="Flux 1.1 Pro",
            category="api node/image/Replicate",
            description=(
                "Flux 1.1 Pro. Top-tier image quality, ~$0.04 per image, "
                "~5–10 s."
            ),
            inputs=[
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="What to generate."),
                IO.Combo.Input(
                    "aspect_ratio",
                    options=_FLUX_PRO_ASPECT_RATIOS,
                    default="1:1",
                    tooltip="Pick 'custom' to use the width/height fields.",
                ),
                IO.Int.Input("width",  default=1024, min=256, max=1440, step=32,
                             tooltip="Only used when aspect_ratio == 'custom'.",
                             advanced=True),
                IO.Int.Input("height", default=1024, min=256, max=1440, step=32,
                             tooltip="Only used when aspect_ratio == 'custom'.",
                             advanced=True),
                IO.Int.Input("safety_tolerance", default=2, min=1, max=6,
                             tooltip="1 = strict, 6 = permissive.",
                             advanced=True),
                IO.Boolean.Input("prompt_upsampling", default=False,
                                 tooltip="Let the model rewrite your prompt for better results.",
                                 advanced=True),
                IO.Combo.Input("output_format", options=["png", "jpg"], default="png", advanced=True),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             tooltip="0 = random."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.04}'),
        )

    @classmethod
    async def execute(cls, prompt, aspect_ratio, width, height,
                      safety_tolerance, prompt_upsampling, output_format, seed):
        input_dict: dict = {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "safety_tolerance": safety_tolerance,
            "prompt_upsampling": prompt_upsampling,
            "output_format": output_format,
            "output_quality": 95,
        }
        if aspect_ratio == "custom":
            input_dict["width"] = width
            input_dict["height"] = height
        if seed and seed > 0:
            input_dict["seed"] = seed
        pred = await _run_prediction("black-forest-labs/flux-1.1-pro", input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "flux_pro"))


# =============================================================================
# Node: Flux Kontext Pro (image edit)
# =============================================================================

_FLUX_KONTEXT_ASPECT_RATIOS = [
    "match_input_image", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
]


async def _run_fal_kontext(
    image_data_url: str, prompt: str, *,
    aspect_ratio: str = "match_input_image",
    safety_tolerance: int = 2,
    enhance_prompt: bool = False,
    output_format: str = "png",
    seed: int = 0,
) -> str:
    """Run fal-ai/flux-pro/kontext (image edit) and return the output image URL.

    fal is ~2× cheaper than Replicate's black-forest-labs/flux-kontext-pro
    ($0.04 vs $0.08). fal's dialect differs from Replicate's: the source is
    `image_url` (not `input_image`); there is no `match_input_image` enum — the
    ratio is matched by OMITTING `aspect_ratio`; `output_format` is `jpeg` not
    `jpg`; `prompt_upsampling` maps to `enhance_prompt`; the output is
    `images[0].url`. `safety_tolerance` is sent only when non-default, as the
    string enum fal expects.
    """
    from comfy_api_nodes import fal_refs

    inp: dict = {
        "prompt": prompt,
        "image_url": image_data_url,
        "output_format": "jpeg" if output_format in ("jpg", "jpeg") else "png",
    }
    if aspect_ratio and aspect_ratio != "match_input_image":
        inp["aspect_ratio"] = aspect_ratio
    if safety_tolerance and safety_tolerance != 2:
        inp["safety_tolerance"] = str(safety_tolerance)
    if enhance_prompt:
        inp["enhance_prompt"] = True
    if seed and seed > 0:
        inp["seed"] = seed
    result = await fal_refs.run_fal_prediction("fal-ai/flux-pro/kontext", "", inp)
    return fal_refs.first_fal_image_url(result)


async def _run_fal_flux2_edit(
    image_data_urls: list[str], prompt: str, *,
    output_format: str = "png",
    seed: int = 0,
) -> str:
    """Run fal-ai/flux-2-pro/edit (image edit, up to 9 reference images) and
    return the output image URL.

    Unlike flux-pro/kontext, the source is an `image_urls` ARRAY (not a single
    `image_url`); `image_size` defaults to "auto" — which matches the input — so
    it is omitted here. Output is `images[0].url`, same as kontext.
    """
    from comfy_api_nodes import fal_refs

    inp: dict = {
        "prompt": prompt,
        "image_urls": list(image_data_urls),
        "output_format": "jpeg" if output_format in ("jpg", "jpeg") else "png",
    }
    if seed and seed > 0:
        inp["seed"] = seed
    result = await fal_refs.run_fal_prediction("fal-ai/flux-2-pro/edit", "", inp)
    return fal_refs.first_fal_image_url(result)


async def _run_fal_nano_banana_edit(
    image_urls: list[str], prompt: str, *,
    model: str = "fal-ai/nano-banana-2/edit",
    resolution: str = "1K",
    output_format: str = "png",
    seed: int = 0,
) -> str:
    """Run Google Nano Banana image-edit on fal and return the output image URL.

    fal reaches Google through its OWN Vertex project, so it routes around the
    project-scoped `gemini-3.1-flash-image-preview` 404 that currently breaks
    Replicate's google/nano-banana-2 (whose error names Replicate's
    `replicate-prod-imagen-access` GCP project). Same model, live account.

    fal's dialect: the sources go in an `image_urls` ARRAY (public http OR data
    URLs both work); `output_format` is `jpeg`/`png`/`webp` (map our `jpg`);
    output is `images[0].url`.
    """
    from comfy_api_nodes import fal_refs

    inp: dict = {
        "prompt": prompt,
        "image_urls": list(image_urls),
        "output_format": "jpeg" if output_format in ("jpg", "jpeg") else output_format,
        "resolution": resolution,
        "num_images": 1,
    }
    if seed and seed > 0:
        inp["seed"] = int(seed) & 0xFFFFFFFF
    result = await fal_refs.run_fal_prediction(model, "", inp)
    return fal_refs.first_fal_image_url(result)


# Replicate Nano Banana slug → its fal image-edit endpoint. fal reaches Google
# through its OWN project, so these route around Replicate's project-scoped
# gemini-3.1-flash-image-preview 404. The original google/nano-banana (Gemini 2.5)
# is deliberately absent: it isn't affected and has a resolution-422 quirk, so it
# stays on Replicate.
_NANO_BANANA_FAL_EDIT = {
    "google/nano-banana-2": "fal-ai/nano-banana-2/edit",
    "google/nano-banana-pro": "fal-ai/nano-banana-pro/edit",
}


async def _run_nano_banana_edit(
    image_urls: list[str], prompt: str, *,
    replicate_slug: str = "google/nano-banana-2",
    resolution: str = "1K",
    output_format: str = "png",
    seed: int = 0,
) -> str:
    """Nano Banana image-edit, fal-first per model with failover: the fal endpoint
    matching `replicate_slug` first (fal's Google access dodges Replicate's
    project-scoped preview-model 404), then fal Nano Banana Pro (a different, live
    Gemini model), then Replicate as a last resort so a fal outage still degrades
    to the original path. Shared by every Nano-Banana image-edit node."""
    fal_primary = _NANO_BANANA_FAL_EDIT.get(replicate_slug, "fal-ai/nano-banana-2/edit")
    fal_chain = [(fal_primary, f"fal {replicate_slug}")]
    _pro = "fal-ai/nano-banana-pro/edit"
    if fal_primary != _pro:
        fal_chain.append((_pro, "fal nano-banana-pro"))
    # Only try fal when a token is configured; otherwise go straight to Replicate.
    fal_ok = False
    try:
        from comfy_api_nodes import fal_refs
        fal_refs.get_fal_token()
        fal_ok = True
    except Exception:
        fal_ok = False
    last_fal_err = "fal not configured" if not fal_ok else None
    if fal_ok:
        for app, label in fal_chain:
            try:
                url = await _run_fal_nano_banana_edit(
                    image_urls, prompt, model=app,
                    resolution=resolution, output_format=output_format, seed=seed,
                )
                if url:
                    return url
            except Exception as err:
                last_fal_err = f"{label}: {err}"
                print(f"[nano-banana-edit] {label} failed, trying next: {err}")

    # Last resort: the requested model on Replicate (currently the broken path for
    # nano-banana-2, but kept so a fal outage still has a route and it recovers on
    # its own). Fold the last fal error into any failure here so a dual-outage
    # doesn't look like a Replicate-only problem.
    nb_input: dict = {
        "prompt": prompt,
        "image_input": list(image_urls),
        "output_format": output_format,
        "resolution": resolution,
    }
    if seed and seed > 0:
        nb_input["seed"] = int(seed) & 0xFFFFFFFF
    try:
        pred = await _run_prediction(replicate_slug, nb_input)
        url = _first_output_url(pred)
    except Exception as rep_err:
        raise RuntimeError(f"nano-banana edit failed on fal ({last_fal_err}) and Replicate ({rep_err})") from rep_err
    if not url:
        raise RuntimeError(f"nano-banana edit returned no image (fal: {last_fal_err}; Replicate returned empty)")
    return url


async def _run_image_edit_prediction(replicate_slug: str, input_dict: dict) -> str:
    """Run one image-edit prediction with provider failover, returning the output
    image URL. When `replicate_slug` has a fal twin (see _NANO_BANANA_FAL_EDIT),
    route fal-first via _run_nano_banana_edit — dodging Replicate's project-scoped
    Gemini 404 — with Replicate as the fallback; every other slug runs straight on
    Replicate. This is the single seam the input-dict-driven edit nodes go through,
    so registering a new model→fal mapping wires failover everywhere at once.

    The input_dict is the Replicate-shaped dict a model's build_input produced;
    for fal we read `image_input` / `resolution` / `output_format` / `seed` back
    out of it (the keys every Nano Banana builder emits)."""
    if replicate_slug in _NANO_BANANA_FAL_EDIT:
        return await _run_nano_banana_edit(
            list(input_dict.get("image_input") or []),
            input_dict.get("prompt", ""),
            replicate_slug=replicate_slug,
            resolution=input_dict.get("resolution", "1K"),
            output_format=input_dict.get("output_format", "png"),
            seed=int(input_dict.get("seed") or 0),
        )
    pred = await _run_prediction(replicate_slug, input_dict)
    return _first_output_url(pred)


class FluxKontextRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="FluxKontextRemoteNode",
            display_name="Flux Kontext Pro · Edit (fal)",
            category="api node/image/Replicate",
            description=(
                "Flux Kontext Pro image editing — give it an image and a "
                "natural-language instruction ('make her hair blue', 'remove "
                "the background', 'add a cat on the couch'). ~$0.04 per edit."
            ),
            inputs=[
                IO.Image.Input("input_image", tooltip="Source image to edit."),
                IO.String.Input(
                    "prompt", multiline=True, default="",
                    tooltip="Edit instruction in natural language.",
                ),
                IO.Combo.Input(
                    "aspect_ratio",
                    options=_FLUX_KONTEXT_ASPECT_RATIOS,
                    default="match_input_image",
                    tooltip="match_input_image keeps the source's ratio.",
                ),
                IO.Int.Input("safety_tolerance", default=2, min=1, max=6, advanced=True),
                IO.Boolean.Input("prompt_upsampling", default=False, advanced=True),
                IO.Combo.Input("output_format", options=["png", "jpg"], default="png", advanced=True),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             tooltip="0 = random."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.04}'),
        )

    @classmethod
    async def execute(cls, input_image, prompt, aspect_ratio,
                      safety_tolerance, prompt_upsampling, output_format, seed):
        url = await _run_fal_kontext(
            _image_tensor_to_data_url(input_image), prompt,
            aspect_ratio=aspect_ratio, safety_tolerance=safety_tolerance,
            enhance_prompt=prompt_upsampling, output_format=output_format, seed=seed,
        )
        tensor = await download_url_to_image_tensor(url, cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "flux_kontext"))


# =============================================================================
# Node: Kling 2.1 video
# =============================================================================

class KlingVideoRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="KlingVideoRemoteNode",
            display_name="Kling 2.1 Video",
            category="api node/video/Replicate",
            description=(
                "Kling 2.1 text-to-video or image-to-video. ~$0.35 for 5s, "
                "~$0.70 for 10s. Generation takes a few minutes."
            ),
            inputs=[
                IO.String.Input(
                    "prompt", multiline=True, default="",
                    tooltip="What should happen in the video.",
                ),
                IO.Image.Input(
                    "start_image", optional=True,
                    tooltip="Optional first frame — turns this into image-to-video.",
                ),
                IO.Combo.Input(
                    "aspect_ratio",
                    options=["16:9", "9:16", "1:1"],
                    default="16:9",
                    tooltip="Ignored when start_image is provided.",
                ),
                IO.Combo.Input(
                    "duration",
                    options=["5", "10"],
                    default="5",
                    tooltip="Seconds. Longer = roughly 2× the cost.",
                ),
                IO.String.Input(
                    "negative_prompt", default="",
                    tooltip="What to avoid (blur, glitches, distortion, etc.).",
                    advanced=True,
                ),
                IO.Float.Input(
                    "cfg_scale", default=0.5, min=0.0, max=1.0, step=0.05,
                    tooltip="Prompt adherence vs. naturalness.",
                    advanced=True,
                ),
            ],
            outputs=[IO.Video.Output()],
            price_badge=IO.PriceBadge(
                expr='{"type":"usd","usd":0.35,"format":{"approximate":true}}',
            ),
        )

    @classmethod
    async def execute(cls, prompt, start_image, aspect_ratio, duration,
                      negative_prompt, cfg_scale):
        input_dict: dict = {
            "prompt": prompt,
            "duration": int(duration),
            "cfg_scale": cfg_scale,
        }
        if negative_prompt:
            input_dict["negative_prompt"] = negative_prompt
        if start_image is not None:
            input_dict["start_image"] = _image_tensor_to_data_url(start_image)
        else:
            input_dict["aspect_ratio"] = aspect_ratio
        pred = await _run_prediction(
            "kwaivgi/kling-v2.1",
            input_dict,
            poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC,
        )
        video = await download_url_to_video_output(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(video)


# =============================================================================
# Node: Clarity upscaler
# =============================================================================

class ClarityUpscaleRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="ClarityUpscaleRemoteNode",
            display_name="Clarity Upscale",
            category="api node/image/Replicate",
            description=(
                "philz1337x/clarity-upscaler — high-quality detail-enhancing "
                "upscale. Adds plausible detail; not pixel-perfect. ~$0.05–0.20 "
                "per image depending on input size and scale factor."
            ),
            inputs=[
                IO.Image.Input("image", tooltip="Image to upscale."),
                IO.String.Input(
                    "prompt", multiline=True,
                    default="masterpiece, best quality, highres",
                    tooltip="Style prompt — the upscaler uses this to invent detail.",
                ),
                IO.Float.Input(
                    "scale_factor",
                    default=2.0, min=1.0, max=10.0, step=0.5,
                    tooltip="Output is scale_factor × input dimensions.",
                ),
                IO.Float.Input(
                    "creativity",
                    default=0.35, min=0.0, max=1.0, step=0.05,
                    tooltip="0 = preserve original, 1 = reinvent. 0.3–0.4 is the sweet spot.",
                ),
                IO.Float.Input(
                    "resemblance",
                    default=0.6, min=0.0, max=3.0, step=0.05,
                    tooltip="How tightly to stick to the source. Higher = closer to input.",
                ),
                IO.String.Input(
                    "negative_prompt", default="(worst quality, low quality, normal quality:2)",
                    tooltip="What to avoid in the upscaled image.",
                    advanced=True,
                ),
                IO.Int.Input(
                    "num_inference_steps", default=18, min=10, max=50,
                    advanced=True,
                ),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             tooltip="0 = random."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(
                expr='{"type":"usd","usd":0.20,"format":{"approximate":true}}',
            ),
        )

    @classmethod
    async def execute(cls, image, prompt, scale_factor, creativity, resemblance,
                      negative_prompt, num_inference_steps, seed):
        input_dict: dict = {
            "image": _image_tensor_to_data_url(image),
            "prompt": prompt,
            "scale_factor": scale_factor,
            "creativity": creativity,
            "resemblance": resemblance,
            "negative_prompt": negative_prompt,
            "num_inference_steps": num_inference_steps,
            "output_format": "png",
        }
        if seed and seed > 0:
            input_dict["seed"] = seed
        pred = await _run_prediction("philz1337x/clarity-upscaler", input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "clarity_upscale"))


# =============================================================================
# Node: Ideogram V3 Turbo (best-in-class for typography / text in images)
# =============================================================================

_IDEOGRAM_ASPECT_RATIOS = [
    "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "16:10", "10:16",
    "1:3", "3:1", "4:5", "5:4",
]
_IDEOGRAM_STYLES = ["None", "Auto", "General", "Realistic", "Design"]


class IdeogramV3TurboNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="IdeogramV3TurboRemoteNode",
            display_name="Ideogram V3 Turbo",
            category="api node/image/Replicate",
            description=(
                "Ideogram V3 Turbo — the strongest model for typography, posters, "
                "and readable in-image text. ~$0.03 per image, ~5 s. Requires "
                "REPLICATE_API_TOKEN."
            ),
            inputs=[
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="What to generate. Use quotes around exact text you want rendered."),
                IO.Combo.Input("aspect_ratio", options=_IDEOGRAM_ASPECT_RATIOS, default="1:1"),
                IO.Combo.Input("style_type", options=_IDEOGRAM_STYLES, default="None", advanced=True,
                               tooltip="Override style; 'None' lets the model decide."),
                IO.String.Input("magic_prompt", default="Auto", advanced=True,
                                tooltip="Auto / On / Off — Ideogram-side prompt expansion."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, tooltip="0 = random."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.03}'),
        )

    @classmethod
    async def execute(cls, prompt, aspect_ratio, style_type, magic_prompt, seed):
        input_dict: dict = {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "magic_prompt_option": magic_prompt,
        }
        if style_type and style_type != "None":
            input_dict["style_type"] = style_type
        if seed and seed > 0:
            input_dict["seed"] = seed
        pred = await _run_prediction("ideogram-ai/ideogram-v3-turbo", input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "ideogram"))


# =============================================================================
# Node: Google Veo 3 (best-in-class text-to-video with synced audio)
# =============================================================================

_VEO3_ASPECT_RATIOS = ["16:9", "9:16"]


class Veo3RemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="Veo3RemoteNode",
            display_name="Veo 3",
            category="api node/video/Replicate",
            description=(
                "Google Veo 3 — flagship text-to-video with synchronized audio "
                "(dialogue, ambient, music). 8s clips, ~$6.00 per generation. "
                "Slow (5–10 min) and pricey, but best-in-class quality."
            ),
            inputs=[
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Describe the shot. Include camera moves, dialog in quotes for audio sync."),
                IO.Image.Input("image", optional=True,
                               tooltip="Optional first frame for image-to-video."),
                IO.Combo.Input("aspect_ratio", options=_VEO3_ASPECT_RATIOS, default="16:9"),
                IO.String.Input("negative_prompt", default="", advanced=True,
                                tooltip="Concepts to avoid (e.g., 'low quality, blurry')."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, tooltip="0 = random."),
            ],
            outputs=[IO.Video.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":6.00,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, prompt, image, aspect_ratio, negative_prompt, seed):
        input_dict: dict = {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
        }
        if image is not None:
            input_dict["image"] = _image_tensor_to_data_url(image)
        if negative_prompt:
            input_dict["negative_prompt"] = negative_prompt
        if seed and seed > 0:
            input_dict["seed"] = seed
        pred = await _run_prediction(
            "google/veo-3",
            input_dict,
            poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC,
        )
        video = await download_url_to_video_output(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(video)


# =============================================================================
# Node: Seedance 2.0 (currently top-ranked text/image-to-video)
# =============================================================================

_SEEDANCE_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]
_SEEDANCE_RESOLUTIONS = ["480p", "720p", "1080p"]


class Seedance2RemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="Seedance2RemoteNode",
            display_name="Seedance 2.0",
            category="api node/video/Replicate",
            description=(
                "ByteDance Seedance 2.0 — currently the top-ranked text/image-"
                "to-video model. Cinematic motion, strong prompt adherence, "
                "stable cameras, sharp detail. 5 or 10 second clips at up to "
                "1080p. ~$0.50–$1.50 per clip depending on resolution + duration."
            ),
            inputs=[
                IO.String.Input(
                    "prompt", multiline=True, default="",
                    tooltip="Describe the shot. Include camera moves, mood, lighting.",
                ),
                IO.Image.Input(
                    "image", optional=True,
                    tooltip="Optional first frame — turns this into image-to-video.",
                ),
                IO.Combo.Input("aspect_ratio", options=_SEEDANCE_ASPECT_RATIOS, default="16:9",
                               tooltip="Ignored when image is provided."),
                IO.Combo.Input("resolution", options=_SEEDANCE_RESOLUTIONS, default="1080p",
                               tooltip="Higher = sharper but more expensive."),
                IO.Combo.Input("duration", options=["5", "10"], default="5",
                               tooltip="Seconds. 10s ≈ 2× the cost."),
                IO.Boolean.Input("camera_fixed", default=False, advanced=True,
                                 tooltip="Lock the camera — useful when you only want subject motion."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, tooltip="0 = random."),
            ],
            outputs=[IO.Video.Output()],
            price_badge=IO.PriceBadge(
                expr='{"type":"usd","usd":0.60,"format":{"approximate":true}}',
            ),
        )

    @classmethod
    async def execute(cls, prompt, image, aspect_ratio, resolution, duration,
                      camera_fixed, seed):
        input_dict: dict = {
            "prompt": prompt,
            "resolution": resolution,
            "duration": int(duration),
            "camera_fixed": camera_fixed,
            "fps": 24,
        }
        if image is not None:
            input_dict["image"] = _image_tensor_to_data_url(image)
        else:
            input_dict["aspect_ratio"] = aspect_ratio
        if seed and seed > 0:
            input_dict["seed"] = seed
        pred = await _run_prediction(
            "bytedance/seedance-2.0",
            input_dict,
            poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC,
        )
        video = await download_url_to_video_output(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(video)


# =============================================================================
# Node: Whisper (best-in-class transcription)
# =============================================================================


class WhisperRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="WhisperRemoteNode",
            display_name="Whisper (fal · wizper)",
            category="api node/audio/Replicate",
            description=(
                "Whisper large-v3 via fal's 'wizper' — transcribes audio to "
                "text with language detection, ~250× real-time. Near-free "
                "(fal bills by compute time; a short clip is a fraction of a "
                "cent). Output is a plain string; pair with a Text node to "
                "feed downstream prompts."
            ),
            inputs=[
                IO.Audio.Input("audio", tooltip="Audio clip to transcribe."),
                IO.Combo.Input(
                    "language",
                    options=["auto", "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ru", "ar", "hi"],
                    default="auto",
                    tooltip="Hint the language (or auto-detect).",
                ),
                IO.Boolean.Input("translate", default=False, advanced=True,
                                 tooltip="Translate to English instead of transcribing in original language."),
            ],
            outputs=[IO.String.Output(display_name="transcript")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.001,"format":{"suffix":"/min","approximate":true}}'),
        is_output_node=True,
        )

    @classmethod
    async def execute(cls, audio, language, translate):
        from comfy_api_nodes import fal_refs

        # wizper fetches audio_url server-side; host the clip on fal's CDN rather
        # than inline it (a 60s wav data URL is multi-MB and unreliable inline).
        data_url = _audio_dict_to_wav_data_url(audio, max_seconds=60)
        audio_url = await _lipsync_hosted_media_url(data_url, "audio/wav", "whisper.wav")
        input_dict: dict = {
            "audio_url": audio_url,
            "task": "translate" if translate else "transcribe",
            "version": "3",
        }
        if language and language != "auto":
            input_dict["language"] = language

        # fal-ai/wizper is a single-endpoint app (no trailing function segment).
        result = await fal_refs.run_fal_prediction("fal-ai/wizper", "", input_dict)
        # wizper returns {text, chunks, languages}; text is the full transcript.
        text = str((result or {}).get("text") or "")
        return IO.NodeOutput(text)


# =============================================================================
# Node: MusicGen (text-to-music)
# =============================================================================


class MusicGenRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="MusicGenRemoteNode",
            display_name="MusicGen",
            category="api node/audio/Replicate",
            description=(
                "Meta MusicGen — text-to-music. Describe a mood, genre, "
                "instruments, tempo. Mono / stereo, up to ~30s. ~$0.01–0.05 "
                "depending on length. Output is AUDIO ready for SaveAudio."
            ),
            inputs=[
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Describe the music. e.g. 'lo-fi hip-hop, mellow piano, 80 bpm'."),
                IO.Int.Input("duration", default=8, min=1, max=30, step=1,
                             tooltip="Seconds."),
                IO.Combo.Input(
                    "model_version",
                    options=["stereo-melody-large", "stereo-large", "melody-large", "large"],
                    default="stereo-melody-large",
                    advanced=True,
                ),
                IO.Float.Input("temperature", default=1.0, min=0.0, max=2.0, step=0.05, advanced=True),
                IO.Float.Input("top_p", default=0.0, min=0.0, max=1.0, step=0.05, advanced=True,
                               tooltip="0 disables top-p; uses top-k=250 instead."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, tooltip="0 = random."),
            ],
            outputs=[IO.Audio.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.02,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, prompt, duration, model_version, temperature, top_p, seed):
        input_dict: dict = {
            "prompt": prompt,
            "duration": duration,
            "model_version": model_version,
            "temperature": temperature,
            "output_format": "wav",
            "normalization_strategy": "peak",
        }
        if top_p > 0:
            input_dict["top_p"] = top_p
        if seed and seed > 0:
            input_dict["seed"] = seed
        pred = await _run_prediction("meta/musicgen", input_dict)
        audio = await _download_url_to_audio_dict(_first_output_url(pred))
        return IO.NodeOutput(audio)


# =============================================================================
# Node: MiniMax Speech-02 HD (best-in-class TTS)
# =============================================================================

_MINIMAX_VOICES = [
    "Wise_Woman", "Friendly_Person", "Inspirational_girl", "Deep_Voice_Man",
    "Calm_Woman", "Casual_Guy", "Lively_Girl", "Patient_Man", "Young_Knight",
    "Determined_Man", "Lovely_Girl", "Decent_Boy", "Imposing_Manner", "Elegant_Man",
    "Abbess", "Sweet_Girl_2", "Exuberant_Girl",
]
_MINIMAX_EMOTIONS = ["auto", "happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"]


def _list_cloned_voice_ids() -> list[str]:
    """Voice ids cloned via the Train-a-voice flow, persisted as
    ``models/voices/<voice_id>.json`` sidecars by the Nitro voice-clone routes.

    Read fresh on every call (i.e. per ``/object_info``) so a newly cloned voice
    becomes a valid ``voice_id`` combo value as soon as the frontend refetches the
    schema. Without this, ComfyUI's combo validation would reject a cloned id at
    run time. Best-effort: any error yields no extra ids rather than breaking the
    node schema.
    """
    import os
    out: list[str] = []
    try:
        voices_dir = os.path.join(folder_paths.models_dir, "voices")
        for fn in sorted(os.listdir(voices_dir)):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(voices_dir, fn), "r", encoding="utf-8") as f:
                    data = json.load(f)
                vid = data.get("voice_id") or os.path.splitext(fn)[0]
                if vid:
                    out.append(str(vid))
            except Exception:
                continue
    except Exception:
        pass
    return out


class MiniMaxSpeechRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="MiniMaxSpeechRemoteNode",
            display_name="MiniMax Speech-02 HD",
            category="api node/audio/Replicate",
            description=(
                "MiniMax Speech-02 HD — natural, emotional text-to-speech across "
                "many languages with curated voices and emotion control. ~$0.30 "
                "per 1K characters. Output is AUDIO."
            ),
            inputs=[
                IO.String.Input("text", multiline=True, default="",
                                tooltip="What to say."),
                IO.Combo.Input("voice_id", options=_MINIMAX_VOICES + _list_cloned_voice_ids(), default="Wise_Woman"),
                IO.Combo.Input("emotion", options=_MINIMAX_EMOTIONS, default="auto", advanced=True),
                IO.Float.Input("speed", default=1.0, min=0.5, max=2.0, step=0.05,
                               tooltip="0.5 = half speed, 2.0 = double."),
                IO.Float.Input("volume", default=1.0, min=0.1, max=10.0, step=0.1, advanced=True),
                IO.Int.Input("pitch", default=0, min=-12, max=12, advanced=True,
                             tooltip="Semitone offset."),
                IO.Combo.Input(
                    "language_boost",
                    options=["auto", "English", "Spanish", "French", "German", "Italian",
                            "Portuguese", "Japanese", "Korean", "Chinese", "Arabic"],
                    default="auto",
                    advanced=True,
                ),
            ],
            outputs=[IO.Audio.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.30,"format":{"suffix":"/1K chars","approximate":true}}'),
        )

    @classmethod
    async def execute(cls, text, voice_id, emotion, speed, volume, pitch, language_boost):
        input_dict: dict = {
            "text": text,
            "voice_id": voice_id,
            "speed": speed,
            "volume": volume,
            "pitch": pitch,
            "sample_rate": 32000,
            "bitrate": 128000,
            "channel": "mono",
            "english_normalization": True,
        }
        if emotion and emotion != "auto":
            input_dict["emotion"] = emotion
        if language_boost and language_boost != "auto":
            input_dict["language_boost"] = language_boost
        pred = await _run_prediction("minimax/speech-02-hd", input_dict)
        audio = await _download_url_to_audio_dict(_first_output_url(pred))
        return IO.NodeOutput(audio)


# =============================================================================
# Node: Hunyuan3D 2 (best-in-class image-to-3D)
# =============================================================================


class Hunyuan3DRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="Hunyuan3DRemoteNode",
            display_name="Hunyuan3D 2",
            category="api node/3d/Replicate",
            description=(
                "Tencent Hunyuan3D 2 — image-to-3D. Feed a single reference "
                "image, get back a textured GLB mesh URL. ~$0.30 per asset, "
                "~30–60s. Output is a STRING URL (use as upload to viewer or "
                "downstream nodes)."
            ),
            inputs=[
                IO.Image.Input("image", tooltip="Reference image. Use a clean, well-lit subject on a neutral bg."),
                IO.Int.Input("steps", default=50, min=20, max=100, step=5,
                             tooltip="Inference steps for shape synthesis."),
                IO.Float.Input("guidance_scale", default=5.5, min=1.0, max=20.0, step=0.5, advanced=True),
                IO.Int.Input("octree_resolution", default=256, min=128, max=512, step=64, advanced=True,
                             tooltip="Mesh resolution. Higher = denser geometry."),
                IO.Boolean.Input("remove_background", default=True,
                                 tooltip="Pre-process: remove the background before reconstruction."),
                IO.Boolean.Input("texture", default=True,
                                 tooltip="Bake textures (else returns just geometry)."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, tooltip="0 = random."),
            ],
            outputs=[IO.String.Output(display_name="glb_url")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.30,"format":{"approximate":true}}'),
        is_output_node=True,
        )

    @classmethod
    async def execute(cls, image, steps, guidance_scale, octree_resolution,
                      remove_background, texture, seed):
        input_dict: dict = {
            "image": _image_tensor_to_data_url(image),
            "steps": steps,
            "guidance_scale": guidance_scale,
            "octree_resolution": octree_resolution,
            "remove_background": remove_background,
            "texture": texture,
        }
        if seed and seed > 0:
            input_dict["seed"] = seed
        pred = await _run_prediction(
            "tencent/hunyuan3d-2",
            input_dict,
            poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC,
        )
        url = _first_output_url(pred)
        return IO.NodeOutput(url)


# =============================================================================
# Node: Hunyuan3D 2 Multi-View (front/back/left/right → textured GLB)
# =============================================================================


class Hunyuan3DMultiViewNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="Hunyuan3DMultiViewNode",
            display_name="Multi-View → 3D",
            category="api node/3d/Replicate",
            description=(
                "Reconstruct a 3D model from a front/back/left/right character sheet "
                "(e.g. the Pose Mannequin 'Generate 3D views' output). Front is "
                "required; the other three are optional but strongly recommended.\n"
                "• TRELLIS — textured GLB (good, cheaper).\n"
                "• Rodin — textured PBR + QUAD topology (premium, best for rigging).\n"
                "• Hunyuan3D-2mv — geometry only (finer mesh, no texture).\n"
                "~$0.30–0.60, ~30–120s. Output is a STRING URL to the GLB mesh."
            ),
            inputs=[
                IO.Image.Input("front_image", tooltip="Front view (required)."),
                IO.Image.Input("back_image", optional=True, tooltip="Back view."),
                IO.Image.Input("left_image", optional=True, tooltip="Left-side view."),
                IO.Image.Input("right_image", optional=True, tooltip="Right-side view."),
                IO.Combo.Input("engine",
                               options=["TRELLIS (textured)", "Rodin (textured · quad mesh)", "Hunyuan3D-2mv (geometry only)"],
                               default="TRELLIS (textured)",
                               tooltip="TRELLIS/Rodin bake textures (Rodin = quad topology, premium); Hunyuan3D-2mv is shape-only."),
                IO.Int.Input("steps", default=50, min=20, max=100, step=5,
                             tooltip="Inference steps (Hunyuan only)."),
                IO.Float.Input("guidance_scale", default=5.5, min=1.0, max=20.0, step=0.5, advanced=True),
                IO.Int.Input("octree_resolution", default=256, min=128, max=512, step=64, advanced=True,
                             tooltip="Mesh resolution, Hunyuan only. Higher = denser."),
                IO.Boolean.Input("remove_background", default=True,
                                 tooltip="Strip each view's background before reconstruction."),
                # control_after_generate=True is REQUIRED: it auto-randomizes the
                # seed each run (so ComfyUI doesn't serve a cached result forever —
                # "Done in 0.3s"), and keeps the widgets declared AFTER it aligned.
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             control_after_generate=True, tooltip="0 = random."),
                # New inputs appended LAST + optional so existing node instances keep
                # their widget positions and fall back to the execute() defaults.
                IO.String.Input("prompt", multiline=True, default="a full-body character", optional=True,
                                tooltip="Text description of the subject. REQUIRED by Rodin; ignored by TRELLIS/Hunyuan."),
                IO.Combo.Input("rodin_quality", options=["medium", "high", "low", "extra-low"], default="medium",
                               optional=True, advanced=True, tooltip="Rodin mesh detail tier."),
                IO.Boolean.Input("rodin_tapose", default=False, optional=True, advanced=True,
                                 tooltip="Rodin: normalize a human model to a clean A/T-pose base (good for rigging)."),
                IO.Int.Input("rodin_poly_count", default=0, min=0, max=300000, step=1000, optional=True, advanced=True,
                             tooltip="Rodin: custom polygon count (0 = automatic)."),
            ],
            outputs=[IO.String.Output(display_name="glb_url")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.30,"format":{"approximate":true}}'),
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, front_image, back_image=None, left_image=None, right_image=None,
                      engine="TRELLIS (textured)", prompt="a full-body character",
                      rodin_quality="medium", rodin_tapose=False, rodin_poly_count=0,
                      steps=50, guidance_scale=5.5,
                      octree_resolution=256, remove_background=True, seed=0):
        front = _image_tensor_to_data_url(front_image)
        back = _image_tensor_to_data_url(back_image) if back_image is not None else None
        left = _image_tensor_to_data_url(left_image) if left_image is not None else None
        right = _image_tensor_to_data_url(right_image) if right_image is not None else None

        if engine.startswith("Hunyuan"):
            # Geometry-only: tencent/hunyuan3d-2mv (no texture stage).
            input_dict: dict = {
                "front_image": front, "steps": steps, "guidance_scale": guidance_scale,
                "octree_resolution": octree_resolution, "remove_background": remove_background,
                "file_type": "glb",
            }
            if back: input_dict["back_image"] = back
            if left: input_dict["left_image"] = left
            if right: input_dict["right_image"] = right
            if seed and seed > 0:
                input_dict["seed"] = seed
            pred = await _run_prediction("tencent/hunyuan3d-2mv", input_dict,
                                         poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC)
            return IO.NodeOutput(_first_output_url(pred))

        if engine.startswith("Rodin"):
            # Hyper3D Rodin — multi-image (up to 5) → textured PBR GLB with quad
            # topology. Premium quality; output is a plain GLB URL. Rodin REQUIRES
            # a non-empty prompt even with images.
            images = [img for img in (front, back, left, right) if img]
            input_dict = {
                "images": images,
                "prompt": (prompt or "").strip() or "a full-body character",
                "material": "PBR",
                "mesh_mode": "Quad",
                "quality": rodin_quality,
                "geometry_file_format": "glb",
                "tapose": bool(rodin_tapose),
            }
            if rodin_poly_count and rodin_poly_count > 0:
                input_dict["quality_override"] = int(rodin_poly_count)
            if seed and seed > 0:
                # Rodin caps the seed at 65535; our randomizer goes to ~4.3B, so map in.
                input_dict["seed"] = int(seed) % 65536
            pred = await _run_prediction("hyper3d/rodin", input_dict,
                                         poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC)
            return IO.NodeOutput(_first_output_url(pred))

        # Default: TRELLIS — multi-image → TEXTURED GLB. Order front-first.
        images = [img for img in (front, back, left, right) if img]
        input_dict = {
            "images": images,
            "generate_model": True,   # off by default on Replicate → must enable for a GLB
            "generate_color": False,
            "texture_size": 1024,
            "mesh_simplify": 0.95,
        }
        if seed and seed > 0:
            input_dict["seed"] = seed
            input_dict["randomize_seed"] = False
        pred = await _run_prediction("firtoz/trellis", input_dict,
                                     poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC)
        output = pred.get("output")
        url = output.get("model_file") if isinstance(output, dict) else None
        return IO.NodeOutput(url or _first_output_url(pred))


# =============================================================================
# Node: Remove background (851-labs/background-remover)
# =============================================================================


class RemoveBackgroundRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="RemoveBackgroundRemoteNode",
            display_name="Remove Background",
            category="api node/image/Replicate",
            description=(
                "851-labs/background-remover — fast, clean alpha-matte "
                "background removal. ~$0.001 per image, <2s. Output is a PNG "
                "with transparent background (the alpha channel is collapsed "
                "to RGB by Comfy's IMAGE type, so for true transparency use "
                "the URL output downstream)."
            ),
            inputs=[
                IO.Image.Input("image", tooltip="Image to remove the background from."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.001,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, image):
        input_dict = {"image": _image_tensor_to_data_url(image)}
        pred = await _run_prediction("851-labs/background-remover", input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "remove_bg"))


# =============================================================================
# Node: Restore an old photo (flux-kontext-apps/restore-image)
# =============================================================================


class RestorePhotoRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="RestorePhotoRemoteNode",
            display_name="Restore Photo",
            category="api node/image/Replicate",
            description=(
                "flux-kontext-apps/restore-image — restore old, damaged, or "
                "faded photographs. Fixes scratches, fading, mild damage; can "
                "also colorize black-and-white. ~$0.04 per image."
            ),
            inputs=[
                IO.Image.Input("image", tooltip="Photo to restore."),
                IO.String.Input("safety_tolerance", default="2", advanced=True,
                                tooltip="Flux safety: 1 strict, 6 permissive."),
                IO.Combo.Input("output_format", options=["png", "jpg"], default="png", advanced=True),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.04}'),
        )

    @classmethod
    async def execute(cls, image, safety_tolerance, output_format):
        input_dict = {
            "input_image": _image_tensor_to_data_url(image),
            "safety_tolerance": int(safety_tolerance) if str(safety_tolerance).isdigit() else 2,
            "output_format": output_format,
        }
        pred = await _run_prediction("flux-kontext-apps/restore-image", input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "restore_photo"))


# =============================================================================
# Node: Fix faces in a photo (sczhou/codeformer)
# =============================================================================


class CodeformerRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="CodeformerRemoteNode",
            display_name="Fix Faces · CodeFormer",
            category="api node/image/Replicate",
            description=(
                "sczhou/codeformer — face-specific restoration. Sharpens, "
                "de-blurs, and reconstructs damaged or low-res faces while "
                "leaving the rest of the photo intact. Great for old portraits, "
                "low-res screenshots, AI-generated faces with artifacts. "
                "~$0.005 per image."
            ),
            inputs=[
                IO.Image.Input("image", tooltip="Image containing faces to restore."),
                IO.Float.Input(
                    "codeformer_fidelity",
                    default=0.5, min=0.0, max=1.0, step=0.05,
                    tooltip="0 = stronger restoration (more change), 1 = more faithful (subtle).",
                ),
                IO.Boolean.Input("background_enhance", default=True, advanced=True,
                                 tooltip="Also enhance the non-face background with Real-ESRGAN."),
                IO.Boolean.Input("face_upsample", default=True, advanced=True,
                                 tooltip="Upsample faces for higher final resolution."),
                IO.Int.Input("upscale", default=2, min=1, max=4, step=1, advanced=True,
                             tooltip="Final upscale factor relative to input."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.005,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, image, codeformer_fidelity, background_enhance,
                      face_upsample, upscale):
        input_dict = {
            "image": _image_tensor_to_data_url(image),
            "codeformer_fidelity": codeformer_fidelity,
            "background_enhance": background_enhance,
            "face_upsample": face_upsample,
            "upscale": upscale,
        }
        pred = await _run_prediction("sczhou/codeformer", input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "codeformer"))


# =============================================================================
# Node: Describe an image (lucataco/moondream2)
# =============================================================================


class DescribeImageRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="DescribeImageRemoteNode",
            display_name="Describe Image · Moondream 2",
            category="api node/image/Replicate",
            description=(
                "lucataco/moondream2 — small, fast vision-language model. "
                "Answer any question about an image, generate captions, "
                "describe objects, count things. ~$0.001 per query. Output is "
                "plain text — pair with a Text node for downstream use."
            ),
            inputs=[
                IO.Image.Input("image", tooltip="Image to describe."),
                IO.String.Input(
                    "prompt", multiline=True,
                    default="Describe this image in detail.",
                    tooltip="What to ask. e.g. 'What color is the car?' or 'Count the people.'",
                ),
            ],
            outputs=[IO.String.Output(display_name="description")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.001,"format":{"approximate":true}}'),
        is_output_node=True,
        )

    @classmethod
    async def execute(cls, image, prompt):
        input_dict = {
            "image": _image_tensor_to_data_url(image),
            "prompt": prompt,
        }
        pred = await _run_prediction("lucataco/moondream2", input_dict)
        out = pred.get("output")
        # moondream2 sometimes returns a list of tokens, sometimes a single string.
        if isinstance(out, list):
            text = "".join(str(x) for x in out)
        elif isinstance(out, str):
            text = out
        else:
            text = str(out or "")
        return IO.NodeOutput(text.strip())


# =============================================================================
# Node: Sync lips to audio (sync/lipsync-2-pro)
# =============================================================================


class LipsyncRemoteNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="LipsyncRemoteNode",
            display_name="Lipsync · sync.so 2-pro",
            category="api node/video/Replicate",
            description=(
                "sync/lipsync-2-pro — drive any face's lips to match an audio "
                "track. Feed a source video (or image for talking-portrait), "
                "an audio clip, and get a lip-synced video out. ~$1.00 per "
                "30s of output. Best-in-class quality."
            ),
            inputs=[
                IO.String.Input(
                    "video_url", default="",
                    tooltip="URL of a source video showing the face. Public URL or data URL.",
                ),
                IO.Audio.Input("audio", tooltip="Audio track to sync the lips to."),
                IO.Combo.Input(
                    "sync_mode",
                    options=["loop", "bounce", "cut_off", "silence", "remap"],
                    default="cut_off",
                    advanced=True,
                    tooltip="How to handle audio shorter/longer than the video.",
                ),
            ],
            outputs=[IO.Video.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":1.00,"format":{"approximate":true,"suffix":"/30s"}}'),
        )

    @classmethod
    async def execute(cls, video_url, audio, sync_mode):
        # Encode audio dict → WAV data URL (same shape as Whisper does).
        audio_url = _audio_dict_to_wav_data_url(audio, max_seconds=60)

        if not video_url:
            raise RuntimeError(
                "video_url is required. Paste a public URL to the source video "
                "(or upload it via your asset library and use that URL)."
            )

        input_dict = {
            "video": video_url,
            "audio": audio_url,
            "sync_mode": sync_mode,
        }
        pred = await _run_prediction(
            "sync/lipsync-2-pro",
            input_dict,
            poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC,
        )
        video = await download_url_to_video_output(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(video)


def _lipsync_resolve_engine(engine: str, has_image: bool, has_video: bool) -> str:
    """Pick the lip-sync engine: explicit choice wins; else a video → sync
    (relip), an image → fabric (talking head)."""
    if engine in ("fabric", "sync"):
        return engine
    return "sync" if has_video else "fabric"


def _lipsync_build_input(engine, image, video, audio, resolution, sync_mode):
    """Shape the Replicate input per engine. Returns (slug, input_dict)."""
    if not audio:
        raise RuntimeError("Lip-sync requires an audio clip.")
    if engine == "sync":
        # Video-relip engine. Uses kwaivgi/kling-lip-sync (Kling/Kuaishou) — a
        # different provider from sync.so, whose lipsync-2-pro was returning
        # backend errors. Kling takes video_url + audio_file (both public URLs;
        # hosted in execute). It has no sync_mode.
        if not video:
            raise RuntimeError("Video lip-sync requires a source video.")
        return "kwaivgi/kling-lip-sync", {"video_url": video, "audio_file": audio}
    if not image:
        raise RuntimeError("Fabric 1.0 requires an input image (face).")
    return "veed/fabric-1.0", {"image": image, "audio": audio, "resolution": resolution}


async def _upload_public_file(data: bytes, filename: str, content_type: str = "application/octet-stream") -> str:
    """Upload bytes to fal storage and return a PUBLIC CDN url (v3.fal.media).
    Used for the sync engine's source VIDEO: sync/lipsync-2-pro proxies to sync.so,
    whose servers fetch the video URL directly — so it must be publicly reachable
    (a Replicate Files url is auth-gated; a /view url is local; a multi-MB base64
    data url is rejected). fal-cdn urls need no auth. (Fabric/images stay data urls.)"""
    from comfy_api_nodes import fal_refs
    token = fal_refs.get_fal_token()
    hdr = {"Authorization": f"Key {token}", "Content-Type": "application/json"}
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
            headers=hdr, json={"content_type": content_type, "file_name": filename},
        ) as r:
            if r.status not in (200, 201):
                raise RuntimeError(f"fal storage initiate failed HTTP {r.status}: {await r.text()}")
            init = await r.json()
        file_url = init.get("file_url")
        upload_url = init.get("upload_url")
        if not (file_url and upload_url):
            raise RuntimeError(f"fal storage initiate returned no urls: {init}")
        async with session.put(upload_url, data=data, headers={"Content-Type": content_type}) as r:
            if r.status not in (200, 201, 204):
                raise RuntimeError(f"fal storage upload PUT failed HTTP {r.status}: {await r.text()}")
    return file_url


async def _lipsync_hosted_media_url(src: str, content_type: str, fallback_name: str) -> str:
    """Resolve a media ref to a publicly-fetchable URL. A public http(s) URL passes
    through; a /view input ref or a data: URL is uploaded to fal storage. Empty/
    unknown forms pass through unchanged. Used for the video-relip (Kling) engine,
    whose proxy fetches both the video and audio from public URLs."""
    if not src:
        return src
    if src.startswith("http://") or src.startswith("https://"):
        return src
    name = _parse_view_ref(src)
    if name:
        path = os.path.join(folder_paths.get_input_directory(), name)
        if not os.path.isfile(path):
            raise RuntimeError(f"Source media {name!r} is missing from the input folder.")
        with open(path, "rb") as f:
            data = f.read()
        return await _upload_public_file(data, name, content_type)
    if src.startswith("data:"):
        b64 = src.split(",", 1)[1] if "," in src else ""
        data = base64.b64decode(b64)
        return await _upload_public_file(data, fallback_name, content_type)
    return src


# =============================================================================
# USE-CASE NODES
# =============================================================================
#
# Single nodes per use-case with a Model dropdown inside. Shared inputs sit
# at the top; model-specific fields live under the advanced fold and are
# tagged in their tooltips with the model(s) they apply to. `execute()`
# dispatches to the right Replicate model based on the `model` combo.
#
# The per-model classes above stay registered for workflow back-compat but
# are deprecated — the Generators panel hides them via its DENY list.

# ---- shared helpers --------------------------------------------------------

def _maybe(d: dict, key: str, value, *, default_to_drop=None):
    """Set d[key] = value, but skip if value is the default sentinel."""
    if value == default_to_drop:
        return
    d[key] = value


# =============================================================================
# Use case: Generate an image
# =============================================================================
#
# Single node fronting the entire Replicate text-to-image fleet via a model
# gallery UI. Schema is intentionally lean: shared widgets (model, prompt,
# aspect_ratio, seed) plus a hidden `model_options` JSON blob that the
# gallery edits for the active model. Per-model dispatch + input shaping
# lives in image_models.py — adding a new model = appending an entry there.
from comfy_api_nodes.image_models import (
    MODELS as _IMAGE_MODELS,
    IMAGE_MODELS_BY_ID as _IMAGE_MODELS_BY_ID,
    ALL_ASPECT_RATIOS as _IMAGE_GEN_ASPECT_RATIOS,
    DEFAULT_MODEL_ID as _IMAGE_DEFAULT_MODEL_ID,
    accepts_refs as _accepts_refs,
)

# The combo serializes the model `id` (e.g. "flux-1.1-pro") so we can rename
# the human-facing `label` without breaking existing workflows.
_IMAGE_GEN_MODEL_IDS = [m.id for m in _IMAGE_MODELS]


def _fal_available(spec) -> bool:
    """True when this model has an exact fal counterpart AND a fal token exists.
    A fal-primary model gracefully collapses to Replicate-only when fal isn't
    configured (no misleading 'fal failed: no token' in the error path)."""
    if not (spec.fal_slug and spec.fal_build_input):
        return False
    try:
        from comfy_api_nodes import fal_refs
        fal_refs.get_fal_token()  # raises if unconfigured
        return True
    except Exception:
        return False


def _provider_order(spec, prefer_replicate: bool = False) -> list[str]:
    """Providers to try, in order. fal is only ever included when it's actually
    available; `spec.primary` decides which of the two goes first.

    `prefer_replicate` (moodboards Plan B, Task B3): when moodboard refs are
    riding along, the REPLICATE builders are the ones that emit them (their
    schemas take `image_input`/`image_urls` on the t2i endpoint; fal's t2i
    endpoints don't, and an unverified fal field is a silent-fallover trap —
    see the enum-mismatch incident). A fal-primary ref-capable model therefore
    flips to Replicate-first for that run; fal stays as the backup, where the
    fallover print makes the ref drop legible."""
    if not _fal_available(spec):
        return ["replicate"]
    if prefer_replicate:
        return ["replicate", "fal"]
    return ["fal", "replicate"] if getattr(spec, "primary", "replicate") == "fal" else ["replicate", "fal"]


async def _replicate_image_urls(spec, prompt, aspect_ratio, seed, advanced, refs=None) -> list:
    input_dict = spec.build_input(prompt, aspect_ratio, int(seed or 0), advanced, refs)
    print(
        f"[GenerateImage] replicate model={spec.id!r} slug={spec.replicate_slug!r} "
        f"input_keys={list(input_dict)} advanced={advanced}",
        flush=True,
    )
    pred = await _run_prediction(spec.replicate_slug, input_dict)
    # num_outputs>1 (sketch preset) makes Replicate return `output` as a list of
    # N urls in ONE prediction; num_outputs=1 may still come back as a bare
    # string. _all_output_urls normalizes both to a list.
    urls = _all_output_urls(pred)
    if not urls:
        raise RuntimeError(f"Replicate returned no output (status={pred.get('status')})")
    return urls


async def _fal_image_urls(spec, prompt, aspect_ratio, seed, advanced, refs=None) -> list:
    from comfy_api_nodes import fal_refs
    fal_input = spec.fal_build_input(prompt, aspect_ratio, int(seed or 0), advanced, refs)
    print(
        f"[GenerateImage] fal model={spec.id!r} endpoint={spec.fal_slug!r} "
        f"input_keys={list(fal_input)}"
        # No fal t2i builder emits refs (their schemas take none) — say so
        # rather than dropping them silently on the fallover path.
        + (" (moodboard refs NOT sent — fal t2i takes none)" if refs else ""),
        flush=True,
    )
    # Bound the wait: a stuck/queued fal job shouldn't block the fallover to the
    # other provider for the default 15 minutes. 300s covers the slowest measured
    # endpoint (Seedream 5 Pro's reasoning pass: ~140s) with margin; the fast
    # models (schnell ~2s, flux-pro ~8s) never get near it.
    result = await fal_refs.run_fal_prediction(spec.fal_slug, "", fal_input, poll_deadline_sec=300)
    urls = fal_refs.all_fal_image_urls(result)
    if not urls:
        raise RuntimeError(f"fal returned no image (endpoint={spec.fal_slug})")
    return urls


async def _dispatch_image(spec, prompt, aspect_ratio, seed, advanced, refs=None) -> list:
    """Run the model on its primary provider, falling over to the other on ANY
    failure. Returns output image URLs. Raises a combined error only if EVERY
    available provider fails. `refs` (moodboard style references, data URLs)
    flips the order Replicate-first — the provider whose builders emit them."""
    runners = {"replicate": _replicate_image_urls, "fal": _fal_image_urls}
    order = _provider_order(spec, prefer_replicate=bool(refs))
    errors: list[str] = []
    for prov in order:
        try:
            return await runners[prov](spec, prompt, aspect_ratio, seed, advanced, refs)
        except Exception as e:
            errors.append(f"{prov}: {e}")
            # Only worth announcing a fallover when another provider remains.
            if prov != order[-1]:
                print(
                    f"[GenerateImage] {prov} failed ({e}); falling over to "
                    f"{order[order.index(prov) + 1]}",
                    flush=True,
                )
    raise RuntimeError("Image generation failed — " + "; ".join(errors))


# ── Moodboard style references (moodboards Plan B, Task B3) ──────────────────
#
# The frontend's moodboard apply writes a small JSON payload into the node's
# hidden `style_refs` widget: {"folder": "moodboard_<ms>", "files": [...]} —
# input-dir-relative paths, never base64 (saved-project size is a contract).
# The node reads ≤3 of those files from `<repo-root>/input/<folder>/`, turns
# them into data URLs and hands them to the ref-capable model builders.
#
# The guards are a Python port of the frontend's moodboard route guards
# (shared/taste/moodboard.ts MOODBOARD_FOLDER_RE + server/utils/
# moodboardImages.ts safeImageFile): folder must be a `moodboard_<ms>` name —
# NEVER a lora_dataset_* folder — and every file a bare image name with no
# traversal.

_MOODBOARD_FOLDER_RE = re.compile(r"^moodboard_\d+$")
_MOODBOARD_IMAGE_EXT_RE = re.compile(r"\.(png|jpe?g|webp)$", re.IGNORECASE)
_MOODBOARD_REF_MIME = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
}
_MOODBOARD_MAX_REFS = 3
_STYLE_REFS_INSTRUCTION = (
    "Use the attached reference images strictly as STYLE references — match "
    "their palette, light, grain and mood; do not copy their subjects or "
    "composition."
)


def _safe_moodboard_file(name) -> bool:
    """Port of server/utils/moodboardImages.ts safeImageFile: a bare image
    filename — no slashes, no backslashes, no `..` — with an image extension."""
    if not name or not isinstance(name, str):
        return False
    if "/" in name or "\\" in name or ".." in name:
        return False
    return bool(_MOODBOARD_IMAGE_EXT_RE.search(name))


def _parse_style_refs(style_refs) -> tuple[str, list[str]] | None:
    """Parse + validate the `style_refs` widget JSON. Returns (folder, files)
    with files capped at _MOODBOARD_MAX_REFS, or None when the payload is
    empty, malformed, or fails the folder/file guards. Never raises — a bad
    payload must degrade to a plain (ref-less) generation, not kill the run."""
    if not style_refs or not str(style_refs).strip():
        return None
    try:
        payload = json.loads(style_refs)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    folder = payload.get("folder")
    files = payload.get("files")
    if not isinstance(folder, str) or not _MOODBOARD_FOLDER_RE.match(folder):
        return None
    if not isinstance(files, list):
        return None
    good = [f for f in files if _safe_moodboard_file(f)][:_MOODBOARD_MAX_REFS]
    if not good:
        return None
    return folder, good


def _moodboard_ref_data_urls(folder: str, files: list[str], input_dir: str | None = None) -> list[str]:
    """Read ≤3 validated moodboard images from `<input>/<folder>/` and return
    them as data URLs. Unreadable files are skipped (logged) — a board whose
    image was deleted still styles via its text block."""
    base = input_dir if input_dir is not None else folder_paths.get_input_directory()
    out: list[str] = []
    for name in files[:_MOODBOARD_MAX_REFS]:
        path = os.path.join(base, folder, name)
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            print(f"[GenerateImage] moodboard ref unreadable, skipping: {folder}/{name}", flush=True)
            continue
        ext = name.rsplit(".", 1)[-1].lower()
        mime = _MOODBOARD_REF_MIME.get(ext, "image/png")
        out.append(f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}")
    return out


class GenerateImageNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="GenerateImageNode",
            display_name="Generate an image",
            category="api node/image/Replicate",
            description=(
                "Single entry point for image generation. Click the model "
                "button to open the gallery — pick a model and tune its "
                "settings without leaving the canvas."
            ),
            inputs=[
                # Marked as a model_picker so the frontend renders a launcher
                # button (WidgetModelPicker) instead of a plain dropdown. The
                # underlying combo still serializes a plain string id so
                # workflows stay portable.
                IO.Combo.Input(
                    "model",
                    options=_IMAGE_GEN_MODEL_IDS,
                    default=_IMAGE_DEFAULT_MODEL_ID,
                    tooltip="Click to choose a model from the gallery.",
                    extra_dict={"sailor_widget": "model_picker"},
                ),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="What to generate."),
                IO.Combo.Input("aspect_ratio", options=_IMAGE_GEN_ASPECT_RATIOS, default="1:1",
                               tooltip="The active model auto-falls-back to 1:1 if it doesn't accept the picked ratio."),
                # control_after_generate=True is REQUIRED here: ComfyUI's frontend
                # auto-adds the seed-control widget when present, and our Vue
                # widgetDefs use the same flag to insert a placeholder so the
                # widgets_values array stays aligned across the bridge. Without
                # it, every input declared AFTER `seed` is off-by-one at queue
                # time and silently picks up the schema default.
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             control_after_generate=True, tooltip="0 = random."),
                # JSON blob the gallery writes — per-model advanced settings.
                # *Required* (not optional) because ComfyUI's frontend only
                # auto-instantiates LiteGraph widgets for required inputs; on
                # optional inputs, our Vue-side widgets_values update never
                # gets a slot in graphToPrompt and the bag silently stays
                # at the schema default. The `sailor_widget: "internal"`
                # hint tells the Vue node body to skip rendering it (see
                # the widget filter in ComfyNode.vue), so users still see a
                # clean 4-widget node.
                IO.String.Input(
                    "model_options",
                    default="{}",
                    multiline=False,
                    extra_dict={"sailor_widget": "internal"},
                    tooltip="JSON bag of per-model advanced settings — edited via the gallery modal.",
                ),
                # ── Moodboard style inputs (moodboards Plan B, Task B2). APPENDED
                # LAST — widgets_values is positional, so inserting either of
                # these earlier would shift every saved value after it onto the
                # wrong widget (see the schema-order guard test). The frontend
                # writes style_block BY NAME at submit time (composeLoraStyle →
                # the node's `properties.aesthetic`); the widget itself stays
                # hidden (`sailor_widget: "internal"`), like model_options.
                IO.String.Input(
                    "style_block",
                    default="",
                    multiline=True,
                    optional=True,
                    extra_dict={"sailor_widget": "internal"},
                    tooltip="Style block prepended to the prompt — written by the moodboard/style apply, not by hand.",
                ),
                # Reference-image payload (`{folder, files[]}` JSON, input-dir
                # relative). Threaded to execute but CONSUMED in Task B3 —
                # declared now so both new inputs land in one schema append.
                IO.String.Input(
                    "style_refs",
                    default="",
                    multiline=False,
                    optional=True,
                    extra_dict={"sailor_widget": "internal"},
                    tooltip="Moodboard reference-image payload (JSON) for ref-capable models.",
                ),
                # ── Taste wire + Idea socket (moodboards Plan B, Task B4) ────
                # APPENDED LAST (positional widgets_values contract, see the
                # comment above style_block). Both are socket-only — TASTE is
                # not a widget primitive and prompt_in is force_input — so
                # NEITHER occupies a widgets_values slot (schema-order test
                # asserts the widget count stays unchanged).
                _TASTE.Input(
                    "style_in",
                    optional=True,
                    tooltip=(
                        "Taste wire: a Moodboard node's compiled style block. "
                        "Prepends ahead of everything — style_block included."
                    ),
                ),
                IO.String.Input(
                    "prompt_in",
                    optional=True,
                    force_input=True,
                    tooltip=(
                        "Upstream prompt (the Idea node's socket). Joins ahead "
                        "of the prompt widget; the widget text is kept."
                    ),
                ),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.03,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, prompt, aspect_ratio, seed, model_options="{}",
                      style_block="", style_refs="", style_in="", prompt_in=""):
        spec = _IMAGE_MODELS_BY_ID.get(model)
        if spec is None:
            raise RuntimeError(
                f"Unknown image model id: {model!r}. "
                f"Known: {list(_IMAGE_MODELS_BY_ID)}"
            )
        # Task B4 prompt composition, wire first: fold prompt_in into the
        # prompt (the ONE shared rule — see _fold_prompt_in), then style_block
        # prepends, then style_in (the taste WIRE) prepends ahead of
        # everything. Final order: style_in · style_block · prompt_in · prompt.
        prompt = _fold_prompt_in(prompt, prompt_in)
        # Moodboard/style block rides ahead of the subject prompt — same
        # ordering as the FLUX LoRA nodes' client-side prompt fold.
        style_block = (style_block or "").strip()
        if style_block:
            prompt = f"{style_block} {prompt}"
        style_in = (style_in or "").strip()
        if style_in:
            prompt = f"{style_in} {prompt}".strip()
        # Moodboard reference images (Task B3): a validated `style_refs`
        # payload on a ref-capable model ('multi-image' tag) becomes ≤3 data
        # URLs handed to the model builder, plus a style-only instruction so
        # the model borrows palette/light/grain — never subjects/composition.
        refs = None
        parsed_refs = _parse_style_refs(style_refs)
        if parsed_refs and _accepts_refs(spec):
            refs = _moodboard_ref_data_urls(*parsed_refs) or None
            if refs:
                prompt = f"{prompt} {_STYLE_REFS_INSTRUCTION}".strip()
        # Tolerate empty / missing / malformed model_options — every field is
        # optional and the per-model builder applies safe defaults.
        try:
            advanced = json.loads(model_options or "{}")
            if not isinstance(advanced, dict):
                advanced = {}
        except json.JSONDecodeError:
            advanced = {}

        # Dispatch to the model's primary provider, falling over to the other on
        # ANY failure (Replicate's E9828/cold-boot is provider-specific, so the
        # backup provider sidesteps it). fal-primary models with no fal token
        # collapse to Replicate-only. See _dispatch_image / _provider_order.
        # _all_output_urls handles num_outputs>1 (sketch preset) as a batch, so
        # save_generation_output emits one ui file per image either way.
        urls = await _dispatch_image(spec, prompt, aspect_ratio, seed, advanced, refs=refs)
        tensor = torch.cat(
            [await download_url_to_image_tensor(u, cls=cls) for u in urls], dim=0
        )
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "generate_image"))


# =============================================================================
# Use case: Edit an image
# =============================================================================

# Nano Banana 2 (google/nano-banana-2, Gemini 3.1 Flash Image) is the default —
# it follows natural-language edit instructions noticeably better than Flux
# Kontext. Flux Kontext Pro stays available for its aspect-ratio / safety dials;
# Flux 2 Pro is the newest BFL editor (sharper detail, keeps input aspect).
_IMAGE_EDIT_MODELS = ["Nano Banana 2", "Flux Kontext Pro", "Flux 2 Pro"]


class EditImageNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="EditImageNode",
            display_name="Edit an image",
            category="api node/image/Replicate",
            description=(
                "Image editing via natural language — 'remove the background', "
                "'make her hair blue', 'add a cat'. Nano Banana 2 (best instruction "
                "following), Flux Kontext Pro or Flux 2 Pro (newest, sharper). "
                "~$0.04–0.05 per edit."
            ),
            inputs=[
                IO.Combo.Input("model", options=_IMAGE_EDIT_MODELS, default="Nano Banana 2"),
                IO.Image.Input("input_image", tooltip="Source image to edit."),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Edit instruction in natural language."),
                IO.Combo.Input("aspect_ratio", options=_FLUX_KONTEXT_ASPECT_RATIOS,
                               default="match_input_image",
                               tooltip="Output aspect ratio. Flux Kontext only — Nano Banana 2 "
                                       "and Flux 2 Pro keep the input's aspect ratio."),
                IO.Combo.Input("resolution", options=["1K", "2K", "4K"], default="1K", advanced=True,
                               tooltip="Output resolution for Nano Banana 2 — higher costs more. "
                                       "Ignored by Flux Kontext."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, tooltip="0 = random."),
                IO.Int.Input("safety_tolerance", default=2, min=1, max=6, advanced=True,
                             tooltip="Flux Kontext only."),
                IO.Boolean.Input("prompt_upsampling", default=False, advanced=True,
                                 tooltip="Flux Kontext only."),
                IO.Combo.Input("output_format", options=["png", "jpg"], default="png", advanced=True),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.15,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, input_image, prompt, aspect_ratio, resolution, seed,
                      safety_tolerance, prompt_upsampling, output_format):
        data_url = _image_tensor_to_data_url(input_image)

        # Each model speaks a different dialect. Nano Banana goes fal-first (fal's
        # Google access dodges Replicate's project-scoped Gemini 404), with a
        # Replicate fallback; Flux Kontext goes to fal (~2× cheaper than
        # Replicate's flux-kontext-pro).
        if model == "Nano Banana 2":
            # Prefer fal (routes around Replicate's project-scoped Gemini 404);
            # falls back to fal Nano Banana Pro, then Replicate.
            url = await _run_nano_banana_edit(
                [data_url], prompt,
                resolution=resolution, output_format=output_format, seed=seed,
            )
        elif model == "Flux 2 Pro":
            # flux-2-pro/edit takes an image_urls array and sizes to "auto"
            # (matches the input), so the Kontext-only aspect/safety dials are N/A.
            url = await _run_fal_flux2_edit(
                [data_url], prompt, output_format=output_format, seed=seed,
            )
        else:  # Flux Kontext Pro
            url = await _run_fal_kontext(
                data_url, prompt, aspect_ratio=aspect_ratio,
                safety_tolerance=safety_tolerance, enhance_prompt=prompt_upsampling,
                output_format=output_format, seed=seed,
            )

        tensor = await download_url_to_image_tensor(url, cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "edit_image"))


# =============================================================================
# Use case: Develop a sketch — one-tap "make this rough real" (the sketch
# pile's Develop action). Exactly EditImageNode's Nano Banana 2 path with the
# polish instruction baked in; the only dial the card shows is resolution.
# =============================================================================

_DEVELOP_PROMPT = (
    "Turn this rough into a polished, finished, highly detailed image — "
    "keep the same composition and subject."
)


class DevelopImageNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="DevelopImageNode",
            display_name="Develop",
            category="api node/image/Replicate",
            description=(
                "Develop a rough or sketch into a finished, detailed image — "
                "keeps the composition and subject, upgrades the rendering "
                "(Nano Banana 2). ~$0.05 per image."
            ),
            inputs=[
                IO.Image.Input("input_image", tooltip="The rough/sketch to develop."),
                IO.Combo.Input("resolution", options=["1K", "2K", "4K"], default="1K",
                               tooltip="Output resolution — higher costs more."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, advanced=True,
                             tooltip="0 = random."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.05,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, input_image, resolution, seed):
        url = await _run_nano_banana_edit(
            [_image_tensor_to_data_url(input_image)], _DEVELOP_PROMPT,
            replicate_slug="google/nano-banana-2",
            resolution=resolution, output_format="png", seed=seed,
        )
        tensor = await download_url_to_image_tensor(url, cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "edit_image"))


# =============================================================================
# Use case: Generate from references — compose a new image from up to 6
# reference images + a prompt. Backed by the image_edit_models dispatcher
# (REFERENCE_MODEL_IDS), so adding a multi-reference model is one catalog entry.
# =============================================================================

_REFERENCE_ASPECT_RATIOS = [
    "match_input_image", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9",
]


class GenerateFromReferencesNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="GenerateFromReferencesNode",
            display_name="Generate from references",
            category="api node/image/Replicate",
            description=(
                "Compose a new image from up to 6 reference images plus a prompt. "
                "Seedream 5 Pro/Lite (design-aware reasoning, up to 10 refs) or "
                "Nano Banana 2. Wire references into image_1…image_6. "
                "~$0.04–0.09 per image."
            ),
            inputs=[
                IO.Combo.Input("model", options=_REFERENCE_MODEL_IDS,
                               default=_DEFAULT_REFERENCE_MODEL_ID),
                IO.Image.Input("image_1", tooltip="Primary reference image (required)."),
                IO.Image.Input("image_2", optional=True, tooltip="Reference image 2."),
                IO.Image.Input("image_3", optional=True, tooltip="Reference image 3."),
                IO.Image.Input("image_4", optional=True, tooltip="Reference image 4."),
                IO.Image.Input("image_5", optional=True, tooltip="Reference image 5."),
                IO.Image.Input("image_6", optional=True, tooltip="Reference image 6."),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="What to generate from the references."),
                IO.Combo.Input("aspect_ratio", options=_REFERENCE_ASPECT_RATIOS,
                               default="match_input_image",
                               tooltip="Output aspect ratio. 'match_input_image' follows the first reference."),
                IO.Combo.Input("size", options=["1K", "2K", "3K"], default="2K", advanced=True,
                               tooltip="Output resolution. Each model clamps to what it supports "
                                       "(Pro 1K/2K · Lite 2K/3K · Nano Banana 1K/2K/4K)."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             control_after_generate=True, tooltip="0 = random."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.06,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, image_1, image_2=None, image_3=None, image_4=None,
                      image_5=None, image_6=None, prompt="", aspect_ratio="match_input_image",
                      size="2K", seed=0):
        refs = [t for t in (image_1, image_2, image_3, image_4, image_5, image_6) if t is not None]
        image_urls = [_image_tensor_to_data_url(t) for t in refs]

        spec = _IMAGE_EDIT_MODELS_BY_ID[model]
        adv = {"size": size, "aspect_ratio": aspect_ratio}
        input_dict = spec.build_input(prompt, image_urls, int(seed or 0), adv)
        # Nano Banana routes fal-first (Replicate's Gemini 404); Seedream stays on
        # Replicate. build_input already clamped size→resolution. See
        # _run_image_edit_prediction.
        url = await _run_image_edit_prediction(spec.replicate_slug, input_dict)
        tensor = await download_url_to_image_tensor(url, cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "generate_from_references"))


# =============================================================================
# Use case: Blend Scene — harmonize a composite into one cohesive photo
# =============================================================================

_BLEND_SCENE_MODELS = ["Flux Kontext Pro", "Flux 2 Pro", "Nano Banana"]

# The instruction is assembled from the always-on base sentence plus one clause
# per enabled toggle. A user-supplied `prompt` (advanced) overrides the whole thing.
_BLEND_SCENE_BASE = "Blend all elements into a single cohesive, photorealistic image."
_BLEND_CLAUSE_LIGHTING = (
    "Unify the lighting direction, color temperature and ambient tone across the whole scene."
)
_BLEND_CLAUSE_SHADOWS = "Add soft, realistic contact shadows where objects meet surfaces."
_BLEND_CLAUSE_CAMERA = "Match film grain and depth of field."
_BLEND_CLAUSE_IDENTITY = (
    "Keep each element's shape, position, proportions and identity unchanged. "
    "Do not move, rotate, rescale or reflow any element."
)


def _build_blend_instruction(unify_lighting, contact_shadows, match_camera_look,
                             preserve_identity):
    parts = [_BLEND_SCENE_BASE]
    if unify_lighting:
        parts.append(_BLEND_CLAUSE_LIGHTING)
    if contact_shadows:
        parts.append(_BLEND_CLAUSE_SHADOWS)
    if match_camera_look:
        parts.append(_BLEND_CLAUSE_CAMERA)
    if preserve_identity:
        parts.append(_BLEND_CLAUSE_IDENTITY)
    return " ".join(parts)


class BlendSceneNode(IO.ComfyNode):
    """Take a flat composite of separate elements (e.g. a generated background with
    a transparent product + prop dropped onto a Frame) and re-render it as one
    cohesive photo — matched lighting/color and real contact shadows.

    Optional `keep_subject` mask preserves a region (e.g. the product) pixel-exact:
    the harmonized scene is used everywhere except that region, where the original
    pixels are composited back so a logo/label is never reinterpreted.
    """

    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="BlendSceneNode",
            display_name="Blend Scene",
            category="api node/image/Replicate",
            description=(
                "Harmonize a composite (background + cutout elements) into one "
                "cohesive photo — unified lighting/color and realistic contact "
                "shadows. Flux Kontext (faithful), Flux 2 Pro (newest, sharper) "
                "or Nano Banana (more dramatic). ~$0.04 per blend."
            ),
            inputs=[
                IO.Combo.Input("model", options=_BLEND_SCENE_MODELS, default="Flux Kontext Pro"),
                IO.Image.Input("image", tooltip="The flattened composite to blend (e.g. a Frame's output)."),
                IO.Boolean.Input("unify_lighting", default=True,
                                 tooltip="Match lighting direction, color temperature and ambient tone across the whole scene."),
                IO.Boolean.Input("contact_shadows", default=True,
                                 tooltip="Add soft, realistic contact shadows where elements meet surfaces."),
                IO.Boolean.Input("match_camera_look", default=True,
                                 tooltip="Match film grain and depth of field across the elements."),
                IO.Boolean.Input("preserve_identity", default=True,
                                 tooltip="Keep each element's shape, position, proportions and identity unchanged — don't move or resize anything."),
                IO.Mask.Input("keep_subject", optional=True,
                              tooltip="Optional: a mask of a region to keep pixel-exact (e.g. the product). "
                                      "The harmonized scene fills everywhere else."),
                IO.Float.Input("keep_feather", default=2.0, min=0.0, max=30.0, step=0.5, advanced=True,
                               tooltip="Soften the edge where the kept region meets the blended scene."),
                IO.String.Input("prompt", multiline=True, default="", optional=True, advanced=True,
                                tooltip="Advanced: fully custom blend instruction. Leave empty to use the checkboxes above."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, advanced=True, tooltip="0 = random."),
                IO.Combo.Input("output_format", options=["png", "jpg"], default="png", advanced=True),
            ],
            outputs=[IO.Image.Output()],
            hidden=[IO.Hidden.unique_id],
            is_output_node=True,
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.04,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, image, unify_lighting=True, contact_shadows=True,
                      match_camera_look=True, preserve_identity=True, keep_subject=None,
                      keep_feather=2.0, prompt="", seed=0, output_format="png"):
        import torch.nn.functional as F

        # A custom prompt (advanced) wins; otherwise assemble from the toggles.
        instruction = (prompt or "").strip() or _build_blend_instruction(
            unify_lighting, contact_shadows, match_camera_look, preserve_identity)
        data_url = _image_tensor_to_data_url(image)

        # Each model takes a different schema. Nano Banana stays on Replicate;
        # Flux Kontext and Flux 2 Pro go to fal (~2× cheaper than Replicate).
        if model == "Nano Banana":
            input_dict = {"prompt": instruction, "image_input": [data_url]}
            pred = await _run_prediction("google/nano-banana", input_dict)
            url = _first_output_url(pred)
        elif model == "Flux 2 Pro":
            url = await _run_fal_flux2_edit(
                [data_url], instruction, output_format=output_format, seed=seed,
            )
        else:  # Flux Kontext Pro
            url = await _run_fal_kontext(
                data_url, instruction, output_format=output_format, seed=seed,
            )

        edited = await download_url_to_image_tensor(url, cls=cls)

        # Optional subject-preserve: composite the original masked region back over
        # the harmonized result so e.g. a product label is never reinterpreted.
        if keep_subject is not None:
            base = image if image.dim() == 4 else image.unsqueeze(0)
            ed = edited if edited.dim() == 4 else edited.unsqueeze(0)
            _B, H, W, _C = base.shape
            # Match the harmonized image back to the original size.
            if ed.shape[1:3] != (H, W):
                ed = F.interpolate(ed.permute(0, 3, 1, 2), size=(H, W), mode="bilinear",
                                   align_corners=False).permute(0, 2, 3, 1)
            m = keep_subject
            if m.dim() == 2:
                m = m.unsqueeze(0)
            if m.dim() == 4 and m.shape[1] == 1:
                m = m.squeeze(1)
            if m.shape[1:3] != (H, W):
                m = F.interpolate(m.unsqueeze(1), size=(H, W), mode="bilinear",
                                  align_corners=False).squeeze(1)
            if keep_feather > 0:
                from torchvision.transforms.functional import gaussian_blur
                ksize = 2 * int(round(3.0 * keep_feather)) + 1
                m = gaussian_blur(m.unsqueeze(1), kernel_size=ksize, sigma=float(keep_feather)).squeeze(1)
            m = m.clamp(0.0, 1.0).unsqueeze(-1)  # [B,H,W,1]
            edited = (base[..., :3] * m + ed[..., :3] * (1.0 - m)).clamp(0.0, 1.0)

        return IO.NodeOutput(
            edited,
            ui=save_generation_output(edited, "blend_scene"),
        )


# =============================================================================
# Use case: Restyle an image using the style of another image
# =============================================================================

# Nano Banana family + the IP-Adapter engine. All three Nano Banana models
# share the same `prompt` + `image_input` interface on Replicate (verified
# against the live schema); the newer two additionally accept `resolution`.
_RESTYLE_MODELS = [
    "Nano Banana 2",            # google/nano-banana-2  (Gemini 3.1 Flash Image)
    "Nano Banana Pro",          # google/nano-banana-pro (Gemini 3 Pro Image)
    "Nano Banana",              # google/nano-banana    (Gemini 2.5 Flash Image, original)
    "Style Transfer · IP-Adapter",
]

# Display name → Replicate slug. The "Nano Banana *" entries all speak the same
# input dialect, so they fall through one shared request-builder below.
_NANO_BANANA_SLUGS = {
    "Nano Banana": "google/nano-banana",
    "Nano Banana 2": "google/nano-banana-2",
    "Nano Banana Pro": "google/nano-banana-pro",
}

class RestyleFromImageNode(IO.ComfyNode):
    """Apply the *style* of one image (the reference) onto another (the content).

    Two engines, picked per-run:
      • Nano Banana — multi-image edit. Most flexible / creative, but may
        reinterpret the content while matching the reference's style.
      • Style Transfer · IP-Adapter (fofr/style-transfer) — copies the
        reference's style while keeping the content image's structure intact
        (depth ControlNet + IP-Adapter). Best when composition must not change.
    """

    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="RestyleFromImageNode",
            display_name="Restyle from Image",
            category="api node/image/Replicate",
            description=(
                "Apply the style of one image onto another. Nano Banana 2 / Pro "
                "(creative, Gemini-powered) or IP-Adapter Style Transfer (keeps "
                "the content's structure). Cost varies by model/resolution: "
                "~$0.05 (NB2 @ 1K) up to ~$0.24 (Pro @ 4K)."
            ),
            inputs=[
                IO.Combo.Input("model", options=_RESTYLE_MODELS, default="Nano Banana 2"),
                IO.Image.Input("content_image",
                               tooltip="The image to restyle — its subject/composition is kept."),
                IO.Image.Input("style_image", optional=True,
                               tooltip="The reference image whose look/style is copied onto the content. "
                                       "Ignored when a moodboard is wired into style_in."),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Optional extra guidance (e.g. 'watercolor', 'cyberpunk neon'). "
                                        "Leave blank to let the style image speak for itself."),
                IO.Float.Input("structure_strength", default=0.65, min=0.0, max=1.0, step=0.05,
                               tooltip="How much of the content's original structure to preserve. "
                                       "Higher = closer to the original. IP-Adapter uses this directly; "
                                       "Nano Banana folds it into the instruction (high = lock the subject, "
                                       "low = free reinterpretation)."),
                IO.Combo.Input("resolution", options=["1K", "2K", "4K"], default="1K",
                               tooltip="Output resolution for Nano Banana 2 / Pro — higher costs more. "
                                       "Ignored by the original Nano Banana and IP-Adapter."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, advanced=True, tooltip="0 = random."),
                IO.Combo.Input("output_format", options=["png", "jpg"], default="png", advanced=True),
                # ── Moodboard style source (2026-08-09) ──────────────────────
                # Reference-image payload written by the frontend at submit time
                # (properties.style_refs → this hidden widget, by NAME). A
                # moodboard here OVERRIDES the single style_image.
                IO.String.Input(
                    "style_refs",
                    default="",
                    multiline=False,
                    optional=True,
                    extra_dict={"sailor_widget": "internal"},
                    tooltip="Moodboard reference-image payload (JSON) — the board's ≤3 images.",
                ),
                # Taste wire: the Moodboard node's compiled style block flows in
                # here and folds into the restyle instruction as extra direction.
                _TASTE.Input(
                    "style_in",
                    optional=True,
                    tooltip="Taste wire: a Moodboard node's compiled style block.",
                ),
            ],
            outputs=[IO.Image.Output()],
            hidden=[IO.Hidden.unique_id],
            is_output_node=True,
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.05,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, content_image, style_image=None, prompt="",
                      structure_strength=0.65, resolution="1K", seed=0,
                      output_format="png", style_in="", style_refs=""):
        content_url = _image_tensor_to_data_url(content_image)
        guidance = (prompt or "").strip()
        taste = (style_in or "").strip()

        # Moodboard style source (2026-08-09): a validated style_refs payload
        # overrides the single style_image. Up to 3 board images become the
        # style references and the taste block (the TASTE wire) rides along as
        # extra style direction.
        parsed_refs = _parse_style_refs(style_refs)
        board_urls = _moodboard_ref_data_urls(*parsed_refs) if parsed_refs else []

        # A restyle needs SOME style source. With no board, no style image and
        # no taste block there is nothing to restyle toward — fail loudly rather
        # than crash in the tensor encoder.
        if not board_urls and style_image is None and not taste:
            raise RuntimeError(
                "Restyle needs a style image or a wired moodboard — neither was provided."
            )

        extra_direction = f"{guidance} {taste}".strip() if taste else guidance

        if model in _NANO_BANANA_SLUGS:
            if board_urls:
                # Content first, then the board images as STYLE-only refs.
                instruction = (
                    f"{build_restyle_instruction(structure_strength, extra_direction)} "
                    f"{_STYLE_REFS_INSTRUCTION}"
                ).strip()
                image_input = [content_url, *board_urls]
            elif style_image is not None:
                # Original single-style-image path.
                instruction = build_restyle_instruction(structure_strength, extra_direction)
                image_input = [content_url, _image_tensor_to_data_url(style_image)]
            else:
                # Board wired but its images are gone (or never readable) and the
                # frontend dropped style_image on apply. The taste block — the
                # only style source left, guaranteed non-empty by the guard above
                # — carries the restyle with no reference image.
                instruction = build_restyle_instruction(structure_strength, extra_direction)
                image_input = [content_url]
            input_dict = {
                "prompt": instruction,
                "image_input": image_input,
                "output_format": output_format,
            }
            # Only the newer models accept a resolution dial; passing it to the
            # original google/nano-banana would 422.
            if model != "Nano Banana":
                input_dict["resolution"] = resolution
            slug = _NANO_BANANA_SLUGS[model]
        else:  # Style Transfer · IP-Adapter — single style image only
            # IP-Adapter's style_image can't be fed by a taste block, so with no
            # board image and no style image there's nothing to transfer from —
            # a taste-only restyle is impossible on this engine.
            if not board_urls and style_image is None:
                raise RuntimeError(
                    "Style Transfer needs a style image or a moodboard image — "
                    "a taste block alone can't feed IP-Adapter."
                )
            # IP-Adapter cannot take multiple references, so a moodboard
            # degrades to its FIRST image; the taste block folds into the prompt.
            style_url = board_urls[0] if board_urls else _image_tensor_to_data_url(style_image)
            base_prompt = guidance or "a high quality image"
            input_dict = {
                "prompt": f"{base_prompt} {taste}".strip() if taste else base_prompt,
                "style_image": style_url,
                "structure_image": content_url,
                "structure_denoising_strength": float(structure_strength),
                "output_format": output_format,
                "number_of_images": 1,
            }
            if seed and seed > 0:
                input_dict["seed"] = seed
            slug = "fofr/style-transfer"

        # Nano Banana 2 / Pro route fal-first (Replicate's Gemini 404); the
        # original google/nano-banana and fofr/style-transfer stay on Replicate.
        # See _run_image_edit_prediction.
        url = await _run_image_edit_prediction(slug, input_dict)
        result = await download_url_to_image_tensor(url, cls=cls)
        return IO.NodeOutput(
            result,
            ui=save_generation_output(result, "restyle"),
        )


# =============================================================================
# Use case: Restyle an Image · Style LoRA — fuse describe → flux-lora → nano-banana
# =============================================================================


class RestyleWithLoRANode(IO.ComfyNode):
    """Restyle a content image with a trained style LoRA, structure-preserving.

    Runs the proven three-step pipeline internally:
      1. Moondream 2 captions the content image.
      2. Flux-Dev-LoRA img2img restyles the content, prompted with the LoRA's
         trigger + aesthetic + the caption — producing a style-reference image.
      3. Nano Banana 2 paints that style back onto the original content image,
         preserving structure.
    The intermediate (step-2) image is used internally and discarded; only the
    final image is output and saved to Assets.
    """

    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="RestyleWithLoRANode",
            display_name="Restyle an Image · Style LoRA",
            category="api node/image/Replicate",
            description=(
                "Restyle an image with a trained style LoRA, keeping its "
                "structure. Captions the image (Moondream), restyles it with "
                "your LoRA (Flux Dev), then transfers that look back with Nano "
                "Banana 2. Works for photo and illustration LoRAs: illustration "
                "results are auto-verified and re-rolled up to 2x if Nano Banana "
                "washes the style back to a photo. ~$0.09/run at 1K; illustration "
                "re-rolls and higher resolutions cost more."
            ),
            inputs=[
                IO.Image.Input("content_image",
                               tooltip="The image to restyle — its subject/composition is kept."),
                IO.Combo.Input(
                    "lora_name",
                    options=folder_paths.get_filename_list("loras") + ["[None]"],
                    default="[None]",
                    tooltip="Your style LoRA (needs a sidecar .json from the cloud trainer).",
                    extra_dict={"sailor_widget": "lora_picker"},
                ),
                IO.Float.Input("style_strength", default=0.5, min=0.0, max=1.0, step=0.05,
                               tooltip="Higher = bolder restyle (looser structure); "
                                       "lower = stays closer to the original."),
                IO.Combo.Input("resolution", options=["1K", "2K", "4K"], default="1K",
                               tooltip="Nano Banana 2 output resolution — higher costs more."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             tooltip="Reproducible: same seed + same settings = same result. "
                                     "Change the seed to get a different variation. Applied to "
                                     "the Flux and Nano Banana stages."),
                IO.String.Input("lora_url", default="", multiline=False, advanced=True,
                                tooltip="Override LoRA source (HF / CivitAI / Replicate ref / "
                                        ".safetensors URL). Wins over lora_name."),
                IO.Float.Input("lora_scale", default=1.0, min=0.0, max=1.5, step=0.05,
                               advanced=True, tooltip="LoRA strength on the Flux stage."),
                IO.Float.Input("flux_prompt_strength", default=0.0, min=0.0, max=1.0, step=0.05,
                               advanced=True,
                               tooltip="Override the Flux img2img strength. 0 = derive from "
                                       "style_strength."),
                IO.Int.Input("flux_steps", default=28, min=4, max=50, advanced=True,
                             tooltip="Flux inference steps."),
                IO.Float.Input("flux_guidance", default=3.5, min=0.0, max=20.0, step=0.1,
                               advanced=True, tooltip="Flux prompt adherence."),
                IO.String.Input("describe_prompt", multiline=True,
                                default=_RESTYLE_DESCRIBE_PROMPT,
                                advanced=True,
                                tooltip="What to ask Moondream about the content image. Keep it "
                                        "SUBJECT-only — photographic/lighting words here drown the "
                                        "LoRA style and the restyle comes back near-photoreal."),
                IO.String.Input("extra_style_direction", multiline=True, default="",
                                advanced=True,
                                tooltip="Extra guidance appended to the Nano Banana instruction "
                                        "(e.g. 'watercolor', 'cyberpunk neon')."),
                IO.Combo.Input("output_format", options=["png", "jpg"], default="png", advanced=True),
            ],
            outputs=[IO.Image.Output()],
            hidden=[IO.Hidden.unique_id],
            is_output_node=True,
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.09,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, content_image, lora_name, style_strength=0.5,
                      resolution="1K", seed=0, lora_url="", lora_scale=1.0,
                      flux_prompt_strength=0.0, flux_steps=28, flux_guidance=3.5,
                      describe_prompt=_RESTYLE_DESCRIBE_PROMPT,
                      extra_style_direction="", output_format="png"):
        content_url = _image_tensor_to_data_url(content_image)
        structure_strength, prompt_strength = restyle_style_strength_to_knobs(
            style_strength, flux_prompt_strength
        )

        # Auto-migrate nodes saved with the OLD generic describe default. It
        # produced long photographic captions ("clear blue sky, looking at the
        # camera") that drown the LoRA style — fatal for strong styles. Existing
        # graphs keep their saved widget value, so upgrade it here. Anyone who
        # deliberately customised the field keeps their text.
        if describe_prompt.strip() == "Describe this image in detail.":
            describe_prompt = _RESTYLE_DESCRIBE_PROMPT

        # --- Stage 1: describe the content image (Moondream 2) ---------------
        try:
            pred = await _run_prediction(
                "lucataco/moondream2",
                {"image": content_url, "prompt": describe_prompt},
            )
            out = pred.get("output")
            if isinstance(out, list):
                caption = "".join(str(x) for x in out).strip()
            else:
                caption = str(out or "").strip()
        except Exception as err:
            raise RuntimeError(f"Restyle stage failed (describe): {err}") from err
        if not caption:
            caption = "a high quality image"

        # --- Stage 2: restyle with the LoRA (Flux-Dev-LoRA img2img) ----------
        sidecar = _read_lora_sidecar(lora_name) or {}
        flux_prompt = build_flux_style_prompt(
            sidecar.get("trigger", ""), sidecar_aesthetic(sidecar), caption
        )
        try:
            plan = resolve_flux_lora_plan(lora_name, lora_url)
            flux_input = {
                "prompt": flux_prompt,
                "image": content_url,
                "prompt_strength": prompt_strength,
                "num_inference_steps": flux_steps,
                "num_outputs": 1,
                "output_format": "png",
                "disable_safety_checker": False,
                # Always pin the seed so identical settings reproduce. Sending an
                # explicit integer (0 included) makes the Flux stage deterministic;
                # the user re-rolls by changing the seed, not by re-running.
                "seed": int(seed),
            }
            if plan["trained_model"]:
                flux_model = plan["trained_model"]
                flux_input["guidance_scale"] = flux_guidance
                flux_input["lora_scale"] = lora_scale
            else:
                flux_model = "black-forest-labs/flux-dev-lora"
                flux_input["guidance"] = flux_guidance
                lora_ref = plan["lora_ref"]
                if lora_ref:
                    lora_ref = await _autodetect_huggingface(lora_ref)
                    flux_input["lora_weights"] = lora_ref
                    flux_input["lora_scale"] = lora_scale
            flux_pred = await _run_prediction(flux_model, flux_input)
            # The intermediate is only a style reference for Nano Banana and is
            # never displayed, so hand its public Replicate URL straight to the
            # next stage — no need to download, strip alpha, and re-encode it.
            style_url = _first_output_url(flux_pred)
        except Exception as err:
            raise RuntimeError(f"Restyle stage failed (stylize): {err}") from err

        # --- Stage 3: transfer the style back onto the content (Nano Banana 2)
        # NB2 keeps identity beautifully but has a photoreal prior: handed an
        # illustration reference it intermittently "re-photographs" the result,
        # the coin-flip that made restyles land only ~half the time. So: classify
        # the Flux reference once; if it's an illustration, verify each NB2 output
        # and re-roll (new seed + a harder anti-photo instruction) until the style
        # holds. Photo targets are trusted on the first try (no extra cost). If
        # every attempt washes out, fall back to the Flux image, which is the
        # guaranteed-style result (at the cost of NB2's identity lock).
        try:
            ref_style = await _classify_image_style(style_url)
            base_instruction = build_restyle_instruction(structure_strength, extra_style_direction)
            best_url = None
            matched = False
            for attempt in range(1 + _RESTYLE_MAX_NB_RETRIES):
                instruction = base_instruction
                if attempt > 0:
                    instruction = base_instruction + RESTYLE_ANTIPHOTO_RETRY
                # Prefer fal for the transfer (its Google access dodges
                # Replicate's project-scoped Gemini 404); falls back to fal Nano
                # Banana Pro, then Replicate. Deterministic per-attempt variation:
                # same base seed always replays the same sequence of re-rolls.
                # Masked to uint32 so a near-max seed can't overflow the range.
                best_url = await _run_nano_banana_edit(
                    [content_url, style_url], instruction,
                    resolution=resolution, output_format=output_format,
                    seed=(int(seed) + attempt) & 0xFFFFFFFF,
                )
                # Photo target → NB2's first answer is what we want. Illustration
                # target → only accept once the output is still illustrated.
                if ref_style != "illustration":
                    matched = True
                    break
                if await _classify_image_style(best_url) == "illustration":
                    matched = True
                    break
            # All illustration attempts washed out → the Flux image is the
            # guaranteed-style safety net.
            final_url = best_url if matched else style_url
            final = await download_url_to_image_tensor(final_url, cls=cls)
            if final.dim() == 4 and final.shape[-1] == 4:
                final = final[..., :3].contiguous()
        except Exception as err:
            raise RuntimeError(f"Restyle stage failed (restyle): {err}") from err

        return IO.NodeOutput(final, ui=save_generation_output(final, "restyle_lora"))


# =============================================================================
# Use case: Product Shot — drop a product photo, get a studio-quality scene
# =============================================================================

# The ad-inpaint model takes a "W, H" string; expose a few friendly presets.
_PRODUCT_SHOT_ASPECTS = {
    "Square": "1024, 1024",
    "Portrait": "832, 1216",
    "Landscape": "1216, 832",
}
_PRODUCT_FILL = ["Original", "80", "70", "60", "50", "40", "30", "20"]

_PRODUCT_SHOT_DEFAULT_PROMPT = (
    "on a clean marble countertop, soft natural window light, minimal studio "
    "setting, professional product photography, shallow depth of field"
)


class ProductShotNode(IO.ComfyNode):
    """Turn a plain product photo into a studio-quality marketing shot.

    Wraps catacolabs/sdxl-ad-inpaint: the product's background is removed and it
    is placed into a generated scene described by `scene_prompt`. With
    `keep_product_exact` on (default), the original product pixels are re-applied
    over the result, so labels/logos are never reinterpreted.
    """

    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="ProductShotNode",
            display_name="Product Shot",
            category="api node/image/Replicate",
            description=(
                "Drop a product photo and describe a scene — get a studio-quality "
                "product shot. The background is removed and the product is placed "
                "into a generated setting, kept pixel-exact. ~$0.04 per shot."
            ),
            inputs=[
                IO.Image.Input("image", tooltip="The product photo. Its background is removed automatically."),
                IO.String.Input("scene_prompt", multiline=True, default=_PRODUCT_SHOT_DEFAULT_PROMPT,
                                tooltip="Describe the setting/background to place the product in."),
                IO.Combo.Input("aspect", options=list(_PRODUCT_SHOT_ASPECTS.keys()), default="Square"),
                IO.Combo.Input("product_size", options=_PRODUCT_FILL, default="Original",
                               tooltip="How much of the frame the product fills. 'Original' keeps its natural "
                                       "size; a number = percent of the image width."),
                IO.Boolean.Input("keep_product_exact", default=True, advanced=True,
                                 tooltip="Re-apply your original product pixels over the result so labels and "
                                         "logos are never altered."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, advanced=True, tooltip="0 = random."),
            ],
            outputs=[IO.Image.Output()],
            hidden=[IO.Hidden.unique_id],
            is_output_node=True,
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.04,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, image, scene_prompt, aspect="Square", product_size="Original",
                      keep_product_exact=True, seed=0):
        input_dict = {
            "image": _image_tensor_to_data_url(image),
            "prompt": (scene_prompt or "").strip() or _PRODUCT_SHOT_DEFAULT_PROMPT,
            "img_size": _PRODUCT_SHOT_ASPECTS.get(aspect, "1024, 1024"),
            "product_fill": product_size,
            "apply_img": bool(keep_product_exact),
        }
        if seed and seed > 0:
            input_dict["seed"] = seed
        pred = await _run_prediction("catacolabs/sdxl-ad-inpaint", input_dict)
        result = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(
            result,
            ui=save_generation_output(result, "product_shot"),
        )


# =============================================================================
# Use case: Rotate the camera around an image's subject
# =============================================================================
#
# Purpose-built generator that asks Qwen-Image-Edit-Plus to re-render the
# subject from a new viewpoint. There's no text prompt input — a 3-axis
# gimbal widget on the canvas writes a {yaw, pitch, roll} JSON blob which
# this node translates into a director-style natural-language phrase
# ("viewed from the right side at eye level") before dispatching.

from comfy_api_nodes.image_edit_models import (
    IMAGE_EDIT_MODELS_BY_ID as _IMAGE_EDIT_MODELS_BY_ID,
    DEFAULT_CAMERA_MODEL_ID as _CAMERA_DEFAULT_MODEL_ID,
    REFERENCE_MODEL_IDS as _REFERENCE_MODEL_IDS,
    DEFAULT_REFERENCE_MODEL_ID as _DEFAULT_REFERENCE_MODEL_ID,
)


# ---- Camera angle → English ------------------------------------------------
#
# Single source of truth for the phrasing. The Vue gimbal mirrors this
# translation client-side so the user sees the same caption that will be
# sent to the model — keep these aligned if the phrasing evolves.

def _yaw_phrase(yaw_deg: float) -> str:
    """Yaw in [-180, 180]: 0 = front, +90 = right, ±180 = directly behind."""
    # Normalize into [-180, 180] then bucket every 45° with a 22.5° tolerance.
    y = ((yaw_deg + 180) % 360) - 180
    abs_y = abs(y)
    if abs_y < 22.5:    return "the front"
    if abs_y > 157.5:   return "directly behind"
    if y > 0:
        if abs_y < 67.5:    return "the front-right"
        if abs_y < 112.5:   return "the right side"
        return "the back-right"
    else:
        if abs_y < 67.5:    return "the front-left"
        if abs_y < 112.5:   return "the left side"
        return "the back-left"


def _pitch_phrase(pitch_deg: float) -> str | None:
    """Pitch in [-90, 90]: 0 = eye level, +up = high angle, -down = low angle.
    Returns None when at eye level so the calling template can skip the clause."""
    p = max(-90.0, min(90.0, pitch_deg))
    if abs(p) < 7.5:
        return None  # eye level — omit
    if p > 0:
        if p < 30:   return "at a slight high angle"
        if p < 60:   return "at a high angle"
        if p < 80:   return "from a very high angle"
        return "nearly top-down"
    else:
        ap = abs(p)
        if ap < 30:   return "at a slight low angle"
        if ap < 60:   return "at a low angle"
        if ap < 80:   return "from a very low angle"
        return "nearly worm's-eye"


def _roll_phrase(roll_deg: float) -> str | None:
    """Roll in [-180, 180]: 0 = level, +cw = clockwise tilt."""
    r = ((roll_deg + 180) % 360) - 180
    ar = abs(r)
    if ar < 5:
        return None  # level — omit
    direction = "clockwise" if r > 0 else "counter-clockwise"
    if ar < 20:    return f"with the camera tilted slightly {direction}"
    if ar < 60:    return f"with a Dutch tilt {direction}"
    return f"with a heavy Dutch tilt {direction}"


def _camera_to_phrase(yaw_deg: float, pitch_deg: float, roll_deg: float) -> str:
    """Compose the director-style camera-position phrase.

    Examples:
      (0, 0, 0)      -> "viewed from the front"
      (90, 0, 0)     -> "viewed from the right side"
      (180, 30, 0)   -> "viewed from directly behind, at a slight high angle"
      (-45, -30, 15) -> "viewed from the front-left, at a low angle, with the
                         camera tilted slightly clockwise"
    """
    parts = [f"viewed from {_yaw_phrase(yaw_deg)}"]
    p = _pitch_phrase(pitch_deg)
    if p:
        parts.append(p)
    r = _roll_phrase(roll_deg)
    if r:
        parts.append(r)
    return ", ".join(parts)


class RotateCameraNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="RotateCameraNode",
            display_name="Rotate camera",
            category="api node/image/Replicate",
            description=(
                "Re-render an image from a new viewpoint via Qwen-Image-Edit-Plus. "
                "Drag the 3-axis gimbal to point the camera; the node translates "
                "the angles into a director's-note prompt and dispatches. No "
                "typing needed — the widget IS the prompt. ~$0.04 per render."
            ),
            inputs=[
                IO.Image.Input("image", tooltip="The source image to re-frame."),
                # Hidden JSON string carrying {"yaw":N,"pitch":N,"roll":N}.
                # Edited via the camera_gimbal widget on the node body.
                # Required (not optional) so ComfyUI auto-instantiates the widget.
                IO.String.Input(
                    "camera",
                    default='{"yaw":0,"pitch":0,"roll":0}',
                    multiline=False,
                    extra_dict={"sailor_widget": "camera_gimbal"},
                    tooltip="3-axis camera orientation. Edited via the gimbal widget.",
                ),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             control_after_generate=True, tooltip="0 = random."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.04,"format":{"approximate":true}}'),
            # Terminal effect (self-saves via save_generation_output) — flag as an
            # output node so ComfyUI doesn't prune it when it feeds a non-output
            # compute node. See RemoveBackgroundNode for the same fix.
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, image, camera, seed):
        # Parse the camera JSON tolerantly — if it's malformed (older workflow,
        # manual edit) treat as the default front-view and continue.
        try:
            cam = json.loads(camera or "{}")
            if not isinstance(cam, dict):
                cam = {}
        except json.JSONDecodeError:
            cam = {}
        yaw   = float(cam.get("yaw", 0) or 0)
        pitch = float(cam.get("pitch", 0) or 0)
        roll  = float(cam.get("roll", 0) or 0)

        # Front view with no rotation = no-op; the model would just regenerate
        # the input. Surface that explicitly so the user understands why.
        phrase = _camera_to_phrase(yaw, pitch, roll)

        spec = _IMAGE_EDIT_MODELS_BY_ID[_CAMERA_DEFAULT_MODEL_ID]
        image_url = _image_tensor_to_data_url(image)
        input_dict = spec.build_input(phrase, [image_url], int(seed or 0), {})
        print(
            f"[RotateCamera] yaw={yaw:.1f} pitch={pitch:.1f} roll={roll:.1f} "
            f"phrase={phrase!r} slug={spec.replicate_slug!r}",
            flush=True,
        )
        url = await _run_image_edit_prediction(spec.replicate_slug, input_dict)
        tensor = await download_url_to_image_tensor(url, cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "rotate_camera"))


# =============================================================================
# Use case: Typographic text effect
# =============================================================================
#
# Type a word, pick a visual treatment (liquid chrome, holographic, brutalist
# concrete, …) from the effect gallery, and Ideogram renders the word in that
# style. The gallery widget live-previews the user's actual word in each
# effect via CSS, so picking is visual.

from comfy_api_nodes.text_effects import (
    EFFECTS as _TEXT_EFFECTS,
    DEFAULT_EFFECT_ID as _TEXT_DEFAULT_EFFECT_ID,
    MATCH_INPUT_AR as _MATCH_INPUT_AR,
    build_text_effect_request as _build_text_effect_request,
)

_TEXT_EFFECT_IDS = [e.id for e in _TEXT_EFFECTS]
_TEXT_EFFECT_AR = [_MATCH_INPUT_AR, "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "16:10", "10:16"]


class TextEffectNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="TextEffectNode",
            display_name="Text effect",
            category="api node/image/Replicate",
            description=(
                "Render a word as typographic art. Type your text, click the "
                "effect button to pick a treatment (liquid chrome, holographic, "
                "brutalist concrete, molten metal, …) — the gallery previews "
                "your actual word in each style. Wire a Font Playground (or any "
                "image) into the image input to restyle its exact letterforms "
                "instead of generating from text. ~$0.04 per render."
            ),
            inputs=[
                IO.String.Input("text", multiline=False, default="",
                                tooltip="The word or short phrase to render."),
                IO.Combo.Input(
                    "effect",
                    options=_TEXT_EFFECT_IDS,
                    default=_TEXT_DEFAULT_EFFECT_ID,
                    tooltip="Click to choose a treatment from the effect gallery.",
                    extra_dict={"sailor_widget": "text_effect_picker"},
                ),
                IO.Combo.Input("aspect_ratio", options=_TEXT_EFFECT_AR, default="1:1",
                               tooltip="Output ratio — 16:9 for wordmarks, 1:1 for icons. "
                                       "'Match input' keeps the source crop in restyle mode."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             control_after_generate=True, tooltip="0 = random."),
                IO.Float.Input(
                    "freedom", default=0.0, min=0.0, max=1.0, step=0.05,
                    tooltip="Restyle mode only. How far dispersion effects (Ink in "
                            "Water, Smoke, Light Trails) may break the letters apart: "
                            "0 = keep the exact letterforms, 1 = let them dissolve "
                            "into the medium. The gallery sets a good default per "
                            "effect; material effects ignore this.",
                ),
                IO.Image.Input(
                    "image", optional=True,
                    tooltip="Connect a Font Playground (or any image) to restyle "
                            "its exact letterforms instead of generating from text. "
                            "The chosen aspect ratio still applies — pick 'Match "
                            "input' to keep the source crop.",
                ),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.04,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, text, effect, aspect_ratio, seed, freedom=0.0, image=None):
        # Dispatch (which model + inputs) is pure logic in text_effects.py so it
        # unit-tests offline; the node just does the I/O around it.
        image_data_url = _image_tensor_to_data_url(image) if image is not None else None
        try:
            slug, input_dict = _build_text_effect_request(
                effect, text, aspect_ratio, seed, image_data_url=image_data_url,
                freedom=freedom,
            )
        except ValueError as e:
            # Surface the generate-mode "enter text" guard as a runtime error.
            raise RuntimeError(str(e))
        mode = "restyle" if image_data_url is not None else "generate"
        print(
            f"[TextEffect] mode={mode} effect={effect!r} text={text!r} "
            f"freedom={freedom!r} slug={slug!r} prompt={input_dict.get('prompt')!r}",
            flush=True,
        )
        pred = await _run_prediction(slug, input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "text_effect"))


# =============================================================================
# Use case: Generate a video
# =============================================================================

# Video catalog dispatcher — mirrors the image-gen pattern. The node exposes
# the shared inputs (model, prompt, image?, aspect_ratio, duration, seed)
# plus a hidden `model_options` JSON blob that the video gallery writes for
# the active model. Per-model dispatch + input shaping lives in video_models.py.
from comfy_api_nodes.video_models import (
    MODELS as _VIDEO_MODELS,
    VIDEO_MODELS_BY_ID as _VIDEO_MODELS_BY_ID,
    ALL_VIDEO_ASPECT_RATIOS as _VIDEO_GEN_ASPECT_RATIOS,
    ALL_VIDEO_DURATIONS as _VIDEO_GEN_DURATIONS,
    DEFAULT_VIDEO_MODEL_ID as _VIDEO_DEFAULT_MODEL_ID,
    parse_view_ref as _parse_view_ref,
)
from comfy_api_nodes import fal_refs


# Shot Director references arrive in model_options as small local
# '/view?filename=X&type=input' URLs (uploaded via /upload/image) instead of
# multi-MB data URLs — see frontend/app/lib/shotdirector/refUpload.ts. Replicate
# can't fetch 127.0.0.1, so resolve them to data URLs here, at execute time.
# data:/https: refs pass through untouched.
_LOCAL_REF_LIST_KEYS = (
    "reference_images", "reference_videos", "reference_audios",  # Replicate
    "image_urls", "video_urls", "audio_urls",                    # fal
)
_LOCAL_REF_STR_KEYS = (
    "image", "last_frame_image",   # Replicate
    "image_url", "end_image_url",  # fal
)


def _local_ref_to_data_url(filename: str) -> str:
    path = os.path.join(folder_paths.get_input_directory(), filename)
    if not os.path.isfile(path):
        raise RuntimeError(
            f"Reference file {filename!r} is missing from the input folder — "
            "re-add the reference in the Shot Director."
        )
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _resolve_local_refs(advanced: dict) -> dict:
    def resolve(src):
        name = _parse_view_ref(src)
        return _local_ref_to_data_url(name) if name else src

    out = dict(advanced)
    for key in _LOCAL_REF_LIST_KEYS:
        vals = out.get(key)
        if isinstance(vals, list):
            out[key] = [resolve(s) for s in vals]
    for key in _LOCAL_REF_STR_KEYS:
        val = out.get(key)
        if isinstance(val, str) and val:
            out[key] = resolve(val)
    return out


def _fal_fn_for_input(input_dict: dict, fn_by_mode: dict) -> str:
    """Pick the fal Seedance function from the built payload: a first-frame
    image_url => image-to-video; any *_urls reference arrays => reference-to-video;
    otherwise text-to-video."""
    if input_dict.get("image_url"):
        return fn_by_mode["firstLast"]
    if any(input_dict.get(k) for k in ("image_urls", "video_urls", "audio_urls")):
        return fn_by_mode["reference"]
    return fn_by_mode["t2v"]


async def _dispatch_video_prediction(spec, input_dict, *, cls, log_prefix, model):
    """Run a built video-model input through its provider (fal or Replicate)
    and return a downloaded video output. Shared by FilmShotNode and
    GenerateVideoNode so both honor spec.provider."""
    if spec.provider == "fal":
        fn = _fal_fn_for_input(input_dict, spec.fal_fn_by_mode or {})
        print(
            f"[{log_prefix}] provider=fal app={spec.fal_app!r} fn={fn!r} "
            f"model={model!r} input_keys={list(input_dict)}",
            flush=True,
        )
        pred = await fal_refs.run_fal_prediction(
            spec.fal_app, fn, input_dict, poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC,
        )
        url = fal_refs.first_fal_video_url(pred)
    else:
        pred = await _run_prediction(
            spec.replicate_slug, input_dict, poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC,
        )
        url = _first_output_url(pred)
    return await download_url_to_video_output(url, cls=cls)

# Combo serializes the model `id` (e.g. "veo-3.1") so we can rename labels
# without breaking saved workflows.
_VIDEO_GEN_MODEL_IDS = [m.id for m in _VIDEO_MODELS]
# Duration combo values are strings (LiteGraph combos serialize as strings);
# the dispatcher casts back to int when calling the per-model builder.
_VIDEO_GEN_DURATION_OPTS = [str(d) for d in _VIDEO_GEN_DURATIONS]


class GenerateVideoNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="GenerateVideoNode",
            display_name="Generate a video",
            category="api node/video/Replicate",
            description=(
                "Single entry point for text/image-to-video. Click the model "
                "button to open the gallery — pick from 15 models (Veo 3.1, "
                "Sora 2, Runway Gen-4.5, Kling, Seedance, Wan, Luma, …) and "
                "tune per-model settings without leaving the canvas."
            ),
            inputs=[
                IO.Combo.Input(
                    "model",
                    options=_VIDEO_GEN_MODEL_IDS,
                    default=_VIDEO_DEFAULT_MODEL_ID,
                    tooltip="Click to choose a model from the video gallery.",
                    extra_dict={"sailor_widget": "video_model_picker"},
                ),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Describe the shot. Include camera moves, mood, lighting."),
                IO.Image.Input("image", optional=True,
                               tooltip="Optional first frame — turns this into image-to-video. "
                                       "Models tagged T2V-only ignore it. Required for "
                                       "lip-sync models (Fabric)."),
                IO.Audio.Input("audio", optional=True,
                               tooltip="Optional audio clip. Required for lip-sync models "
                                       "(Fabric). Other models ignore it."),
                IO.Combo.Input("aspect_ratio", options=_VIDEO_GEN_ASPECT_RATIOS, default="16:9",
                               tooltip="The active model auto-falls-back to its nearest "
                                       "supported ratio if it doesn't accept this one."),
                IO.Combo.Input("duration", options=_VIDEO_GEN_DURATION_OPTS, default="5",
                               tooltip="Seconds. Remapped to the model's nearest supported value.",
                               control_after_generate=False),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             control_after_generate=True, tooltip="0 = random."),
                # JSON bag of per-model advanced settings written by the gallery.
                # Required (not optional) for the same reason as GenerateImageNode:
                # ComfyUI only auto-instantiates widgets for required inputs.
                IO.String.Input(
                    "model_options",
                    default="{}",
                    multiline=False,
                    extra_dict={"sailor_widget": "internal"},
                    tooltip="JSON bag of per-model advanced settings — edited via the gallery modal.",
                ),
            ],
            outputs=[IO.Video.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.40,"format":{"approximate":true}}'),
        )

    # Legacy label → new id map. Earlier versions of this node hardcoded
    # 3 model labels; this lets workflows saved against that schema keep
    # running after the refactor without manual re-picking.
    _LEGACY_MODEL_REMAP = {
        "Seedance 2.0": "seedance-2.0",
        "Veo 3":        "veo-3.1",        # Veo 3 retired upstream; 3.1 is the closest fit.
        "Kling 2.1":    "kling-v2.5-turbo-pro",
    }

    @classmethod
    async def execute(cls, model, prompt, aspect_ratio, duration, seed,
                      model_options="{}", image=None, audio=None):
        # Backwards-compat: remap pre-dispatcher labels to their current ids.
        if model in cls._LEGACY_MODEL_REMAP:
            print(
                f"[GenerateVideo] migrating legacy model label {model!r} → "
                f"{cls._LEGACY_MODEL_REMAP[model]!r}. Re-save the workflow to "
                f"silence this notice.",
                flush=True,
            )
            model = cls._LEGACY_MODEL_REMAP[model]

        spec = _VIDEO_MODELS_BY_ID.get(model)
        if spec is None:
            raise RuntimeError(
                f"Unknown video model id: {model!r}. "
                f"Known: {list(_VIDEO_MODELS_BY_ID)}"
            )

        # Mode check: an I2V-only model requires an input image.
        if "t2v" not in spec.modes and image is None:
            raise RuntimeError(
                f"Model {spec.label!r} requires an input image (image-to-video only). "
                f"Connect an Image to the optional `image` input."
            )

        try:
            advanced = json.loads(model_options or "{}")
            if not isinstance(advanced, dict):
                advanced = {}
        except json.JSONDecodeError:
            advanced = {}

        try:
            dur_int = int(duration)
        except (TypeError, ValueError):
            dur_int = spec.default_duration

        image_data_url = _image_tensor_to_data_url(image) if image is not None else None
        # 60s cap matches Fabric's max output length and keeps other models
        # from being fed accidentally-massive uploads.
        audio_data_url = _audio_dict_to_wav_data_url(audio, max_seconds=60) if audio is not None else None
        input_dict = spec.build_input(prompt, aspect_ratio, dur_int, int(seed or 0),
                                      image_data_url, audio_data_url, advanced)
        print(
            f"[GenerateVideo] model={model!r} slug={spec.replicate_slug!r} "
            f"input_keys={list(input_dict)} advanced={advanced}",
            flush=True,
        )
        video = await _dispatch_video_prediction(
            spec, input_dict, cls=cls, log_prefix="GenerateVideo", model=model,
        )
        return IO.NodeOutput(video)


# =============================================================================
# Use case: Film a shot — cinematic framing presets over the video registry
# =============================================================================
#
# 28 named shot presets (slow push-in, dolly zoom, overhead god shot, …), each
# a full recipe across five dimensions: size, angle, movement, lens,
# composition. The recipe compiles into model-appropriate prompt language
# (per-model dialects: Veo gets lens-forward vocabulary, Hailuo gets Director
# bracket commands) and dispatches through the same video-model registry as
# GenerateVideoNode. Design: docs/plans/2026-06-10-film-a-shot-node-design.md

from comfy_api_nodes.shot_presets import (
    AUTO as _SHOT_AUTO,
    ANGLE_OPTIONS as _SHOT_ANGLE_OPTIONS,
    COMPOSITION_OPTIONS as _SHOT_COMPOSITION_OPTIONS,
    DEFAULT_PRESET_ID as _SHOT_DEFAULT_PRESET_ID,
    LENS_OPTIONS as _SHOT_LENS_OPTIONS,
    MOVEMENT_OPTIONS as _SHOT_MOVEMENT_OPTIONS,
    PRESET_IDS as _SHOT_PRESET_IDS,
    SIZE_OPTIONS as _SHOT_SIZE_OPTIONS,
    build_shot_phrase as _build_shot_phrase,
    dialect_for_model as _shot_dialect_for_model,
    resolve_recipe as _resolve_shot_recipe,
)

_FILM_SHOT_DEFAULT_MODEL_ID = "kling-v2.5-turbo-pro"


class FilmShotNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="FilmShotNode",
            display_name="Film a shot",
            category="api node/video/Replicate",
            description=(
                "Direct a video like a cinematographer: pick a shot preset "
                "(slow push-in, dolly zoom, overhead god shot, …) and describe "
                "the subject — the node writes the camera language for you. "
                "28 presets across movement, angle, lens and composition; "
                "per-dimension overrides under ADVANCED."
            ),
            inputs=[
                IO.Combo.Input(
                    "preset",
                    options=_SHOT_PRESET_IDS,
                    default=_SHOT_DEFAULT_PRESET_ID,
                    tooltip="Click to choose a shot from the preset gallery.",
                    extra_dict={"sailor_widget": "shot_preset_picker"},
                ),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="The subject of the shot — who/what and where. "
                                        "The preset supplies the cinematography."),
                IO.Image.Input("image", optional=True,
                               tooltip="Optional first frame — turns this into "
                                       "image-to-video."),
                IO.Combo.Input(
                    "model",
                    options=_VIDEO_GEN_MODEL_IDS,
                    default=_FILM_SHOT_DEFAULT_MODEL_ID,
                    tooltip="Video model. Kling v2.5 Turbo Pro recommended for "
                            "camera-language adherence.",
                    extra_dict={"sailor_widget": "video_model_picker"},
                ),
                IO.Combo.Input("aspect_ratio", options=_VIDEO_GEN_ASPECT_RATIOS, default="16:9",
                               tooltip="Auto-falls back to the model's nearest supported ratio."),
                IO.Combo.Input("duration", options=_VIDEO_GEN_DURATION_OPTS, default="5",
                               tooltip="Seconds. Remapped to the model's nearest supported value.",
                               control_after_generate=False),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             control_after_generate=True, tooltip="0 = random."),
                IO.String.Input(
                    "model_options",
                    default="{}",
                    multiline=False,
                    extra_dict={"sailor_widget": "internal"},
                    tooltip="JSON bag of per-model advanced settings — edited via the gallery modal.",
                ),
                # ADVANCED per-dimension overrides. Option strings ARE the
                # substitution phrases (see shot_presets.py); AUTO keeps the preset.
                IO.Combo.Input("shot_size", options=_SHOT_SIZE_OPTIONS, default=_SHOT_AUTO,
                               advanced=True, tooltip="Override the preset's shot size."),
                IO.Combo.Input("camera_angle", options=_SHOT_ANGLE_OPTIONS, default=_SHOT_AUTO,
                               advanced=True, tooltip="Override the preset's camera angle."),
                IO.Combo.Input("camera_movement", options=_SHOT_MOVEMENT_OPTIONS, default=_SHOT_AUTO,
                               advanced=True, tooltip="Override the preset's camera movement."),
                IO.Combo.Input("lens_look", options=_SHOT_LENS_OPTIONS, default=_SHOT_AUTO,
                               advanced=True, tooltip="Override the preset's lens & depth of field."),
                IO.Combo.Input("composition", options=_SHOT_COMPOSITION_OPTIONS, default=_SHOT_AUTO,
                               advanced=True, tooltip="Override the preset's composition."),
            ],
            outputs=[IO.Video.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.40,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, preset, prompt, model, aspect_ratio, duration, seed,
                      model_options="{}", image=None,
                      shot_size=_SHOT_AUTO, camera_angle=_SHOT_AUTO,
                      camera_movement=_SHOT_AUTO, lens_look=_SHOT_AUTO,
                      composition=_SHOT_AUTO):
        spec = _VIDEO_MODELS_BY_ID.get(model)
        if spec is None:
            raise RuntimeError(
                f"Unknown video model id: {model!r}. Known: {list(_VIDEO_MODELS_BY_ID)}"
            )

        # Fabric is a lip-sync model that always requires audio; it cannot
        # produce a cinematography shot. Fail early with a meaningful message
        # instead of letting its build_input demand an audio clip.
        if model == "fabric-1.0":
            raise RuntimeError(
                "VEED Fabric 1.0 is a lip-sync model and can't be used with "
                "'Film a shot'. Pick a camera-language model (Kling, Seedance, Veo, …)."
            )

        if "t2v" not in spec.modes and image is None:
            raise RuntimeError(
                f"Model {spec.label!r} requires an input image (image-to-video only). "
                f"Connect an Image to the optional `image` input."
            )

        try:
            advanced = json.loads(model_options or "{}")
            if not isinstance(advanced, dict):
                advanced = {}
        except json.JSONDecodeError:
            advanced = {}

        # Shot Director drives this node with its own fully-compiled prompt
        # (subject/action/scene + explicit camera language already baked
        # in). FilmShotNode's default behaviour of prepending a shot-preset
        # phrase (e.g. "push-in") would silently contradict that compiled
        # prompt on every dispatch. dispatch.ts sets this marker in
        # model_options; pop it here so it never reaches the Seedance
        # builder or Replicate.
        shot_directed = bool(advanced.pop("__shot_directed", False))
        advanced = _resolve_local_refs(advanced)

        recipe = _resolve_shot_recipe(preset, shot_size, camera_angle,
                                      camera_movement, lens_look, composition)
        dialect = _shot_dialect_for_model(model)
        shot_phrase = _build_shot_phrase(recipe, dialect)
        if shot_directed:
            full_prompt = (prompt or "").strip()
        else:
            full_prompt = f"{shot_phrase} {(prompt or '').strip()}".strip()

        try:
            dur_int = int(duration)
        except (TypeError, ValueError):
            dur_int = spec.default_duration

        image_data_url = _image_tensor_to_data_url(image) if image is not None else None
        input_dict = spec.build_input(full_prompt, aspect_ratio, dur_int, int(seed or 0),
                                      image_data_url, None, advanced)
        print(
            f"[FilmShot] preset={recipe.id!r} dialect={dialect!r} model={model!r} "
            f"slug={spec.replicate_slug!r} advanced={advanced} phrase={shot_phrase!r}",
            flush=True,
        )
        video = await _dispatch_video_prediction(
            spec, input_dict, cls=cls, log_prefix="FilmShot", model=model,
        )
        return IO.NodeOutput(video)


# =============================================================================
# Use case: Upscale an image
# =============================================================================


# Upscale engines, from creative→faithful. Each speaks a different input
# dialect (verified against the live Replicate schemas), so execute() maps the
# shared widgets per model. Slugs all route through _run_prediction.
_UPSCALE_MODELS = ["Clarity", "Crystal", "Real-ESRGAN", "Recraft Crisp", "Topaz"]
_UPSCALE_SLUGS = {
    "Clarity": "philz1337x/clarity-upscaler",
    "Crystal": "philz1337x/crystal-upscaler",
    "Real-ESRGAN": "nightmareai/real-esrgan",
    "Recraft Crisp": "recraft-ai/recraft-crisp-upscale",
    "Topaz": "topazlabs/image-upscale",
}


class UpscaleImageNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="UpscaleImageNode",
            display_name="Upscale an image",
            category="api node/image/Replicate",
            description=(
                "Upscale an image. Engines range from creative to faithful:\n"
                "• Clarity — adds invented detail, prompt-guided (~$0.05–0.20)\n"
                "• Crystal — creative detail, simple creativity knob (~$0.01–0.04)\n"
                "• Real-ESRGAN — fast, faithful, no hallucination (~$0.002)\n"
                "• Recraft Crisp — clean, crisp, cheapest, zero knobs (~$0.006)\n"
                "• Topaz — premium pro-grade quality (~$0.05+)\n"
                "Prompt / creativity / resemblance / steps apply to Clarity only."
            ),
            inputs=[
                IO.Combo.Input("model", options=_UPSCALE_MODELS, default="Clarity",
                               tooltip="Upscale engine. Clarity & Crystal invent detail; "
                                       "Real-ESRGAN and Recraft Crisp stay faithful; Topaz is premium."),
                IO.Image.Input("image"),
                IO.String.Input("prompt", multiline=True,
                                default="masterpiece, best quality, highres",
                                tooltip="(Clarity only) Style prompt — guides invented detail."),
                IO.Float.Input("scale_factor", default=2.0, min=1.0, max=10.0, step=0.5,
                               tooltip="Output is scale_factor × input dimensions. "
                                       "(Clarity / Real-ESRGAN — Topaz uses its own upscale factor.)"),
                IO.Float.Input("creativity", default=0.35, min=0.0, max=1.0, step=0.05, advanced=True,
                               tooltip="(Clarity only) 0 = preserve, 1 = reinvent. 0.3–0.4 is the sweet spot."),
                IO.Float.Input("resemblance", default=0.6, min=0.0, max=3.0, step=0.05, advanced=True,
                               tooltip="(Clarity only) Higher = closer to input."),
                IO.String.Input("negative_prompt", default="(worst quality, low quality, normal quality:2)",
                                advanced=True, tooltip="(Clarity only) What to avoid."),
                IO.Int.Input("num_inference_steps", default=18, min=10, max=50, advanced=True,
                             tooltip="(Clarity only) More steps = more detail, slower."),
                # control_after_generate=True is REQUIRED: without it every input
                # declared AFTER `seed` (face_enhance + all topaz_* widgets) is
                # off-by-one at queue time, because the Vue bridge only reserves
                # the seed-control slot in widgets_values when this flag is set.
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             control_after_generate=True, tooltip="0 = random. Used by Clarity."),
                # NOTE: new inputs MUST be appended at the END. Widget values are
                # positional, so inserting mid-list shifts every later widget on
                # existing nodes (scrambles their saved values). face_enhance is
                # last so the original first-8 slots stay put.
                IO.Boolean.Input("face_enhance", default=False, advanced=True,
                                 tooltip="Restore/enhance faces (Real-ESRGAN & Topaz). Ignored by others."),
                # --- Topaz-only controls (mirror topazlabs/image-upscale). Gated
                # to the Topaz model in the frontend; appended here per the
                # positional-widget rule above so existing nodes keep their values.
                IO.Combo.Input("topaz_enhance_model",
                               options=["Standard V2", "Low Resolution V2", "CGI",
                                        "High Fidelity V2", "Text Refine"],
                               default="Standard V2", advanced=True,
                               tooltip="(Topaz) Enhancement model: Standard V2 (general), "
                                       "Low Resolution V2 (low-res input), CGI (digital art), "
                                       "High Fidelity V2 (preserves detail), Text Refine (text)."),
                IO.Combo.Input("topaz_upscale_factor", options=["None", "2x", "4x", "6x"],
                               default="2x", advanced=True,
                               tooltip="(Topaz) How much to upscale. None = enhance only, no resize."),
                IO.Combo.Input("topaz_subject_detection", options=["None", "All", "Foreground", "Background"],
                               default="None", advanced=True,
                               tooltip="(Topaz) Detect and prioritize subjects when enhancing."),
                IO.Combo.Input("topaz_output_format", options=["png", "jpg"], default="png", advanced=True,
                               tooltip="(Topaz) Output image format."),
                IO.Float.Input("topaz_face_creativity", default=0.0, min=0.0, max=1.0, step=0.05, advanced=True,
                               tooltip="(Topaz) Face-enhancement creativity 0–1. Ignored unless Face enhance is on."),
                IO.Float.Input("topaz_face_strength", default=0.8, min=0.0, max=1.0, step=0.05, advanced=True,
                               tooltip="(Topaz) How sharp enhanced faces are vs. background, 0–1. "
                                       "Ignored unless Face enhance is on."),
                # --- Crystal-only controls (mirror philz1337x/crystal-upscaler).
                # Crystal's creativity is 0–10 (not Clarity's 0–1), so it gets its
                # own widget. Appended at the END per the positional-widget rule.
                IO.Float.Input("crystal_creativity", default=0.0, min=0.0, max=10.0, step=0.5, advanced=True,
                               tooltip="(Crystal) Creativity 0–10. 0 = faithful, higher = more invented detail."),
                IO.Combo.Input("crystal_output_format", options=["png", "jpg"], default="png", advanced=True,
                               tooltip="(Crystal) Output image format."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.10,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, image, prompt, scale_factor,
                      creativity, resemblance, negative_prompt, num_inference_steps, seed,
                      face_enhance=False,
                      topaz_enhance_model="Standard V2", topaz_upscale_factor="2x",
                      topaz_subject_detection="None", topaz_output_format="png",
                      topaz_face_creativity=0.0, topaz_face_strength=0.8,
                      crystal_creativity=0.0, crystal_output_format="png"):
        img_url = _image_tensor_to_data_url(image)

        if model == "Clarity":
            input_dict = {
                "image": img_url,
                "prompt": prompt,
                "scale_factor": scale_factor,
                "creativity": creativity,
                "resemblance": resemblance,
                "negative_prompt": negative_prompt,
                "num_inference_steps": num_inference_steps,
                "output_format": "png",
            }
            if seed and seed > 0:
                input_dict["seed"] = seed
        elif model == "Crystal":
            input_dict = {
                "image": img_url,
                "scale_factor": float(scale_factor),
                "creativity": float(crystal_creativity),
                "output_format": crystal_output_format,
            }
        elif model == "Real-ESRGAN":
            input_dict = {
                "image": img_url,
                "scale": float(scale_factor),
                "face_enhance": bool(face_enhance),
            }
        elif model == "Recraft Crisp":
            # Zero-knob crisp upscaler — takes only the image.
            input_dict = {"image": img_url}
        elif model == "Topaz":
            input_dict = {
                "image": img_url,
                "enhance_model": topaz_enhance_model,
                "upscale_factor": topaz_upscale_factor,
                "subject_detection": topaz_subject_detection,
                "output_format": topaz_output_format,
                "face_enhancement": bool(face_enhance),
            }
            if face_enhance:
                input_dict["face_enhancement_creativity"] = float(topaz_face_creativity)
                input_dict["face_enhancement_strength"] = float(topaz_face_strength)
        else:
            raise ValueError(f"Unknown upscale model: {model}")

        pred = await _run_prediction(_UPSCALE_SLUGS[model], input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor)


class EnhanceDetailNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="EnhanceDetailNode",
            display_name="Enhance Detail",
            category="api node/image/Replicate",
            description=(
                "Add realistic fine detail to an image — in place, no resize.\n"
                "• Creative — invents plausible detail, prompt-guided (Clarity, ~$0.05–0.20)\n"
                "• Faithful — cleans & sharpens, no hallucination (Topaz, ~$0.05)\n"
                "• Diffusion Refine — ControlNet img2img re-render for max realism (Magic Refiner, ~$0.05–0.10)\n"
                "Detail strength drives the active engine. Prompt is used by "
                "Creative & Diffusion Refine. To also enlarge, use the Upscale node."
            ),
            inputs=[
                IO.Combo.Input("model", options=ENHANCE_ENGINES, default="Creative",
                               tooltip="Engine. Creative invents detail; Faithful stays true; "
                                       "Diffusion Refine re-renders for max realism."),
                IO.Image.Input("image"),
                IO.String.Input("prompt", multiline=True,
                                default="masterpiece, best quality, highres",
                                tooltip="Style prompt (Creative & Diffusion Refine). Ignored by Faithful."),
                IO.Float.Input("detail_strength", default=0.4, min=0.0, max=1.0, step=0.05,
                               display_mode=IO.NumberDisplay.slider,
                               tooltip="How much new detail to add. Drives the active engine. "
                                       "Ignored by Faithful (auto)."),
                # --- Creative (Clarity) advanced ---
                IO.Float.Input("resemblance", default=0.6, min=0.0, max=3.0, step=0.05, advanced=True,
                               tooltip="(Creative) Higher = stays closer to the input."),
                IO.String.Input("negative_prompt", default="(worst quality, low quality, normal quality:2)",
                                advanced=True, tooltip="(Creative) What to avoid."),
                IO.Int.Input("num_inference_steps", default=18, min=10, max=50, advanced=True,
                             tooltip="(Creative) More steps = more detail, slower."),
                # control_after_generate=True REQUIRED so the Vue bridge reserves the
                # seed-control slot in widgets_values (same caveat as UpscaleImageNode).
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF,
                             control_after_generate=True,
                             tooltip="0 = random. Used by Creative & Diffusion Refine."),
                # --- Faithful (Topaz) advanced ---
                IO.Combo.Input("topaz_enhance_model",
                               options=["Standard V2", "Low Resolution V2", "CGI",
                                        "High Fidelity V2", "Text Refine"],
                               default="Standard V2", advanced=True,
                               tooltip="(Faithful) Enhancement model."),
                IO.Combo.Input("topaz_subject_detection", options=["None", "All", "Foreground", "Background"],
                               default="None", advanced=True,
                               tooltip="(Faithful) Detect & prioritize subjects."),
                IO.Combo.Input("topaz_output_format", options=["png", "jpg"], default="png", advanced=True,
                               tooltip="(Faithful) Output image format."),
                # --- Diffusion Refine (magic-image-refiner) advanced ---
                IO.Int.Input("refine_steps", default=20, min=10, max=50, advanced=True,
                             tooltip="(Diffusion Refine) Sampling steps. More = more detail, slower."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.10,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, image, prompt, detail_strength,
                      resemblance=0.6,
                      negative_prompt="(worst quality, low quality, normal quality:2)",
                      num_inference_steps=18, seed=0,
                      topaz_enhance_model="Standard V2", topaz_subject_detection="None",
                      topaz_output_format="png", refine_steps=20):
        img_url = _image_tensor_to_data_url(image)
        slug, input_dict = build_enhance_input(
            model,
            image_url=img_url, prompt=prompt, detail_strength=detail_strength,
            resemblance=resemblance, negative_prompt=negative_prompt,
            num_inference_steps=num_inference_steps, seed=seed,
            topaz_enhance_model=topaz_enhance_model,
            topaz_subject_detection=topaz_subject_detection,
            topaz_output_format=topaz_output_format,
            refine_steps=refine_steps,
        )
        pred = await _run_prediction(slug, input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor)


# =============================================================================
# Use case: Remove background
# =============================================================================


class RemoveBackgroundNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="RemoveBackgroundNode",
            display_name="Remove background",
            category="api node/image/Replicate",
            description="Fast alpha-matte background removal. ~$0.001 per image.",
            inputs=[
                IO.Combo.Input("model", options=["851-labs/bg-remover"], default="851-labs/bg-remover"),
                IO.Image.Input("image"),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.001,"format":{"approximate":true}}'),
            # Terminal effect node: it saves its own preview (execute returns
            # save_generation_output), so flag it as an output node. Otherwise
            # ComfyUI prunes it when its only consumer is a non-output compute
            # node (e.g. a downstream Inpaint), and it silently produces nothing.
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, model, image):
        pred = await _run_prediction("851-labs/background-remover",
                                     {"image": _image_tensor_to_data_url(image)})
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "remove_bg"))


# =============================================================================
# Use case: Restore an old photo
# =============================================================================


class RestorePhotoNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="RestorePhotoNode",
            display_name="Restore an old photo",
            category="api node/image/Replicate",
            description="Restore old, damaged, faded photos. Can colorize B&W. ~$0.04 per image.",
            inputs=[
                IO.Combo.Input("model", options=["Flux Kontext · Restore"], default="Flux Kontext · Restore"),
                IO.Image.Input("image"),
                IO.Int.Input("safety_tolerance", default=2, min=1, max=6, advanced=True),
                IO.Combo.Input("output_format", options=["png", "jpg"], default="png", advanced=True),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.04}'),
            # Terminal effect (self-saves via save_generation_output) — flag as an
            # output node so ComfyUI doesn't prune it when it feeds a non-output
            # compute node. See RemoveBackgroundNode for the same fix.
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, model, image, safety_tolerance, output_format):
        input_dict = {
            "input_image": _image_tensor_to_data_url(image),
            "safety_tolerance": safety_tolerance,
            "output_format": output_format,
        }
        pred = await _run_prediction("flux-kontext-apps/restore-image", input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor, ui=save_generation_output(tensor, "restore_photo"))


# =============================================================================
# Use case: Fix faces in a photo
# =============================================================================


class FixFacesNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="FixFacesNode",
            display_name="Fix faces in a photo",
            category="api node/image/Replicate",
            description="Face-specific restoration — sharpens, de-blurs, reconstructs faces. ~$0.005 per image.",
            inputs=[
                IO.Combo.Input("model", options=["CodeFormer"], default="CodeFormer"),
                IO.Image.Input("image"),
                IO.Float.Input("codeformer_fidelity", default=0.5, min=0.0, max=1.0, step=0.05,
                               tooltip="0 = stronger restoration, 1 = more faithful."),
                IO.Boolean.Input("background_enhance", default=True, advanced=True),
                IO.Boolean.Input("face_upsample", default=True, advanced=True),
                IO.Int.Input("upscale", default=2, min=1, max=4, step=1, advanced=True),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.005,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, image, codeformer_fidelity, background_enhance,
                      face_upsample, upscale):
        input_dict = {
            "image": _image_tensor_to_data_url(image),
            "codeformer_fidelity": codeformer_fidelity,
            "background_enhance": background_enhance,
            "face_upsample": face_upsample,
            "upscale": upscale,
        }
        pred = await _run_prediction("sczhou/codeformer", input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor)


# =============================================================================
# Use case: Separate text from image (split a flat design into layers)
# =============================================================================


class LayerizeGraphicNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="LayerizeGraphicNode",
            display_name="Separate text from image",
            category="api node/image/Replicate",
            description=(
                "Split a flat graphic (poster, ad, thumbnail, UI mockup) into a "
                "clean, text-free background plus structured text-layer data — "
                "positions, fonts, colors, and ready-to-use HTML overlay code. "
                "Best for design graphics, not photographs. Ideogram Layerize. "
                "~$0.08 per image.\n"
                "Outputs: the background image (text removed) and the layer JSON."
            ),
            inputs=[
                IO.Combo.Input("model", options=["Ideogram Layerize"], default="Ideogram Layerize"),
                IO.Image.Input("image", tooltip="The flat graphic to layerize (JPEG/PNG/WebP, max 10MB)."),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Optional — describe the graphic to guide layerization."),
                IO.Int.Input("seed", default=0, min=0, max=0x7FFFFFFF, advanced=True,
                             control_after_generate=True,
                             tooltip="0 = random. Set for reproducible results."),
            ],
            outputs=[
                IO.Image.Output(display_name="background"),
                IO.String.Output(display_name="layers_json"),
            ],
            hidden=[IO.Hidden.unique_id],
            # Output node so the run's `executed` event reaches the frontend
            # even with nothing wired downstream: the node carries its own
            # background preview + the layer JSON (data.text), which is what
            # the "Edit as Frame" conversion reads.
            is_output_node=True,
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.08,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, image, prompt, seed):
        import json as _json
        input_dict = {"flat_graphic_image": _image_tensor_to_data_url(image)}
        if (prompt or "").strip():
            input_dict["prompt"] = prompt.strip()
        if seed and seed > 0:
            input_dict["seed"] = int(seed)

        pred = await _run_prediction("ideogram-ai/layerize", input_dict)
        urls = _all_output_urls(pred)
        if not urls:
            raise ValueError("Layerize returned no output.")

        # Output is an unordered pair: a background image and a text-layer JSON.
        # Pick by file extension so we're robust to ordering changes.
        def _ext(u: str) -> str:
            return u.lower().split("?")[0].rsplit(".", 1)[-1]
        img_url = next((u for u in urls if _ext(u) in ("png", "jpg", "jpeg", "webp")), None)
        json_url = next((u for u in urls if _ext(u) == "json"), None)
        if img_url is None:
            img_url = next((u for u in urls if u != json_url), None)
        if img_url is None:
            raise ValueError("Layerize returned no background image.")

        tensor = await download_url_to_image_tensor(img_url, cls=cls)

        layers_json = ""
        if json_url:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        json_url, timeout=aiohttp.ClientTimeout(total=30)
                    ) as r:
                        layers_json = await r.text()
            except Exception as e:
                layers_json = _json.dumps({"error": f"failed to fetch layer data: {e}"})

        # Surface both results on the node itself (background preview image +
        # the layer JSON as a text payload) so "Edit as Frame" can convert the
        # structured text layers without any downstream wiring.
        ui = save_generation_output(tensor, "layerize")
        if layers_json:
            ui = {**ui, "text": [layers_json]}
        return IO.NodeOutput(tensor, layers_json, ui=ui)


# =============================================================================
# Use case: Separate background and foreground (subject cutout + clean background plate)
# =============================================================================


# Background-fill engines for the hole left behind once the subject is removed.
# Both are dedicated object *removers* — they reconstruct the hole from
# surrounding context and do NOT regenerate a new subject (unlike a generative
# inpainter such as Flux Fill, which happily paints a fresh person into a
# person-shaped hole). Both take image + mask with white = remove.
_PHOTO_FILL_SLUGS = {
    "LaMa (fast)": "zylim0702/remove-object",
    "Bria Eraser (quality)": "bria/eraser",
}


class SplitPhotoLayersNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SplitPhotoLayersNode",
            display_name="Separate background and foreground",
            category="api node/image/Replicate",
            description=(
                "Decompose a photo into two editable layers, ready for the "
                "Compositor:\n"
                "• subject — a transparent RGBA cutout (851-labs background remover)\n"
                "• background — a clean plate with the subject removed and the "
                "hole reconstructed (LaMa, ~$0.003 total; or Bria Eraser, ~$0.04)\n"
                "Both engines ERASE (reconstruct from surroundings) — they will "
                "not paint a new subject into the hole. The revealed area is "
                "AI-reconstructed, not recovered."
            ),
            inputs=[
                IO.Combo.Input("background_fill", options=list(_PHOTO_FILL_SLUGS),
                               default="LaMa (fast)",
                               tooltip="How to reconstruct the hole left by the removed subject. "
                                       "LaMa is fast/cheap; Bria Eraser is SOTA quality. Both are "
                                       "true erasers — neither regenerates a new subject."),
                IO.Image.Input("image", tooltip="The photo to split into subject + background."),
                IO.Int.Input("mask_grow", default=12, min=0, max=50, step=1, advanced=True,
                             tooltip="Grow the subject mask by N px before filling, so no thin "
                                     "halo of the subject is left behind in the background plate."),
            ],
            outputs=[
                IO.Image.Output(display_name="subject"),     # RGBA cutout (alpha preserved)
                IO.Image.Output(display_name="background"),  # opaque clean plate
            ],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.01,"format":{"approximate":true}}'),
            # Terminal effect (self-saves via save_generation_output) — flag as an
            # output node so ComfyUI doesn't prune it when it feeds a non-output
            # compute node. See RemoveBackgroundNode for the same fix.
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, background_fill, image, mask_grow=12):
        from PIL import ImageFilter
        img_url = _image_tensor_to_data_url(image)

        # 1) Subject cutout (RGBA) from the background remover.
        sub_pred = await _run_prediction(
            "851-labs/background-remover",
            {"image": img_url, "background_type": "rgba", "format": "png"},
        )
        subject = await download_url_to_image_tensor(_first_output_url(sub_pred), cls=cls)

        # 2) Inpaint mask (white = subject region to fill). Derive it from the
        #    cutout's alpha — free, no extra call. Fall back to the remover's
        #    dedicated matte ('map') if no alpha came back for some reason.
        if subject.dim() == 4 and subject.shape[-1] >= 4:
            alpha = (subject[0, :, :, 3].clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
            mask_img = Image.fromarray(alpha, mode="L")
        else:
            map_pred = await _run_prediction(
                "851-labs/background-remover",
                {"image": img_url, "background_type": "map", "format": "png"},
            )
            mt = await download_url_to_image_tensor(_first_output_url(map_pred), cls=cls)
            arr = (mt[0, :, :, 0].clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
            mask_img = Image.fromarray(arr, mode="L")

        if mask_grow > 0:
            mask_img = mask_img.filter(ImageFilter.MaxFilter(mask_grow * 2 + 1))
        mbuf = io.BytesIO()
        mask_img.save(mbuf, format="PNG")
        mask_url = "data:image/png;base64," + base64.b64encode(mbuf.getvalue()).decode("ascii")

        # 3) Erase the subject region → clean background plate. Both engines
        #    take image + mask (white = remove) and reconstruct, not regenerate.
        slug = _PHOTO_FILL_SLUGS[background_fill]
        # The fill engines (LaMa / Flux Fill) take image + mask and expect RGB +
        # mask = 4 channels. If the source carries an alpha channel, an RGBA image
        # + mask reaches the model as 5 channels and it errors
        # ("expected input to have 4 channels, but got 5 instead"). Send an
        # alpha-dropped RGB copy for the fill step (the background remover above
        # tolerates RGBA, so only this call needs it).
        fill_image = image[..., :3].contiguous() if (image.dim() == 4 and image.shape[-1] == 4) else image
        fill_url = _image_tensor_to_data_url(fill_image)
        bg_pred = await _run_prediction(slug, {"image": fill_url, "mask": mask_url})
        background = await download_url_to_image_tensor(_first_output_url(bg_pred), cls=cls)
        # Background is an opaque plate — drop any alpha so the downstream Image
        # artifact renders normally (a spurious alpha routes it to the
        # transparent-preview path).
        if background.dim() == 4 and background.shape[-1] == 4:
            background = background[..., :3].contiguous()

        # Surface both results as ui images, in OUTPUT-SLOT ORDER (subject=0,
        # background=1) — the Frame resolves a wire's preview by the source
        # output index into data.images. Durable outputs so both land in Assets.
        sub_ui = save_generation_output(subject, "split_subject")
        bg_ui = save_generation_output(background, "split_background")
        ui = {"images": [*sub_ui["images"], *bg_ui["images"]], "animated": (False,)}
        return IO.NodeOutput(subject, background, ui=ui)


# =============================================================================
# Use case: Layerize a photo into raster layers (fal Seedream 5 Pro Layerize)
# =============================================================================


class SeedreamLayerizeNode(IO.ComfyNode):
    """Split a finished image into 2-17 transparent-PNG raster layers via fal
    Seedream 5 Pro Layerize. Emits a preview + layers_json; "Edit as Frame"
    turns the layers into editable Compositor image layers."""
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SeedreamLayerizeNode",
            display_name="Layerize an image",
            category="api node/image/Replicate",
            inputs=[
                IO.Image.Input("image"),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Optional guidance for how to split the image."),
                IO.Combo.Input("image_size", options=["auto", "auto_1K", "auto_1.5K", "auto_2K"],
                               default="auto", optional=True),
            ],
            outputs=[
                IO.Image.Output(display_name="preview"),
                IO.String.Output(display_name="layers_json"),
            ],
            hidden=[IO.Hidden.unique_id],
            is_output_node=True,
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.34,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, image, prompt, image_size="auto"):
        from comfy_api_nodes import fal_refs
        from comfy_api_nodes.seedream_layerize import seedream_layerize_input, parse_seedream_layers
        import json as _json

        inp = seedream_layerize_input(prompt, _image_tensor_to_data_url(image), image_size)
        result = await fal_refs.run_fal_prediction(
            "bytedance/seedream/v5/pro/layerize", "", inp, poll_deadline_sec=300)
        layers, W, H = parse_seedream_layers(result)

        out_layers = []
        for lyr in layers:
            tensor = await download_url_to_image_tensor(lyr["url"], cls=cls)
            fname = save_image_to_input(tensor, "seedream_layer")
            out_layers.append({
                "filename": fname, "z_index": lyr["z_index"], "box": lyr["box"],
                "name": lyr["name"], "description": lyr["description"],
            })
        layers_json = _json.dumps({"source": "seedream", "width": W, "height": H, "layers": out_layers})

        # Preview: the recomposed flat image if fal returned one, else the input.
        preview = image
        imgs = result.get("images") or []
        if imgs and isinstance(imgs[0], dict) and imgs[0].get("url"):
            preview = await download_url_to_image_tensor(imgs[0]["url"], cls=cls)
        ui = save_generation_output(preview, "seedream_layerize")
        if out_layers:
            ui = {**ui, "text": [layers_json]}
        return IO.NodeOutput(preview, layers_json, ui=ui)


# =============================================================================
# Use case: Expand / outpaint an image
# =============================================================================


_OUTPAINT_DIRECTIONS = [
    "Zoom out 1.5x", "Zoom out 2x", "Make square",
    "Left outpaint", "Right outpaint", "Top outpaint", "Bottom outpaint",
]
_OUTPAINT_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"]


class OutpaintImageNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="OutpaintImageNode",
            display_name="Expand / outpaint an image",
            category="api node/image/Replicate",
            description=(
                "Extend an image beyond its borders — the model invents plausible "
                "new surroundings. Two engines:\n"
                "• Flux Fill — directional outpaint or zoom-out via a single picker "
                "(Left/Right/Top/Bottom, Zoom out, Make square), prompt-steerable (~$0.05)\n"
                "• Bria Expand — expand to an exact target aspect ratio, clean and "
                "commercial-grade (~$0.04)\n"
                "Use the prompt to guide what fills the new space (optional)."
            ),
            inputs=[
                IO.Combo.Input("model", options=["Flux Fill", "Bria Expand"], default="Flux Fill",
                               tooltip="Flux Fill = directional/zoom outpaint; "
                                       "Bria Expand = expand to a target aspect ratio."),
                IO.Image.Input("image"),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Optional — describe what should fill the new area "
                                        "(e.g. 'forest clearing, soft daylight'). Both engines use it."),
                IO.Combo.Input("direction", options=_OUTPAINT_DIRECTIONS, default="Zoom out 1.5x",
                               tooltip="(Flux Fill) Which way to extend, or zoom out / make square. "
                                       "The mask is generated automatically."),
                IO.Combo.Input("aspect_ratio", options=_OUTPAINT_ASPECT_RATIOS, default="16:9",
                               tooltip="(Bria Expand) Target aspect ratio to expand the canvas to."),
                # seed last + control_after_generate=True (positional-widget rule).
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, advanced=True,
                             control_after_generate=True, tooltip="0 = random."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.05,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, image, prompt, direction, aspect_ratio, seed=0):
        img_url = _image_tensor_to_data_url(image)
        prompt = (prompt or "").strip()

        if model == "Flux Fill":
            input_dict = {
                "image": img_url,
                "outpaint": direction,
                "prompt": prompt,
                "output_format": "png",
                "safety_tolerance": 6,
            }
            if seed and seed > 0:
                input_dict["seed"] = int(seed)
            slug = "black-forest-labs/flux-fill-pro"
        elif model == "Bria Expand":
            input_dict = {"image": img_url, "aspect_ratio": aspect_ratio}
            if prompt:
                input_dict["prompt"] = prompt
            if seed and seed > 0:
                input_dict["seed"] = int(seed)
            slug = "bria/expand-image"
        else:
            raise ValueError(f"Unknown outpaint model: {model}")

        pred = await _run_prediction(slug, input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        # Opaque result — drop any alpha so the downstream Image artifact renders.
        if tensor.dim() == 4 and tensor.shape[-1] == 4:
            tensor = tensor[..., :3].contiguous()
        return IO.NodeOutput(tensor)


# =============================================================================
# Use case: Describe an image
# =============================================================================


class DescribeImageNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="DescribeImageNode",
            display_name="Describe an image",
            category="api node/image/Replicate",
            description="Vision-language model for captions, Q&A, counting. Output is text. ~$0.001 per query.",
            inputs=[
                IO.Combo.Input("model", options=["Moondream 2"], default="Moondream 2"),
                IO.Image.Input("image"),
                IO.String.Input("prompt", multiline=True,
                                default="Describe this image in detail.",
                                tooltip="What to ask."),
            ],
            outputs=[IO.String.Output(display_name="description")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.001,"format":{"approximate":true}}'),
        is_output_node=True,
        )

    @classmethod
    async def execute(cls, model, image, prompt):
        input_dict = {"image": _image_tensor_to_data_url(image), "prompt": prompt}
        pred = await _run_prediction("lucataco/moondream2", input_dict)
        out = pred.get("output")
        if isinstance(out, list):
            text = "".join(str(x) for x in out)
        elif isinstance(out, str):
            text = out
        else:
            text = str(out or "")
        return IO.NodeOutput(text.strip())


# =============================================================================
# Use case: Sync lips to audio
# =============================================================================


class LipsyncNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="LipsyncNode",
            display_name="Sync lips to audio",
            category="api node/video/Replicate",
            description=(
                "Drive a face's lips to match an audio track. Requires a "
                "public URL to the source video + an audio track. ~$1 per 30s."
            ),
            inputs=[
                IO.Combo.Input("model", options=["sync.so 2-pro"], default="sync.so 2-pro"),
                IO.String.Input("video_url", default="",
                                tooltip="URL of the source video. Public URL or data URL."),
                IO.Audio.Input("audio"),
                IO.Combo.Input("sync_mode",
                               options=["loop", "bounce", "cut_off", "silence", "remap"],
                               default="cut_off", advanced=True),
            ],
            outputs=[IO.Video.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":1.00,"format":{"approximate":true,"suffix":"/30s"}}'),
        )

    @classmethod
    async def execute(cls, model, video_url, audio, sync_mode):
        if not video_url:
            raise RuntimeError("video_url is required (paste a public URL to the source video).")
        # Same audio-to-WAV encoding as Whisper / old Lipsync.
        audio_url = _audio_dict_to_wav_data_url(audio, max_seconds=60)
        pred = await _run_prediction(
            "sync/lipsync-2-pro",
            {"video": video_url, "audio": audio_url, "sync_mode": sync_mode},
            poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC,
        )
        video = await download_url_to_video_output(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(video)


class LipSyncNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="LipSyncNode",
            display_name="Lip-sync a character",
            category="api node/video/Replicate",
            description=(
                "Make a face speak an audio clip. Image face → VEED Fabric 1.0 "
                "(talking head); video face → sync/lipsync-2-pro (relip). Driven "
                "by the Lip-Sync Studio; ~$1 per 30s."
            ),
            inputs=[
                IO.Image.Input("image", optional=True,
                               tooltip="Optional wired face image (else supplied via the studio)."),
                IO.Audio.Input("audio", optional=True,
                               tooltip="Optional wired voice clip (else supplied via the studio)."),
                IO.Combo.Input("engine", options=["auto", "fabric", "sync"], default="auto",
                               tooltip="auto = image→Fabric, video→sync."),
                IO.Combo.Input("resolution", options=["480p", "720p", "1080p"], default="720p",
                               tooltip="Fabric only; sync keeps the source framing."),
                IO.Combo.Input("sync_mode",
                               options=["cut_off", "loop", "bounce", "silence", "remap"],
                               default="cut_off", advanced=True,
                               tooltip="sync only — how to handle audio/video length mismatch."),
                IO.String.Input("model_options", multiline=True, default="{}",
                                tooltip="JSON from the Lip-Sync Studio: face_image / face_video / audio URLs."),
            ],
            outputs=[IO.Video.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":1.00,"format":{"approximate":true,"suffix":"/30s"}}'),
        )

    @classmethod
    async def execute(cls, image=None, audio=None, engine="auto",
                      resolution="720p", sync_mode="cut_off", model_options="{}"):
        try:
            opts = json.loads(model_options or "{}")
            if not isinstance(opts, dict):
                opts = {}
        except json.JSONDecodeError:
            opts = {}

        def _resolve(src):
            if not src:
                return src
            name = _parse_view_ref(src)
            return _local_ref_to_data_url(name) if name else src

        # Wired ports win over studio-supplied URLs.
        face_image = _image_tensor_to_data_url(image) if image is not None else _resolve(opts.get("face_image"))
        video_src = opts.get("face_video")
        audio_src = opts.get("audio")
        resolution = opts.get("resolution", resolution)
        sync_mode = opts.get("sync_mode", sync_mode)
        engine = opts.get("engine", engine)

        eng = _lipsync_resolve_engine(engine, bool(face_image), bool(video_src))
        if eng == "sync":
            # Kling video-relip fetches BOTH the video and the audio from public
            # URLs — host each to fal storage (a data URL/local /view URL isn't
            # reachable). A wired AUDIO tensor is encoded to WAV first, then hosted.
            face_video = await _lipsync_hosted_media_url(video_src, "video/mp4", "lipsync-source.mp4")
            audio_raw = _audio_dict_to_wav_data_url(audio, max_seconds=60) if audio is not None else audio_src
            audio_url = await _lipsync_hosted_media_url(audio_raw, "audio/mpeg", "lipsync-voice.mp3")
        else:
            # Fabric (image) accepts data URLs — images are small.
            face_video = _resolve(video_src)
            audio_url = _audio_dict_to_wav_data_url(audio, max_seconds=60) if audio is not None else _resolve(audio_src)
        slug, input_dict = _lipsync_build_input(
            eng, face_image, face_video, audio_url, resolution, sync_mode)
        print(f"[LipSync] engine={eng!r} slug={slug!r} keys={list(input_dict)}", flush=True)
        pred = await _run_prediction(slug, input_dict, poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC)
        video = await download_url_to_video_output(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(video)


# =============================================================================
# Use case: Transcribe audio
# =============================================================================


class TranscribeAudioNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="TranscribeAudioNode",
            display_name="Transcribe audio",
            category="api node/audio/Replicate",
            description="Transcribe audio to text. ~$0.005 per minute.",
            inputs=[
                IO.Combo.Input("model", options=["Whisper"], default="Whisper"),
                IO.Audio.Input("audio"),
                IO.Combo.Input("language",
                               options=["auto","en","es","fr","de","it","pt","ja","ko","zh","ru","ar","hi"],
                               default="auto"),
                IO.Boolean.Input("translate", default=False, advanced=True,
                                 tooltip="Translate to English instead of transcribing in original language."),
            ],
            outputs=[IO.String.Output(display_name="transcript")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.005,"format":{"suffix":"/min","approximate":true}}'),
        is_output_node=True,
        )

    @classmethod
    async def execute(cls, model, audio, language, translate):
        # Reuse the original WhisperRemoteNode's logic by calling its execute.
        return await WhisperRemoteNode.execute(audio=audio, language=language, translate=translate)


# =============================================================================
# Use case: Generate music
# =============================================================================


class GenerateMusicNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="GenerateMusicNode",
            display_name="Generate music",
            category="api node/audio/Replicate",
            description="Text-to-music. ~$0.01–0.05 depending on length.",
            inputs=[
                IO.Combo.Input("model", options=["MusicGen"], default="MusicGen"),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Describe the music. e.g. 'lo-fi hip-hop, mellow piano, 80 bpm'."),
                IO.Int.Input("duration", default=8, min=1, max=30, step=1, tooltip="Seconds."),
                IO.Combo.Input("model_version",
                               options=["stereo-melody-large","stereo-large","melody-large","large"],
                               default="stereo-melody-large", advanced=True),
                IO.Float.Input("temperature", default=1.0, min=0.0, max=2.0, step=0.05, advanced=True),
                IO.Float.Input("top_p", default=0.0, min=0.0, max=1.0, step=0.05, advanced=True),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF),
            ],
            outputs=[IO.Audio.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.02,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, prompt, duration, model_version, temperature, top_p, seed):
        return await MusicGenRemoteNode.execute(
            prompt=prompt, duration=duration, model_version=model_version,
            temperature=temperature, top_p=top_p, seed=seed,
        )


# =============================================================================
# Use case: Generate speech
# =============================================================================


class GenerateSpeechNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="GenerateSpeechNode",
            display_name="Generate speech",
            category="api node/audio/Replicate",
            description="Natural TTS with emotion + voice control. ~$0.30 per 1K chars.",
            inputs=[
                IO.Combo.Input("model", options=["MiniMax Speech-02 HD"], default="MiniMax Speech-02 HD"),
                IO.String.Input("text", multiline=True, default="", tooltip="What to say."),
                IO.Combo.Input("voice_id", options=_MINIMAX_VOICES + _list_cloned_voice_ids(), default="Wise_Woman",
                               extra_dict={"sailor_widget": "voice_picker"}),
                IO.Combo.Input("emotion", options=_MINIMAX_EMOTIONS, default="auto", advanced=True),
                IO.Float.Input("speed", default=1.0, min=0.5, max=2.0, step=0.05),
                IO.Float.Input("volume", default=1.0, min=0.1, max=10.0, step=0.1, advanced=True),
                IO.Int.Input("pitch", default=0, min=-12, max=12, advanced=True),
                IO.Combo.Input("language_boost",
                               options=["auto","English","Spanish","French","German","Italian",
                                        "Portuguese","Japanese","Korean","Chinese","Arabic"],
                               default="auto", advanced=True),
            ],
            outputs=[IO.Audio.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.30,"format":{"suffix":"/1K chars","approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, text, voice_id, emotion, speed, volume, pitch, language_boost):
        return await MiniMaxSpeechRemoteNode.execute(
            text=text, voice_id=voice_id, emotion=emotion, speed=speed,
            volume=volume, pitch=pitch, language_boost=language_boost,
        )


# =============================================================================
# Use case: Generate a 3D model
# =============================================================================


class Generate3DNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="Generate3DNode",
            display_name="Generate a 3D model",
            category="api node/3d/Replicate",
            description="Image-to-3D. Output is a STRING URL to a textured GLB mesh. ~$0.30 per asset.",
            inputs=[
                IO.Combo.Input("model", options=["Hunyuan3D 2"], default="Hunyuan3D 2"),
                IO.Image.Input("image"),
                IO.Int.Input("steps", default=50, min=20, max=100, step=5),
                IO.Float.Input("guidance_scale", default=5.5, min=1.0, max=20.0, step=0.5, advanced=True),
                IO.Int.Input("octree_resolution", default=256, min=128, max=512, step=64, advanced=True),
                IO.Boolean.Input("remove_background", default=True),
                IO.Boolean.Input("texture", default=True),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF),
            ],
            outputs=[IO.String.Output(display_name="glb_url")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.30,"format":{"approximate":true}}'),
        is_output_node=True,
        )

    @classmethod
    async def execute(cls, model, image, steps, guidance_scale, octree_resolution,
                      remove_background, texture, seed):
        return await Hunyuan3DRemoteNode.execute(
            image=image, steps=steps, guidance_scale=guidance_scale,
            octree_resolution=octree_resolution, remove_background=remove_background,
            texture=texture, seed=seed,
        )


# =============================================================================
# Use case: Sketch to image
# =============================================================================


class SketchToImageNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SketchToImageNode",
            display_name="Sketch to image",
            category="api node/image/Replicate",
            description=(
                "Turn a rough sketch into a finished image. Google Nano Banana "
                "(Gemini 2.5 Flash Image) — one of the best at sketch-to-image; "
                "very good at preserving composition from line art."
            ),
            inputs=[
                IO.Combo.Input("model", options=["Nano Banana"], default="Nano Banana"),
                IO.Image.Input("image", tooltip="Sketch or rough drawing."),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="Describe what the finished image should look like."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.04,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, image, prompt):
        input_dict = {
            "prompt": prompt,
            "image_input": [_image_tensor_to_data_url(image)],
        }
        pred = await _run_prediction("google/nano-banana", input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor)


# =============================================================================
# Use case: Extract text from image (OCR)
# =============================================================================


class ExtractTextNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="ExtractTextNode",
            display_name="Extract text from image",
            category="api node/image/Replicate",
            description=(
                "OCR — extract text from a photo, screenshot, or document. "
                "ByteDance Dolphin model. ~$0.005 per image."
            ),
            inputs=[
                IO.Combo.Input("model", options=["ByteDance Dolphin"], default="ByteDance Dolphin"),
                IO.Image.Input("image"),
            ],
            outputs=[IO.String.Output(display_name="text")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.005,"format":{"approximate":true}}'),
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, model, image):
        # bytedance/dolphin: real field is `file` (not `image`), and the
        # output is either markdown or json depending on output_format.
        input_dict = {
            "file": _image_tensor_to_data_url(image),
            "output_format": "markdown_content",
        }
        pred = await _run_prediction("bytedance/dolphin", input_dict)
        out = pred.get("output")
        if isinstance(out, list):
            text = "\n".join(str(x) for x in out)
        elif isinstance(out, dict):
            text = str(out.get("text") or out.get("markdown") or out.get("transcription") or "")
        elif isinstance(out, str):
            text = out
        else:
            text = ""
        return IO.NodeOutput(text.strip())


# =============================================================================
# Use case: Swap a face
# =============================================================================


# Removed: Replicate FaceSwapNode. Sailor ships a faster local face-swap
# node (`FaceSwap` in comfy_extras/nodes_face.py) backed by InsightFace +
# inswapper_128.onnx. It runs on the user's GPU, handles video batches with
# identity tracking, and is free after the one-time model download. The
# Replicate cloud version was redundant and slower.


# =============================================================================
# Use case: Find objects in an image (open-vocabulary detection)
# =============================================================================


class FindObjectsNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="FindObjectsNode",
            display_name="Find objects in an image",
            category="api node/image/Replicate",
            description=(
                "Open-vocabulary object detection — name what you want to find "
                "in plain English ('car, person, traffic light') and get back "
                "bounding boxes. Powered by YOLO-World. ~$0.005 per image. "
                "Output is JSON: [{label, confidence, x, y, width, height}, ...]."
            ),
            inputs=[
                IO.Combo.Input("model", options=["YOLO-World"], default="YOLO-World"),
                IO.Image.Input("image"),
                IO.String.Input("query", multiline=True, default="person, car, dog",
                                tooltip="Comma-separated list of things to look for."),
                IO.Float.Input("confidence", default=0.25, min=0.0, max=1.0, step=0.05, advanced=True),
            ],
            outputs=[IO.String.Output(display_name="detections_json")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.005,"format":{"approximate":true}}'),
        is_output_node=True,
        )

    @classmethod
    async def execute(cls, model, image, query, confidence):
        import json as _json
        # YOLO-World fields: `input_media`, `class_names`, `score_thr`.
        input_dict = {
            "input_media": _image_tensor_to_data_url(image),
            "class_names": query,
            "score_thr":   confidence,
        }
        pred = await _run_prediction("zsxkib/yolo-world", input_dict)
        out = pred.get("output")
        # YOLO-World typically returns a dict with detections array or an annotated image URL.
        # Surface the raw structure as JSON so downstream nodes can parse it.
        return IO.NodeOutput(_json.dumps(out) if not isinstance(out, str) else out)


# =============================================================================
# Use case: Generate face references
# =============================================================================


class ConsistentFaceNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="ConsistentFaceNode",
            display_name="Generate face references",
            category="api node/image/Replicate",
            description=(
                "Generate new images of the same character/face across scenes. "
                "Feed a reference face and a new prompt — Ideogram Character "
                "keeps identity stable while changing pose, scene, outfit. "
                "~$0.08 per image."
            ),
            inputs=[
                IO.Combo.Input("model", options=["Ideogram Character"], default="Ideogram Character"),
                IO.Image.Input("reference_image", tooltip="A clean front-on photo of the character."),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="New scene/pose/outfit — e.g. 'in a sunny park, holding a coffee'."),
                IO.Combo.Input(
                    "aspect_ratio",
                    options=["1:1", "16:9", "9:16", "4:3", "3:4", "16:10", "10:16"],
                    default="1:1",
                ),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFF, tooltip="0 = random."),
            ],
            outputs=[IO.Image.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.08,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, reference_image, prompt, aspect_ratio, seed):
        input_dict = {
            "prompt": prompt,
            "character_reference_image": _image_tensor_to_data_url(reference_image),
            "aspect_ratio": aspect_ratio,
        }
        if seed and seed > 0:
            input_dict["seed"] = seed
        pred = await _run_prediction("ideogram-ai/ideogram-character", input_dict)
        tensor = await download_url_to_image_tensor(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(tensor)


# =============================================================================
# Use case: Enhance a video (upscale / restore)
# =============================================================================


class EnhanceVideoNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="EnhanceVideoNode",
            display_name="Enhance a video",
            category="api node/video/Replicate",
            description=(
                "Upscale + denoise + sharpen video. Topaz Video Upscale is "
                "industry-grade. ~$0.50–$2.00 per clip depending on length."
            ),
            inputs=[
                IO.Combo.Input("model", options=["Topaz Video Upscale"], default="Topaz Video Upscale"),
                IO.String.Input("video_url", default="",
                                tooltip="Public URL of the source video (or data URL)."),
                IO.Combo.Input("target_resolution",
                               options=["720p", "1080p", "4k"],
                               default="1080p"),
                IO.Combo.Input("fps", options=["original", "30", "60"], default="original", advanced=True,
                               tooltip="Resample frame rate. 'original' keeps source fps (Topaz default 60)."),
            ],
            outputs=[IO.Video.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":1.00,"format":{"approximate":true}}'),
        )

    @classmethod
    async def execute(cls, model, video_url, target_resolution, fps):
        if not video_url:
            raise RuntimeError("video_url is required.")
        input_dict = {
            "video": video_url,
            "target_resolution": target_resolution,
        }
        if fps != "original":
            input_dict["target_fps"] = int(fps)
        pred = await _run_prediction(
            "topazlabs/video-upscale",
            input_dict,
            poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC,
        )
        video = await download_url_to_video_output(_first_output_url(pred), cls=cls)
        return IO.NodeOutput(video)


# =============================================================================
# Use case: Describe a video
# =============================================================================


class DescribeVideoNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="DescribeVideoNode",
            display_name="Describe a video",
            category="api node/video/Replicate",
            description=(
                "Send a video and a question, get back text. Powered by "
                "Google Gemini 2.5 Flash. Useful for "
                "captions, summaries, content analysis. ~$0.01 per request."
            ),
            inputs=[
                IO.Combo.Input("model", options=["Gemini 2.5 Flash"], default="Gemini 2.5 Flash"),
                IO.String.Input("video_url", default="",
                                tooltip="Public URL of the video to describe."),
                IO.String.Input("prompt", multiline=True,
                                default="Describe this video in detail.",
                                tooltip="What to ask. e.g. 'Summarize in one sentence.'"),
            ],
            outputs=[IO.String.Output(display_name="description")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.01,"format":{"approximate":true}}'),
        is_output_node=True,
        )

    @classmethod
    async def execute(cls, model, video_url, prompt):
        if not video_url:
            raise RuntimeError("video_url is required.")
        # google/gemini-2.5-flash accepts media as `videos: [url]` (array).
        input_dict = {
            "prompt": prompt,
            "videos": [video_url],
        }
        pred = await _run_prediction(
            "google/gemini-2.5-flash",
            input_dict,
            poll_deadline_sec=_VIDEO_POLL_DEADLINE_SEC,
        )
        out = pred.get("output")
        if isinstance(out, list):
            text = "".join(str(x) for x in out)
        elif isinstance(out, str):
            text = out
        else:
            text = str(out or "")
        return IO.NodeOutput(text.strip())


# =============================================================================
# Use case: Clone a singing voice (RVC)
# =============================================================================


_RVC_PRESET_VOICES = [
    "Squidward", "MrKrabs", "Plankton", "Drake", "Vader", "Trump", "Biden",
    "Obama", "Guitar", "Voilin", "CUSTOM",
]


class CloneSingingVoiceNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="CloneSingingVoiceNode",
            display_name="Clone a singing voice",
            category="api node/audio/Replicate",
            description=(
                "Re-sing a song in a different voice using RVC (Retrieval-"
                "based Voice Conversion). Pick a preset voice or paste a URL "
                "to a custom .zip RVC model. ~$0.02 per minute."
            ),
            inputs=[
                IO.Combo.Input("model", options=["Realistic Voice Cloning (RVC)"],
                               default="Realistic Voice Cloning (RVC)"),
                IO.Audio.Input("audio", tooltip="Song to re-sing (clean vocals preferred)."),
                IO.Combo.Input("rvc_model", options=_RVC_PRESET_VOICES, default="Squidward",
                               tooltip="Pre-trained voice. Choose CUSTOM to use a downloaded model."),
                IO.String.Input("custom_rvc_model_url", default="", advanced=True,
                                tooltip="URL to a .zip RVC model. Only used when rvc_model='CUSTOM'."),
                IO.Combo.Input("pitch_change",
                               options=["no-change", "male-to-female", "female-to-male"],
                               default="no-change",
                               tooltip="Octave shift preset based on the original singer's gender."),
                IO.Int.Input("pitch_shift_semitones", default=0, min=-12, max=12, advanced=True,
                             tooltip="Additional semitone shift on top of the gender preset."),
                IO.Combo.Input("pitch_detection_algorithm",
                               options=["rmvpe", "mangio-crepe"],
                               default="rmvpe", advanced=True),
                IO.Combo.Input("output_format", options=["mp3", "wav"], default="wav", advanced=True),
            ],
            outputs=[IO.Audio.Output()],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.02,"format":{"approximate":true,"suffix":"/min"}}'),
        )

    @classmethod
    async def execute(cls, model, audio, rvc_model, custom_rvc_model_url,
                      pitch_change, pitch_shift_semitones, pitch_detection_algorithm,
                      output_format):
        audio_url = _audio_dict_to_wav_data_url(audio, max_seconds=60)

        input_dict = {
            "song_input":                audio_url,
            "rvc_model":                 rvc_model,
            "pitch_change":              pitch_change,
            "pitch_change_all":          float(pitch_shift_semitones),
            "pitch_detection_algorithm": pitch_detection_algorithm,
            "output_format":             output_format,
        }
        if rvc_model == "CUSTOM" and custom_rvc_model_url:
            input_dict["custom_rvc_model_download_url"] = custom_rvc_model_url
        pred = await _run_prediction("zsxkib/realistic-voice-cloning", input_dict)
        audio_out = await _download_url_to_audio_dict(_first_output_url(pred))
        return IO.NodeOutput(audio_out)


# =============================================================================
# Use case: Identify speakers in audio (diarization + transcription)
# =============================================================================


class IdentifySpeakersNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="IdentifySpeakersNode",
            display_name="Identify speakers in audio",
            category="api node/audio/Replicate",
            description=(
                "Transcribe + label who said what. Returns a JSON array of "
                "segments: [{start, end, speaker, text}]. Useful for podcasts, "
                "interviews, meetings. ~$0.05 per audio minute."
            ),
            inputs=[
                IO.Combo.Input("model", options=["Whisper Diarization"], default="Whisper Diarization"),
                IO.Audio.Input("audio"),
                IO.Int.Input("num_speakers", default=0, min=0, max=20, step=1,
                             tooltip="0 = auto-detect. Set explicitly if you know."),
                IO.Combo.Input("language",
                               options=["auto","en","es","fr","de","it","pt","ja","ko","zh","ru","ar","hi"],
                               default="auto", advanced=True),
            ],
            outputs=[IO.String.Output(display_name="segments_json")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.05,"format":{"approximate":true,"suffix":"/min"}}'),
        is_output_node=True,
        )

    @classmethod
    async def execute(cls, model, audio, num_speakers, language):
        import json as _json
        audio_url = _audio_dict_to_wav_data_url(audio, max_seconds=60)

        input_dict = {"file": audio_url}
        if num_speakers > 0:
            input_dict["num_speakers"] = num_speakers
        if language and language != "auto":
            input_dict["language"] = language
        pred = await _run_prediction("thomasmol/whisper-diarization", input_dict)
        out_payload = pred.get("output")
        return IO.NodeOutput(_json.dumps(out_payload) if not isinstance(out_payload, str) else out_payload)


# =============================================================================
# Use case: Chat with an LLM
# =============================================================================
#
# Multi-model node — pick a frontier LLM and get text out. Each provider
# uses slightly different input field names so execute() dispatches per
# model, normalizing the shared inputs (prompt, system, temperature) to
# whatever Replicate's wrapper expects.

_CHAT_LLM_MODELS = ["GPT-5", "Claude 4.5 Sonnet", "Gemini 3 Flash"]


class ChatLLMNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="ChatLLMNode",
            display_name="Chat with an LLM",
            category="api node/text/Replicate",
            description=(
                "Send a prompt to a frontier LLM. GPT-5 = top "
                "general quality. Claude 4.5 Sonnet = thoughtful long-form. "
                "Gemini 3 Flash = fastest + cheapest. Output is plain text — "
                "wire downstream as a prompt for image/video gen, or as final."
            ),
            inputs=[
                IO.Combo.Input("model", options=_CHAT_LLM_MODELS, default="Gemini 3 Flash",
                               tooltip="GPT-5: top quality. Claude: long-form reasoning. Gemini Flash: fastest + cheapest."),
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="What to ask. Plain text — model-specific formatting handled internally."),
                IO.String.Input("system_prompt", multiline=True, default="", advanced=True,
                                tooltip="Optional system instruction. e.g. 'You are a concise copywriter.'"),
                IO.Float.Input("temperature", default=1.0, min=0.0, max=2.0, step=0.05, advanced=True),
                IO.Int.Input("max_tokens", default=1024, min=1, max=8192, step=64, advanced=True),
            ],
            outputs=[IO.String.Output(display_name="response")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.005,"format":{"approximate":true}}'),
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, model, prompt, system_prompt, temperature, max_tokens):
        if model == "GPT-5":
            input_dict = {"prompt": prompt, "temperature": temperature, "max_completion_tokens": max_tokens}
            if system_prompt: input_dict["system_prompt"] = system_prompt
            slug = "openai/gpt-5"
        elif model == "Claude 4.5 Sonnet":
            input_dict = {"prompt": prompt, "temperature": temperature, "max_tokens": max_tokens}
            if system_prompt: input_dict["system_prompt"] = system_prompt
            slug = "anthropic/claude-4.5-sonnet"
        elif model == "Gemini 3 Flash":
            input_dict = {"prompt": prompt, "temperature": temperature, "max_output_tokens": max_tokens}
            if system_prompt: input_dict["system_instruction"] = system_prompt
            slug = "google/gemini-3-flash"
        else:
            raise RuntimeError(f"unknown model: {model}")
        pred = await _run_prediction(slug, input_dict)
        out = pred.get("output")
        # LLMs typically stream tokens — Replicate gathers them into a list of strings.
        if isinstance(out, list):
            text = "".join(str(x) for x in out)
        elif isinstance(out, str):
            text = out
        else:
            text = str(out or "")
        return IO.NodeOutput(text.strip())


# =============================================================================
# Use case: Improve a prompt
# =============================================================================
#
# Specialized prompt-engineering helper: takes the user's plain-English
# image or video idea and rewrites it as a detailed prompt that image/video
# models respond to better. Uses GPT-5-nano — small, cheap, fast.

_IMPROVE_PROMPT_SYSTEM_BASE = (
    "You are a prompt engineer for diffusion {kind} generation models. "
    "Rewrite the user's idea into a concrete, vivid, descriptive {kind} prompt. "
    "Include: subject, action, setting, lighting, camera/style, mood. "
    "Keep it under 80 words. No preamble, no explanation — output ONLY the "
    "improved prompt, nothing else."
)


class ImprovePromptNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="ImprovePromptNode",
            display_name="Improve a prompt",
            category="api node/text/Replicate",
            description=(
                "Rewrite a rough idea into a detailed prompt that image/video "
                "models respond to. Adds composition, lighting, style hints. "
                "Uses GPT-5-nano (fast + cheap, ~$0.001/call)."
            ),
            inputs=[
                IO.Combo.Input("model", options=["GPT-5 nano"], default="GPT-5 nano"),
                IO.String.Input("idea", multiline=True, default="",
                                tooltip="Your rough idea, plain English. e.g. 'a cat on a skateboard'."),
                IO.Combo.Input("target", options=["image", "video"], default="image",
                               tooltip="Tunes the rewrite for image vs video output."),
            ],
            outputs=[IO.String.Output(display_name="improved_prompt")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.001,"format":{"approximate":true}}'),
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, model, idea, target):
        system = _IMPROVE_PROMPT_SYSTEM_BASE.format(kind=target)
        input_dict = {
            "prompt": idea,
            "system_prompt": system,
            "temperature": 0.7,
            "max_completion_tokens": 200,
        }
        pred = await _run_prediction("openai/gpt-5-nano", input_dict)
        out = pred.get("output")
        if isinstance(out, list):
            text = "".join(str(x) for x in out)
        elif isinstance(out, str):
            text = out
        else:
            text = str(out or "")
        return IO.NodeOutput(text.strip())


# =============================================================================
# Shared LLM dispatch — normalized inputs across provider families
# =============================================================================
#
# Replicate exposes each frontier-model family with subtly different input
# field names: OpenAI wants `max_completion_tokens`, Anthropic wants
# `max_tokens`, Google wants `max_output_tokens` + `system_instruction`.
# Centralizing the dispatch keeps every use-case node below tiny.

_LLM_MODEL_SLUGS: dict[str, tuple[str, str]] = {
    # alias                  -> (replicate slug,                  family)
    "GPT-5":              ("openai/gpt-5",                "openai"),
    "GPT-5 mini":         ("openai/gpt-5-mini",           "openai"),
    "GPT-5 nano":         ("openai/gpt-5-nano",           "openai"),
    "Claude 4.5 Sonnet":  ("anthropic/claude-4.5-sonnet", "anthropic"),
    "Claude 4.5 Haiku":   ("anthropic/claude-4.5-haiku",  "anthropic"),
    "Gemini 3 Flash":     ("google/gemini-3-flash",       "google"),
    # DeepSeek's Replicate wrapper takes OpenAI-shaped inputs.
    "DeepSeek R1":        ("deepseek-ai/deepseek-r1",     "openai"),
}


async def _run_llm(
    model: str,
    prompt: str,
    *,
    system: str = "",
    temperature: float = 0.7,
    max_tokens: int = 1024,
) -> str:
    """Run any registered chat-LLM on Replicate with normalized inputs.
    Returns the joined text output, trimmed.
    """
    if model not in _LLM_MODEL_SLUGS:
        raise RuntimeError(f"unknown LLM alias: {model}")
    slug, family = _LLM_MODEL_SLUGS[model]
    if family == "openai":
        d: dict = {"prompt": prompt, "temperature": temperature, "max_completion_tokens": max_tokens}
        if system: d["system_prompt"] = system
    elif family == "anthropic":
        d = {"prompt": prompt, "temperature": temperature, "max_tokens": max_tokens}
        if system: d["system_prompt"] = system
    elif family == "google":
        d = {"prompt": prompt, "temperature": temperature, "max_output_tokens": max_tokens}
        if system: d["system_instruction"] = system
    else:
        raise RuntimeError(f"unknown LLM family: {family}")
    pred = await _run_prediction(slug, d)
    out = pred.get("output")
    if isinstance(out, list):
        return "".join(str(x) for x in out).strip()
    if isinstance(out, str):
        return out.strip()
    return str(out or "").strip()


# =============================================================================
# Use case: Summarize text
# =============================================================================
#
# Long text in, short summary out. Defaults to the smallest+cheapest model
# in each family because compression is a low-leverage task — paying premium
# for it is wasteful.

_SUMMARIZE_MODELS = ["Gemini 3 Flash", "GPT-5 nano", "Claude 4.5 Haiku"]
_SUMMARIZE_LENGTHS = {
    "1 sentence":  "Reply with a single sentence. No preamble.",
    "Short":       "Reply with 2-3 sentences. No preamble, no bullets.",
    "Medium":      "Reply with a 4-6 sentence paragraph. No preamble.",
    "Bullets":     "Reply with 3-6 short bullet points. Use '-' as the bullet marker. No preamble.",
}


class SummarizeTextNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SummarizeTextNode",
            display_name="Summarize text",
            category="api node/text/Replicate",
            description=(
                "Compress long text into a short summary. Wire in a transcript, "
                "article, or any string; pick a length style; get a tight version "
                "back. Defaults to Gemini Flash — fastest + cheapest."
            ),
            inputs=[
                IO.String.Input("text", multiline=True, default="",
                                tooltip="Source text to summarize. Plain text — formatting will be flattened."),
                IO.Combo.Input("length", options=list(_SUMMARIZE_LENGTHS.keys()), default="Short",
                               tooltip="Output shape: one sentence, a few, a paragraph, or bullets."),
                IO.Combo.Input("model", options=_SUMMARIZE_MODELS, default="Gemini 3 Flash", advanced=True),
            ],
            outputs=[IO.String.Output(display_name="summary")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.001,"format":{"approximate":true}}'),
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, text, length, model):
        if not (text or "").strip():
            return IO.NodeOutput("", ui={"text": [""]})
        system = (
            "You are a precise summarizer. " + _SUMMARIZE_LENGTHS[length] +
            " Preserve key facts, names, numbers, and intent. Strip filler. "
            "Output the summary directly — no headers like 'Summary:'."
        )
        result = await _run_llm(model, text, system=system, temperature=0.3, max_tokens=400)
        return IO.NodeOutput(result, ui={"text": [result]})


# =============================================================================
# Use case: Translate text
# =============================================================================
#
# Gemini Flash is strong + cheap on common language pairs; Claude Haiku is
# a fallback when the user wants more nuance on idioms / tone. The "Other"
# language option lets you free-type anything Replicate's LLMs can handle
# (Welsh, Tagalog, Esperanto — they all work).

_TRANSLATE_LANGUAGES = [
    "English", "Spanish", "French", "German", "Italian", "Portuguese",
    "Dutch", "Polish", "Russian", "Arabic", "Hebrew",
    "Japanese", "Chinese (Simplified)", "Chinese (Traditional)", "Korean",
    "Hindi", "Vietnamese", "Thai", "Turkish",
]


class TranslateTextNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="TranslateTextNode",
            display_name="Translate text",
            category="api node/text/Replicate",
            description=(
                "Translate text between languages. Pick the target language; "
                "the source is auto-detected. Preserves tone and intent — "
                "doesn't pad with explanations."
            ),
            inputs=[
                IO.String.Input("text", multiline=True, default="",
                                tooltip="Text to translate. Source language is auto-detected."),
                IO.Combo.Input("target_language", options=_TRANSLATE_LANGUAGES, default="English",
                               tooltip="Target language."),
                IO.String.Input("custom_language", default="", advanced=True,
                                tooltip="Override target language (e.g. 'Welsh', 'Catalan'). Takes precedence if non-empty."),
            ],
            outputs=[IO.String.Output(display_name="translation")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.001,"format":{"approximate":true}}'),
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, text, target_language, custom_language):
        if not (text or "").strip():
            return IO.NodeOutput("", ui={"text": [""]})
        target = (custom_language or "").strip() or target_language
        system = (
            f"You are a professional translator. Translate the user's text into {target}. "
            "Preserve tone, register, and intent. Keep proper nouns intact unless conventionally translated. "
            "Output ONLY the translation — no source, no explanation, no quotes around it."
        )
        result = await _run_llm("Gemini 3 Flash", text, system=system, temperature=0.2, max_tokens=2048)
        return IO.NodeOutput(result, ui={"text": [result]})


# =============================================================================
# Use case: Rewrite in a tone
# =============================================================================
#
# Style transfer for prose. Claude Haiku is the default — Anthropic models
# tend to land tone shifts more cleanly than GPT, in our testing, without
# inventing new content. Tone options cover the common copywriting needs.

_REWRITE_MODELS = ["Claude 4.5 Haiku", "Gemini 3 Flash", "Claude 4.5 Sonnet"]
_REWRITE_TONES = [
    "Punchy",
    "Concise",
    "Formal",
    "Casual",
    "Friendly",
    "Professional",
    "Playful",
    "Poetic",
    "Witty",
    "Persuasive",
    "Plain",
]
_TONE_GUIDANCE: dict[str, str] = {
    "Punchy":       "Make it punchy. Short sentences. Active verbs. Cut filler. Land a hook.",
    "Concise":      "Tighten ruthlessly. Same meaning, half the words.",
    "Formal":       "Make it formal and precise. Avoid contractions and colloquialisms.",
    "Casual":       "Make it casual and conversational. Use contractions. Sound like a person, not a brand.",
    "Friendly":     "Warm and approachable, like talking to a friend. No corporate-speak.",
    "Professional": "Polished and business-appropriate. Confident, not stiff.",
    "Playful":      "Lean into wordplay, light humor, gentle surprise. Don't overdo it.",
    "Poetic":       "More lyrical. Sensory imagery, rhythm, deliberate cadence.",
    "Witty":        "Add wit — clever turns of phrase, sharp observations. Punch up the prose.",
    "Persuasive":   "Persuasive copy. Strong verbs, clear benefit, subtle urgency.",
    "Plain":        "Plain English. No jargon, no buzzwords. A smart 14-year-old should follow it.",
}


class RewriteToneNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="RewriteToneNode",
            display_name="Rewrite in a tone",
            category="api node/text/Replicate",
            description=(
                "Rewrite text in a different tone — punchy, formal, casual, "
                "poetic, etc. — without changing the meaning. Useful for "
                "iterating marketing copy, UX strings, or social posts."
            ),
            inputs=[
                IO.String.Input("text", multiline=True, default="",
                                tooltip="Text to rewrite."),
                IO.Combo.Input("tone", options=_REWRITE_TONES, default="Punchy",
                               tooltip="Target tone / register."),
                IO.Combo.Input("model", options=_REWRITE_MODELS, default="Claude 4.5 Haiku", advanced=True),
            ],
            outputs=[IO.String.Output(display_name="rewritten")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.002,"format":{"approximate":true}}'),
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, text, tone, model):
        if not (text or "").strip():
            return IO.NodeOutput("", ui={"text": [""]})
        guidance = _TONE_GUIDANCE.get(tone, f"Rewrite in a {tone.lower()} tone.")
        system = (
            "You are a careful copy editor. Rewrite the user's text in the target tone "
            "while preserving the original meaning, facts, and structure. " + guidance +
            " Output ONLY the rewritten text — no preamble, no notes, no quotes."
        )
        result = await _run_llm(model, text, system=system, temperature=0.6, max_tokens=1024)
        return IO.NodeOutput(result, ui={"text": [result]})


# =============================================================================
# Use case: Brainstorm ideas
# =============================================================================
#
# Generates N variants of a prompt/idea in a single LLM call, newline-
# separated. Pairs directly with the multi-entry Text artifact node — wire
# the output in and each line lands in its own slot (no per-variant LLM
# call needed). Uses GPT-5 mini: enough creative spark, modest cost.

_BRAINSTORM_ANGLES: dict[str, str] = {
    "Variations":   "Generate distinct phrasings of the same core idea — same intent, different angles, vocabulary, or focus.",
    "Expansions":   "Each idea should extend or build on the topic — go deeper, add a twist, push the concept further.",
    "Opposites":    "Each idea should explore an opposite, inverse, or contrarian take on the topic.",
    "Styles":       "Each idea should reframe the topic in a different style or genre (noir, minimalist, maximalist, retro, etc.).",
    "Audiences":    "Each idea should target a different audience or context (kids, experts, marketers, skeptics, etc.).",
    "Free":         "Generate distinct, creative ideas related to the topic. Vary widely.",
}


class BrainstormIdeasNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="BrainstormIdeasNode",
            display_name="Brainstorm ideas",
            category="api node/text/Replicate",
            description=(
                "Generate N distinct ideas from a topic, one per line. Wire "
                "the output into a Text artifact and each line becomes its "
                "own entry — perfect for fan-out across image/video runs."
            ),
            inputs=[
                IO.String.Input("topic", multiline=True, default="",
                                tooltip="The topic or starting idea. e.g. 'A poster for a coffee shop'."),
                IO.Int.Input("count", default=3, min=2, max=12, step=1,
                             tooltip="How many ideas to generate."),
                IO.Combo.Input("angle", options=list(_BRAINSTORM_ANGLES.keys()), default="Variations",
                               tooltip="How the variants should differ from each other."),
            ],
            outputs=[IO.String.Output(display_name="ideas")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.003,"format":{"approximate":true}}'),
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, topic, count, angle):
        if not (topic or "").strip():
            return IO.NodeOutput("", ui={"text": [""]})
        guidance = _BRAINSTORM_ANGLES.get(angle, _BRAINSTORM_ANGLES["Free"])
        system = (
            f"You generate exactly {count} ideas from a topic. {guidance} "
            "Output ONLY the ideas, one per line, with no numbering, no bullets, "
            "no preamble, no trailing commentary. Each line is a single complete idea. "
            "No blank lines between ideas."
        )
        result = await _run_llm("GPT-5 mini", topic, system=system, temperature=0.9, max_tokens=600)
        # Defensive cleanup: strip bullets / numbering the model might still emit,
        # collapse blank lines, cap at the requested count.
        lines: list[str] = []
        for raw in (result or "").splitlines():
            s = raw.strip()
            if not s: continue
            # Strip leading "1.", "1)", "-", "•", "*" markers.
            while s and (s[0] in "-•*" or (len(s) >= 2 and s[0].isdigit() and s[1] in ".)")):
                if s[0] in "-•*":
                    s = s[1:].lstrip()
                else:
                    # numbered: drop up to the punctuation, then any space
                    cut = 2
                    while cut < len(s) and s[cut - 1].isdigit():
                        cut += 1
                    s = s[cut:].lstrip()
            if s:
                lines.append(s)
        lines = lines[:count]
        joined = "\n".join(lines)
        return IO.NodeOutput(joined, ui={"text": [joined]})


# =============================================================================
# Use case: Think step by step
# =============================================================================
#
# Reasoning-focused node — leverages DeepSeek R1 (RL-trained reasoning) or
# a frontier model with explicit chain-of-thought prompting. By default we
# strip the reasoning and return just the conclusion; toggle
# `include_reasoning` to see the model's working.

_REASON_MODELS = ["DeepSeek R1", "GPT-5", "Claude 4.5 Sonnet"]


class ReasonStepByStepNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="ReasonStepByStepNode",
            display_name="Think step by step",
            category="api node/text/Replicate",
            description=(
                "Ask a reasoning question — math, logic, planning, multi-step "
                "decisions — and get a worked answer. Defaults to returning "
                "just the conclusion; flip `include_reasoning` to see why."
            ),
            inputs=[
                IO.String.Input("question", multiline=True, default="",
                                tooltip="The question or problem. Be specific."),
                IO.Boolean.Input("include_reasoning", default=False,
                                 tooltip="If true, returns the full chain of thought plus the answer. Otherwise just the final answer."),
                IO.Combo.Input("model", options=_REASON_MODELS, default="DeepSeek R1", advanced=True),
            ],
            outputs=[IO.String.Output(display_name="answer")],
            price_badge=IO.PriceBadge(expr='{"type":"usd","usd":0.01,"format":{"approximate":true}}'),
            is_output_node=True,
        )

    @classmethod
    async def execute(cls, question, include_reasoning, model):
        if not (question or "").strip():
            return IO.NodeOutput("", ui={"text": [""]})
        if include_reasoning:
            system = (
                "You are a careful reasoner. Think step by step, showing your work clearly. "
                "End with a line that starts with 'Answer:' followed by the final answer."
            )
        else:
            system = (
                "You are a careful reasoner. Think step by step internally, then output "
                "ONLY the final answer — concise, direct, no preamble, no 'Answer:' prefix, "
                "no working shown."
            )
        result = await _run_llm(model, question, system=system, temperature=0.4, max_tokens=2048)
        return IO.NodeOutput(result, ui={"text": [result]})


# ---------- Extension registration -----------------------------------------

class ReplicateExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [
            # ─── Use-case nodes (the user-facing surface) ───
            # Image — generation
            FluxLoRARemoteNode,         # Generate an image with a style — kept separate
            FluxMultiLoRARemoteNode,    # Stack up to 4 LoRAs (character + style + accents) · flux-dev-multi-lora
            GenerateImageNode,          # Generate an image · Flux Pro / Ideogram
            ConsistentFaceNode,         # Generate face references · Ideogram Character
            SketchToImageNode,          # Sketch to image · Nano Banana
            # Image — manipulation
            GenerateFromReferencesNode, # Generate from references · Seedream 5 Pro/Lite / Nano Banana 2
            EditImageNode,              # Edit an image · Flux Kontext
            DevelopImageNode,           # Develop · sketch → finished (Nano Banana 2)
            BlendSceneNode,             # Blend Scene · Flux Kontext / Nano Banana
            RestyleFromImageNode,       # Restyle from Image · Nano Banana / IP-Adapter
            RestyleWithLoRANode,        # Restyle an Image · Style LoRA — describe→flux-lora→nano-banana
            ProductShotNode,            # Product Shot · catacolabs/sdxl-ad-inpaint
            RotateCameraNode,           # Rotate camera · Qwen-Image-Edit-Plus
            TextEffectNode,             # Text effect · Ideogram v3
            UpscaleImageNode,           # Upscale an image · Clarity
            EnhanceDetailNode,          # Enhance Detail · Clarity / Topaz / Magic Refiner
            RemoveBackgroundNode,       # Remove background · 851-labs/bg-remover
            RestorePhotoNode,           # Restore an old photo · Flux Kontext Restore
            FixFacesNode,               # Fix faces in a photo · CodeFormer
            LayerizeGraphicNode,        # Separate text from image · Ideogram Layerize
            SplitPhotoLayersNode,       # Separate background and foreground · bg-remover + LaMa/Bria Eraser
            SeedreamLayerizeNode,       # Layerize an image (raster layers) · Seedream 5 Pro Layerize
            OutpaintImageNode,          # Expand / outpaint an image · Flux Fill / Bria Expand
            # Image — analysis
            DescribeImageNode,          # Describe an image · Moondream 2
            ExtractTextNode,            # Extract text from image (OCR) · Dolphin
            FindObjectsNode,            # Find objects in an image · YOLO-World
            # Video
            GenerateVideoNode,          # Generate a video · Seedance / Veo 3 / Kling
            FilmShotNode,               # Film a shot · cinematic framing presets
            EnhanceVideoNode,           # Enhance a video · Topaz
            DescribeVideoNode,          # Describe a video · Gemini 2.5 Flash
            LipsyncNode,                # Sync lips to audio · sync.so 2-pro
            LipSyncNode,                # Lip-sync a character · Fabric 1.0 / sync 2-pro
            # Audio
            TranscribeAudioNode,        # Transcribe audio · Whisper
            IdentifySpeakersNode,       # Identify speakers in audio · Whisper Diarization
            GenerateMusicNode,          # Generate music · MusicGen
            GenerateSpeechNode,         # Generate speech · MiniMax Speech-02 HD
            CloneSingingVoiceNode,      # Clone a singing voice · RVC
            # 3D
            Generate3DNode,             # Generate a 3D model · Hunyuan3D 2
            # Text / LLM
            ChatLLMNode,                # Chat with an LLM · GPT-5 / Claude / Gemini
            ImprovePromptNode,          # Improve a prompt · GPT-5 nano
            SummarizeTextNode,          # Summarize text · Gemini 3 Flash (default)
            TranslateTextNode,          # Translate text · Gemini 3 Flash
            RewriteToneNode,            # Rewrite in a tone · Claude 4.5 Haiku
            BrainstormIdeasNode,        # Brainstorm ideas (N variants) · GPT-5 mini
            ReasonStepByStepNode,       # Think step by step · DeepSeek R1

            # ─── Per-model nodes (deprecated — kept for workflow back-compat) ───
            # Hidden from the Generators panel via its DEPRECATED_NODES list.
            FluxProRemoteNode,
            IdeogramV3TurboNode,
            FluxKontextRemoteNode,
            ClarityUpscaleRemoteNode,
            RemoveBackgroundRemoteNode,
            RestorePhotoRemoteNode,
            CodeformerRemoteNode,
            DescribeImageRemoteNode,
            Seedance2RemoteNode,
            Veo3RemoteNode,
            KlingVideoRemoteNode,
            LipsyncRemoteNode,
            WhisperRemoteNode,
            MusicGenRemoteNode,
            MiniMaxSpeechRemoteNode,
            Hunyuan3DRemoteNode,
            Hunyuan3DMultiViewNode,
        ]


async def comfy_entrypoint() -> ReplicateExtension:
    return ReplicateExtension()
