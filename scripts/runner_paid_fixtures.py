"""Writes frontend/tests/unit/fixtures/runner-paid-<group>.json: what the REAL
Python gives for Sailor's paid-node runner (step 3, stage R3), for the
TypeScript ports to be measured against. One file per group, keys sorted,
stable bytes (run it twice: the second time `git diff --stat` shows nothing).

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_paid_fixtures.py --group machinery

`--self-check` runs capture_calls on real classes and writes nothing.

Each R3 task adds its group: a list of node cases made by `paid_case`, which
runs the class's real `execute` through `capture_calls` (every provider call,
upload, download, save and JSON-link fetch patched out) and records the calls
Python makes, in order, and what the node returns.

Groups:
  machinery  (R3.1) Python's json module and float repr, for
             frontend/shared/runner/pyJson.ts (tests/unit/py-json.unit.spec.ts):
               bodies  — JSON body texts with json.dumps(json.loads(text)), or
                         `error` where json.loads refuses the text
               scalars — str(json.loads(text)) of every kind of scalar
               floats  — 10,000 seeded doubles (their IEEE-754 bits, big-endian
                         hex) with repr()
  llm        (R3.3) the seven LLM text nodes (Chat with an LLM, Improve a prompt,
             Summarize, Translate, Rewrite in a tone, Brainstorm ideas, Think
             step by step), for frontend/server/runner/generators/llm.ts
             (tests/unit/runner-paid-llm.unit.spec.ts):
               cases          — paid_case of every class × model × text kind
                                (blank, spaces, one line, 2,000 characters,
                                non-ASCII, emoji) and of every setting the
                                brief names, with token-list, string, null,
                                mixed and multi-line answers
               isdigit_ranges — the code points str.isdigit() accepts, as
                                [first, last] ranges (Brainstorm's clean-up)
  repair     (R3.5) Upscale (every engine), Enhance detail (every engine),
             Restore an old photo and Remove background (and their hidden
             twins), for frontend/server/runner/generators/repair.ts
             (tests/unit/runner-paid-repair.unit.spec.ts)
  layers     (R3.6) Separate text from image (Layerize), Layerize an image
             (Seedream) and Expand / outpaint (Flux Fill, Bria Expand), for
             frontend/server/runner/generators/layers.ts
             (tests/unit/runner-paid-layers.unit.spec.ts)
  split      (R3.7) Separate background and foreground: both fill engines,
             mask_grow 0, 1, 12 and 50, RGB and RGBA inputs, cut-outs PIL
             reads its own way (grey + alpha, palette, CMYK, 16-bit grey) and
             one with no alpha (Python still makes two calls: a downloaded
             picture is always read as RGBA), for
             frontend/server/runner/generators/splitLayers.ts; and PIL's
             MaxFilter alone on masks touching every edge and corner, for
             frontend/server/runner/pixels/maxFilter.ts
             (tests/unit/runner-paid-split.unit.spec.ts)
  audio-gen  (R3.8) Generate music and Generate speech, and their hidden twins
             (MusicGen, MiniMax Speech-02 HD): every music version at 1 s and
             30 s, top_p and seeds, every emotion and language boost, the
             speed, pitch and volume bounds, a non-ASCII text, a cloned
             voice, for frontend/server/runner/generators/audioGen.ts
             (tests/unit/runner-paid-audio-gen.unit.spec.ts)
  sound-in   (R3.10) Transcribe audio and its hidden twin (Whisper on fal's
             Wizper), Identify speakers, Clone a singing voice and Sync lips to
             audio and its hidden twin: every language, translate, speaker
             counts, RVC presets, pitch settings and formats, every sync mode
             and address kind, Wizper answers with the text missing, null,
             spaced and non-ASCII; and the WAV Python sends for the standard
             clips (3 s mono and stereo at 16, 44.1 and 48 kHz, 75 s clips cut
             at 60 s, float clips beyond ±1), by samples, for
             frontend/server/runner/generators/soundIn.ts and soundWav.ts
             (tests/unit/runner-paid-sound-in.unit.spec.ts)
  gen-3d     (R3.9) Generate a 3D model and its hidden twin (Hunyuan3D 2), and
             Multi-View → 3D on each engine (TRELLIS, Rodin, Hunyuan3D-2mv)
             with one, two and four views; seeds 0, 1, 65,536 and 2**32 - 1;
             Rodin's prompts, polygon counts and qualities; each answer shape
             (a list, a string, a dict with or without `model_file`, Hunyuan3D
             2's `{mesh}`), for frontend/server/runner/generators/gen3d.ts
             (tests/unit/runner-paid-3d.unit.spec.ts)
  film-shot  (R3.11) Film a shot's preset path, for
             frontend/shared/runner/shotPresets.ts and the FilmShotNode case
             of frontend/server/runner/executors.ts
             (tests/unit/runner-paid-film-shot.unit.spec.ts):
               phrases — shot_presets.py itself: every preset in every
                         dialect, each override option on its own and all
                         five at once, an unknown preset, dialect_for_model
               cases   — capture_first_call on FilmShotNode (fix round 1: every
                         `__shot_directed` value Python's bool() reads, and a
                         negative prompt in the options): every preset ×
                         a Veo, a Hailuo and a standard model × a blank and a
                         spaced prompt; each override option on its own and
                         all five at once on the three; an unknown preset;
                         model_options bad JSON, a list, `__shot_directed:
                         false`; every model in the node's list with and
                         without `image` (the phrase Python built is kept
                         with each call)
               runs    — paid_case (capture_calls) of a few preset shots with
                         the provider's answer, for the engine run
  image-extras (R3.12) Text effect (every effect on both paths at every
             freedom, every ratio, the seeds, the texts, text_effects.py's own
             catalogue and functions), Sketch to image and Generate face
             references (blank and non-ASCII prompts, every ratio, the seeds),
             for frontend/server/runner/generators/textEffects.ts and
             imageExtras.ts (tests/unit/runner-paid-image-extras.unit.spec.ts)
  lora       (R3.13) Flux Dev + LoRA (every kind of sidecar in a temporary
             models/loras/, every form of lora_url, the HuggingFace look-up
             found / not found / offline, image-to-image, the seeds) and Flux
             Dev + LoRAs (0, 1, 2 and 4 slots, repeated LoRAs, prompt_in and
             style_in, logs with and without "Downloading LoRA weights": the
             reload retry, the order toggle), for
             frontend/server/runner/generators/lora.ts
             (tests/unit/runner-paid-lora.unit.spec.ts)
  restyle-lora (R3.14) Restyle an Image · Style LoRA (Moondream caption, the
             LoRA's Flux Dev restyle, Moondream's photo-or-illustration
             verdicts and up to three Nano Banana 2 passes on fal): style
             strength 0, 0.5 and 1 with the Flux strength derived and set;
             a trained model, sidecars with a trigger and an aesthetic, links
             and a bare ref looked up; a photo target, an illustration target
             that holds on the first pass, on the third and never; classifiers
             that fail; an empty caption; the seeds (0xFFFFFFFF: the mask on
             Nano Banana's seed); every resolution and format, for
             frontend/server/runner/generators/restyleLora.ts
             (tests/unit/runner-paid-restyle-lora.unit.spec.ts)
  nano-extras (R3.15) Lens · 3D Reframe (every lens pair, Custom at focal 10
             and 300, the strengths) and Pose Mannequin (every branch of
             execute: image, prompt and mannequin modes, baked results with
             EXIF orientation 6, missing files, the conditioning render Python
             raises on), for frontend/server/runner/generators/nanoExtras.ts
             (tests/unit/runner-paid-nano-extras.unit.spec.ts)
  turntable  (R3.16) Turntable, front view only (Luma Ray 2 720p, both
             directions, blank, spaced, non-ASCII and missing instructions,
             each answer shape) and _turntable_plan.py's plan_segments for
             every subset of views and both directions (for R3.17), for
             frontend/server/runner/generators/turntable.ts
             (tests/unit/runner-paid-turntable.unit.spec.ts)
  turntable-views (R3.17) Turntable with views: every subset of the three
             views × both directions, Seedance 2.0 first → last frame calls on
             fal, and stitch_clips of the answers' clips (small H.264 clips,
             smooth, noisy and of two sizes; a failure at segment 3), each
             stitched file recorded with libx264 and switched to libopenh264
             (frame hashes, counts, rates, lengths), for
             frontend/server/runner/generators/turntable.ts
             (tests/unit/runner-paid-turntable-views.unit.spec.ts)
  handoff2  (R3.H2) the PNG `_image_tensor_to_data_url` sends for a picture
             made in the run: a provider's answer of every file kind (PIL's
             RGBA), Expand / outpaint's answer with its alpha dropped, and an
             effect's float32 tensor (from LoadImage, an Image card with
             see-through pixels, and a provider's answer), each sent on by
             Edit an image (fal), for frontend/server/runner/pictureHandoff.ts
             (tests/unit/runner-handoff2-parity.unit.spec.ts)
  handoff   (R3.H) the PNG `_image_tensor_to_data_url` sends for a loader's
             tensor: every file kind (EXIF 2–8, RGBA, grey + alpha, palette and
             colour-key transparency, CMYK, 16-bit, WebP, GIF…) through the real
             LoadImage and the real Image card, sent by Edit an image (fal) and
             Remove object (Replicate), for
             frontend/server/runner/pictures/handoffView.ts
             (tests/unit/runner-handoff-parity.unit.spec.ts)
  local-cutout (R7.1) Background remove (comfy_extras/nodes_bg_remove.py) with
             its model swapped for a stand-in `rembg.remove` (no model file, no
             network: os.path.isfile and the session patched) that answers a
             recorded RGBA picture: soft, hard and empty alpha × each `output`
             × edge_softness 0, 2 and 10 on a 48 × 40 picture; a batch of three
             frames (one answer each, as a clip); a 7 × 5 picture with the
             blur wider than it; an answer in grey + alpha. Each records the
             answer PNG, the node's float32 outputs (sha256; whole when small),
             their 8-bit forms, the mask, and the live preview Python wrote
             (save_live_preview(unique=True)), for
             frontend/server/runner/generators/localModels.ts and
             frontend/server/runner/pixels/cutout.ts
             (tests/unit/runner-local-cutout.unit.spec.ts)
  local-erase (R7.3) Object removal (comfy_extras/nodes_object_remove.py →
             _inpaint.py): cv2.dilate recorded directly (Python's 8 bits of
             the mask — LoadImage's 1 − a/255, soft, hard, every edge and
             corner, all black — grown 0, 1, 4 and 64 times on 29 × 19, 3 × 2
             and 1 × 1), and the real execute with LaMa's session and its
             512 × 512 resizes swapped for stand-ins, so the composite is of a
             recorded full-size fill (the provider's answer): grow 0 / 4 / 64,
             an all-black mask (no call), a clip of three frames with one mask
             and a mask per frame. Each records the output tensor, its 8-bit
             forms and the live preview, for
             frontend/server/runner/generators/localModels.ts and
             frontend/server/runner/pixels/erase.ts
             (tests/unit/runner-local-erase.unit.spec.ts)
  local-masks (R7.4) Mask by text and Mask extractor (comfy_extras/nodes_matte_ml.py)
             with CLIPSeg and SAM swapped for stand-ins: CLIPSeg's logits at the
             picture's own size (hard ±1000, soft with exact 0.5s), so its
             resize is the identity; SAM's three candidate masks and scores. The
             real execute then thresholds, feathers, inverts and previews:
             every threshold, feather and invert edge, a batch of two pictures,
             a feather wider than the picture (Python fails), and the click
             texts Python reads (bad, empty, non-list, clamped, string numbers,
             bools, several points, and the ones Python fails on). Each records
             what the stand-in was sent, the mask and the preview, for
             frontend/server/runner/generators/localModels.ts,
             frontend/shared/runner/samInput.ts and
             frontend/server/runner/pixels/samMask.ts
             (tests/unit/runner-local-masks.unit.spec.ts)
  e2e    (R3.18) the controller check's chained workflows no single-node
             case covers, node by node (Summarize → Generate an image;
             Separate background and foreground → Frame; Upscale → Remove
             background → Save image; Restyle held on the second pass; Flux
             Dev + LoRAs with a picture), for
             frontend/tests/unit/runner-paid-e2e.unit.spec.ts

The network is blocked (as in compositor_fixtures.py): every outbound connect
and DNS lookup raises and the provider keys are removed before any node module
is imported. Nothing here needs the network. The node-level helpers of
runner_builder_fixtures.py (its module list and save helpers) are imported
only inside capture_calls, after the block: importing that module loads
comfy_api_nodes.image_models at once.
"""
import asyncio
import contextlib
import json
import os
import random
import socket
import struct
import sys
from unittest import mock

PROVIDER_KEYS = ("FAL_KEY", "FAL_API_KEY", "NUXT_REPLICATE_TOKEN", "REPLICATE_API_TOKEN")


def block_network() -> None:
    def refuse(*a, **_k):
        raise RuntimeError(f"NETWORK BLOCKED: {a!r}")
    socket.socket.connect = refuse
    socket.socket.connect_ex = refuse
    socket.create_connection = refuse
    socket.getaddrinfo = refuse
    for key in PROVIDER_KEYS:
        os.environ.pop(key, None)


if __name__ == "__main__" and "--allow-network" not in sys.argv[1:]:
    block_network()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
FIXTURES = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures")


# ── capture_calls (R3.2): every provider call a node's execute() makes ──────

class UnservedGet(BaseException):
    """A GET the case didn't serve. A BaseException, so a node's own
    `except Exception` (the HuggingFace look-up, a layer-JSON fetch) can't
    swallow it and quietly take another branch; capture_calls also refuses the
    case after the run if one was ever raised."""


def png_bytes(w: int, h: int, seed: int, mode: str = "RGB") -> bytes:
    """A small deterministic picture (a case's input or answer file)."""
    import io
    from PIL import Image
    rng = random.Random(seed)
    channels = len(mode)
    img = Image.frombytes(mode, (w, h), bytes(rng.randrange(256) for _ in range(w * h * channels)))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def cmyk_jpeg_bytes(w: int, h: int, seed: int) -> bytes:
    """A small deterministic CMYK JPEG (R3.6 fix round 1: PIL converts CMYK naively)."""
    import io
    from PIL import Image
    rng = random.Random(seed)
    img = Image.frombytes("CMYK", (w, h), bytes(rng.randrange(256) for _ in range(w * h * 4)))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def grey16_png_bytes(w: int, h: int, seed: int) -> bytes:
    """A small deterministic 16-bit greyscale PNG (PIL's I;16), with values below and above 255."""
    import io
    import numpy as np
    from PIL import Image
    rng = random.Random(seed)
    arr = np.array([rng.choice((rng.randrange(256), rng.randrange(65536))) for _ in range(w * h)], dtype=np.uint16).reshape(h, w)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


def wav_bytes(seconds: float, rate: int, seed: int, channels: int = 1) -> bytes:
    """A small deterministic 16-bit PCM WAV (a case's input or answer sound)."""
    import io
    import wave
    rng = random.Random(seed)
    n = int(seconds * rate) * channels
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(rng.randrange(-20000, 20000).to_bytes(2, "little", signed=True) for _ in range(n)))
    return buf.getvalue()


def _b64(data: bytes) -> str:
    import base64
    return base64.b64encode(data).decode("ascii")


def _unb64(text: str) -> bytes:
    import base64
    return base64.b64decode(text)


def _picture_tensor(data: bytes, mode: str = "RGB"):
    """A picture input as LoadImage (and the Image card) hands it on:
    ImageOps.exif_transpose, then RGB, float32 /255, [1, H, W, 3]; `mode`
    "RGBA" as a node that keeps alpha hands it on (R3.7: [1, H, W, 4]: a
    downloaded picture, read as bytesio_to_image_tensor reads it, not turned)."""
    import io
    import numpy as np
    import torch
    from PIL import Image, ImageOps
    img = Image.open(io.BytesIO(data))
    img = img.convert(mode) if mode == "RGBA" else ImageOps.exif_transpose(img).convert(mode)
    return torch.from_numpy(np.array(img).astype(np.float32) / 255.0).unsqueeze(0)


def _sound_dict(data: bytes) -> dict:
    """A sound input as Comfy's AUDIO dict, decoded from a 16-bit PCM WAV."""
    import io
    import wave
    import numpy as np
    import torch
    with wave.open(io.BytesIO(data), "rb") as w:
        ch, rate, frames = w.getnchannels(), w.getframerate(), w.readframes(w.getnframes())
    arr = np.frombuffer(frames, dtype="<i2").astype(np.float32).reshape(-1, ch).T / 32768.0
    return {"waveform": torch.from_numpy(np.ascontiguousarray(arr)).unsqueeze(0), "sample_rate": rate}


def _served(links: dict, files: dict) -> dict:
    """URL → (status, body bytes): `links` values are text or {status, text}; `files` values base64."""
    out = {}
    for url, v in (links or {}).items():
        # {"raise": message}: the fetch itself fails (a dropped connection), as ConnectionError(message) (R3.6).
        if isinstance(v, dict) and "raise" in v:
            out[url] = ("raise", str(v["raise"]).encode("utf-8"))
        elif isinstance(v, dict):
            out[url] = (int(v.get("status", 200)), str(v.get("text", "")).encode("utf-8"))
        else:
            out[url] = (200, str(v).encode("utf-8"))
    for url, b in (files or {}).items():
        out[url] = (200, _unb64(b))
    return out


class _FakeResponse:
    def __init__(self, url, status, body):
        self.url = url
        self.status = status
        self._body = body

    async def text(self, *_a, **_k):
        return self._body.decode("utf-8")

    async def read(self):
        return self._body

    async def json(self, *_a, **_k):
        return json.loads(self._body.decode("utf-8"))

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


def _fake_session(get):
    """aiohttp.ClientSession: GETs answered by `get(url)`; anything else refused."""
    class FakeSession:
        def __init__(self, *_a, **_k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        def get(self, url, *_a, **_k):
            status, body = get(str(url))
            return _FakeResponse(str(url), status, body)

        def post(self, url, *_a, **_k):
            raise UnservedGet(f"NETWORK BLOCKED: POST {url!r}")

        put = post

        async def close(self):
            pass
    return FakeSession


def capture_calls(node_cls, answers: list, links: dict | None = None, files: dict | None = None,
                  pictures: dict | None = None, sounds: dict | None = None, picture_modes: dict | None = None,
                  made_pixels: bool = False, tensors: dict | None = None, **kwargs) -> dict:
    """Run `node_cls.execute(**kwargs)` with every provider call, upload,
    download, save and web fetch patched out, and record what it does.

    - Each provider call (Replicate `_run_prediction`, fal
      `run_fal_prediction`) records `{provider, endpoint, payload,
      payload_json}` in `calls` (payload_json: the wire text, keys sorted)
      and returns the next of `answers` (Replicate: the prediction dict; fal:
      the result body; `{"__body__": text}`: json.loads of that text, so the
      TypeScript side keeps the numbers' written form).
    - `pictures` / `sounds` (input name → file bytes) are passed in as the
      real tensors / AUDIO dicts LoadImage and the audio loaders hand on, and
      sent as `IMG:<name>` / `WAV:<name>`. A picture the node made itself (an
      alpha-dropped copy, a crop) is sent as `PNG:<sha256>` of the PNG Python
      encodes; a sound as `WAV:<sha256>`. Uploads become `UPLOAD:<file name>`.
      `picture_modes` (input name → PIL mode, R3.7): a picture handed on in
      that mode ("RGBA": a node upstream kept its alpha). `made_pixels`
      (R3.7): each `PNG:<sha256>` is also described in `made` by its decoded
      pixels (`{shape, sha256}` of the 8-bit array), since the TypeScript
      side's PNG encoder writes other bytes for the same pixels; and each
      picture input by the pixels its tensor holds (`loaded`, R3.7 fix
      round 1: the loader's view, EXIF turned).
    - `tensors` (input name → a tensor a real loader made, R3.H): passed in
      as they are, not named, so `_image_tensor_to_data_url` encodes them as
      it encodes any picture (`PNG:<sha256>`, described in `made`).
    - Every GET (aiohttp, and the download helpers) is recorded in `gets` as
      `{url, status}` and served from `links` (text, or `{status, text}` — a
      404 is served as asked; `{raise: message}` fails the fetch outright
      with ConnectionError, recorded with status 0) and `files` (URL →
      base64 bytes). The real
      decoders run on those bytes, so a node that works on a downloaded
      picture or sound goes on to its next call. A GET the case doesn't serve
      raises UnservedGet, which the node can't swallow, and fails the case.

    Returns `{calls, gets, output, ui}` — `output` as Python returned it:
    strings verbatim, a downloaded file as `{image|video|audio: url}`, an
    input picture as `{image: "IMG:<name>"}`, any other picture as `{tensor:
    {shape, sha256}}` (sha256 of its 8-bit bytes by save_generation_output's
    rule) — or `error` (type and message) when execute raised."""
    if "--allow-network" not in sys.argv[1:]:
        block_network()
    import hashlib
    import aiohttp
    import numpy as np
    import torch
    from runner_builder_fixtures import SAVE_HELPERS, UNREADABLE_BOARD_PREFIX, _node_modules
    nr, fal_refs, extras = _node_modules()
    from comfy_api.latest._io import HiddenHolder
    from comfy_api_nodes.util import download_helpers as dh

    calls: list = []
    gets: list = []
    queue = list(answers)
    counters: dict = {}
    saved_inputs: list = []
    made: dict = {}
    served = _served(links or {}, files or {})
    named: dict = {}  # id(object) → (kind, label); objects kept alive in `keep`
    keep: list = []

    def name(obj, kind, label):
        named[id(obj)] = (kind, label)
        keep.append(obj)
        return obj

    def serve(url):
        if url not in served:
            gets.append({"url": url, "status": None})
            raise UnservedGet(f"GET {url!r} is not served by the case")
        status, body = served[url]
        if status == "raise":
            # A fetch that fails outright (R3.6: Layerize's layer JSON): recorded with status 0.
            gets.append({"url": url, "status": 0})
            raise ConnectionError(body.decode("utf-8"))
        gets.append({"url": url, "status": status})
        return status, body

    def answer(provider, endpoint, payload):
        # Serialised at once, so a later change to the dict can't alter the record.
        # `payload_json`: the wire text (json.dumps, as aiohttp's json= sends it), keys sorted, so 1.0 and 1 differ.
        calls.append({"provider": provider, "endpoint": endpoint, "payload": json.loads(json.dumps(payload)),
                      "payload_json": json.dumps(payload, sort_keys=True)})
        if not queue:
            raise RuntimeError(f"no answer programmed for call {len(calls)} ({endpoint})")
        a = queue.pop(0)
        # A call that fails at the provider ({"__raise__": message}, R3.14): the call raises RuntimeError(message).
        if isinstance(a, dict) and set(a) == {"__raise__"}:
            raise RuntimeError(a["__raise__"])
        # A body text given as it is ({"__body__": text}, paidParity.ts RawBody): what json.loads reads of it.
        return json.loads(a["__body__"]) if isinstance(a, dict) and set(a) == {"__body__"} else a

    async def fake_replicate(model, input_dict, **_kw):
        return answer("replicate", model, input_dict)

    async def fake_fal(app, fn, input_dict, **_kw):
        return answer("fal", f"{app}/{fn}" if fn else app, input_dict)

    async def fake_upload(data, filename, content_type="application/octet-stream"):
        return f"UPLOAD:{filename}"

    async def fake_hosted(src, content_type, fallback_name):
        return src if str(src).startswith(("http://", "https://")) or not src else f"UPLOAD:{fallback_name}"

    real_image_url = nr._image_tensor_to_data_url
    real_wav_url = nr._audio_dict_to_wav_data_url

    def image_url(t):
        label = named.get(id(t))
        if label and label[0] == "input":
            return f"IMG:{label[1]}"
        png = _unb64(real_image_url(t).split(",", 1)[1])
        key = f"PNG:{hashlib.sha256(png).hexdigest()}"
        if made_pixels:
            import io as _io
            from PIL import Image as _Image
            arr = np.array(_Image.open(_io.BytesIO(png)))
            made[key] = {"shape": list(arr.shape), "sha256": hashlib.sha256(arr.tobytes()).hexdigest()}
        return key

    def wav_url(a, max_seconds=None):
        label = named.get(id(a))
        if label and label[0] == "input":
            return f"WAV:{label[1]}"
        wav = _unb64(real_wav_url(a, max_seconds=max_seconds).split(",", 1)[1])
        return f"WAV:{hashlib.sha256(wav).hexdigest()}"

    async def fake_bytesio(url, dest, **_kw):
        status, body = serve(str(url))
        if status != 200:
            raise RuntimeError(f"HTTP {status} for {url}")
        if isinstance(dest, (str, os.PathLike)):
            with open(dest, "wb") as f:
                f.write(body)
        else:
            dest.write(body)
            if hasattr(dest, "seek"):
                dest.seek(0)

    real_image = dh.download_url_to_image_tensor
    real_video = dh.download_url_to_video_output
    real_audio = nr._download_url_to_audio_dict

    async def fake_image(url, *a, **k):
        return name(await real_image(url, *a, **k), "download", ("image", url))

    async def fake_video(url, *a, **k):
        return name(await real_video(url, *a, **k), "download", ("video", url))

    async def fake_audio(url, *a, **k):
        return name(await real_audio(url, *a, **k), "download", ("audio", url))

    def describe(v):
        label = named.get(id(v))
        if label and label[0] == "download":
            return {label[1][0]: label[1][1]}
        if label and label[0] == "input":
            return {"image": f"IMG:{label[1]}"} if isinstance(v, torch.Tensor) else {"audio": f"WAV:{label[1]}"}
        if isinstance(v, torch.Tensor):
            arr = np.clip(255.0 * v.detach().cpu().float().numpy(), 0, 255).astype(np.uint8)
            return {"tensor": {"shape": list(v.shape), "sha256": hashlib.sha256(arr.tobytes()).hexdigest()}}
        return None

    def jsonable(v):
        d = describe(v)
        if d is not None:
            return d
        if v is None or isinstance(v, (bool, int, float, str)):
            return v
        if isinstance(v, (list, tuple)):
            return [jsonable(x) for x in v]
        if isinstance(v, dict):
            return {str(k): jsonable(x) for k, x in v.items()}
        return {"repr": type(v).__name__}

    def fake_generation(tensor, filename_prefix="generation"):
        return {"images": [{"prefix": filename_prefix, "image": jsonable(tensor)}], "animated": [False]}

    def fake_live(tensor, node_id=None, unique=False):
        return {"images": [{"live_preview": jsonable(tensor)}]}

    def fake_to_input(tensor, filename_prefix="layer"):
        counters[filename_prefix] = counters.get(filename_prefix, 0) + 1
        file = f"{filename_prefix}_{counters[filename_prefix]:05}_.png"
        # What save_image_to_input writes (R3.6 fix round 1): the 8-bit pixels, by its own rule.
        img = tensor if tensor.ndim == 3 else tensor[0]
        arr = np.clip(255.0 * img.detach().cpu().float().numpy(), 0, 255).astype(np.uint8)
        saved_inputs.append({"file": file, "shape": list(arr.shape), "sha256": hashlib.sha256(arr.tobytes()).hexdigest()})
        return file

    loaded: dict = {}
    for pname, data in (pictures or {}).items():
        kwargs[pname] = name(_picture_tensor(data, (picture_modes or {}).get(pname, "RGB")), "input", pname)
        if made_pixels:
            arr = np.clip(255.0 * kwargs[pname][0].numpy(), 0, 255).round().astype(np.uint8)
            loaded[pname] = {"shape": list(arr.shape), "sha256": hashlib.sha256(arr.tobytes()).hexdigest()}
    for sname, data in (sounds or {}).items():
        kwargs[sname] = name(_sound_dict(data), "input", sname)
    for tname, t in (tensors or {}).items():
        kwargs[tname] = t

    saves = {"save_generation_output": fake_generation, "save_live_preview": fake_live, "save_image_to_input": fake_to_input}
    patches = [
        mock.patch.object(node_cls, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "fixture"})),
        mock.patch.object(nr, "_run_prediction", fake_replicate),
        mock.patch.object(fal_refs, "run_fal_prediction", fake_fal),
        mock.patch.object(fal_refs, "get_fal_token", lambda: "fixture-token"),
        mock.patch.object(nr, "_upload_public_file", fake_upload),
        mock.patch.object(nr, "_lipsync_hosted_media_url", fake_hosted),
        mock.patch.object(nr, "_image_tensor_to_data_url", image_url),
        mock.patch.object(nr, "_audio_dict_to_wav_data_url", wav_url),
        mock.patch.object(dh, "download_url_to_bytesio", fake_bytesio),
        mock.patch.object(nr, "download_url_to_image_tensor", fake_image),
        mock.patch.object(nr, "download_url_to_video_output", fake_video),
        mock.patch.object(nr, "_download_url_to_audio_dict", fake_audio),
        mock.patch.object(nr, "_moodboard_ref_data_urls",
                          lambda folder, files, input_dir=None: [f"BOARD:{f}" for f in files
                                                                 if not f.startswith(UNREADABLE_BOARD_PREFIX)]),
        mock.patch.object(aiohttp, "ClientSession", _fake_session(serve)),
    ]
    for mod in [nr, *extras, sys.modules.get(node_cls.__module__)]:
        for helper in SAVE_HELPERS:
            if mod is not None and hasattr(mod, helper):
                patches.append(mock.patch.object(mod, helper, saves[helper]))

    result = {"calls": calls, "gets": gets}
    with contextlib.ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        try:
            out = asyncio.run(node_cls.execute(**kwargs))
        except UnservedGet:
            raise
        except Exception as e:  # noqa: BLE001 — the node's own failure is part of the fixture
            result["error"] = {"type": type(e).__name__, "message": str(e)}
    # Loud even when something caught the sentinel: a case never takes a branch silently.
    unserved = [g["url"] for g in gets if g["status"] is None]
    if unserved:
        raise RuntimeError(f"{node_cls.__name__}: GETs the case doesn't serve: {unserved}")
    if made_pixels:
        result["made"] = made
        result["loaded"] = loaded
    if "error" in result:
        return result
    args = getattr(out, "args", out)
    result["output"] = jsonable(list(args) if isinstance(args, tuple) else args)
    result["ui"] = jsonable(getattr(out, "ui", None))
    if saved_inputs:
        result["saved_inputs"] = saved_inputs
    return result


def paid_case(name: str, node_cls, widgets: dict, answers: list, pictures=(), sounds=(),
              links: dict | None = None, files: dict | None = None, picture_modes: dict | None = None,
              made_pixels: bool = False) -> dict:
    """One fixture case (tests/unit/__runner__/paidParity.ts PaidCase): the
    node's widgets, its picture and sound inputs, the answers and served
    files, and what capture_calls saw. `pictures` / `sounds`: input names
    (each given a small deterministic file) or name → bytes. The input files
    are written into the case (base64) so the TypeScript side sends the same
    bytes."""
    def files_of(given, make):
        if isinstance(given, dict):
            return dict(given)
        return {n: make(n, i) for i, n in enumerate(given)}
    pics = files_of(pictures, lambda n, i: png_bytes(8, 6, 1000 + i))
    snds = files_of(sounds, lambda n, i: wav_bytes(0.25, 8000, 2000 + i))
    got = capture_calls(node_cls, answers, links=links, files=files, pictures=pics, sounds=snds,
                        picture_modes=picture_modes, made_pixels=made_pixels, **widgets)
    case = {"name": name, "class_type": node_cls.define_schema().node_id, "widgets": widgets,
            "pictures": list(pics), "sounds": list(snds),
            "picture_files": {n: _b64(b) for n, b in pics.items()},
            "sound_files": {n: _b64(b) for n, b in snds.items()},
            "answers": answers, "calls": got["calls"], "gets": got["gets"],
            "output": got.get("output"), "ui": got.get("ui")}
    if links:
        case["links"] = links
    if files:
        case["files"] = files
    if "error" in got:
        case["error"] = got["error"]
    if "saved_inputs" in got:
        case["saved_inputs"] = got["saved_inputs"]
    if picture_modes:
        case["picture_modes"] = picture_modes
    if "made" in got:
        case["made"] = got["made"]
    if "loaded" in got:
        case["loaded"] = got["loaded"]
    return case


# ── machinery (R3.1): json.loads / json.dumps / str / repr ──────────────────

MACHINERY_BODIES = [
    # ints past 2**53, big and negative, and -0 (an int: 0)
    '{"id": 9007199254740993, "big": 123456789012345678901234567890, "neg": -18446744073709551617, "z": -0}',
    '[0, -0, 1, -1, 9007199254740992, 9007199254740993]',
    # floats that are whole, exponents, signed zero, tiny and huge
    '{"a": 1.0, "b": 1e5, "c": 1E-7, "d": -0.0, "e": 2.5e+16, "f": 0.1, "g": 1e400, "h": -1e400}',
    '[1.0, 10.0, 100.0, 1e15, 1e16, 1e17, 0.0001, 0.00001, 123.456, 5e-324, 1.7976931348623157e308]',
    '[3.141592653589793, 2.718281828459045, 1.5, -2.25, 1e-10, 123456789.0, 0.30000000000000004]',
    # NaN and the infinities Python's json reads
    '{"nan": NaN, "inf": Infinity, "ninf": -Infinity}',
    '[NaN, Infinity, -Infinity]',
    # non-ASCII, escapes, astral characters (written raw and as escapes), control escapes
    '{"t": "café", "raw": "café — naïve ☃", "emoji": "\\ud83d\\ude00", "rawEmoji": "😀🎉"}',
    '["\\"quoted\\"", "back\\\\slash", "slash\\/", "\\b\\f\\n\\r\\t", "\\u0000\\u001f\\u007f", "tab\\there"]',
    '"\\u00e9\\u4e2d\\ud800"',
    '"日本語のテキスト"',
    '"a raw lone surrogate \ud800 and a raw pair \ud83d\ude00"',
    # repeated keys: first place, last value
    '{"a": 1, "b": 2, "a": 3}',
    '{"x": {"k": 1, "k": {"deep": [1, 2]}}, "y": [], "x": {"k": 0}}',
    # nesting and empties
    '{"a": {"b": {"c": [[], {}, [{}], [[1.0]]]}}, "empty": "", "t": true, "f": false, "n": null}',
    '[[[[[[[[[["deep"]]]]]]]]]]',
    '{}',
    '[]',
    # blanks around and between tokens
    ' \t\n\r{ "a" :\t[ 1 , 2.0 ]\r\n} \n',
    # top-level scalars
    '"just a string"',
    '42',
    '-3.5',
    'true',
    'null',
    # what a text model answers (a token list, a dict with usage)
    '{"output": ["Hello", ",", " world", "!"], "metrics": {"input_token_count": 12, "output_token_count": 4, "predict_time": 0.53}}',
    '{"objects": [{"label": "cat", "score": 0.98, "box": [10, 20.5, 110, 220]}, {"label": "dog", "score": 1.0, "box": [0, 0, 1e2, 5E1]}]}',
    # refused by json.loads
    '{"a": 1,}',
    '[1, 2',
    '01',
    '1.',
    '.5',
    '+1',
    '"tab\there"',
    '"bad \\x escape"',
    '"\\u12"',
    '{a: 1}',
    '[1] [2]',
    '﻿{"bom": true}',
    '-',
    '-Inf',
    'nan',
    '',
    # int()'s digit limit (4300 digits): refused; 4300 digits: read
    '[' + '9' * 4301 + ']',
    '[' + '9' * 4300 + ']',
]

MACHINERY_SCALARS = [
    '"text"', '""', '"  spaced  "', '"caf\\u00e9 \\ud83d\\ude00"', '"line\\nbreak"',
    '0', '-0', '7', '-12', '9007199254740993', '123456789012345678901234567890',
    '1.0', '-0.0', '1e5', '1E-7', '0.1', '2.5e+16', '1e16', '1e15', '0.0001', '0.00001', '5e-324',
    'NaN', 'Infinity', '-Infinity', 'true', 'false', 'null',
]

_EDGE_FLOATS = [
    0.0, -0.0, 1.0, -1.0, 0.1, 0.2, 0.3, 1 / 3, 2 / 3, 0.1 + 0.2, 1e16, 1e15, 9999999999999998.0,
    1e17, 1e22, 1e23, 1e-4, 1e-5, 0.0001, 0.00012345, 1.5e-5, 5e-324, 2.2250738585072014e-308,
    2.225073858507201e-308, 1.7976931348623157e308, float(2 ** 53), float(2 ** 53 + 1), float(2 ** 63),
    123456789012345680.0, 1234567890123456.8, 0.5, 0.25, 100.0, 1e100, 1e-100, 4.35, 2.675, 1.005,
    float("inf"), float("-inf"),
]


def _float_hex(x: float) -> str:
    return struct.pack(">d", x).hex()


def _machinery_floats() -> list:
    rng = random.Random(20260927)
    out = list(_EDGE_FLOATS)
    while len(out) < 10_000:
        kind = len(out) % 4
        if kind == 0:
            # any bit pattern but NaN (its repr is 'nan' whatever the payload)
            x = struct.unpack(">d", rng.getrandbits(64).to_bytes(8, "big"))[0]
            if x != x:
                continue
        elif kind == 1:
            x = round(rng.uniform(-1e6, 1e6), rng.randint(0, 9))
        elif kind == 2:
            x = rng.choice((1.0, -1.0)) * 10 ** rng.uniform(-25, 25)
        else:
            x = float(rng.randint(-2 ** 62, 2 ** 62)) / rng.choice((1, 2, 4, 10, 100, 1000, 3, 7))
        out.append(x)
    return [{"bits": _float_hex(x), "repr": repr(x)} for x in out]


def machinery_group() -> dict:
    bodies = []
    for text in MACHINERY_BODIES:
        try:
            bodies.append({"text": text, "dumps": json.dumps(json.loads(text))})
        except ValueError as e:  # JSONDecodeError is a ValueError, as is int()'s digit limit
            bodies.append({"text": text, "error": type(e).__name__})
    scalars = [{"text": t, "str": str(json.loads(t))} for t in MACHINERY_SCALARS]
    return {"bodies": bodies, "scalars": scalars, "floats": _machinery_floats()}


# ── llm (R3.3): the seven LLM text nodes ────────────────────────────────────

LLM_TEXTS = {
    "blank": "",
    "spaces": "   \t ",
    "one line": "A red fox jumps over a sleeping dog.",
    "2000 chars": ("The quick brown fox jumps over the lazy dog. " * 45)[:2000],
    "non-ASCII": "Caf\u00e9 na\u00efve \u2014 \u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8, \u00fcber \u0161\u0107",
    "emoji": "\U0001f389 party time \U0001f600 with \U0001f98a",
}


def _llm_body(output, metrics=True, raw_output=None) -> dict:
    """A Replicate prediction body as text (numbers keep their written form)."""
    out_text = raw_output if raw_output is not None else json.dumps(output)
    m = ', "metrics": {"input_token_count": 37, "output_token_count": 12, "predict_time": 0.5}' if metrics else ""
    return {"__body__": '{"id": "p1", "status": "succeeded", "output": ' + out_text + m + "}"}


LLM_ANSWERS = {
    "token list": _llm_body(["Hello", ",", " world", "!"]),
    "string with spaces": _llm_body("  \n  A tidy answer.\u3000 \n"),
    "null": _llm_body(None),
    "mixed list": _llm_body(None, raw_output="[1, 2.0, true, null]"),
    "no metrics": _llm_body(["No", " metrics"], metrics=False),
    "list with markers": _llm_body(
        "1. First idea\n\n- Second idea\n  * Third idea\n2) Fourth\n\u2022 Fifth\n\n10. Tenth stays numbered\n1.2.3 nested"),
    "unicode breaks": _llm_body("alpha\u2028- beta\x85gamma\r\ndelta\rep\x0bzeta\x0ceta\x1ctheta\x1diota\x1ekappa\u2029lambda"),
    "full-width digit": _llm_body("\uff11. full width one\n\u00b2) superscript two\n\u2460. circled one\n\U0001d7ce. math zero\n\u0663) arabic three"),
    "numbers": _llm_body(None, raw_output="42"),
    "false": _llm_body(None, raw_output="false"),
    "float": _llm_body(None, raw_output="1e5"),
}


def llm_group() -> dict:
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    answer = [LLM_ANSWERS["token list"]]
    cases: list = []

    def add(name, cls, widgets, answers=None):
        cases.append(paid_case(name, cls, widgets, answers if answers is not None else answer))

    # Every class × model × text kind.
    per_model = [
        ("chat", nr.ChatLLMNode, list(nr._CHAT_LLM_MODELS),
         lambda m, t: {"model": m, "prompt": t, "system_prompt": "", "temperature": 1.0, "max_tokens": 1024}),
        ("improve", nr.ImprovePromptNode, ["GPT-5 nano"], lambda m, t: {"model": m, "idea": t, "target": "image"}),
        ("summarize", nr.SummarizeTextNode, list(nr._SUMMARIZE_MODELS), lambda m, t: {"text": t, "length": "Short", "model": m}),
        ("translate", nr.TranslateTextNode, [None], lambda m, t: {"text": t, "target_language": "French", "custom_language": ""}),
        ("rewrite", nr.RewriteToneNode, list(nr._REWRITE_MODELS), lambda m, t: {"text": t, "tone": "Punchy", "model": m}),
        ("brainstorm", nr.BrainstormIdeasNode, [None], lambda m, t: {"topic": t, "count": 3, "angle": "Variations"}),
        ("reason", nr.ReasonStepByStepNode, list(nr._REASON_MODELS), lambda m, t: {"question": t, "include_reasoning": False, "model": m}),
    ]
    for tag, cls, models, widgets in per_model:
        for m in models:
            for kind, text in LLM_TEXTS.items():
                add(f"{tag} · {m or 'fixed model'} · {kind}", cls, widgets(m, text))

    # Chat: with and without a system prompt, temperature 0, 1 and 2, max tokens 1 and 8192, on each model.
    for m in nr._CHAT_LLM_MODELS:
        for system in ("", "You are a concise copywriter. \u2728"):
            for temp in (0.0, 1.0, 2.0):
                for mx in (1, 8192):
                    add(f"chat · {m} · system {'on' if system else 'off'} · t{temp} · max {mx}", nr.ChatLLMNode,
                        {"model": m, "prompt": "Name a colour.", "system_prompt": system, "temperature": temp, "max_tokens": mx})
    add("chat · spaces-only system prompt is sent", nr.ChatLLMNode,
        {"model": "GPT-5", "prompt": "Hi", "system_prompt": "  ", "temperature": 0.35, "max_tokens": 64})

    # Improve: both targets.
    for target in ("image", "video"):
        add(f"improve · target {target}", nr.ImprovePromptNode, {"model": "GPT-5 nano", "idea": "a cat on a skateboard", "target": target})

    # Summarize: every length.
    for length in nr._SUMMARIZE_LENGTHS:
        add(f"summarize · {length}", nr.SummarizeTextNode, {"text": "Long text here.", "length": length, "model": "Gemini 3 Flash"})

    # Translate: every language, and a custom one with spaces around it (and a blank custom one).
    for lang in nr._TRANSLATE_LANGUAGES:
        add(f"translate · {lang}", nr.TranslateTextNode, {"text": "Good morning", "target_language": lang, "custom_language": ""})
    add("translate · custom with spaces", nr.TranslateTextNode, {"text": "Good morning", "target_language": "German", "custom_language": "  Welsh \u3000"})
    add("translate · custom spaces only", nr.TranslateTextNode, {"text": "Good morning", "target_language": "Korean", "custom_language": " \t "})

    # Rewrite: every tone.
    for tone in nr._REWRITE_TONES:
        add(f"rewrite · {tone}", nr.RewriteToneNode, {"text": "We sell shoes.", "tone": tone, "model": "Claude 4.5 Haiku"})

    # Brainstorm: every angle, counts 2 and 12.
    for angle in nr._BRAINSTORM_ANGLES:
        add(f"brainstorm · {angle}", nr.BrainstormIdeasNode, {"topic": "A poster for a coffee shop", "count": 3, "angle": angle})
    for count in (2, 12):
        add(f"brainstorm · count {count}", nr.BrainstormIdeasNode, {"topic": "Coffee", "count": count, "angle": "Free"})

    # Reason: with and without the reasoning shown.
    for m in nr._REASON_MODELS:
        for inc in (False, True):
            add(f"reason · {m} · reasoning {'shown' if inc else 'hidden'}", nr.ReasonStepByStepNode,
                {"question": "What is 17 * 23?", "include_reasoning": inc, "model": m})

    # Every answer shape, through Chat (no ui), Summarize (ui) and Brainstorm (the clean-up), at counts 2 and 12.
    for aname, ans in LLM_ANSWERS.items():
        add(f"answer · chat · {aname}", nr.ChatLLMNode,
            {"model": "GPT-5", "prompt": "Say hi", "system_prompt": "", "temperature": 0.5, "max_tokens": 64}, [ans])
        add(f"answer · summarize · {aname}", nr.SummarizeTextNode, {"text": "Text", "length": "Short", "model": "GPT-5 nano"}, [ans])
        for count in (2, 12):
            add(f"answer · brainstorm {count} · {aname}", nr.BrainstormIdeasNode, {"topic": "Tea", "count": count, "angle": "Free"}, [ans])

    digits = [c for c in range(0x110000) if chr(c).isdigit()]
    ranges: list = []
    for c in digits:
        if ranges and ranges[-1][1] == c - 1:
            ranges[-1][1] = c
        else:
            ranges.append([c, c])
    return {"cases": cases, "isdigit_ranges": ranges}


# ── describe (R3.4): Describe an image (+ twin), Describe a video, Extract text, Find objects ──

DESCRIBE_PROMPTS = {
    "default": "Describe this image in detail.",
    "empty": "",
    "non-ASCII": "Qu'y a-t-il sur l'étiquette ? 日本語 \U0001f98a",
}

VIDEO_URL = "https://example.test/clip.mp4"


def _body(raw_output: str) -> dict:
    """A Replicate prediction body as text, its `output` written as given (numbers keep their form)."""
    return {"__body__": '{"id": "p1", "status": "succeeded", "output": ' + raw_output + ', "metrics": {"predict_time": 0.4}}'}


TEXT_ANSWERS = {
    "token list": _body('["A ", "red", " fox", ".", "  "]'),
    "string with spaces": _body('"  \\n A tidy caption.\\u3000 \\n"'),
    "null": _body("null"),
    "mixed list": _body("[1, 2.0, true, null, \"x\"]"),
    "empty list": _body("[]"),
    "number": _body("42"),
    "float": _body("1e5"),
    "false": _body("false"),
    "non-ASCII string": _body('"Caf\\u00e9 — \U0001f98a"'),
}

EXTRACT_ANSWERS = {
    "pages list": _body('["# Page 1\\n", "Page 2 \\u2603", 3, 2.0, null, true]'),
    "empty list": _body("[]"),
    "dict text": _body('{"text": "  Hello text  ", "markdown": "ignored"}'),
    "dict markdown": _body('{"markdown": "# Title\\n\\nBody", "transcription": "ignored"}'),
    "dict transcription": _body('{"transcription": "spoken words"}'),
    "dict falsy text": _body('{"text": "", "markdown": 0, "transcription": "third"}'),
    "dict number": _body('{"markdown": 12.0}'),
    "dict none": _body('{"pages": 2, "blocks": []}'),
    "empty dict": _body("{}"),
    "string": _body('"  plain markdown\\n"'),
    "null": _body("null"),
    "number": _body("7"),
    "true": _body("true"),
}

FIND_ANSWERS = {
    "string": _body('"{\\"objects\\": [1.0, 2]}  "'),
    "dict with floats": _body('{"detections": [{"label": "caf\\u00e9", "confidence": 0.9, "x": 12.0, "y": 1e-3, "width": 1E2, '
                              '"height": 5, "big": 123456789012345678901}], "count": 1, "ok": true, "none": null}'),
    "list": _body('[{"label": "person", "box": [0.0, 10.5, -0.0, 2.5e+16]}, "\\u65e5\\u672c", []]'),
    "null": _body("null"),
    "number": _body("3.0"),
    "empty dict": _body("{}"),
    # (No NaN or Infinity: Replicate answers in strict JSON, and the runner's clients read it with JSON.parse.)
    "nested": _body('{"a": {"b": {"c": [[], {}, [1.0, -0.0, 1e300, 1.5e-7]]}}}'),
}


def describe_group() -> dict:
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    cases: list = []

    def add(name, cls, widgets, answers, pictures=("image",)):
        cases.append(paid_case(name, cls, widgets, answers, pictures=list(pictures)))

    caption = [TEXT_ANSWERS["token list"]]
    # Describe an image, its hidden twin and Describe a video: every prompt, then every answer shape.
    for pname, prompt in DESCRIBE_PROMPTS.items():
        add(f"describe · {pname}", nr.DescribeImageNode, {"model": "Moondream 2", "prompt": prompt}, caption)
        add(f"describe twin · {pname}", nr.DescribeImageRemoteNode, {"prompt": prompt}, caption)
        add(f"video · {pname}", nr.DescribeVideoNode, {"model": "Gemini 2.5 Flash", "video_url": VIDEO_URL, "prompt": prompt}, caption, pictures=())
    for aname, ans in TEXT_ANSWERS.items():
        add(f"answer · describe · {aname}", nr.DescribeImageNode, {"model": "Moondream 2", "prompt": "What is it?"}, [ans])
        add(f"answer · describe twin · {aname}", nr.DescribeImageRemoteNode, {"prompt": "What is it?"}, [ans])
        add(f"answer · video · {aname}", nr.DescribeVideoNode,
            {"model": "Gemini 2.5 Flash", "video_url": VIDEO_URL, "prompt": "Summarize."}, [ans], pictures=())
    # Describe a video with no address: Python raises before any call.
    add("video · blank address", nr.DescribeVideoNode, {"model": "Gemini 2.5 Flash", "video_url": "", "prompt": "Describe."}, [], pictures=())
    # An address of spaces is sent as it is (Python's `if not video_url`).
    add("video · spaces address", nr.DescribeVideoNode, {"model": "Gemini 2.5 Flash", "video_url": "   ", "prompt": "Describe."}, caption, pictures=())

    # Extract text: every answer shape.
    for aname, ans in EXTRACT_ANSWERS.items():
        add(f"extract · {aname}", nr.ExtractTextNode, {"model": "ByteDance Dolphin"}, [ans])

    # Find objects: confidence 0, 0.25 and 1; the default query, an empty one, one with spaces and commas, non-ASCII.
    found = [FIND_ANSWERS["dict with floats"]]
    for conf in (0.0, 0.25, 1.0):
        add(f"find · confidence {conf}", nr.FindObjectsNode, {"model": "YOLO-World", "query": "person, car, dog", "confidence": conf}, found)
    for qname, query in {"empty": "", "spaces and commas": "  red car ,, person ,  traffic light,", "non-ASCII": "café, 猫"}.items():
        add(f"find · query {qname}", nr.FindObjectsNode, {"model": "YOLO-World", "query": query, "confidence": 0.25}, found)
    for aname, ans in FIND_ANSWERS.items():
        add(f"answer · find · {aname}", nr.FindObjectsNode, {"model": "YOLO-World", "query": "person", "confidence": 0.25}, [ans])
    return {"cases": cases}


UPSCALE_DEFAULTS = {
    "model": "Clarity", "prompt": "masterpiece, best quality, highres", "scale_factor": 2.0, "creativity": 0.35,
    "resemblance": 0.6, "negative_prompt": "(worst quality, low quality, normal quality:2)", "num_inference_steps": 18,
    "seed": 0, "face_enhance": False, "topaz_enhance_model": "Standard V2", "topaz_upscale_factor": "2x",
    "topaz_subject_detection": "None", "topaz_output_format": "png", "topaz_face_creativity": 0.0,
    "topaz_face_strength": 0.8, "crystal_creativity": 0.0, "crystal_output_format": "png",
}
ENHANCE_DEFAULTS = {
    "model": "Creative", "prompt": "masterpiece, best quality, highres", "detail_strength": 0.4, "resemblance": 0.6,
    "negative_prompt": "(worst quality, low quality, normal quality:2)", "num_inference_steps": 18, "seed": 0,
    "topaz_enhance_model": "Standard V2", "topaz_subject_detection": "None", "topaz_output_format": "png", "refine_steps": 20,
}
REPAIR_OUT = "https://r.test/repaired.png"
REPAIR_OUT_2 = "https://r.test/second.png"


def repair_group() -> dict:
    """R3.5: Upscale (every engine), Enhance detail (every engine), Restore an
    old photo and Remove background, and the hidden twins of the last two.
    Each answers one picture URL; the first of a list is the one downloaded
    (`_first_output_url`)."""
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    rgb = _b64(png_bytes(8, 6, 11))
    rgba = _b64(png_bytes(8, 6, 12, "RGBA"))
    cases: list = []

    def add(name, cls, widgets, answer=None, files=None):
        answers = [answer or {"output": [REPAIR_OUT]}]
        cases.append(paid_case(name, cls, widgets, answers, pictures=["image"], files=files or {REPAIR_OUT: rgb}))

    def up(name, **w):
        add(f"upscale · {name}", nr.UpscaleImageNode, {**UPSCALE_DEFAULTS, **w})

    def enh(name, **w):
        add(f"enhance · {name}", nr.EnhanceDetailNode, {**ENHANCE_DEFAULTS, **w})

    # Upscale: every engine at its default, then each setting the brief names.
    for engine in ("Clarity", "Crystal", "Real-ESRGAN", "Recraft Crisp", "Topaz"):
        up(f"{engine} default", model=engine)
    for seed in (0, 42):
        up(f"Clarity seed {seed}", seed=seed)
    for scale in (1.0, 10.0, 2.5):
        up(f"Clarity scale {scale}", scale_factor=scale)
    up("Clarity non-ASCII prompt", prompt="caf\u00e9 \u732b, sharp", negative_prompt="")
    for factor in ("None", "2x", "4x", "6x"):
        for face in (False, True):
            up(f"Topaz {factor} face {'on' if face else 'off'}", model="Topaz", topaz_upscale_factor=factor, face_enhance=face,
               topaz_face_creativity=0.25, topaz_face_strength=1.0)
    up("Topaz every other setting", model="Topaz", topaz_enhance_model="Text Refine", topaz_subject_detection="Foreground",
       topaz_output_format="jpg")
    for fmt in ("png", "jpg"):
        up(f"Crystal {fmt}", model="Crystal", crystal_output_format=fmt, crystal_creativity=3.5, scale_factor=4.0)
    for face in (False, True):
        up(f"Real-ESRGAN face {'on' if face else 'off'}", model="Real-ESRGAN", face_enhance=face, scale_factor=3.0)
    # Enhance detail: each engine at detail 0, 0.4 and 1; seeds and the other settings.
    for engine in ("Creative", "Faithful", "Diffusion Refine"):
        for detail in (0.0, 0.4, 1.0):
            enh(f"{engine} detail {detail}", model=engine, detail_strength=detail)
        enh(f"{engine} seed 7", model=engine, seed=7)
    enh("Creative every other setting", resemblance=1.25, negative_prompt="blurry", num_inference_steps=30, prompt="")
    enh("Faithful every other setting", model="Faithful", topaz_enhance_model="CGI", topaz_subject_detection="All", topaz_output_format="jpg")
    enh("Diffusion Refine every other setting", model="Diffusion Refine", refine_steps=50, prompt="a crisp portrait")

    # Restore an old photo and its twin: both formats; the twin's safety as text.
    for fmt in ("png", "jpg"):
        add(f"restore · {fmt}", nr.RestorePhotoNode, {"model": "Flux Kontext \u00b7 Restore", "safety_tolerance": 2, "output_format": fmt})
        add(f"restore twin · {fmt}", nr.RestorePhotoRemoteNode, {"safety_tolerance": "2", "output_format": fmt})
    # Safety 6: the node offers it (1-6); Replicate's schema says 0-2. Python sends it; the live check decides.
    add("restore · safety 6", nr.RestorePhotoNode, {"model": "Flux Kontext \u00b7 Restore", "safety_tolerance": 6, "output_format": "png"})
    for label, text in (("1", "1"), ("text", "strict"), ("empty", ""), ("spaced", " 2"), ("decimal", "2.5"), ("minus", "-1")):
        add(f"restore twin · safety {label}", nr.RestorePhotoRemoteNode, {"safety_tolerance": text, "output_format": "png"})
    # Digits Python's isdigit() takes that aren't 0-9: a superscript (int() raises, no call) and an Arabic-Indic three (sent as 3).
    add("restore twin · safety superscript", nr.RestorePhotoRemoteNode, {"safety_tolerance": "\u00b2", "output_format": "png"})
    add("restore twin · safety arabic-indic", nr.RestorePhotoRemoteNode, {"safety_tolerance": "\u0663", "output_format": "png"})

    # Remove background and its twin: an RGBA cut-out; the answer as a list, a string, and a list of two (the first).
    cut = {REPAIR_OUT: rgba}
    add("remove background · list", nr.RemoveBackgroundNode, {"model": "851-labs/bg-remover"}, {"output": [REPAIR_OUT]}, cut)
    add("remove background · string", nr.RemoveBackgroundNode, {"model": "851-labs/bg-remover"}, {"output": REPAIR_OUT}, cut)
    add("remove background · two", nr.RemoveBackgroundNode, {"model": "851-labs/bg-remover"}, {"output": [REPAIR_OUT, REPAIR_OUT_2]}, cut)
    add("remove background twin · list", nr.RemoveBackgroundRemoteNode, {}, {"output": [REPAIR_OUT]}, cut)
    add("remove background twin · string", nr.RemoveBackgroundRemoteNode, {}, {"output": REPAIR_OUT}, cut)
    # Upscale answering a plain string, and two URLs (the first is the picture).
    add("upscale · answer string", nr.UpscaleImageNode, {**UPSCALE_DEFAULTS, "model": "Real-ESRGAN"}, {"output": REPAIR_OUT})
    add("upscale · answer two", nr.UpscaleImageNode, {**UPSCALE_DEFAULTS, "model": "Recraft Crisp"}, {"output": [REPAIR_OUT, REPAIR_OUT_2]})
    return {"cases": cases}


LAYERIZE_BG = "https://r.test/layerize/bg.png"
LAYERIZE_JSON = "https://r.test/layerize/layers.json"
# The layer data as Ideogram writes it: non-ASCII, whole floats and an exponent kept as written.
LAYERIZE_BODY = ('{"width": 1024, "height": 768, "layers": [{"type": "text", "text": "Café — SALE", '
                 '"font_size": 48.0, "x": 1e2, "color": "#fff"}]}')
SEEDREAM_FLAT = "https://r.test/seedream/flat.png"


def _seedream_layer(i: int, **over) -> dict:
    layer = {
        "image": {"url": f"https://r.test/seedream/layer_{i}.png", "width": 64, "height": 48, "content_type": "image/png"},
        "z_index": i,
        "bounding_box": {"absolute": [i, i * 2, 32 + i, 24 + i], "normalized": [i * 10, i * 20, 500 + i, 500 + i]},
        "name": f"layer {i}",
        "description": f"element number {i}",
    }
    if i == 0:
        layer.pop("bounding_box")
        layer.pop("name")
        layer.pop("description")
    layer.update(over)
    return layer


def _seedream_answer(layers: list, images: list | None = None) -> dict:
    return {"images": [{"url": SEEDREAM_FLAT, "width": 64, "height": 48}] if images is None else images, "layers": layers}


def layers_group() -> dict:
    """R3.6: Separate text from image (Ideogram Layerize), Layerize an image
    (fal Seedream 5 Pro Layerize) and Expand / outpaint (Flux Fill, Bria
    Expand). Layerize answers a picture and a JSON link (picked by
    extension); Seedream answers its layers (each downloaded and saved to the
    input folder) and a flat preview; Outpaint one picture, alpha dropped."""
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    rgba = lambda seed: _b64(png_bytes(8, 6, seed, "RGBA"))  # noqa: E731
    cases: list = []

    # ── Separate text from image (Layerize): prompts and seeds, then every answer shape.
    bg_files = {LAYERIZE_BG: rgba(21)}
    layer_links = {LAYERIZE_JSON: LAYERIZE_BODY}
    pair = {"output": [LAYERIZE_BG, LAYERIZE_JSON]}

    def layerize(name, widgets, answer=None, links=None, files=None):
        w = {"model": "Ideogram Layerize", "prompt": "", "seed": 0, **widgets}
        cases.append(paid_case(f"layerize · {name}", nr.LayerizeGraphicNode, w, [answer or pair], pictures=["image"],
                               links=layer_links if links is None else links, files=files or bg_files))

    for pname, prompt in {"blank": "", "spaces only": "   ", "spaced": "  a summer sale poster \n", "non-ASCII": "affiche été — 猫"}.items():
        layerize(f"prompt {pname}", {"prompt": prompt})
    for seed in (0, 1, 2 ** 31 - 1):
        layerize(f"seed {seed}", {"seed": seed})
    layerize("answer · picture first", {}, pair)
    layerize("answer · JSON first", {}, {"output": [LAYERIZE_JSON, LAYERIZE_BG]})
    noext = "https://r.test/layerize/background"
    layerize("answer · no extension", {}, {"output": [noext, LAYERIZE_JSON]}, files={noext: rgba(22)})
    upper = "https://r.test/layerize/BG.PNG?sig=1.json"
    layerize("answer · upper-case extension and a query", {}, {"output": [LAYERIZE_JSON, upper]}, files={upper: rgba(23)})
    layerize("answer · no JSON link", {}, {"output": [LAYERIZE_BG]}, links={})
    layerize("answer · a string", {}, {"output": LAYERIZE_BG}, links={})
    layerize("answer · JSON link fails", {}, pair, links={LAYERIZE_JSON: {"raise": "Connection reset by peer"}})
    # Python keeps a 404's body text (aiohttp's r.text() reads any status); the runner's error JSON instead (documented).
    layerize("answer · JSON link 404", {}, pair, links={LAYERIZE_JSON: {"status": 404, "text": "Not Found"}})
    layerize("answer · empty JSON body", {}, pair, links={LAYERIZE_JSON: ""})
    layerize("answer · no output", {}, {"output": None}, links={})
    layerize("answer · only the JSON link", {}, {"output": [LAYERIZE_JSON]}, links={})

    # ── Layerize an image (Seedream): every image_size and a bad one; answers of 2 and 17 layers and odd layers.
    def layer_files(layers: list, flat: bool = True) -> dict:
        out = {SEEDREAM_FLAT: rgba(40)} if flat else {}
        for i, layer in enumerate(layers):
            url = (layer.get("image") or {}).get("url") if isinstance(layer, dict) and isinstance(layer.get("image"), dict) else None
            if isinstance(url, str):
                out[url] = rgba(41 + i)
        return out

    def seedream(name, widgets, answer, files=None):
        w = {"prompt": "", "image_size": "auto", **widgets}
        body = {"__body__": json.dumps(answer)} if not isinstance(answer, str) else {"__body__": answer}
        parsed = json.loads(body["__body__"])
        cases.append(paid_case(f"seedream · {name}", nr.SeedreamLayerizeNode, w, [body], pictures=["image"],
                               files=files if files is not None else layer_files(parsed.get("layers") or [], bool(parsed.get("images")))))

    two = _seedream_answer([_seedream_layer(0), _seedream_layer(1)])
    for size in ("auto", "auto_1K", "auto_1.5K", "auto_2K", "8K"):
        seedream(f"image_size {size}", {"image_size": size}, two)
    seedream("prompt", {"prompt": "  keep the logo apart  "}, two)
    seedream("17 layers", {}, _seedream_answer([_seedream_layer(i) for i in range(17)]))
    seedream("a layer without bounding_box", {}, _seedream_answer([_seedream_layer(0), _seedream_layer(1, bounding_box=None), _seedream_layer(2)]))
    seedream("a non-dict layer", {}, _seedream_answer([_seedream_layer(0), "not a layer", 7, _seedream_layer(1)]))
    seedream("no images (the input is the preview)", {}, _seedream_answer([_seedream_layer(0), _seedream_layer(1)], images=[]))
    # Numbers as fal might write them: a float box, a float z_index, whole floats; non-ASCII names; a layer with no url.
    odd = ('{"images": [{"url": "' + SEEDREAM_FLAT + '", "width": 64.0, "height": 48}], "layers": ['
           '{"image": {"url": "https://r.test/seedream/layer_0.png", "width": 64, "height": 48}, "z_index": 0}, '
           '{"image": {"url": "https://r.test/seedream/layer_1.png"}, "z_index": 1.0, '
           '"bounding_box": {"absolute": [1.5, 2.0, 30, 1e1]}, "name": "Café — 猫", "description": null}, '
           '{"image": {"width": 3}, "z_index": 2}, '
           '{"image": {"url": "https://r.test/seedream/layer_3.png"}, "z_index": "3", "bounding_box": {"absolute": [1, 2, 3]}, '
           '"name": 5, "description": "😀 emoji"}]}')
    seedream("odd numbers and names", {}, odd, files={SEEDREAM_FLAT: rgba(40), "https://r.test/seedream/layer_0.png": rgba(41),
                                                         "https://r.test/seedream/layer_1.png": rgba(42), "https://r.test/seedream/layer_3.png": rgba(44)})
    # The base layer has no width: the size comes from images[0].
    seedream("base without a width", {}, _seedream_answer([_seedream_layer(0, image={"url": "https://r.test/seedream/layer_0.png"}), _seedream_layer(1)]))
    seedream("no layers", {}, {"images": [{"url": SEEDREAM_FLAT, "width": 64, "height": 48}], "layers": None})
    # Fix round 1: layers PIL reads its own way (a CMYK JPEG, 16-bit greyscale), and a Python-only name (a list).
    odd_files = _seedream_answer([_seedream_layer(0), _seedream_layer(1), _seedream_layer(2)])
    seedream("CMYK and 16-bit grey layers", {}, odd_files, files={
        SEEDREAM_FLAT: rgba(40), "https://r.test/seedream/layer_0.png": rgba(41),
        "https://r.test/seedream/layer_1.png": _b64(cmyk_jpeg_bytes(8, 6, 60)),
        "https://r.test/seedream/layer_2.png": _b64(grey16_png_bytes(8, 6, 61))})
    seedream("a name that is a list", {}, _seedream_answer([_seedream_layer(0), _seedream_layer(1, name=["a", 1.0, None])]))

    # ── Expand / outpaint: every direction (Flux Fill) and ratio (Bria Expand), seeds, prompts, an RGBA answer.
    out = "https://r.test/outpaint.png"

    def outpaint(name, widgets, answer=None, fill=None):
        w = {"model": "Flux Fill", "prompt": "", "direction": "Zoom out 1.5x", "aspect_ratio": "16:9", "seed": 0, **widgets}
        cases.append(paid_case(f"outpaint · {name}", nr.OutpaintImageNode, w, [answer or {"output": [out]}], pictures=["image"],
                               files={out: fill or _b64(png_bytes(8, 6, 50))}))

    for direction in ("Zoom out 1.5x", "Zoom out 2x", "Make square", "Left outpaint", "Right outpaint", "Top outpaint", "Bottom outpaint"):
        outpaint(f"Flux Fill {direction}", {"direction": direction})
    for ratio in ("1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"):
        outpaint(f"Bria Expand {ratio}", {"model": "Bria Expand", "aspect_ratio": ratio})
    for model in ("Flux Fill", "Bria Expand"):
        for seed in (0, 42):
            outpaint(f"{model} seed {seed}", {"model": model, "seed": seed})
        outpaint(f"{model} prompt spaced", {"model": model, "prompt": "  a forest clearing, soft daylight \n"})
        outpaint(f"{model} prompt spaces only", {"model": model, "prompt": "   "})
        outpaint(f"{model} RGBA answer", {"model": model}, fill=rgba(51))
    outpaint("Flux Fill answer a string", {}, {"output": out})
    # Fix round 1: answers PIL reads its own way.
    outpaint("Flux Fill CMYK JPEG answer", {}, fill=_b64(cmyk_jpeg_bytes(8, 6, 52)))
    outpaint("Bria Expand 16-bit grey answer", {"model": "Bria Expand"}, fill=_b64(grey16_png_bytes(8, 6, 53)))
    outpaint("Bria Expand seed 2^32-1", {"model": "Bria Expand", "seed": 2 ** 32 - 1})
    return {"cases": cases}


# ── split (R3.7): Separate background and foreground ────────────────────────

SPLIT_CUTOUT = "https://r.test/split/cutout.png"
SPLIT_BACKGROUND = "https://r.test/split/background.png"
SPLIT_FILLS = {"LaMa (fast)": "LaMa", "Bria Eraser (quality)": "Bria"}


def split_mask(w: int, h: int, seed: int) -> bytes:
    """A deterministic 8-bit mask (w × h, raw L bytes) that touches every edge
    and corner: distinct corner values, about a third of the border set, a
    few interior points and a solid block (a subject), so a max filter's edge
    rule shows wherever it differs."""
    rng = random.Random(seed)
    px = bytearray(w * h)
    for x in range(w):
        for y in (0, h - 1):
            if rng.random() < 0.35:
                px[y * w + x] = rng.randrange(1, 256)
    for y in range(h):
        for x in (0, w - 1):
            if rng.random() < 0.35:
                px[y * w + x] = rng.randrange(1, 256)
    for i in range(w * h):
        if rng.random() < 0.03:
            px[i] = rng.randrange(1, 256)
    bw, bh = max(1, w // 4), max(1, h // 4)
    bx, by = rng.randrange(0, max(1, w - bw)), rng.randrange(0, max(1, h - bh))
    for y in range(by, by + bh):
        for x in range(bx, bx + bw):
            px[y * w + x] = 255
    # Distinct corners (a 1-pixel side shares them: the last write wins).
    px[0] = 201
    px[w - 1] = 157
    px[(h - 1) * w] = 113
    px[(h - 1) * w + w - 1] = 67
    return bytes(px)


def _split_cutout(w: int, h: int, seed: int, kind: str = "RGBA") -> bytes:
    """The remover's cut-out, alpha from split_mask, in the file kind asked:
    RGBA, LA (grey + alpha), P (palette, alpha by tRNS), RGB (no alpha),
    CMYK (a JPEG) or I;16 (16-bit grey)."""
    import io
    from PIL import Image
    rng = random.Random(seed + 7)
    alpha = split_mask(w, h, seed)
    if kind == "CMYK":
        return cmyk_jpeg_bytes(w, h, seed)
    if kind == "I;16":
        return grey16_png_bytes(w, h, seed)
    buf = io.BytesIO()
    if kind == "P":
        img = Image.frombytes("P", (w, h), alpha)
        img.putpalette(bytes(rng.randrange(256) for _ in range(768)))
        img.save(buf, format="PNG", transparency=bytes(range(256)))
        return buf.getvalue()
    # The colours don't reach the mask: a smooth gradient keeps the fixture small.
    base = rng.randrange(256)
    grey = bytes((base + x + 3 * y) % 256 for y in range(h) for x in range(w))
    rgb = Image.merge("RGB", (Image.frombytes("L", (w, h), grey), Image.frombytes("L", (w, h), grey[::-1]),
                              Image.frombytes("L", (w, h), bytes((v + 85) % 256 for v in grey))))
    if kind == "LA":
        img = Image.merge("LA", (Image.frombytes("L", (w, h), grey), Image.frombytes("L", (w, h), alpha)))
    elif kind == "RGB":
        img = rgb
    else:
        img = rgb.convert("RGBA")
        img.putalpha(Image.frombytes("L", (w, h), alpha))
    img.save(buf, format="PNG")
    return buf.getvalue()


def _exif_picture(w: int, h: int, seed: int, orientation: int, fmt: str) -> bytes:
    """A deterministic RGB picture stored w × h with an EXIF orientation tag
    (R3.7 fix round 1: a phone photo), as a JPEG or a PNG (its eXIf chunk)."""
    import io
    from PIL import Image
    rng = random.Random(seed)
    img = Image.frombytes("RGB", (w, h), bytes(rng.randrange(256) for _ in range(w * h * 3)))
    exif = Image.Exif()
    exif[0x0112] = orientation
    buf = io.BytesIO()
    img.save(buf, format=fmt, exif=exif, **({"quality": 95} if fmt == "JPEG" else {}))
    return buf.getvalue()


def split_group() -> dict:
    """R3.7: Separate background and foreground (SplitPhotoLayersNode). The
    remover's cut-out (alpha → the mask, grown by PIL's MaxFilter), then the
    fill engine on the picture without its alpha and the mask. Every case
    records the mask Python sends (its PNG in the payload: the TypeScript side
    compares its pixels) and each alpha-dropped picture's pixels (`made`).
    `maxfilter`: MaxFilter alone, the edge rule, on masks touching every edge
    and corner."""
    import hashlib
    from PIL import Image, ImageFilter
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    cases: list = []
    W, H = 48, 36

    def split(name, fill="LaMa (fast)", grow=12, mode="RGB", size=(W, H), cutout=None, background=None,
              answers=None, seed=300, picture=None):
        w, h = size
        pic = picture if picture is not None else png_bytes(w, h, seed, mode)
        files = {SPLIT_CUTOUT: _b64(cutout if cutout is not None else _split_cutout(w, h, seed + 1)),
                 SPLIT_BACKGROUND: _b64(background if background is not None else png_bytes(w, h, seed + 2, "RGBA"))}
        cases.append(paid_case(f"split · {name}", nr.SplitPhotoLayersNode, {"background_fill": fill, "mask_grow": grow},
                               answers or [{"output": SPLIT_CUTOUT}, {"output": [SPLIT_BACKGROUND]}],
                               pictures={"image": pic}, files=files,
                               picture_modes={"image": "RGBA"} if mode == "RGBA" else None, made_pixels=True))

    for fill, short in SPLIT_FILLS.items():
        for grow in (0, 1, 12, 50):
            for mode in ("RGB", "RGBA"):
                split(f"{short} · mask_grow {grow} · {mode} input", fill, grow, mode, seed=300 + grow * 3 + (mode == "RGBA"))
    split("a picture 50 px wide, mask_grow 50", grow=50, size=(50, 20), seed=400)
    split("a picture 50 px wide, mask_grow 50, Bria", fill="Bria Eraser (quality)", grow=50, size=(50, 20), mode="RGBA", seed=401)
    # A downloaded picture is always read as RGBA (bytesio_to_image_tensor): with no alpha the mask is all 255
    # and the remover's matte ('map') is never asked for. Two calls, as every other case.
    split("a cut-out with no alpha (no matte call)", cutout=_split_cutout(W, H, 411, "RGB"), seed=410)
    for kind, label in (("LA", "grey and alpha"), ("P", "palette with transparency"), ("CMYK", "CMYK JPEG"), ("I;16", "16-bit grey")):
        split(f"a cut-out in {label}", cutout=_split_cutout(W, H, 421, kind), seed=420)
    split("a cut-out larger than the picture", cutout=_split_cutout(60, 45, 431), seed=430)
    split("a cut-out 1 px tall, mask_grow 1", size=(W, 1), grow=1, cutout=_split_cutout(W, 1, 436), seed=435)
    for kind, label, data in (("RGB", "RGB", png_bytes(W, H, 441, "RGB")), ("CMYK", "CMYK JPEG", cmyk_jpeg_bytes(W, H, 442)),
                              ("I;16", "16-bit grey", grey16_png_bytes(W, H, 443))):
        split(f"a background in {label}", background=data, seed=440)
    split("answers the other way round (a list, then a string)", answers=[{"output": [SPLIT_CUTOUT]}, {"output": SPLIT_BACKGROUND}], seed=455)
    # Fix round 1: phone photos, EXIF turned by the loader (Python's picture is the turned one; the remover
    # answers in that shape). Stored 36 × 48 with orientation 6 (turned to 48 × 36), and 48 × 36 with 3 (180°).
    split("an EXIF-6 JPEG from the loader", picture=_exif_picture(H, W, 480, 6, "JPEG"), seed=480)
    split("an EXIF-3 PNG from the loader", fill="Bria Eraser (quality)", grow=1, picture=_exif_picture(W, H, 485, 3, "PNG"), seed=485)
    split("a cut-out answer with no output", answers=[{"output": None}], seed=460)
    split("a background answer with no output", answers=[{"output": SPLIT_CUTOUT}, {"output": []}], seed=470)

    # MaxFilter alone: PIL expands the image by size // 2 before its rank filter; the fixture says how it fills.
    # Each mask is written once (`masks`, raw L bytes by "<w>x<h>"), then filtered at each size.
    masks: dict = {}
    maxfilter = []
    for (w, h) in ((37, 23), (320, 200), (1, 7), (9, 1), (1, 1)):
        raw = split_mask(w, h, 500 + w * 7 + h)
        masks[f"{w}x{h}"] = _b64(raw)
        for size in (3, 25, 101):
            out = Image.frombytes("L", (w, h), raw).filter(ImageFilter.MaxFilter(size)).tobytes()
            row = {"w": w, "h": h, "size": size, "sha256": hashlib.sha256(out).hexdigest()}
            if w * h <= 37 * 23:
                row["out"] = _b64(out)
            maxfilter.append(row)
    return {"cases": cases, "maxfilter": maxfilter, "masks": masks}


# ── handoff (R3.H): the picture a loader's tensor is handed to a provider as ──

def _raw_png(w: int, h: int, colour_type: int, depth: int, pixels: bytes) -> bytes:
    """A PNG written by hand (PIL can't write 16-bit colour): filter 0 rows of `pixels`."""
    import zlib
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[colour_type]
    row = w * channels * depth // 8

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + pixels[y * row:(y + 1) * row] for y in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, depth, colour_type, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def handoff_files() -> dict:
    """The loader files of the handoff group, by case name: every kind the
    brief names (EXIF 2–8 JPEG, RGBA PNG, palette PNG with transparency, CMYK
    JPEG, 16-bit PNG, WebP, a plain RGB JPEG) and the kinds that decide RGB
    against RGBA on the Image card (grey + alpha, a colour-keyed RGB PNG, an
    RGBA PNG that is opaque everywhere) or that carry chunks Python drops."""
    import io
    from PIL import Image
    W, H = 23, 15
    rng = random.Random(9100)

    def noise(n: int) -> bytes:
        return bytes(rng.randrange(256) for _ in range(n))

    def save(img, fmt: str, **kw) -> bytes:
        buf = io.BytesIO()
        img.save(buf, format=fmt, **kw)
        return buf.getvalue()

    def exif(orientation: int):
        e = Image.Exif()
        e[0x0112] = orientation
        return e

    rgb = Image.frombytes("RGB", (W, H), noise(W * H * 3))
    alpha = bytes(rng.choice((0, 255, rng.randrange(256))) for _ in range(W * H))
    rgba = rgb.convert("RGBA")
    rgba.putalpha(Image.frombytes("L", (W, H), alpha))
    out = {
        "a plain RGB JPEG": save(rgb, "JPEG", quality=95),
        "a plain RGB PNG": save(rgb, "PNG"),
        "an RGB PNG with a text chunk": save(rgb, "PNG", pnginfo=_png_text()),
        "a grey PNG": save(Image.frombytes("L", (W, H), noise(W * H)), "PNG"),
        "an RGBA PNG, partly see-through": save(rgba, "PNG"),
        "an RGBA PNG, opaque everywhere": save(rgb.convert("RGBA"), "PNG"),
        "an RGBA PNG with one pixel at 254": None,
        "a grey + alpha PNG": save(Image.merge("LA", (Image.frombytes("L", (W, H), noise(W * H)), Image.frombytes("L", (W, H), alpha))), "PNG"),
        "an RGB PNG with a colour key": None,
        "a palette PNG with transparency": None,
        "a palette PNG, no transparency": None,
        "a CMYK JPEG": cmyk_jpeg_bytes(W, H, 9101),
        "a CMYK JPEG, EXIF 6": None,
        "a 16-bit grey PNG": grey16_png_bytes(W, H, 9102),
        "a 16-bit RGB PNG": _raw_png(W, H, 2, 16, noise(W * H * 6)),
        "a 16-bit RGBA PNG, partly see-through": _raw_png(W, H, 6, 16, noise(W * H * 8)),
        "a lossy WebP": save(rgb, "WEBP", quality=90),
        "a lossless WebP with alpha": save(rgba, "WEBP", lossless=True),
        "a WebP, EXIF 6": save(rgb, "WEBP", quality=90, exif=exif(6)),
        "a PNG with EXIF 6 (eXIf)": save(rgb, "PNG", exif=exif(6)),
        "an RGBA PNG, EXIF 8, partly see-through": save(rgba, "PNG", exif=exif(8)),
        "a GIF, no transparency": save(rgb.convert("P", palette=Image.Palette.ADAPTIVE, colors=64), "GIF"),
    }
    for o in range(2, 9):
        out[f"a JPEG, EXIF {o}"] = save(rgb, "JPEG", quality=95, exif=exif(o))
    one = bytearray(b"\xff" * (W * H))
    one[W * H // 2] = 254
    nearly = rgb.convert("RGBA")
    nearly.putalpha(Image.frombytes("L", (W, H), bytes(one)))
    out["an RGBA PNG with one pixel at 254"] = save(nearly, "PNG")
    out["an RGB PNG with a colour key"] = save(rgb, "PNG", transparency=rgb.getpixel((3, 2)))
    pal = Image.frombytes("P", (W, H), bytes(rng.randrange(32) for _ in range(W * H)))
    pal.putpalette(noise(32 * 3))
    out["a palette PNG with transparency"] = save(pal, "PNG", transparency=bytes(rng.randrange(256) for _ in range(32)))
    out["a palette PNG, no transparency"] = save(pal, "PNG")
    cmyk = Image.open(io.BytesIO(out["a CMYK JPEG"]))
    out["a CMYK JPEG, EXIF 6"] = save(cmyk, "JPEG", quality=95, exif=exif(6))
    return out


def _png_text():
    from PIL import PngImagePlugin
    info = PngImagePlugin.PngInfo()
    info.add_text("prompt", '{"1": {"class_type": "KSampler"}}')
    return info


def _loader_tensor(loader: str, data: bytes, filename: str):
    """What a real loader hands on for this file: LoadImage (nodes.py) or the
    Image card (comfy_extras/nodes_image.py, which keeps the alpha of a file
    that has any as a 4th channel), from a temporary input folder."""
    import tempfile
    import folder_paths
    import nodes
    from comfy_extras import nodes_image
    with tempfile.TemporaryDirectory() as tmp:
        before = folder_paths.get_input_directory()
        folder_paths.set_input_directory(tmp)
        try:
            with open(os.path.join(tmp, filename), "wb") as f:
                f.write(data)
            if loader == "LoadImage":
                return nodes.LoadImage().load_image(filename)[0]
            none = lambda *_a, **_k: {"ui": {"images": []}}  # noqa: E731 — the previews are not part of the fixture
            with mock.patch.object(nodes_image.Image, "_preview_to_temp", none), \
                    mock.patch.object(nodes_image, "save_live_preview", none), \
                    mock.patch.object(folder_paths, "get_temp_directory", lambda: tmp):
                card = nodes_image.Image()
                got = card.process(image=filename, export=False, filename_prefix="ComfyUI", format="png", quality=90,
                                   lossless_webp=False, png_compression=4, scale=1.0, max_dimension=0, embed_metadata=True)
            return got["result"][0]
        finally:
            folder_paths.set_input_directory(before)


HANDOFF_EDITED = "https://f.test/handoff/edited.png"
HANDOFF_EXT = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif"}


def handoff_group() -> dict:
    """R3.H: the bytes Python hands a provider for a picture from a loader.
    Every paid node the runner takes encodes its IMAGE input with
    `_image_tensor_to_data_url` (a PNG of the first frame, 8-bit, as many
    channels as the tensor); for each file kind and each loader (LoadImage,
    the Image card), the real loader makes the tensor and a real node sends
    it: Edit an image on FLUX.2 [pro] (fal), and Remove object on Nano Banana 2
    (Replicate, comfy_extras) for a few. Each case records the calls (the
    picture as `PNG:<sha256>` of Python's PNG) and `made`: that PNG's decoded
    pixels (shape and sha256), which the runner's hand-off must equal."""
    import io
    from PIL import Image
    import runner_builder_fixtures as rbf
    nr, _fal, extras = rbf._node_modules()
    edit_actions = next(m for m in extras if hasattr(m, "RemoveObjectNode"))
    files = handoff_files()
    edited = _b64(png_bytes(8, 6, 9200, "RGBA"))
    cases: list = []
    for fname, data in files.items():
        ext = HANDOFF_EXT[Image.open(io.BytesIO(data)).format]
        filename = f"handoff.{ext}"
        runs = [("EditImageNode", nr.EditImageNode, "input_image",
                 {"model": "Flux 2 Pro", "prompt": "make it dusk", "aspect_ratio": "match_input_image", "resolution": "1K",
                  "seed": 7, "safety_tolerance": 2, "prompt_upsampling": False, "output_format": "png"},
                 [{"images": [{"url": HANDOFF_EDITED}]}])]
        if fname in ("a JPEG, EXIF 6", "an RGBA PNG, partly see-through", "a CMYK JPEG"):
            runs.append(("RemoveObjectNode", edit_actions.RemoveObjectNode, "image", {"target": "the lamp", "instructions": ""},
                         [{"output": HANDOFF_EDITED}]))
        for loader in ("LoadImage", "Image"):
            for cls_name, cls, input_name, widgets, answers in runs:
                tensor = _loader_tensor(loader, data, filename)
                got = capture_calls(cls, answers, files={HANDOFF_EDITED: edited}, made_pixels=True,
                                    tensors={input_name: tensor}, **widgets)
                case = {"name": f"handoff · {fname} · {loader} → {cls_name}", "file": fname, "filename": filename,
                        "loader": loader, "class_type": cls.define_schema().node_id, "input": input_name,
                        "widgets": widgets, "answers": answers, "calls": got["calls"], "made": got.get("made", {}),
                        "tensor_shape": list(tensor.shape)}
                if "error" in got:
                    case["error"] = got["error"]
                cases.append(case)
    return {"cases": cases, "files": {n: _b64(b) for n, b in files.items()}}


# ── handoff2 (R3.H2): pictures made in the run, handed to a provider ─────────

H2_GENERATED = "https://f.test/handoff2/generated"
H2_OUTPAINTED = "https://r.test/handoff2/outpainted.png"
H2_EDIT = {"model": "Flux 2 Pro", "prompt": "make it dusk", "aspect_ratio": "match_input_image", "resolution": "1K",
           "seed": 7, "safety_tolerance": 2, "prompt_upsampling": False, "output_format": "png"}
H2_GENERATE = {"model": "flux-schnell", "prompt": "a red fox", "aspect_ratio": "1:1", "seed": 7, "model_options": "{}"}
H2_OUTPAINT = {"model": "Flux Fill", "prompt": "", "direction": "Zoom out 1.5x", "aspect_ratio": "16:9", "seed": 0}
H2_EFFECTS = {"AdjustInvert": {"amount": 0.37}, "AdjustExposure": {"exposure": 0.3}}


def _h2_step(node_cls, answers: list, **kw) -> tuple:
    """capture_calls, and the tensor the node hands on (its first output):
    `execute` is wrapped for the one run, nothing else changes."""
    kept: dict = {}
    real = node_cls.execute

    async def keep(**kwargs):
        out = await real(**kwargs)
        kept["out"] = out
        return out

    with mock.patch.object(node_cls, "execute", keep):
        got = capture_calls(node_cls, answers, **kw)
    assert "error" not in got, (node_cls.__name__, got.get("error"))
    return got, kept["out"].args[0]


def _h2_effect(class_type: str, tensor):
    """A real effect's picture (its float32 tensor), its live preview left out."""
    from comfy_api.latest._io import HiddenHolder
    import comfy_extras.nodes_adjust_exposure as ne
    import comfy_extras.nodes_color_filters as ncf
    cls = {"AdjustInvert": ncf.InvertNode, "AdjustExposure": ne.AdjustExposureNode}[class_type]
    none = lambda *_a, **_k: {"images": []}  # noqa: E731 — the preview is not part of the fixture
    with mock.patch.object(cls, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "h2"})), \
            mock.patch.object(sys.modules[cls.__module__], "save_live_preview", none):
        return cls.execute(image=tensor, **H2_EFFECTS[class_type]).args[0]


def handoff2_group() -> dict:
    """R3.H2: the bytes Python hands a provider for a picture made in the run.
    Each case runs a real producer, and its real output tensor goes to Edit an
    image on FLUX.2 [pro] (fal), whose `_image_tensor_to_data_url` makes the
    PNG (`made`: its decoded pixels):
      answer  — Generate an image (flux-schnell, fal) whose answer is each
                file kind (bytesio_to_image_tensor: PIL's RGBA, no EXIF
                turn), and one to Remove object (Replicate);
      dropped — Expand / outpaint (Flux Fill), whose RGBA answer Python cuts
                to RGB (`tensor[..., :3]`);
      effect  — an effect's float32 tensor (Invert 0.37, Exposure 0.3) from a
                LoadImage, an Image card with see-through pixels (4 channels)
                and a provider's answer: `round(255·x)`."""
    import io
    from PIL import Image
    import runner_builder_fixtures as rbf
    nr, _fal, extras = rbf._node_modules()
    edit_actions = next(m for m in extras if hasattr(m, "RemoveObjectNode"))
    files = {k: v for k, v in handoff_files().items() if not (k.startswith("a JPEG, EXIF ") and k != "a JPEG, EXIF 6")}
    edited = _b64(png_bytes(8, 6, 9200, "RGBA"))
    edit_answer = [{"images": [{"url": HANDOFF_EDITED}]}]
    cases: list = []

    def to_edit(name: str, kind: str, source: dict, producer: list, tensor, *, cls=None, input_name="input_image",
                widgets=None, answers=None) -> None:
        cls = cls or nr.EditImageNode
        widgets = widgets if widgets is not None else H2_EDIT
        answers = answers if answers is not None else edit_answer
        got = capture_calls(cls, answers, files={HANDOFF_EDITED: edited}, made_pixels=True, tensors={input_name: tensor}, **widgets)
        assert "error" not in got, (name, got.get("error"))
        cases.append({"name": name, "kind": kind, **source, "producer": producer, "class_type": cls.define_schema().node_id,
                      "input": input_name, "widgets": widgets, "answers": answers, "calls": got["calls"],
                      "made": got["made"], "tensor_shape": list(tensor.shape)})

    def generated(fname: str):
        url = f"{H2_GENERATED}.{HANDOFF_EXT[Image.open(io.BytesIO(files[fname])).format]}"
        answers = [{"images": [{"url": url, "width": 8, "height": 8, "content_type": "image/png"}]}]
        got, t = _h2_step(nr.GenerateImageNode, answers, files={url: _b64(files[fname])}, **H2_GENERATE)
        step = {"class_type": "GenerateImageNode", "widgets": H2_GENERATE, "answers": answers, "calls": got["calls"], "url": url}
        return step, t

    for fname in files:
        step, t = generated(fname)
        to_edit(f"answer · {fname} → Edit an image", "answer", {"file": fname}, [step], t)
    step, t = generated("an RGBA PNG, partly see-through")
    to_edit("answer · an RGBA PNG, partly see-through → Remove object", "answer", {"file": "an RGBA PNG, partly see-through"}, [step], t,
            cls=edit_actions.RemoveObjectNode, input_name="image", widgets={"target": "the lamp", "instructions": ""},
            answers=[{"output": HANDOFF_EDITED}])

    # Alpha dropped by the producer: Expand / outpaint's RGBA answer as RGB.
    src = files["a plain RGB PNG"]
    for fname in ("an RGBA PNG, partly see-through", "a plain RGB JPEG"):
        answers = [{"output": [H2_OUTPAINTED]}]
        got, t = _h2_step(nr.OutpaintImageNode, answers, files={H2_OUTPAINTED: _b64(files[fname])}, pictures={"image": src}, **H2_OUTPAINT)
        step = {"class_type": "OutpaintImageNode", "widgets": H2_OUTPAINT, "answers": answers, "calls": got["calls"], "url": H2_OUTPAINTED}
        to_edit(f"dropped · Expand / outpaint answering {fname} → Edit an image", "dropped",
                {"file": fname, "source_file": "a plain RGB PNG"}, [step], t)

    # An effect's float32 tensor.
    for class_type in H2_EFFECTS:
        for loader, fname in (("LoadImage", "a plain RGB JPEG"), ("Image", "an RGBA PNG, partly see-through")):
            filename = f"handoff2.{HANDOFF_EXT[Image.open(io.BytesIO(files[fname])).format]}"
            t = _h2_effect(class_type, _loader_tensor(loader, files[fname], filename))
            to_edit(f"effect · {loader} {fname} → {class_type} → Edit an image", "effect",
                    {"file": fname, "filename": filename, "loader": loader, "effect": class_type}, [], t)
        step, g = generated("an RGBA PNG, partly see-through")
        to_edit(f"effect · Generate an image (RGBA answer) → {class_type} → Edit an image", "effect",
                {"file": "an RGBA PNG, partly see-through", "effect": class_type}, [step], _h2_effect(class_type, g))
    return {"cases": cases, "files": {n: _b64(b) for n, b in files.items()}, "edited": edited}


MUSIC_OUT = "https://r.test/music/out.wav"
MUSIC_OUT_2 = "https://r.test/music/second.wav"
SPEECH_OUT = "https://r.test/speech/out.wav"
MUSIC_DEFAULTS = {"prompt": "lo-fi hip-hop, mellow piano, 80 bpm", "duration": 8, "model_version": "stereo-melody-large",
                  "temperature": 1.0, "top_p": 0.0, "seed": 0}
SPEECH_DEFAULTS = {"text": "Hello from Sailor.", "voice_id": "Wise_Woman", "emotion": "auto", "speed": 1.0, "volume": 1.0,
                   "pitch": 0, "language_boost": "auto"}


def audio_gen_group() -> dict:
    """R3.8: Generate music and Generate speech, and their hidden twins
    (MusicGen, MiniMax Speech-02 HD). Each answers one sound URL; the first
    of a list is the one downloaded (`_first_output_url`), decoded by the real
    `_download_url_to_audio_dict`."""
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    wav = _b64(wav_bytes(0.1, 8000, 21))
    wav2 = _b64(wav_bytes(0.1, 8000, 22, channels=2))
    cases: list = []

    def add(name, cls, widgets, answer, files=None):
        cases.append(paid_case(name, cls, widgets, [answer], files=files or {MUSIC_OUT: wav, SPEECH_OUT: wav}))

    def music(name, twin=False, answer=None, files=None, **w):
        cls = nr.MusicGenRemoteNode if twin else nr.GenerateMusicNode
        widgets = {**MUSIC_DEFAULTS, **w} if twin else {"model": "MusicGen", **MUSIC_DEFAULTS, **w}
        add(f"{'music twin' if twin else 'music'} · {name}", cls, widgets, answer or {"output": MUSIC_OUT}, files)

    def speech(name, twin=False, answer=None, **w):
        cls = nr.MiniMaxSpeechRemoteNode if twin else nr.GenerateSpeechNode
        widgets = {**SPEECH_DEFAULTS, **w} if twin else {"model": "MiniMax Speech-02 HD", **SPEECH_DEFAULTS, **w}
        add(f"{'speech twin' if twin else 'speech'} · {name}", cls, widgets, answer or {"output": SPEECH_OUT})
        # Python's len() of the text sent: what the price counts (characters, code points).
        cases[-1]["text_len"] = len(widgets["text"])

    # Music: every version at 1 s and 30 s; top_p 0 and 0.5; seeds 0 and 7; the other settings.
    for version in ("stereo-melody-large", "stereo-large", "melody-large", "large"):
        for seconds in (1, 30):
            music(f"{version} {seconds} s", model_version=version, duration=seconds)
    for top_p in (0.0, 0.5, 1.0):
        for seed in (0, 7):
            music(f"top_p {top_p} seed {seed}", top_p=top_p, seed=seed)
    music("seed 4294967295", seed=4294967295)
    music("temperature 0", temperature=0.0)
    music("temperature 1.35", temperature=1.35)
    music("temperature 2", temperature=2.0)
    music("empty prompt", prompt="")
    music("non-ASCII prompt", prompt="caf\u00e9 jazz, \u732b, \U0001f3b8 \u2014 slow")
    music("defaults", twin=True)
    music("large 30 s top_p 0.5 seed 7", twin=True, model_version="large", duration=30, top_p=0.5, seed=7)
    # The answer as a list (the first is the sound) and a stereo sound.
    music("answer list", answer={"output": [MUSIC_OUT, MUSIC_OUT_2]}, files={MUSIC_OUT: wav2, MUSIC_OUT_2: wav})

    # Speech: every emotion, every language boost, the bounds, a non-ASCII text, a cloned voice.
    for emotion in ("auto", "happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"):
        speech(f"emotion {emotion}", emotion=emotion)
    for lang in ("auto", "English", "Spanish", "French", "German", "Italian", "Portuguese", "Japanese", "Korean", "Chinese", "Arabic"):
        speech(f"language {lang}", language_boost=lang)
    for speed in (0.5, 2.0, 1.25):
        speech(f"speed {speed}", speed=speed)
    for pitch in (-12, 12):
        speech(f"pitch {pitch}", pitch=pitch)
    for volume in (0.1, 10.0):
        speech(f"volume {volume}", volume=volume)
    for voice in ("Friendly_Person", "Exuberant_Girl", "Sweet_Girl_2"):
        speech(f"voice {voice}", voice_id=voice)
    speech("cloned voice", voice_id="sailor_clone_7f3a")
    speech("non-ASCII text", text="Caf\u00e9 \u2014 na\u00efve \u732b \U0001f600 \u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8")
    speech("every setting", emotion="sad", language_boost="Japanese", speed=0.75, volume=2.5, pitch=-3, voice_id="Calm_Woman")
    speech("defaults", twin=True)
    speech("every setting", twin=True, emotion="happy", language_boost="Korean", speed=1.5, pitch=5, voice_id="Young_Knight")
    speech("answer list", answer={"output": [SPEECH_OUT, MUSIC_OUT_2]})
    # len() of texts the price counts: ASCII, accents (composed and combining), CJK, emoji (astral,
    # with a skin tone, a ZWJ family), a flag, CRLF, a lone surrogate, and a long one.
    texts = ["", " ", "Hello", "caf\u00e9", "cafe\u0301", "\u65e5\u672c\u8a9e", "\U0001f600", "\U0001f44b\U0001f3fd",
             "\U0001f468\u200d\U0001f469\u200d\U0001f467", "\U0001f1eb\U0001f1f7", "a\r\nb", "x\ud800y", "ab" * 5001]
    return {"cases": cases, "text_lengths": [{"text": t, "len": len(t)} for t in texts]}


# ── sound-in (R3.10) ─────────────────────────────────────────────────────────

WIZPER_OUT = {"text": "Hello from Sailor.", "chunks": [{"timestamp": [0.0, 1.5], "text": "Hello from Sailor."}], "languages": ["en"]}
RVC_OUT = "https://r.test/rvc/out.wav"
RVC_OUT_2 = "https://r.test/rvc/second.wav"
LIPSYNC_OUT = "https://r.test/lipsync/out.mp4"
LIPSYNC_OUT_2 = "https://r.test/lipsync/second.mp4"
FACE_VIDEO = "https://r.test/face.mp4"
TRANSCRIBE_DEFAULTS = {"language": "auto", "translate": False}
DIARIZE_DEFAULTS = {"model": "Whisper Diarization", "num_speakers": 0, "language": "auto"}
RVC_DEFAULTS = {"model": "Realistic Voice Cloning (RVC)", "rvc_model": "Squidward", "custom_rvc_model_url": "",
                "pitch_change": "no-change", "pitch_shift_semitones": 0, "pitch_detection_algorithm": "rmvpe",
                "output_format": "wav"}
LIPSYNC_DEFAULTS = {"video_url": FACE_VIDEO, "sync_mode": "cut_off"}
SOUND_LANGUAGES = ["auto", "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ru", "ar", "hi"]
RVC_PRESETS = ["Squidward", "MrKrabs", "Plankton", "Drake", "Vader", "Trump", "Biden", "Obama", "Guitar", "Voilin", "CUSTOM"]


def clip_samples(frames: int, channels: int, seed: int) -> list:
    """The standard sound clips' samples, interleaved (frame by frame, channel by channel): an LCG
    (state = (state · 1103515245 + 12345) mod 2**31, from `seed`), each sample
    ((state >> 8) mod 65536) − 32768, an int16. The TypeScript side makes the same numbers."""
    state = seed & 0x7FFFFFFF
    out = []
    for _ in range(frames * channels):
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF
        out.append(((state >> 8) & 0xFFFF) - 32768)
    return out


def clip_bytes(kind: str, rate: int, channels: int, frames: int, seed: int) -> bytes:
    """A clip file: `pcm16` a 16-bit PCM WAV of clip_samples; `float32` an IEEE-float WAV of each
    sample / 8192 (up to ±4: samples beyond ±1). The plain 44-byte header, fmt tag 1 or 3."""
    samples = clip_samples(frames, channels, seed)
    if kind == "pcm16":
        data = struct.pack(f"<{len(samples)}h", *samples)
        tag, width = 1, 2
    else:
        data = struct.pack(f"<{len(samples)}f", *[v / 8192 for v in samples])
        tag, width = 3, 4
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE" + b"fmt " + struct.pack(
        "<IHHIIHH", 16, tag, channels, rate, rate * channels * width, channels * width, width * 8) + b"data" + struct.pack("<I", len(data))
    return header + data


SOUND_CLIPS = [
    {"name": "mono 16 kHz 3 s", "kind": "pcm16", "rate": 16000, "channels": 1, "seconds": 3, "seed": 101},
    {"name": "stereo 16 kHz 3 s", "kind": "pcm16", "rate": 16000, "channels": 2, "seconds": 3, "seed": 102},
    {"name": "mono 44.1 kHz 3 s", "kind": "pcm16", "rate": 44100, "channels": 1, "seconds": 3, "seed": 103},
    {"name": "stereo 44.1 kHz 3 s", "kind": "pcm16", "rate": 44100, "channels": 2, "seconds": 3, "seed": 104},
    {"name": "mono 48 kHz 3 s", "kind": "pcm16", "rate": 48000, "channels": 1, "seconds": 3, "seed": 105},
    {"name": "stereo 48 kHz 3 s", "kind": "pcm16", "rate": 48000, "channels": 2, "seconds": 3, "seed": 106},
    {"name": "mono 16 kHz 75 s (cut at 60 s)", "kind": "pcm16", "rate": 16000, "channels": 1, "seconds": 75, "seed": 107},
    {"name": "stereo 8 kHz 75 s (cut at 60 s)", "kind": "pcm16", "rate": 8000, "channels": 2, "seconds": 75, "seed": 108},
    {"name": "stereo 44.1 kHz float, beyond ±1", "kind": "float32", "rate": 44100, "channels": 2, "seconds": 1, "seed": 109},
    {"name": "mono 22.05 kHz float, beyond ±1", "kind": "float32", "rate": 22050, "channels": 1, "seconds": 2, "seed": 110},
]


def _python_wav(path: str) -> dict:
    """What `_audio_dict_to_wav_data_url(audio, max_seconds=60)` sends for the AUDIO LoadAudio makes of
    `path` (nodes_audio.load): the WAV's own header facts and the sha256 of its PCM samples."""
    import comfy_extras.nodes_audio as na
    waveform, rate = na.load(path)
    return _python_wav_of({"waveform": waveform.unsqueeze(0), "sample_rate": rate})


def _card_silence() -> dict:
    """The AUDIO the real Audio card hands on with no file and nothing wired (nodes_audio.py :327-331)."""
    import comfy_extras.nodes_audio as na
    out = na.Audio.execute(audio="", export=False, filename_prefix="audio/ComfyUI", format="flac", quality="V0")
    return out.args[0]


def _python_wav_of(audio: dict) -> dict:
    """`_audio_dict_to_wav_data_url(audio, max_seconds=60)` of an AUDIO dict: the WAV's facts, its PCM's
    sha256, and the sha256 of the whole WAV (what capture_calls names a sound it made itself)."""
    import base64
    import hashlib
    import io
    import wave
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    url = nr._audio_dict_to_wav_data_url(audio, max_seconds=60)
    wav = base64.b64decode(url.split(",", 1)[1])
    with wave.open(io.BytesIO(wav), "rb") as w:
        ch, width, r, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        pcm = w.readframes(n)
    return {"channels": ch, "sample_width": width, "rate": r, "frames": n, "pcm_sha256": hashlib.sha256(pcm).hexdigest(),
            "head": list(struct.unpack(f"<{min(16, len(pcm) // 2)}h", pcm[:32])),
            "seconds": n / r, "wav_sha256": hashlib.sha256(wav).hexdigest()}


def sound_in_group() -> dict:
    """R3.10: Transcribe audio and its twin (Whisper on fal's Wizper), Identify speakers, Clone a singing
    voice and Sync lips to audio and its twin, each sending Python's WAV of its sound (`WAV:<input>`, and
    Whisper's uploaded as `UPLOAD:whisper.wav`); and `wavs`: the WAV Python sends for the standard clips
    (3 s mono and stereo at 16, 44.1 and 48 kHz, 75 s clips cut at 60 s, float clips beyond ±1), each read
    by LoadAudio's own `load`, compared by samples (PyAV's header carries an encoder tag)."""
    import hashlib
    import tempfile
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    rvc_wav = _b64(wav_bytes(0.1, 8000, 31))
    rvc_wav2 = _b64(wav_bytes(0.1, 8000, 32, channels=2))
    video = _b64(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00\x00\x00\x08mdat")
    cases: list = []

    def add(name, cls, widgets, answers, files=None):
        cases.append(paid_case(name, cls, widgets, answers, sounds=["audio"], files=files))

    def transcribe(name, twin=False, answer=None, **w):
        cls = nr.WhisperRemoteNode if twin else nr.TranscribeAudioNode
        widgets = {**TRANSCRIBE_DEFAULTS, **w} if twin else {"model": "Whisper", **TRANSCRIBE_DEFAULTS, **w}
        add(f"{'whisper twin' if twin else 'transcribe'} · {name}", cls, widgets, [WIZPER_OUT if answer is None else answer])

    for lang in SOUND_LANGUAGES:
        transcribe(f"language {lang}", language=lang)
    transcribe("translate", translate=True)
    transcribe("translate fr", translate=True, language="fr")
    # The answer's text: missing, null, empty, spaces kept, non-ASCII, a number (str()), a falsy 0, a null body.
    transcribe("text missing", answer={"chunks": [], "languages": ["en"]})
    transcribe("text null", answer={"__body__": '{"text": null, "chunks": []}'})
    transcribe("text empty", answer={"text": ""})
    transcribe("text with spaces", answer={"text": "  Hello,  world.  \n"})
    transcribe("non-ASCII text", answer={"__body__": '{"text": " caf\\u00e9 \\u732b \\ud83d\\ude00 \\u65e5\\u672c\\u8a9e "}'})
    transcribe("text a float", answer={"__body__": '{"text": 1.0}'})
    transcribe("text a big float", answer={"__body__": '{"text": 1e5}'})
    transcribe("text zero", answer={"__body__": '{"text": 0}'})
    transcribe("body null", answer={"__body__": "null"})
    transcribe("defaults", twin=True)
    transcribe("translate ja", twin=True, translate=True, language="ja")
    transcribe("text with spaces", twin=True, answer={"text": "  twin  "})

    def diarize(name, answer=None, **w):
        add(f"speakers · {name}", nr.IdentifySpeakersNode, {**DIARIZE_DEFAULTS, **w},
            [answer if answer is not None else {"__body__": DIARIZE_BODY}])

    for n in (0, 1, 2, 20):
        diarize(f"{n} speakers", num_speakers=n)
    for lang in SOUND_LANGUAGES:
        diarize(f"language {lang}", language=lang)
    diarize("3 speakers, de", num_speakers=3, language="de")
    diarize("output a string", answer={"output": '{"segments": [], "note": "already text"}'})
    diarize("output null", answer={"__body__": '{"output": null}'})
    diarize("output missing", answer={"__body__": '{"status": "succeeded"}'})
    diarize("output a list", answer={"__body__": '{"output": [1.0, 1e5, "caf\\u00e9", {"b": 2, "a": -0.0}]}'})

    def clone(name, answer=None, files=None, **w):
        add(f"clone · {name}", nr.CloneSingingVoiceNode, {**RVC_DEFAULTS, **w},
            [answer or {"output": RVC_OUT}], files=files or {RVC_OUT: rvc_wav, RVC_OUT_2: rvc_wav2})

    for preset in RVC_PRESETS:
        clone(f"preset {preset}", rvc_model=preset)
    clone("CUSTOM with a URL", rvc_model="CUSTOM", custom_rvc_model_url="https://huggingface.co/alice/voice.zip")
    clone("a URL without CUSTOM", rvc_model="Guitar", custom_rvc_model_url="https://huggingface.co/alice/voice.zip")
    for change in ("no-change", "male-to-female", "female-to-male"):
        clone(f"pitch {change}", pitch_change=change)
    for semis in (-12, -1, 0, 5, 12):
        clone(f"semitones {semis}", pitch_shift_semitones=semis)
    clone("mangio-crepe", pitch_detection_algorithm="mangio-crepe")
    clone("mp3", output_format="mp3")
    clone("answer list", answer={"output": [RVC_OUT_2, RVC_OUT]})

    def lipsync(name, twin=False, answer=None, **w):
        cls = nr.LipsyncRemoteNode if twin else nr.LipsyncNode
        widgets = {**LIPSYNC_DEFAULTS, **w} if twin else {"model": "sync.so 2-pro", **LIPSYNC_DEFAULTS, **w}
        add(f"{'lipsync twin' if twin else 'lipsync'} · {name}", cls, widgets, [answer or {"output": LIPSYNC_OUT}],
            files={LIPSYNC_OUT: video, LIPSYNC_OUT_2: video})

    for mode in ("loop", "bounce", "cut_off", "silence", "remap"):
        lipsync(f"mode {mode}", sync_mode=mode)
        lipsync(f"mode {mode}", twin=True, sync_mode=mode)
    lipsync("upload link", video_url="/view?filename=face.mp4&type=input")
    lipsync("http address", video_url="http://r.test/face.mp4")
    lipsync("spaces address", video_url="   ")
    lipsync("blank address", video_url="")
    lipsync("blank address", twin=True, video_url="")
    lipsync("answer list", answer={"output": [LIPSYNC_OUT_2, LIPSYNC_OUT]})

    # An empty Audio card wired in (fix round 1): Python's card hands on 1 s of 44.1 kHz silence, which
    # each node sends as its WAV (`WAV:<sha256>` of the WAV Python made; Whisper's uploaded as ever).
    def silent(name, cls, widgets, answers, files=None):
        got = capture_calls(cls, answers, files=files, tensors={"audio": _card_silence()}, **widgets)
        case = {"name": name, "class_type": cls.define_schema().node_id, "widgets": widgets, "pictures": [], "sounds": [],
                "picture_files": {}, "sound_files": {}, "silent_card": ["audio"], "answers": answers,
                "calls": got["calls"], "gets": got["gets"], "output": got.get("output"), "ui": got.get("ui")}
        if files:
            case["files"] = files
        if "error" in got:
            case["error"] = got["error"]
        cases.append(case)

    silent("transcribe · empty Audio card", nr.TranscribeAudioNode, {"model": "Whisper", **TRANSCRIBE_DEFAULTS}, [WIZPER_OUT])
    silent("whisper twin · empty Audio card", nr.WhisperRemoteNode, dict(TRANSCRIBE_DEFAULTS), [WIZPER_OUT])
    silent("speakers · empty Audio card", nr.IdentifySpeakersNode, dict(DIARIZE_DEFAULTS), [{"__body__": DIARIZE_BODY}])
    silent("clone · empty Audio card", nr.CloneSingingVoiceNode, {**RVC_DEFAULTS, "rvc_model": "Guitar"}, [{"output": RVC_OUT}],
           files={RVC_OUT: rvc_wav})
    silent("lipsync · empty Audio card", nr.LipsyncNode, {"model": "sync.so 2-pro", **LIPSYNC_DEFAULTS}, [{"output": LIPSYNC_OUT}],
           files={LIPSYNC_OUT: video})
    silent("lipsync twin · empty Audio card", nr.LipsyncRemoteNode, dict(LIPSYNC_DEFAULTS), [{"output": LIPSYNC_OUT}],
           files={LIPSYNC_OUT: video})

    wavs = []
    with tempfile.TemporaryDirectory() as tmp:
        for clip in SOUND_CLIPS:
            data = clip_bytes(clip["kind"], clip["rate"], clip["channels"], clip["rate"] * clip["seconds"], clip["seed"])
            path = os.path.join(tmp, "clip.wav")
            with open(path, "wb") as f:
                f.write(data)
            wavs.append({**clip, "file_sha256": hashlib.sha256(data).hexdigest(), "sent": _python_wav(path)})
    return {"cases": cases, "wavs": wavs, "silence": _python_wav_of(_card_silence())}


DIARIZE_BODY = ('{"output": {"segments": [{"start": 0.0, "end": 1.5, "speaker": "SPEAKER_00", "text": " Hello caf\\u00e9.", '
                '"avg_logprob": -0.25, "words": [{"word": " Hello", "start": 0, "end": 1e5, "probability": 1.0}]}, '
                '{"start": 1.5, "end": 3.0, "speaker": "SPEAKER_01", "text": " \\u732b \\ud83d\\ude00"}], '
                '"num_speakers": 2, "language": "en"}, "metrics": {"predict_time": 1.25}}')


GLB_OUT = "https://r.test/3d/model.glb"
GLB_OUT_2 = "https://r.test/3d/preview.glb"
GLB_VIDEO = "https://r.test/3d/color.mp4"
HUNYUAN_DEFAULTS = {"steps": 50, "guidance_scale": 5.5, "octree_resolution": 256, "remove_background": True,
                    "texture": True, "seed": 0}
MULTI_VIEW_DEFAULTS = {"engine": "TRELLIS (textured)", "steps": 50, "guidance_scale": 5.5, "octree_resolution": 256,
                       "remove_background": True, "seed": 0, "prompt": "a full-body character",
                       "rodin_quality": "medium", "rodin_tapose": False, "rodin_poly_count": 0}
MULTI_VIEW_ENGINES = {"TRELLIS": "TRELLIS (textured)", "Rodin": "Rodin (textured \u00b7 quad mesh)",
                      "Hunyuan3D-2mv": "Hunyuan3D-2mv (geometry only)"}
VIEW_SETS = {"front": ("front_image",), "front and back": ("front_image", "back_image"),
             "front and right": ("front_image", "right_image"),
             "four views": ("front_image", "back_image", "left_image", "right_image")}


def glb_bytes(seed: int) -> bytes:
    """A small binary glTF: the 12-byte header (magic `glTF`, version 2, length) and a JSON chunk."""
    body = json.dumps({"asset": {"version": "2.0"}, "extras": {"seed": seed}}).encode()
    body += b" " * (-len(body) % 4)
    chunk = struct.pack("<II", len(body), 0x4E4F534A) + body
    return b"glTF" + struct.pack("<II", 2, 12 + len(chunk)) + chunk


def gen_3d_group() -> dict:
    """R3.9: Generate a 3D model and its hidden twin Hunyuan3D 2 (tencent/hunyuan3d-2),
    and Multi-View → 3D on each engine. Python hands on the answer's link
    (`_first_output_url`, or TRELLIS's `output.model_file`) and downloads
    nothing; `files` carries a GLB per answer URL for the runner, which saves
    its own copy."""
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    files = {GLB_OUT: _b64(glb_bytes(1)), GLB_OUT_2: _b64(glb_bytes(2))}
    cases: list = []

    def add(name, cls, widgets, answer, pictures):
        cases.append(paid_case(name, cls, widgets, [answer], pictures=list(pictures), files=files))

    def one(name, twin=False, answer=None, **w):
        cls = nr.Hunyuan3DRemoteNode if twin else nr.Generate3DNode
        widgets = {**HUNYUAN_DEFAULTS, **w} if twin else {"model": "Hunyuan3D 2", **HUNYUAN_DEFAULTS, **w}
        add(f"{'hunyuan twin' if twin else 'generate 3d'} \u00b7 {name}", cls, widgets, answer or {"output": GLB_OUT}, ["image"])

    def multi(name, engine, views="front", answer=None, drop=(), **w):
        widgets = {**MULTI_VIEW_DEFAULTS, "engine": MULTI_VIEW_ENGINES[engine], **w}
        for k in drop:
            widgets.pop(k)
        add(f"multi-view \u00b7 {engine} \u00b7 {views} \u00b7 {name}", nr.Hunyuan3DMultiViewNode, widgets,
            answer or ({"output": {"model_file": GLB_OUT}} if engine == "TRELLIS" else {"output": GLB_OUT}), VIEW_SETS[views])

    # Generate a 3D model: the defaults, the seeds, every setting at its bounds, each answer shape.
    one("defaults")
    for seed in (0, 1, 65536, 0xFFFFFFFF):
        one(f"seed {seed}", seed=seed)
    for steps in (20, 35, 50, 100):
        one(f"steps {steps}", steps=steps)
    for octree in (128, 256, 384, 512):
        one(f"octree {octree}", octree_resolution=octree)
    for g in (1.0, 7.5, 20.0):
        one(f"guidance {g}", guidance_scale=g)
    one("no background removal, no texture", remove_background=False, texture=False)
    one("the live check's settings", steps=20, octree_resolution=128, texture=False)
    one("answer list", answer={"output": [GLB_OUT, GLB_OUT_2]})
    one("answer string", answer={"output": GLB_OUT})
    # Hunyuan3D 2's published output: `{mesh}` — `_first_output_url` refuses a dict.
    one("answer mesh dict", answer={"output": {"mesh": GLB_OUT}})
    one("defaults", twin=True)
    one("every setting", twin=True, steps=35, guidance_scale=7.5, octree_resolution=384, remove_background=False, texture=False, seed=65536)
    one("seed 4294967295", twin=True, seed=0xFFFFFFFF)

    # Multi-View: each engine with one, two and four views, and the seeds.
    for engine in MULTI_VIEW_ENGINES:
        for views in VIEW_SETS:
            multi("defaults", engine, views)
        for seed in (0, 1, 65536, 0xFFFFFFFF):
            multi(f"seed {seed}", engine, "four views", seed=seed)
    multi("every setting", "Hunyuan3D-2mv", "front and right", steps=100, guidance_scale=20.0, octree_resolution=128,
          remove_background=False, seed=7)
    multi("steps 20 octree 512", "Hunyuan3D-2mv", steps=20, octree_resolution=512, guidance_scale=1.0)
    # Rodin: its prompts, polygon counts, qualities and pose.
    for label, prompt in (("blank prompt", ""), ("spaced prompt", "   \n\t "), ("padded prompt", "  a red robot \n"),
                          ("non-ASCII prompt", "caf\u00e9 \u732b \U0001f916 \u2014 low-poly")):
        multi(label, "Rodin", prompt=prompt)
    multi("no prompt setting", "Rodin", drop=("prompt", "rodin_quality", "rodin_tapose", "rodin_poly_count"))
    for poly in (0, 1000, 300000):
        multi(f"poly {poly}", "Rodin", rodin_poly_count=poly)
    for quality in ("medium", "high", "low", "extra-low"):
        multi(f"quality {quality}", "Rodin", rodin_quality=quality)
    multi("tapose", "Rodin", "four views", rodin_tapose=True, rodin_quality="extra-low", rodin_poly_count=300000, seed=65537)
    # The settings other engines ignore change nothing there.
    multi("Rodin settings ignored", "TRELLIS", prompt="ignored", rodin_quality="high", rodin_tapose=True, rodin_poly_count=5000)
    multi("Rodin settings ignored", "Hunyuan3D-2mv", prompt="ignored", rodin_quality="high", rodin_tapose=True, rodin_poly_count=5000)
    multi("no optional settings", "TRELLIS", drop=("prompt", "rodin_quality", "rodin_tapose", "rodin_poly_count"))
    # TRELLIS's answers: a dict with model_file (and videos), a dict without it, model_file empty, a list, a string.
    multi("answer model_file", "TRELLIS", answer={"output": {"model_file": GLB_OUT, "color_video": GLB_VIDEO, "combined_video": None}})
    multi("answer dict without model_file", "TRELLIS", answer={"output": {"color_video": GLB_VIDEO}})
    multi("answer empty model_file", "TRELLIS", answer={"output": {"model_file": None}})
    multi("answer list", "TRELLIS", answer={"output": [GLB_OUT, GLB_OUT_2]})
    multi("answer string", "TRELLIS", answer={"output": GLB_OUT})
    multi("answer list", "Rodin", answer={"output": [GLB_OUT_2, GLB_OUT]})
    multi("answer list", "Hunyuan3D-2mv", answer={"output": [GLB_OUT]})
    return {"cases": cases}


# ── film-shot (R3.11): Film a shot's preset path ────────────────────────────

FILM_SHOT_DIALECT_MODELS = {"veo": "veo-3.1", "hailuo": "hailuo-h3", "standard": "seedance-2.0"}
FILM_SHOT_PROMPTS = {"blank": "", "spaced": "  \t a lone rider crosses the salt flats at dusk \n "}
FILM_SHOT_OVERRIDES = ("shot_size", "camera_angle", "camera_movement", "lens_look", "composition")
FILM_SHOT_VIDEO = "https://r.test/shot.mp4"


def film_shot_group() -> dict:
    """R3.11: Film a shot's preset path. `phrases` are shot_presets.py's own
    functions; `cases` are FilmShotNode.execute's first provider call
    (capture_first_call), each with the phrase `_build_shot_phrase` returned
    on that run; `runs` are a few whole runs (capture_calls) with the
    provider's answer, for the engine."""
    import io
    import runner_builder_fixtures as rbf
    from comfy_api_nodes import shot_presets as sp
    nr, _fal, _extras = rbf._node_modules()

    phrases: list = []
    override_lists = {"shot_size": sp.SIZE_OPTIONS, "camera_angle": sp.ANGLE_OPTIONS, "camera_movement": sp.MOVEMENT_OPTIONS,
                      "lens_look": sp.LENS_OPTIONS, "composition": sp.COMPOSITION_OPTIONS}

    def phrase(name, preset, overrides=None):
        o = {k: sp.AUTO for k in FILM_SHOT_OVERRIDES}
        o.update(overrides or {})
        recipe = sp.resolve_recipe(preset, o["shot_size"], o["camera_angle"], o["camera_movement"], o["lens_look"], o["composition"])
        for dialect in ("standard", "veo", "hailuo"):
            phrases.append({"name": name, "preset": preset, "overrides": overrides or {}, "dialect": dialect,
                            "recipe_id": recipe.id, "phrase": sp.build_shot_phrase(recipe, dialect)})

    for pid in sp.PRESET_IDS:
        phrase(f"preset {pid}", pid)
    for widget, options in override_lists.items():
        for opt in options:
            phrase(f"{widget} {opt}", sp.DEFAULT_PRESET_ID, {widget: opt})
            phrase(f"{widget} {opt} on orbit", "orbit", {widget: opt})
    every = {w: override_lists[w][-1] for w in FILM_SHOT_OVERRIDES}
    phrase("all five overrides", "tilt-reveal", every)
    phrase("unknown preset", "slow_push_in")
    phrase("empty override keeps the preset", "dutch", {"camera_movement": ""})
    dialects = {m: sp.dialect_for_model(m) for m in [*nr._VIDEO_GEN_MODEL_IDS, "VEO-3", "Hailuo-X", "", "veo", "seedance-veo"]}

    built: list = []
    real_build = nr._build_shot_phrase

    def record(recipe, dialect="standard"):
        out = real_build(recipe, dialect)
        built.append({"recipe_id": recipe.id, "dialect": dialect, "phrase": out})
        return out

    defaults = {"prompt": "", "aspect_ratio": "16:9", "duration": "5", "seed": 7, "model_options": "{}",
                **{k: sp.AUTO for k in FILM_SHOT_OVERRIDES}}
    cases: list = []

    def case(name, image=False, **w):
        widgets = {**defaults, **w}
        kwargs = dict(widgets)
        if image:
            kwargs["image"] = "image"
        built.clear()
        with mock.patch.object(nr, "_build_shot_phrase", record), contextlib.redirect_stdout(io.StringIO()):
            try:
                call = rbf.capture_first_call(nr.FilmShotNode, **kwargs)
                err = None
            except Exception as e:  # noqa: BLE001 — FilmShotNode's own refusal is part of the fixture
                call, err = None, {"type": type(e).__name__, "message": str(e)}
        c = {"name": name, "class_type": "FilmShotNode", "widgets": widgets, "pictures": ["image"] if image else [],
             "phrase": built[0] if built else None}
        if err:
            c["error"] = err
        else:
            c["call"] = call
        cases.append(c)

    for pid in sp.PRESET_IDS:
        for dialect, model in FILM_SHOT_DIALECT_MODELS.items():
            for label, text in FILM_SHOT_PROMPTS.items():
                case(f"{pid} \u00b7 {dialect} \u00b7 {label} prompt", preset=pid, model=model, prompt=text)
    for widget, options in override_lists.items():
        for opt in options[1:]:
            for dialect, model in FILM_SHOT_DIALECT_MODELS.items():
                case(f"{widget} {opt} \u00b7 {dialect}", preset="push-in", model=model, prompt="a heron lifts off", **{widget: opt})
    for dialect, model in FILM_SHOT_DIALECT_MODELS.items():
        case(f"all five overrides \u00b7 {dialect}", preset="tilt-reveal", model=model, prompt="a heron lifts off", **every)
        case(f"unknown preset \u00b7 {dialect}", preset="slow_push_in", model=model, prompt="a heron lifts off")
    for label, raw in (("bad JSON", "{not json"), ("a list", "[1, 2]"), ("shot_directed false", '{"__shot_directed": false}'),
                       ("empty", ""), ("spaces", "   ")):
        case(f"model_options {label}", preset="orbit", model="seedance-2.0", prompt="a heron lifts off", model_options=raw)
    case("model_options with settings", preset="orbit", model="seedance-2.0", prompt="a heron lifts off",
         model_options='{"__shot_directed": false, "resolution": "720p", "generate_audio": false}')
    case("model_options Seedance first frame by link", preset="orbit", model="seedance-2.0", prompt="a heron lifts off",
         model_options='{"image_url": "https://r.test/first.png"}')
    for model in nr._VIDEO_GEN_MODEL_IDS:
        for image in (False, True):
            case(f"model {model} \u00b7 {'with' if image else 'without'} image", image=image, preset="crane-reveal", model=model,
                 prompt="a lighthouse in a storm")
    # R3.11 fix round 1: `__shot_directed` as Python's bool() reads it — truthy values other than
    # true send the words alone (the runner leaves those to the engine), falsy ones the phrase.
    for value in (True, 1, 2.5, "false", "no", [0], {"a": 1}, False, 0, 0.0, "", None, [], {}):
        for model in ("veo-3.1", "hailuo-h3", "seedance-2.0", "kling-v3"):
            for image in (False, True):
                case(f"shot_directed {json.dumps(value)} \u00b7 {model} \u00b7 {'with' if image else 'without'} image", image=image,
                     preset="orbit", model=model, prompt="  a heron  ", model_options=json.dumps({"__shot_directed": value}))
    # Shot Director's words, stripped by Python (fix round 2): Unicode blanks around them.
    for model in ("veo-3.1", "seedance-2.0", "kling-v3"):
        for image in (False, True):
            case(f"shot_directed true \u00b7 unicode blanks \u00b7 {model} \u00b7 {'with' if image else 'without'} image", image=image,
                 preset="orbit", model=model, prompt="\u3000\u00a0\t a heron \u2014 caf\u00e9\x1c\x85\u2028\n",
                 model_options=json.dumps({"__shot_directed": True}))
    # A negative prompt in the options, on every model whose builder sends one.
    for model in ("veo-3.1", "veo-3.1-fast", "kling-v3", "kling-v2.5-turbo-pro", "wan-2.7-t2v", "ltx-video", "pixverse-v6", "seedance-2.0"):
        case(f"negative prompt \u00b7 {model}", preset="orbit", model=model, prompt="a heron",
             model_options=json.dumps({"negative_prompt": "blurry, caf\u00e9 \u732b"}))

    runs: list = []
    with contextlib.redirect_stdout(io.StringIO()):
        for name, w, answer, pics in (
            ("veo text", {"preset": "push-in", "model": "veo-3.1", "prompt": "a red fox"}, {"video": {"url": FILM_SHOT_VIDEO}}, []),
            ("seedance picture", {"preset": "orbit", "model": "seedance-2.0", "prompt": " a heron "}, {"video": {"url": FILM_SHOT_VIDEO}}, ["image"]),
            ("hailuo overrides", {"preset": "handheld", "model": "hailuo-h3", "prompt": "rain", "camera_movement": "the camera pans slowly left to right"},
             {"video": {"url": FILM_SHOT_VIDEO}}, []),
            ("kling 2.5 text", {"preset": "god-shot", "model": "kling-v2.5-turbo-pro", "prompt": "a maze"}, {"output": FILM_SHOT_VIDEO}, []),
            ("pixverse picture", {"preset": "dutch", "model": "pixverse-v6", "prompt": "a maze"}, {"output": FILM_SHOT_VIDEO}, ["image"]),
        ):
            runs.append(paid_case(name, nr.FilmShotNode, {**defaults, **w}, [answer], pictures=pics,
                                  files={FILM_SHOT_VIDEO: _b64(b"\x00\x00\x00\x18ftypmp42fixture-video")}))
    lists = {"preset_ids": list(sp.PRESET_IDS), "auto": sp.AUTO, "default_preset": sp.DEFAULT_PRESET_ID,
             "overrides": {w: list(o) for w, o in override_lists.items()},
             "presets": [{"id": r.id, "label": r.label, "category": r.category, "size": r.size, "angle": r.angle, "movement": r.movement,
                          "lens": r.lens, "composition": r.composition, "note": r.note} for r in sp.PRESETS]}
    return {"phrases": phrases, "dialects": dialects, "model_ids": list(nr._VIDEO_GEN_MODEL_IDS), "lists": lists,
            "cases": cases, "runs": runs}


# ── image-extras (R3.12): Text effect, Sketch to image, Generate face references ──

IMAGE_EXTRAS_OUT = "https://r.test/extras/out.png"
IMAGE_EXTRAS_OUT_2 = "https://r.test/extras/second.png"
TEXT_EFFECT_DEFAULTS = {"text": "HELLO", "effect": "liquid-chrome", "aspect_ratio": "1:1", "seed": 0, "freedom": 0.0}
TEXT_EFFECT_FREEDOMS = (0.0, 0.12, 0.45, 0.78, 1.0, None)  # None: the widget missing (execute's default, 0.0)
IMAGE_EXTRAS_SEEDS = (0, 42, 2 ** 31 - 1, 2 ** 31, 0xFFFFFFFF)
IMAGE_EXTRAS_TEXTS = {
    "blank": "",
    "spaces": "   \t ",
    "padded": "  Hi there \n",
    "non-ASCII": "Café 日本 \U0001f98a — naïve",
    "unicode blanks": "　 SALE \x1c\x85",
}


def image_extras_group() -> dict:
    """R3.12: Text effect (TextEffectNode: Ideogram V3 Turbo to generate, Flux
    Kontext Pro to restyle a wired picture), Sketch to image (Nano Banana) and
    Generate face references (Ideogram Character), for
    frontend/server/runner/generators/textEffects.ts and imageExtras.ts
    (tests/unit/runner-paid-image-extras.unit.spec.ts):
      catalogue — text_effects.py itself: the 16 effects, build_prompt,
                  build_edit_prompt (every freedom band edge, None, out of
                  range), aspect_ok, edit_aspect, build_text_effect_request
      cases     — paid_case of every effect × both paths × every freedom; every
                  ratio on both paths; the seeds; the texts; each answer shape;
                  Sketch and Face with blank and non-ASCII prompts, every ratio
                  and the seeds."""
    import io
    import runner_builder_fixtures as rbf
    from comfy_api_nodes import text_effects as te
    nr, _fal, _extras = rbf._node_modules()
    files = {IMAGE_EXTRAS_OUT: _b64(png_bytes(8, 6, 21)), IMAGE_EXTRAS_OUT_2: _b64(png_bytes(8, 6, 22))}
    cases: list = []

    def add(name, cls, widgets, pictures=(), answer=None):
        with contextlib.redirect_stdout(io.StringIO()):
            cases.append(paid_case(name, cls, widgets, [answer or {"output": [IMAGE_EXTRAS_OUT]}], pictures=list(pictures), files=files))

    def fx(name, restyle=False, answer=None, drop=(), **w):
        widgets = {**TEXT_EFFECT_DEFAULTS, **w}
        for k in drop:
            widgets.pop(k)
        add(f"text effect · {'restyle' if restyle else 'generate'} · {name}", nr.TextEffectNode, widgets,
            ["image"] if restyle else [], answer)

    # Every effect × both paths × every freedom (and the widget missing).
    for eff in te.EFFECTS:
        for restyle in (False, True):
            for f in TEXT_EFFECT_FREEDOMS:
                if f is None:
                    fx(f"{eff.id} · freedom missing", restyle, effect=eff.id, drop=("freedom",))
                else:
                    fx(f"{eff.id} · freedom {f}", restyle, effect=eff.id, freedom=f)
    # Every ratio on both paths.
    for ar in nr._TEXT_EFFECT_AR:
        for restyle in (False, True):
            fx(f"ratio {ar}", restyle, aspect_ratio=ar)
    # The seeds (Replicate's Ideogram stops at 2**31 - 1), the texts, the band edges.
    for seed in IMAGE_EXTRAS_SEEDS:
        for restyle in (False, True):
            fx(f"seed {seed}", restyle, seed=seed)
    for label, text in IMAGE_EXTRAS_TEXTS.items():
        for restyle in (False, True):
            fx(f"text {label}", restyle, text=text)
    for f in (0.1199, 0.4499, 0.7799, 0.05, 0.6, 0.95):
        fx(f"ink-in-water · freedom {f}", True, effect="ink-in-water", freedom=f)
    # Each answer shape: a list, a string, two URLs (the first is the picture).
    for restyle in (False, True):
        fx("answer string", restyle, answer={"output": IMAGE_EXTRAS_OUT})
        fx("answer two", restyle, answer={"output": [IMAGE_EXTRAS_OUT, IMAGE_EXTRAS_OUT_2]})

    # Sketch to image: the prompts, each answer shape.
    for label, text in IMAGE_EXTRAS_TEXTS.items():
        add(f"sketch · prompt {label}", nr.SketchToImageNode, {"model": "Nano Banana", "prompt": text}, ["image"])
    add("sketch · a castle", nr.SketchToImageNode, {"model": "Nano Banana", "prompt": "a castle at dusk, watercolour"}, ["image"])
    add("sketch · answer string", nr.SketchToImageNode, {"model": "Nano Banana", "prompt": "a castle"}, ["image"], {"output": IMAGE_EXTRAS_OUT})
    add("sketch · answer two", nr.SketchToImageNode, {"model": "Nano Banana", "prompt": "a castle"}, ["image"],
        {"output": [IMAGE_EXTRAS_OUT, IMAGE_EXTRAS_OUT_2]})

    # Generate face references: the prompts, every ratio, the seeds, each answer shape.
    face = {"model": "Ideogram Character", "prompt": "in a sunny park, holding a coffee", "aspect_ratio": "1:1", "seed": 0}
    for label, text in IMAGE_EXTRAS_TEXTS.items():
        add(f"face · prompt {label}", nr.ConsistentFaceNode, {**face, "prompt": text}, ["reference_image"])
    for ar in ("1:1", "16:9", "9:16", "4:3", "3:4", "16:10", "10:16"):
        add(f"face · ratio {ar}", nr.ConsistentFaceNode, {**face, "aspect_ratio": ar}, ["reference_image"])
    for seed in IMAGE_EXTRAS_SEEDS:
        add(f"face · seed {seed}", nr.ConsistentFaceNode, {**face, "seed": seed}, ["reference_image"])
    add("face · answer string", nr.ConsistentFaceNode, face, ["reference_image"], {"output": IMAGE_EXTRAS_OUT})
    add("face · answer two", nr.ConsistentFaceNode, face, ["reference_image"], {"output": [IMAGE_EXTRAS_OUT, IMAGE_EXTRAS_OUT_2]})

    # The catalogue, from text_effects.py itself (the TypeScript port is held to it).
    texts = [*IMAGE_EXTRAS_TEXTS.values(), "HELLO", "a {TEXT} inside"]
    ids = [e.id for e in te.EFFECTS] + ["no-such-effect", ""]
    freedoms = [None, -0.5, 0.0, 0.05, 0.1199, 0.12, 0.3, 0.4499, 0.45, 0.6, 0.7799, 0.78, 0.9, 1.0, 1.5, 0, 1]
    ratios = [*nr._TEXT_EFFECT_AR, "4:5", "21:9", "", "match_input_image", "1:1 "]
    catalogue = {
        "effects": [{"id": e.id, "label": e.label, "prompt_template": e.prompt_template, "edit_template": e.edit_template,
                     "model_slug": e.model_slug, "medium": e.medium, "default_freedom": e.default_freedom} for e in te.EFFECTS],
        "default_effect": te.DEFAULT_EFFECT_ID,
        "match_input": te.MATCH_INPUT_AR,
        "node_ratios": list(nr._TEXT_EFFECT_AR),
        "prompts": [{"effect": i, "text": t, "prompt": te.build_prompt(i, t)} for i in ids for t in texts],
        "edit_prompts": [{"effect": i, "freedom": f, "prompt": te.build_edit_prompt(i, "", f)} for i in ids for f in freedoms],
        "aspect_ok": {r: te.aspect_ok(r) for r in ratios},
        "edit_aspect": {r: te.edit_aspect(r) for r in ratios},
    }
    return {"catalogue": catalogue, "cases": cases}


# ── lora (R3.13): Flux Dev + LoRA, Flux Dev + LoRAs ─────────────────────────

LORA_OUT = "https://r.test/lora/out.png"
LORA_OUT_RGBA = "https://r.test/lora/rgba.png"
LORA_OUT_2 = "https://r.test/lora/second.png"
LORA_MARKER_LOGS = "Loading LoRA 1\nDownloading LoRA weights from https://x\nDownloading LoRA weights from https://y\n"
LORA_NO_MARKER_LOGS = "Using seed: 42\nRunning inference\n"
# The files of a temporary models/loras/: each LoRA's weights file (empty; ComfyUI lists it) and its
# sidecar text (None: no sidecar), as the cloud trainer writes them (and a few it never would).
LORA_FILES = {
    "trained.safetensors": json.dumps({"replicate_model": "finnyjules/my-style:abc123def", "replicate_url": "https://replicate.delivery/x/trained.tar",
                                       "trigger": "TOK", "taste_profile": "soft, grainy"}),
    "trained_nover.safetensors": json.dumps({"replicate_model": " finnyjules/other-style "}),
    "legacy.safetensors": json.dumps({"replicate_url": "https://replicate.delivery/y/legacy.tar"}),
    "legacy_spaces.safetensors": json.dumps({"replicate_url": "  https://replicate.delivery/z/spaced.tar  "}),
    "legacy_bare.safetensors": json.dumps({"replicate_url": "alice/bare-lora"}),
    "urlmodel.safetensors": json.dumps({"replicate_model": "https://example.com/w.safetensors"}),
    "numeric.safetensors": json.dumps({"replicate_model": 5}),
    "empty_model.safetensors": json.dumps({"replicate_model": "", "replicate_url": "https://replicate.delivery/e/e.tar"}),
    "blank_url.safetensors": json.dumps({"replicate_url": "   "}),
    "null.safetensors": "null",
    "list.safetensors": "[1, 2]",
    "broken.safetensors": "{not json",
    "nosidecar.safetensors": None,
    "sub/nested.safetensors": json.dumps({"replicate_url": "https://replicate.delivery/n/nested.tar"}),
}
LORA_SINGLE = {"prompt": "a portrait of TOK, film grain", "lora_name": "[None]", "lora_url": "", "lora_scale": 1.0, "aspect_ratio": "1:1",
               "megapixels": "1", "num_inference_steps": 28, "guidance": 3.5, "seed": 0, "prompt_strength": 0.8}
LORA_MULTI = {"prompt": "TOK in the park", "lora_a": "[None]", "lora_a_url": "", "scale_a": 0.9, "lora_b": "[None]", "lora_b_url": "",
              "scale_b": 0.8, "aspect_ratio": "1:1", "num_inference_steps": 28, "guidance": 3.5, "seed": 0, "prompt_strength": 0.8,
              "lora_c": "[None]", "lora_c_url": "", "scale_c": 0.7, "lora_d": "[None]", "lora_d_url": "", "scale_d": 0.6}
# What huggingface.co's model API answers for the bare refs the cases look up (the look-up's three branches).
LORA_HF = {
    "https://huggingface.co/api/models/alice/hf-lora": {"status": 200, "text": "{\"id\": \"alice/hf-lora\"}"},
    "https://huggingface.co/api/models/bob/missing": {"status": 404, "text": "{\"error\": \"Repository not found\"}"},
    "https://huggingface.co/api/models/carol/offline": {"raise": "Cannot connect to host huggingface.co:443"},
    "https://huggingface.co/api/models/alice/bare-lora": {"status": 200, "text": "{}"},
    "https://huggingface.co/api/models/owner/model": {"status": 404, "text": "{}"},
    # Python strips the scheme of ANY pasted URL (_normalize_lora_ref), so a .safetensors link on another host
    # reaches the look-up as a bare "<host>/<first path part>".
    "https://huggingface.co/api/models/example.com/files": {"status": 404, "text": "{}"},
    "https://huggingface.co/api/models/example.com/x.SAFETENSORS": {"status": 404, "text": "{}"},
    "https://huggingface.co/api/models/example.com/three.safetensors": {"status": 404, "text": "{}"},
    "https://huggingface.co/api/models/replicate.delivery/y": {"status": 404, "text": "{}"},
}


LORA_DEVIATION_REASON = ("runner only (R3.13 fix round 1): a pasted http(s) link keeps its scheme, on flux-dev-lora unless the host is "
                         "huggingface.co, hf.co or civitai.com, on flux-dev-multi-lora always; Python strips it from every link")


def lora_group() -> dict:
    """R3.13: Flux Dev + LoRA (FluxLoRARemoteNode: the user's trained model run
    directly, else black-forest-labs/flux-dev-lora) and Flux Dev + LoRAs
    (FluxMultiLoRARemoteNode: lucataco/flux-dev-multi-lora, with its reload
    retry), for frontend/server/runner/generators/lora.ts
    (tests/unit/runner-paid-lora.unit.spec.ts):
      loras — the temporary models/loras/ the cases read (file → sidecar text,
              null for a LoRA with no sidecar)
      cases — paid_case of Flux Dev + LoRA picked by every kind of sidecar and
              by every kind of lora_url (a trained ref with and without its
              version, HuggingFace URLs, hf.co, CivitAI, .safetensors, bare
              refs looked up on HuggingFace: found, not found, offline),
              image-to-image on and off, the seeds and settings; Flux Dev +
              LoRAs with 0, 1, 2 and 4 slots, repeated LoRAs, prompt_in and
              style_in blank and set, answers whose logs have and lack
              "Downloading LoRA weights". Each multi case records `rotate`,
              the process-wide order toggle before it (reset to 0, except the
              two back-to-back runs of `rotation`)."""
    import shutil
    import tempfile
    import folder_paths
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    from comfy_api_nodes import replicate_refs as rr
    python_normalize = rr._normalize_lora_ref

    def _runner_single_link(ref):
        s = (ref or "").strip()
        low = s.lower()
        for scheme in ("https://", "http://"):
            if low.startswith(scheme):
                return python_normalize(s) if low[len(scheme):].startswith(("huggingface.co/", "hf.co/", "civitai.com/")) else s
        return python_normalize(s)

    def _runner_multi_link(ref):
        s = (ref or "").strip()
        return s if s.lower().startswith(("https://", "http://")) else python_normalize(s)

    files = {LORA_OUT: _b64(png_bytes(8, 6, 31)), LORA_OUT_RGBA: _b64(png_bytes(8, 6, 32, "RGBA")), LORA_OUT_2: _b64(png_bytes(8, 6, 33))}
    cases: list = []
    tmp = tempfile.mkdtemp(prefix="sailor-loras-")
    # The temporary models/loras/ goes when the group ends, whatever happens (fix round 1).
    try:
        for name, sidecar in LORA_FILES.items():
            path = os.path.join(tmp, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(b"")
            if sidecar is not None:
                with open(os.path.splitext(path)[0] + ".json", "w", encoding="utf-8") as f:
                    f.write(sidecar)
        exts = folder_paths.folder_names_and_paths["loras"][1]

        def add(name, cls, widgets, pictures=(), answers=None, rotate=None):
            if rotate is not None:
                nr._MULTILORA_ROTATE["n"] = rotate
            before = nr._MULTILORA_ROTATE["n"]
            case = paid_case(name, cls, widgets, answers or [{"output": [LORA_OUT]}], pictures=list(pictures), files=files, links=LORA_HF)
            after = nr._MULTILORA_ROTATE["n"]
            # The runner's deliberate deviation (fix round 1): the same execute, with the pasted-link rule of
            # frontend/shared/runner/lora.ts runnerLoraLink in place of _normalize_lora_ref. Recorded as `runner`
            # only where it changes what is sent or looked up.
            nr._MULTILORA_ROTATE["n"] = before
            with mock.patch.object(rr, "_normalize_lora_ref", _runner_single_link), \
                    mock.patch.object(nr, "_normalize_lora_ref", _runner_multi_link):
                dev = paid_case(name, cls, widgets, answers or [{"output": [LORA_OUT]}], pictures=list(pictures), files=files, links=LORA_HF)
            dev_after = nr._MULTILORA_ROTATE["n"]
            nr._MULTILORA_ROTATE["n"] = after
            if (dev["calls"], dev["gets"], dev.get("error")) != (case["calls"], case["gets"], case.get("error")):
                case["runner"] = {"calls": dev["calls"], "gets": dev["gets"], "error": dev.get("error"), "rotate_after": dev_after,
                                  "reason": LORA_DEVIATION_REASON}
            if cls is nr.FluxMultiLoRARemoteNode:
                case["rotate"] = before
            # Only the look-ups this case made: the rest of LORA_HF is not part of it.
            used = {g["url"] for g in case["gets"]}
            case["links"] = {u: v for u, v in LORA_HF.items() if u in used}
            if not case["links"]:
                del case["links"]
            cases.append(case)

        with mock.patch.dict(folder_paths.folder_names_and_paths, {"loras": ([tmp], exts)}):
            one = nr.FluxLoRARemoteNode
            # Picked by name: every kind of sidecar.
            for name in LORA_FILES:
                add(f"single · name {name}", one, {**LORA_SINGLE, "lora_name": name})
            add("single · name [None]", one, LORA_SINGLE)
            add("single · name [None] · image", one, LORA_SINGLE, ["image"])
            # lora_url: every form (it wins over the name).
            urls = {
                "trained ref": "finnyjules/my-style",
                "trained ref with version": "finnyjules/my-style:abc123",
                "trained ref three parts": "finnyjules/my-style/abc123",
                "trained ref padded": "  finnyjules/my-style  ",
                "huggingface https": "https://huggingface.co/alice/lora",
                "huggingface file": "huggingface.co/alice/lora/weights.safetensors",
                "hf.co": "hf.co/alice/lora",
                "HF.CO upper": "HTTPS://HF.co/alice/lora",
                "civitai": "https://civitai.com/api/download/models/123?type=Model",
                "safetensors url": "https://example.com/files/w.safetensors",
                "http safetensors": "http://example.com/x.SAFETENSORS",
                "replicate.com url": "https://replicate.com/alice/model",
                "bare four parts found": "alice/hf-lora/sub/file.bin",
                "bare four parts missing": "bob/missing/sub/file.bin",
                "bare four parts offline": "carol/offline/a/b",
                "bare safetensors": "owner/model/lora.safetensors",
            }
            for label, url in urls.items():
                add(f"single · url {label}", one, {**LORA_SINGLE, "lora_url": url, "lora_name": "trained.safetensors"})
            add("single · url huggingface · lora scale 0.75", one, {**LORA_SINGLE, "lora_url": urls["huggingface https"], "lora_scale": 0.75})
            # Image-to-image, both paths; the seeds; the settings.
            for label, w in (("trained", {"lora_name": "trained.safetensors"}), ("flux-dev-lora", {"lora_url": urls["huggingface https"]})):
                add(f"single · {label} · image", one, {**LORA_SINGLE, **w, "prompt_strength": 0.35}, ["image"])
                for seed in (0, 42, 0xFFFFFFFF):
                    add(f"single · {label} · seed {seed}", one, {**LORA_SINGLE, **w, "seed": seed})
                add(f"single · {label} · settings", one, {**LORA_SINGLE, **w, "aspect_ratio": "9:21", "megapixels": "0.25",
                                                           "num_inference_steps": 4, "guidance": 0.0, "lora_scale": 1.5})
                add(f"single · {label} · steps 50", one, {**LORA_SINGLE, **w, "num_inference_steps": 50, "guidance": 20.0})
            for ar in ("16:9", "21:9", "4:5"):
                add(f"single · ratio {ar}", one, {**LORA_SINGLE, "lora_url": urls["hf.co"], "aspect_ratio": ar})
            add("single · prompt non-ASCII", one, {**LORA_SINGLE, "prompt": "Café 日本 \U0001f98a — naïve", "lora_url": urls["hf.co"]})
            add("single · prompt blank", one, {**LORA_SINGLE, "prompt": "", "lora_url": urls["hf.co"]})
            # Each answer shape: a string, two URLs (the first is the picture), a picture with alpha (dropped).
            add("single · answer string", one, {**LORA_SINGLE, "lora_url": urls["hf.co"]}, answers=[{"output": LORA_OUT}])
            add("single · answer two", one, {**LORA_SINGLE, "lora_url": urls["hf.co"]}, answers=[{"output": [LORA_OUT, LORA_OUT_2]}])
            add("single · answer rgba", one, {**LORA_SINGLE, "lora_url": urls["hf.co"]}, answers=[{"output": [LORA_OUT_RGBA]}])
            add("single · answer none", one, {**LORA_SINGLE, "lora_url": urls["hf.co"]}, answers=[{"output": None, "status": "succeeded"}])

            many = nr.FluxMultiLoRARemoteNode
            hf = "https://huggingface.co/alice/one"
            civ = "https://civitai.com/api/download/models/456"
            st = "https://example.com/three.safetensors"
            loaded = [{"output": [LORA_OUT], "logs": LORA_MARKER_LOGS}]
            skipped = [{"output": [LORA_OUT_2], "logs": LORA_NO_MARKER_LOGS}, {"output": [LORA_OUT], "logs": LORA_MARKER_LOGS}]
            two = {"lora_a": "trained.safetensors", "lora_b_url": hf}
            four = {"lora_a": "legacy.safetensors", "lora_b_url": hf, "lora_c_url": civ, "lora_d_url": st}
            # 0 slots (Python raises before any call), and slots that resolve to nothing.
            add("multi · no slots", many, LORA_MULTI, answers=[], rotate=0)
            add("multi · names without weights", many, {**LORA_MULTI, "lora_a": "trained_nover.safetensors", "lora_b": "nosidecar.safetensors",
                                                        "lora_c": "broken.safetensors", "lora_d": "blank_url.safetensors"}, answers=[], rotate=0)
            # 1 slot: never retried, never rotated.
            for label, w in (("name", {"lora_a": "trained.safetensors"}), ("url", {"lora_b_url": hf}), ("slot d", {"lora_d_url": "hf.co/alice/d"})):
                add(f"multi · one slot {label} · loaded", many, {**LORA_MULTI, **w}, answers=loaded, rotate=0)
                add(f"multi · one slot {label} · no marker", many, {**LORA_MULTI, **w}, answers=[{"output": [LORA_OUT], "logs": LORA_NO_MARKER_LOGS}], rotate=0)
            # 2 and 4 slots, with the toggle at 0 and at 1, logs with and without the marker.
            for label, w in (("two", two), ("four", four)):
                for rot in (0, 1):
                    add(f"multi · {label} slots · rotate {rot} · loaded", many, {**LORA_MULTI, **w}, answers=loaded, rotate=rot)
                    add(f"multi · {label} slots · rotate {rot} · retried", many, {**LORA_MULTI, **w}, answers=skipped, rotate=rot)
            add("multi · two slots · no logs", many, {**LORA_MULTI, **two}, answers=[{"output": [LORA_OUT_2]}, {"output": [LORA_OUT], "logs": None}], rotate=0)
            add("multi · two slots · retried, still no marker", many, {**LORA_MULTI, **two},
                answers=[{"output": [LORA_OUT_2], "logs": ""}, {"output": [LORA_OUT_RGBA], "logs": LORA_NO_MARKER_LOGS}], rotate=0)
            add("multi · two slots · every name kind", many, {**LORA_MULTI, "lora_a": "legacy_spaces.safetensors", "lora_b": "sub/nested.safetensors",
                                                              "lora_c": "legacy_bare.safetensors"}, answers=loaded, rotate=0)
            # Repeated LoRAs collapse onto their highest scale (one left: no retry; two left: retried).
            add("multi · repeated · one left", many, {**LORA_MULTI, "lora_a_url": hf, "scale_a": 0.4, "lora_b_url": f"  {hf}  ", "scale_b": 1.2},
                answers=[{"output": [LORA_OUT], "logs": LORA_NO_MARKER_LOGS}], rotate=0)
            add("multi · repeated · two left", many, {**LORA_MULTI, "lora_a_url": hf, "scale_a": 0.4, "lora_b_url": civ, "lora_c_url": "hf.co/alice/one",
                                                      "scale_c": 1.1, "lora_d": "legacy.safetensors"}, answers=skipped, rotate=0)
            add("multi · repeated name and url", many, {**LORA_MULTI, "lora_a": "legacy.safetensors", "lora_b_url": "https://replicate.delivery/y/legacy.tar",
                                                        "scale_b": 0.95}, answers=loaded, rotate=1)
            # Bare refs, looked up on HuggingFace (found, not found, offline).
            add("multi · bare refs", many, {**LORA_MULTI, "lora_a_url": "alice/hf-lora", "lora_b_url": "bob/missing", "lora_c_url": "carol/offline"},
                answers=loaded, rotate=0)
            # prompt_in and style_in, blank and set (wired text).
            for pi_label, pi in (("blank", ""), ("spaces", "  "), ("set", "  an idea from upstream ")):
                for st_label, sty in (("blank", ""), ("set", " moody film look ")):
                    for pr_label, pr in (("prompt", "TOK in the park"), ("prompt blank", "")):
                        add(f"multi · prompt_in {pi_label} · style_in {st_label} · {pr_label}", many,
                            {**LORA_MULTI, **two, "prompt": pr, "prompt_in": pi, "style_in": sty}, answers=loaded, rotate=0)
            # Image-to-image, the seeds, the settings.
            add("multi · image", many, {**LORA_MULTI, **two, "prompt_strength": 0.2}, ["image"], answers=loaded, rotate=0)
            for seed in (0, 42, 0xFFFFFFFF):
                add(f"multi · seed {seed}", many, {**LORA_MULTI, **two, "seed": seed}, answers=loaded, rotate=0)
            add("multi · settings", many, {**LORA_MULTI, **four, "aspect_ratio": "21:9", "num_inference_steps": 50, "guidance": 10.0,
                                           "scale_a": 0.0, "scale_b": 1.5, "scale_c": 1.0, "scale_d": 0.05}, answers=loaded, rotate=0)
            add("multi · answer string", many, {**LORA_MULTI, **two}, answers=[{"output": LORA_OUT, "logs": LORA_MARKER_LOGS}], rotate=0)
            add("multi · answer rgba", many, {**LORA_MULTI, **two}, answers=[{"output": [LORA_OUT_RGBA], "logs": LORA_MARKER_LOGS}], rotate=0)
            # The toggle is process-wide: two runs back to back take the two orders.
            add("multi · rotation · first run", many, {**LORA_MULTI, **four}, answers=loaded, rotate=0)
            add("multi · rotation · second run", many, {**LORA_MULTI, **four}, answers=loaded)
        # replicate_refs.py's reference readers and _fold_prompt_in on their own, over awkward strings.
        from comfy_api_nodes import replicate_refs as rr
        refs = ["", "   ", "a", "a/b", " a/b ", "a/b/c", "a/b/c/d", "a//b", "/a/b", "a/b:ver", "a/b:v1:v2", "a:b/c", "A/B.SAFETENSORS",
                "https://huggingface.co/a/b", "HTTP://x.y/z", "hf.co/a/b", "HF.CO/a/b", "https://hf.co/a/b", "civitai.com/models/1",
                "x/HuggingFace.co", "a/b.safetensors?x=1", "ftp://a/b", "a/b/", "  https://a.b/c.safetensors  ", "replicate.com/a/b",
                "café/naïve", "a\u3000/b", "\x1ca/b\x1f"]
        catalogue = {
            "is_model_ref": {r: rr._is_replicate_model_ref(r) for r in refs},
            "bare_owner_model": {r: rr._bare_owner_model(r) for r in refs},
            "normalize": {r: rr._normalize_lora_ref(r) for r in refs},
            "to_lora_ref": {r: rr._replicate_model_to_lora_ref(r) for r in refs},
            "collect": [{"resolved": res, "out": list(map(list, rr._multilora_collect([tuple(x) for x in res])))} for res in (
                [], [[None, 1.0]], [["a", 0.5], ["a", 0.7]], [["a", 0.9], ["b", 0.1], ["a", 0.3]], [["", 1.0], ["b", 0.2], [None, 0.4], ["b", 0.25]],
                [["x", 1.5], ["y", 0.0], ["z", 0.6], ["y", 0.05]])],
            "fold": [{"prompt": p, "prompt_in": i, "out": nr._fold_prompt_in(p, i)} for p in ("", "  ", "a prompt", " padded ")
                     for i in ("", "  ", "idea", " idea ", "\u3000idea\x1c")],
        }
        return {"cases": cases, "loras": LORA_FILES, "catalogue": catalogue}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ── restyle-lora (R3.14): Restyle an Image · Style LoRA ────────────────────────

RESTYLE_FLUX = "https://r.test/restyle/flux.png"
RESTYLE_FLUX_RGBA = "https://r.test/restyle/flux-rgba.png"
RESTYLE_NB = ("https://f.test/restyle/nb-1.png", "https://f.test/restyle/nb-2.png", "https://f.test/restyle/nb-3.png")
RESTYLE_NB_RGBA = "https://f.test/restyle/nb-rgba.png"
RESTYLE_LORA_URL = "https://huggingface.co/alice/style-lora"
# Restyle's own sidecars, beside the lora group's (LORA_FILES): a trigger with an aesthetic whose keyword
# tail follows a blank line, prose with no tail under taste_profile, a trigger that isn't text.
RESTYLE_FILES = {
    **LORA_FILES,
    "collage.safetensors": json.dumps({"replicate_url": "https://replicate.delivery/c/collage.tar", "trigger": " RCR ",
                                       "aesthetic": "A rough, cut-paper collage look.\n\n torn paper, halftone, muted palette "}),
    "prose.safetensors": json.dumps({"replicate_url": "https://replicate.delivery/p/prose.tar", "trigger": "",
                                     "aesthetic": "   ", "taste_profile": "  bold ink lines only  "}),
    "bad_trigger.safetensors": json.dumps({"replicate_url": "https://replicate.delivery/b/bad.tar", "trigger": 5}),
    "falsy_trigger.safetensors": json.dumps({"replicate_url": "https://replicate.delivery/f/falsy.tar", "trigger": 0, "aesthetic": 7}),
}
RESTYLE_HF = {"https://huggingface.co/api/models/alice/hf-lora": {"status": 200, "text": "{\"id\": \"alice/hf-lora\"}"}}


def restyle_lora_group() -> dict:
    """R3.14: Restyle an Image · Style LoRA (RestyleWithLoRANode), for
    frontend/server/runner/generators/restyleLora.ts
    (tests/unit/runner-paid-restyle-lora.unit.spec.ts):
      loras     — the temporary models/loras/ the cases read (file → sidecar
                  text, null for a LoRA with no sidecar)
      cases     — paid_case of every branch, with the answers scripted: the
                  caption, the LoRA's picture, the verdict on it (photo,
                  illustration, a failure), each Nano Banana pass and its
                  verdict; the final picture is downloaded as Python does
      catalogue — restyle_style_strength_to_knobs, sidecar_aesthetic,
                  aesthetic_to_keywords, build_flux_style_prompt,
                  classify_style_answer and build_restyle_instruction on their
                  own, over awkward values"""
    import shutil
    import tempfile
    import folder_paths
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    from comfy_api_nodes import replicate_refs as rr

    node = nr.RestyleWithLoRANode
    defaults = {"lora_name": "[None]", "style_strength": 0.5, "resolution": "1K", "seed": 0, "lora_url": RESTYLE_LORA_URL,
                "lora_scale": 1.0, "flux_prompt_strength": 0.0, "flux_steps": 28, "flux_guidance": 3.5,
                "describe_prompt": nr._RESTYLE_DESCRIBE_PROMPT, "extra_style_direction": "", "output_format": "png"}
    files = {RESTYLE_FLUX: _b64(png_bytes(8, 6, 41)), RESTYLE_FLUX_RGBA: _b64(png_bytes(8, 6, 42, "RGBA")),
             RESTYLE_NB[0]: _b64(png_bytes(8, 6, 43)), RESTYLE_NB[1]: _b64(png_bytes(8, 6, 44)), RESTYLE_NB[2]: _b64(png_bytes(8, 6, 45)),
             RESTYLE_NB_RGBA: _b64(png_bytes(8, 6, 46, "RGBA"))}
    caption = {"output": ["A woman", " in a red coat", " walks a dog in a park."]}

    def verdict(v):
        return v if isinstance(v, dict) else {"output": v}

    def script(ref, passes=(), flux=RESTYLE_FLUX, cap=None):
        """The answers in call order: the caption, the LoRA's picture, the verdict on it, then each pass
        (its picture, and for an illustration target the verdict on it)."""
        out = [cap or caption, {"output": [flux]}, verdict(ref)]
        for pic, v in passes:
            out.append({"images": [{"url": pic, "width": 8, "height": 6}]})
            if v is not None:
                out.append(verdict(v))
        return out

    photo = script("photograph", [(RESTYLE_NB[0], None)])
    ill_first = script(["illus", "tration"], [(RESTYLE_NB[0], "illustration")])
    ill_third = script("illustration", [(RESTYLE_NB[0], "photograph"), (RESTYLE_NB[1], "a photo"), (RESTYLE_NB[2], "Illustration.")])
    ill_never = script("illustration", [(RESTYLE_NB[0], "photograph"), (RESTYLE_NB[1], "photograph"), (RESTYLE_NB[2], "real-life photo")])

    cases: list = []
    tmp = tempfile.mkdtemp(prefix="sailor-restyle-loras-")
    try:
        for name, sidecar in RESTYLE_FILES.items():
            path = os.path.join(tmp, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(b"")
            if sidecar is not None:
                with open(os.path.splitext(path)[0] + ".json", "w", encoding="utf-8") as f:
                    f.write(sidecar)
        exts = folder_paths.folder_names_and_paths["loras"][1]

        def add(name, widgets, answers, links=None):
            case = paid_case(name, node, {**defaults, **widgets}, answers, pictures=["content_image"], files=files, links=links)
            cases.append(case)

        with mock.patch.dict(folder_paths.folder_names_and_paths, {"loras": ([tmp], exts)}):
            # Style strength 0, 0.5 and 1, with the Flux strength derived (0) and set (0.7).
            for s in (0.0, 0.5, 1.0):
                for fps in (0.0, 0.7):
                    add(f"strength {s} · flux strength {fps}", {"style_strength": s, "flux_prompt_strength": fps}, photo)
            add("strength 0.34 · flux strength 1.0", {"style_strength": 0.34, "flux_prompt_strength": 1.0}, photo)
            add("strength 0.66", {"style_strength": 0.66}, photo)
            # The describe prompt: the old default (migrated, padded too), a custom one, a blank one.
            add("describe prompt · old default", {"describe_prompt": "Describe this image in detail."}, photo)
            add("describe prompt · old default padded", {"describe_prompt": "  Describe this image in detail.\n"}, photo)
            add("describe prompt · custom", {"describe_prompt": "  Who is in the picture? Café — naïve  "}, photo)
            add("describe prompt · blank", {"describe_prompt": ""}, photo)
            # The extra direction: set, padded, spaces only.
            add("extra direction · set", {"extra_style_direction": "  watercolor, cyberpunk neon  "}, photo)
            add("extra direction · spaces", {"extra_style_direction": " \n "}, photo)
            add("extra direction · set · illustration third", {"extra_style_direction": "gouache", "style_strength": 0.9}, ill_third)
            # The LoRA: picked by name (a trained model; sidecars with a trigger and an aesthetic), linked, looked up, none.
            add("lora · trained by name", {"lora_name": "trained.safetensors", "lora_url": ""}, photo)
            add("lora · trained by name · guidance 20", {"lora_name": "trained.safetensors", "lora_url": "", "flux_guidance": 20.0}, photo)
            add("lora · collage by name", {"lora_name": "collage.safetensors", "lora_url": ""}, photo)
            add("lora · prose by name · link", {"lora_name": "prose.safetensors"}, photo)
            add("lora · trained by name · link wins", {"lora_name": "trained.safetensors"}, photo)
            add("lora · falsy trigger by name", {"lora_name": "falsy_trigger.safetensors", "lora_url": ""}, photo)
            add("lora · no sidecar by name", {"lora_name": "nosidecar.safetensors", "lora_url": ""}, photo)
            add("lora · broken sidecar by name", {"lora_name": "broken.safetensors", "lora_url": ""}, photo)
            add("lora · null sidecar by name", {"lora_name": "null.safetensors", "lora_url": ""}, photo)
            add("lora · trained ref link", {"lora_url": "finnyjules/my-style:abc123"}, photo)
            add("lora · bare ref found", {"lora_url": "alice/hf-lora/sub/file.bin"}, photo, links=RESTYLE_HF)
            add("lora · hf.co link", {"lora_url": " hf.co/alice/style-lora "}, photo)
            add("lora · none", {"lora_url": ""}, photo)
            # Python fails after the caption (paid): a sidecar it can't read, a trigger that isn't text, a number for a model.
            add("lora · list sidecar by name", {"lora_name": "list.safetensors", "lora_url": ""}, [caption])
            add("lora · bad trigger by name", {"lora_name": "bad_trigger.safetensors", "lora_url": ""}, [caption])
            add("lora · numeric model by name", {"lora_name": "numeric.safetensors", "lora_url": ""}, [caption])
            # The Flux settings; a guidance flux-dev-lora refuses (the runner refuses it first).
            add("flux settings", {"lora_scale": 0.25, "flux_steps": 50, "flux_guidance": 0.0, "style_strength": 0.8}, photo)
            add("flux guidance 20", {"flux_guidance": 20.0}, photo)
            # The target: a photo (trusted at once), an illustration held on the first, the third and no pass.
            add("target · photo", {}, photo)
            add("target · illustration · first", {}, ill_first)
            add("target · illustration · third", {}, ill_third)
            add("target · illustration · never", {}, ill_never)
            add("target · illustration · never · reference with alpha", {}, script("illustration", [(RESTYLE_NB[0], "photo"), (RESTYLE_NB[1], "photo"),
                                                                                               (RESTYLE_NB[2], "photo")], flux=RESTYLE_FLUX_RGBA))
            # The classifier failing (any failure reads as a photo): on the reference, and on a pass.
            add("classifier fails · reference", {}, script({"__raise__": "Replicate: prediction failed"}, [(RESTYLE_NB[0], None)]))
            add("classifier fails · first pass", {}, script("illustration", [(RESTYLE_NB[0], {"__raise__": "Replicate: prediction failed"}),
                                                                             (RESTYLE_NB[1], "illustration")]))
            # Verdicts in other shapes: nothing, blank, a word with neither hint, a dict (its repr is read).
            add("verdict · none", {}, script({"output": None}, [(RESTYLE_NB[0], None)]))
            add("verdict · blank tokens", {}, script(["", " "], [(RESTYLE_NB[0], None)]))
            add("verdict · neither", {}, script("a picture", [(RESTYLE_NB[0], None)]))
            add("verdict · dict", {}, script({"output": {"medium": "illustration", "sure": True}}, [(RESTYLE_NB[0], {"output": {"medium": "photo"}}),
                                                                                                   (RESTYLE_NB[1], {"output": ["3D ", "render"]})]))
            add("verdict · number", {}, script({"output": 3}, [(RESTYLE_NB[0], None)]))
            # The caption: empty (the stand-in), a string, spaces only.
            add("caption · empty", {}, script("photograph", [(RESTYLE_NB[0], None)], cap={"output": []}))
            add("caption · string", {}, script("photograph", [(RESTYLE_NB[0], None)], cap={"output": "  A lighthouse at dusk.  "}))
            add("caption · spaces", {"lora_name": "collage.safetensors", "lora_url": ""}, script("photograph", [(RESTYLE_NB[0], None)], cap={"output": ["  ", "\n"]}))
            add("caption · none", {}, script("photograph", [(RESTYLE_NB[0], None)], cap={"output": None}))
            # The seeds (the Nano Banana seed is (seed + pass) & 0xFFFFFFFF, sent only when above 0).
            for seed in (0, 1, 42, 0xFFFFFFFE, 0xFFFFFFFF):
                add(f"seed {seed}", {"seed": seed}, ill_never)
            # Each resolution and format.
            for res in ("1K", "2K", "4K"):
                for fmt in ("png", "jpg"):
                    add(f"resolution {res} · format {fmt}", {"resolution": res, "output_format": fmt}, photo)
            # A pass with alpha (dropped).
            add("pass with alpha", {}, script("photograph", [(RESTYLE_NB_RGBA, None)]))

        values = [-0.5, 0.0, 0.05, 0.33, 0.34, 0.5, 0.65, 0.66, 0.67, 0.9, 1.0, 1.5]
        catalogue = {
            "knobs": [{"style": s, "override": o, "out": list(rr.restyle_style_strength_to_knobs(s, o))}
                      for s in values for o in (0.0, -0.3, 0.05, 0.7, 1.0, 1.4)],
            "aesthetic": [{"sidecar": sc, "out": rr.sidecar_aesthetic(sc)} for sc in (
                None, {}, {"aesthetic": ""}, {"aesthetic": "  a  "}, {"aesthetic": "  ", "taste_profile": " b "}, {"aesthetic": 5, "taste_profile": "c"},
                {"taste_profile": ["x"]}, {"aesthetic": "x", "taste_profile": "y"})],
            "keywords": [{"aesthetic": a, "out": rr.aesthetic_to_keywords(a)} for a in (
                "", "   ", "prose only", "a, b", "prose.\n\nk1, k2", "prose.\n\n\n\nk1, k2\n\n", "prose, with comma\n\nno tail here",
                "one\n\ntwo\n\nthree, four", "\n\n", " x \n\n , ", "tabs\t\n\nk　a, b")],
            "prompt": [{"trigger": t, "aesthetic": a, "caption": c, "out": rr.build_flux_style_prompt(t, a, c)}
                       for t in ("", " TOK ", "　") for a in ("", "prose.\n\nk1, k2") for c in ("", " a dog ", "a café")],
            "classify": {a: rr.classify_style_answer(a) for a in (
                "", "   ", "photograph", "Photo.", "illustration", "An ILLUSTRATED photo", "real life", "real-life", "3D", "CGI",
                "stylised", "stylized", "graphic", "painting", "comic", "anime", "cel", "sketch", "unknown", "a picture",
                "{'medium': 'illustration'}", "Real life", "PHOTOGRAPH\n")},
            "instruction": [{"structure": s, "extra": e, "out": rr.build_restyle_instruction(s, e)}
                            for s in (0.0, 0.33, 0.34, 0.65, 0.66, 1.0) for e in ("", "  gouache  ", "　")],
            "retry": rr.RESTYLE_ANTIPHOTO_RETRY,
            "describe_prompt": nr._RESTYLE_DESCRIBE_PROMPT,
            "max_retries": nr._RESTYLE_MAX_NB_RETRIES,
        }
        return {"cases": cases, "loras": RESTYLE_FILES, "catalogue": catalogue}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ── nano-extras (R3.15): Lens · 3D Reframe, Pose Mannequin ──────────────────

NANO_EXTRAS_OUT = "https://r.test/nano/out.png"
NANO_EXTRAS_OUT_2 = "https://r.test/nano/second.png"
# Pose Mannequin's editor-baked files, as the editor uploads them into ComfyUI's input folder.
POSE_BAKED = {
    "pose_result.png": lambda: png_bytes(10, 7, 31),
    "pose_result_exif6.png": lambda: _exif_picture(10, 7, 32, 6, "PNG"),
    "pose_result_exif6.jpg": lambda: _exif_picture(16, 8, 33, 6, "JPEG"),
    "pose_result_rgba.png": lambda: png_bytes(9, 5, 34, "RGBA"),
    "pose_cond.png": lambda: png_bytes(12, 9, 35),
    "pose_mannequin.png": lambda: png_bytes(11, 8, 36),
    "pose_mannequin_rgba.png": lambda: png_bytes(11, 8, 37, "RGBA"),
    "pose_mannequin_exif6.png": lambda: _exif_picture(11, 8, 38, 6, "PNG"),
    # R3.15 fix round 2: saved poses whose header is a picture but whose pixels aren't (PIL fails: None).
    "pose_result_corrupt.png": lambda: _broken_png(png_bytes(10, 7, 39), "corrupt"),
    "pose_result_truncated.png": lambda: _broken_png(png_bytes(10, 7, 40), "truncated"),
    "sub/pose_sub.png": lambda: png_bytes(11, 8, 43),
}


def _broken_png(png: bytes, how: str) -> bytes:
    """A PNG with a valid header whose pixel data can't be decoded (R3.15 fix round 2): its IDAT data
    overwritten mid-stream with the chunk's CRC recomputed ("corrupt"), or the file cut mid-IDAT ("truncated")."""
    import zlib
    o = 8
    while o < len(png):
        n = struct.unpack(">I", png[o:o + 4])[0]
        kind = png[o + 4:o + 8]
        if kind == b"IDAT":
            start, end = o + 8, o + 8 + n
            if how == "truncated":
                return png[:start + n // 2]
            data = bytearray(png[start:end])
            for i in range(2, len(data) - 4):
                data[i] ^= 0x5A
            crc = struct.pack(">I", zlib.crc32(kind + bytes(data)) & 0xFFFFFFFF)
            return png[:start] + bytes(data) + crc + png[end + 4:]
        o += 12 + n
    raise ValueError("no IDAT")
POSE_TEXTS = {
    "blank": "", "spaces": "   ", "padded": "  arms raised overhead  ", "non-ASCII": "bras levés, tête penchée — 腕を上げる",
    "unicode blanks": "　 ", "unicode blanks around a word": "　crouching ",
}


POSE_DEVIATION_REASON = ("runner only (R3.15 fix round 1): Python's `_load_input_image(pose_cond_image) or …` asks a "
                         "picture tensor for its truth value and raises, so the conditioning render never reaches a call; "
                         "the runner does what the code means: the conditioning render when it loads, else the mannequin "
                         "render, then the call")


def nano_extras_group() -> dict:
    """R3.15: Lens · 3D Reframe (LensReframe) and Pose Mannequin
    (PoseMannequin), both Nano Banana 2 on Replicate at 1K, for
    frontend/server/runner/generators/nanoExtras.ts
    (tests/unit/runner-paid-nano-extras.unit.spec.ts):
      catalogue — _lenses.py's LENSES and NAMES, _intensity at its band edges,
                  focal_for, and _pose_prompts.py's three prompts
      cases     — paid_case of Lens reframe: every lens pair; Custom on either
                  side with focal 10 and 300 (and one between whole numbers);
                  strength 0, 1, 1.5 and the band edges; each answer shape.
                  Pose Mannequin: every branch of execute — image mode with and
                  without a pose picture; prompt mode with blank, spaced,
                  padded, non-ASCII and Unicode-blank pose prompts; mannequin
                  mode with a baked result (plain, EXIF 6 PNG and JPEG, RGBA),
                  a missing result, the conditioning render (Python raises:
                  a tensor's truth value), the mannequin render (plain, RGBA,
                  EXIF 6), nothing to pose with; an unknown pose source; the
                  extra direction blank, spaced and non-ASCII. The baked files
                  sit in a temporary input folder and are written into each
                  case (`input_files`, base64)."""
    import io
    import shutil
    import tempfile
    import folder_paths
    import runner_builder_fixtures as rbf
    from comfy_extras import _lenses
    from comfy_extras import _pose_prompts as pp
    _nr, _fal, _extras = rbf._node_modules()
    from comfy_extras.nodes_lens_reframe import LensReframeNode
    from comfy_extras.nodes_pose_mannequin import PoseMannequinNode

    files = {NANO_EXTRAS_OUT: _b64(png_bytes(8, 6, 41)), NANO_EXTRAS_OUT_2: _b64(png_bytes(8, 6, 42))}
    baked = {name: make() for name, make in POSE_BAKED.items()}
    tmp = tempfile.mkdtemp(prefix="nano_extras_input_")
    old_input = folder_paths.get_input_directory()
    cases: list = []
    try:
        for name, data in baked.items():
            os.makedirs(os.path.dirname(os.path.join(tmp, name)), exist_ok=True)
            with open(os.path.join(tmp, name), "wb") as f:
                f.write(data)
        folder_paths.set_input_directory(tmp)

        import torch
        import comfy_extras.nodes_pose_mannequin as npm

        class _Truthy(torch.Tensor):
            """A loaded picture whose truth value is True: `cond or …` then reads as the code means."""
            def __bool__(self):
                return True

        real_load = npm._load_input_image

        def truthy_load(filename):
            t = real_load(filename)
            return None if t is None else t.as_subclass(_Truthy)

        def add(name, cls, widgets, pictures=(), answer=None, uses=()):
            answers = [answer or {"output": [NANO_EXTRAS_OUT]}]
            with contextlib.redirect_stdout(io.StringIO()):
                case = paid_case(name, cls, widgets, answers, pictures=list(pictures), files=files, made_pixels=True)
            # The runner's deliberate deviation (fix round 1): the same execute, a loaded picture's truth value
            # True. Recorded as `runner` only where it changes what happens.
            if cls is PoseMannequinNode:
                with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(npm, "_load_input_image", truthy_load):
                    dev = paid_case(name, cls, widgets, answers, pictures=list(pictures), files=files, made_pixels=True)
                if (dev["calls"], dev.get("error")) != (case["calls"], case.get("error")):
                    case["runner"] = {"calls": dev["calls"], "error": dev.get("error"), "output": dev.get("output"), "ui": dev.get("ui"),
                                      "made": dev.get("made", {}), "reason": POSE_DEVIATION_REASON}
            if uses:
                case["input_files"] = {u: _b64(baked[u]) for u in uses if u in baked}
            cases.append(case)

        # ── Lens · 3D Reframe ──
        lens = {"source_lens": "Normal 50mm Planar", "target_lens": "Portrait 85mm GM", "reframe_strength": 1.0, "custom_focal": 50.0}
        for src in _lenses.NAMES:
            for tgt in _lenses.NAMES:
                add(f"lens · {src} → {tgt}", LensReframeNode, {**lens, "source_lens": src, "target_lens": tgt}, ["image"])
        for focal in (10.0, 300.0):
            for other in _lenses.NAMES:
                add(f"lens · Custom {focal:g} → {other}", LensReframeNode,
                    {**lens, "source_lens": _lenses.CUSTOM, "target_lens": other, "custom_focal": focal}, ["image"])
                add(f"lens · {other} → Custom {focal:g}", LensReframeNode,
                    {**lens, "source_lens": other, "target_lens": _lenses.CUSTOM, "custom_focal": focal}, ["image"])
        add("lens · Custom 85.7 → Custom 85.7", LensReframeNode,
            {**lens, "source_lens": _lenses.CUSTOM, "target_lens": _lenses.CUSTOM, "custom_focal": 85.7}, ["image"])
        add("lens · Wide 24mm Art → Custom 49.9", LensReframeNode,
            {**lens, "source_lens": "Wide 24mm Art", "target_lens": _lenses.CUSTOM, "custom_focal": 49.9}, ["image"])
        for strength in (0.0, 1.0, 1.5, 0.35, 0.4, 0.75, 0.8, 1.1, 1.15, 0.3999, 0.7999, 1.1499):
            add(f"lens · strength {strength!r}", LensReframeNode, {**lens, "reframe_strength": strength}, ["image"])
        add("lens · answer string", LensReframeNode, lens, ["image"], {"output": NANO_EXTRAS_OUT})
        add("lens · answer two", LensReframeNode, lens, ["image"], {"output": [NANO_EXTRAS_OUT, NANO_EXTRAS_OUT_2]})

        # ── Pose Mannequin ──
        pose = {"prompt": "", "pose_state": "", "mannequin_image": "", "pose_cond_image": "", "result_image": "",
                "pose_source": "mannequin", "pose_prompt": ""}

        def p(name, pictures=("character",), answer=None, **w):
            widgets = {**pose, **w}
            uses = [widgets[k] for k in ("result_image", "pose_cond_image", "mannequin_image") if widgets[k]]
            add(f"pose · {name}", PoseMannequinNode, widgets, pictures, answer, uses)

        # Image mode.
        p("image · with a pose picture", ("character", "pose_image"), pose_source="image")
        p("image · no pose picture (passes the character)", pose_source="image")
        p("image · a baked result is ignored", ("character", "pose_image"), pose_source="image", result_image="pose_result.png")
        p("image · no pose picture, a baked result is ignored", pose_source="image", result_image="pose_result.png")
        # Prompt mode.
        for label, text in POSE_TEXTS.items():
            p(f"prompt · pose prompt {label}", pose_source="prompt", pose_prompt=text)
        p("prompt · a pose picture is ignored", ("character", "pose_image"), pose_source="prompt", pose_prompt="sitting cross-legged")
        p("prompt · a baked result is ignored", pose_source="prompt", pose_prompt="sitting cross-legged", result_image="pose_result.png")
        p("prompt · blank, a baked result is ignored", pose_source="prompt", pose_prompt="", result_image="pose_result.png")
        # The extra direction, on each mode that calls.
        for label, text in POSE_TEXTS.items():
            p(f"extra {label} · image", ("character", "pose_image"), pose_source="image", prompt=text)
            p(f"extra {label} · prompt", pose_source="prompt", pose_prompt="a heroic stance", prompt=text)
            p(f"extra {label} · mannequin", pose_source="mannequin", mannequin_image="pose_mannequin.png", prompt=text)
        # Mannequin mode: the baked result wins.
        for f in ("pose_result.png", "pose_result_exif6.png", "pose_result_exif6.jpg", "pose_result_rgba.png"):
            p(f"mannequin · baked result {f}", result_image=f, pose_cond_image="pose_cond.png", mannequin_image="pose_mannequin.png")
        p("mannequin · baked result, no other render", result_image="pose_result.png")
        p("mannequin · baked result [input] annotated", result_image="pose_result.png [input]")
        # A result that can't be loaded falls through.
        p("mannequin · missing result, nothing else (passes the character)", result_image="gone.png")
        p("mannequin · missing result, the mannequin render", result_image="gone.png", mannequin_image="pose_mannequin.png")
        p("mannequin · spaces for a result, the mannequin render", result_image="   ", mannequin_image="pose_mannequin.png")
        # The conditioning render: Python raises (`tensor or …` asks a tensor's truth value).
        p("mannequin · conditioning render", pose_cond_image="pose_cond.png")
        p("mannequin · conditioning and mannequin renders", pose_cond_image="pose_cond.png", mannequin_image="pose_mannequin.png")
        p("mannequin · conditioning render EXIF 6", pose_cond_image="pose_mannequin_exif6.png")
        p("mannequin · conditioning render RGBA", pose_cond_image="pose_mannequin_rgba.png", prompt="  soft light  ")
        p("mannequin · missing result, the conditioning render", result_image="gone.png", pose_cond_image="pose_cond.png")
        # Fix round 2: a saved pose that doesn't decode is Python's None (it falls through to the call).
        for f in ("pose_result_corrupt.png", "pose_result_truncated.png"):
            p(f"mannequin · saved pose {f}, the mannequin render", result_image=f, mannequin_image="pose_mannequin.png")
            p(f"mannequin · saved pose {f}, nothing else", result_image=f)
        # Fix round 2: names Python opens though the runner's plain reader wouldn't (`if not filename` is its only early None).
        for name in ("./pose_mannequin.png", "sub/../pose_mannequin.png", "sub//pose_sub.png", "sub/./pose_sub.png", "./sub/pose_sub.png [input]"):
            p(f"mannequin · render named {name}", mannequin_image=name)
        p("mannequin · saved pose named ./pose_result.png", result_image="./pose_result.png", mannequin_image="pose_mannequin.png")
        p("mannequin · saved pose named x.png[input] (Python strips g[input])", result_image="pose_result.png[input]", mannequin_image="pose_mannequin.png")
        # A conditioning render that can't be loaded: the mannequin render instead.
        p("mannequin · missing conditioning, the mannequin render", pose_cond_image="gone.png", mannequin_image="pose_mannequin.png")
        for f in ("pose_mannequin.png", "pose_mannequin_rgba.png", "pose_mannequin_exif6.png"):
            p(f"mannequin · mannequin render {f}", mannequin_image=f)
        p("mannequin · missing mannequin render (passes the character)", mannequin_image="gone.png")
        p("mannequin · nothing to pose with (passes the character)")
        p("mannequin · pose state alone (passes the character)", pose_state='{"joints": {}}')
        p("mannequin · a pose picture is ignored", ("character", "pose_image"), mannequin_image="pose_mannequin.png")
        p("unknown source · reads as mannequin", pose_source="sideways", mannequin_image="pose_mannequin.png")
        p("unknown source · baked result", pose_source="sideways", result_image="pose_result.png")
        # Each answer shape.
        p("answer string", ("character", "pose_image"), {"output": NANO_EXTRAS_OUT}, pose_source="image")
        p("answer two", ("character", "pose_image"), {"output": [NANO_EXTRAS_OUT, NANO_EXTRAS_OUT_2]}, pose_source="image")

        catalogue = {
            "lenses": _lenses.LENSES,
            "names": _lenses.NAMES,
            "custom": _lenses.CUSTOM,
            "intensity": [{"strength": s, "out": _lenses._intensity(s)} for s in
                          (-1.0, 0.0, 0.3999, 0.4, 0.7999, 0.8, 1.1499, 1.15, 1.5, 2.0)],
            "focal_for": [{"name": n, "custom": c, "out": _lenses.focal_for(n, c)} for n in [*_lenses.NAMES, "nope"] for c in (10.0, 85.7)],
            "pose_prompts": {"mannequin": pp.MANNEQUIN_PROMPT, "image": pp.IMAGE_PROMPT, "text": pp.TEXT_PROMPT, "default_pose": pp._DEFAULT_POSE},
            "pose_instruction": [{"source": s, "extra": e, "pose": q, "out": pp.pose_instruction(s, e, q)}
                                 for s in ("mannequin", "image", "prompt", "other") for e in POSE_TEXTS.values()
                                 for q in ("", " a heroic {stance} ")],
        }
        return {"cases": cases, "baked": {n: _b64(b) for n, b in baked.items()}, "catalogue": catalogue}
    finally:
        folder_paths.set_input_directory(old_input)
        shutil.rmtree(tmp, ignore_errors=True)


# ── turntable (R3.16): Turntable, front view only ────────────────────────────

TURNTABLE_VIDEO = "https://r.test/turntable/spin.mp4"
TURNTABLE_VIDEO_2 = "https://r.test/turntable/second.mp4"
TURNTABLE_TEXTS = {
    "blank": "",
    "spaces": "   \t ",
    "padded": "  slow and steady \n",
    "non-ASCII": "Café 日本 \U0001f98a — naïve",
    "unicode blanks": "\u3000 matte finish \x1c\x85",
    "braces": "{direction} stays {0}",
}


def turntable_group() -> dict:
    """R3.16: Turntable (TurntableNode), front view only: Luma Ray 2 720p on
    Replicate through the video table, for
    frontend/server/runner/generators/turntable.ts
    (tests/unit/runner-paid-turntable.unit.spec.ts):
      catalogue — _turntable_prompts.py's two instructions (both directions,
                  every instruction text, None, the arcs' degrees) and
                  _turntable_plan.py's plan_segments for every subset of the
                  three extra views and both directions (for R3.17)
      cases     — paid_case of the front-only path: both directions × every
                  instruction text, the instructions missing and None; each
                  answer shape (a string, a list of two: the first is kept)."""
    import io
    import runner_builder_fixtures as rbf
    from itertools import combinations
    from comfy_extras import _turntable_plan as tplan
    from comfy_extras import _turntable_prompts as tp
    _nr, _fal, _extras = rbf._node_modules()
    from comfy_extras.nodes_turntable import TurntableNode

    video = _b64(b"\x00\x00\x00\x18ftypmp42turntable-fixture")
    files = {TURNTABLE_VIDEO: video, TURNTABLE_VIDEO_2: video}
    cases: list = []

    def add(name, widgets, answer=None):
        with contextlib.redirect_stdout(io.StringIO()):
            case = paid_case(name, TurntableNode, widgets, [answer or {"output": TURNTABLE_VIDEO}], pictures=["image"], files=files)
        cases.append(case)

    for direction in ("left", "right"):
        for key, text in TURNTABLE_TEXTS.items():
            add(f"{direction} · instructions {key}", {"direction": direction, "instructions": text})
        add(f"{direction} · instructions missing", {"direction": direction})
        add(f"{direction} · instructions None", {"direction": direction, "instructions": None})
    add("answer list · the first is kept", {"direction": "left", "instructions": ""}, {"output": [TURNTABLE_VIDEO, TURNTABLE_VIDEO_2]})
    add("answer list of one", {"direction": "right", "instructions": "gloss"}, {"output": [TURNTABLE_VIDEO]})

    texts = [*TURNTABLE_TEXTS.values(), None]
    subsets = [list(c) for n in range(4) for c in combinations(["right", "back", "left"], n)]
    catalogue = {
        "spin": tp._SPIN,
        "seg": tp._SEG,
        "simple_spin_instruction": [{"direction": d, "instructions": t, "out": tp.simple_spin_instruction(d, t)}
                                    for d in ("left", "right") for t in texts],
        "segment_instruction": [{"degrees": g, "direction": d, "instructions": t, "out": tp.segment_instruction(g, d, t)}
                                for g in (90, 180, 270, 360) for d in ("left", "right") for t in texts],
        "plan_segments": [{"extra": sub, "direction": d, "out": [list(s) for s in tplan.plan_segments(sub, d)]}
                          for sub in subsets for d in ("left", "right")],
    }
    return {"cases": cases, "catalogue": catalogue}


# ── turntable-views (R3.17): Turntable with views, Seedance arcs stitched ─────

TURNTABLE_SEG_URL = "https://f.test/turntable/seg{k}.mp4"
TURNTABLE_VIEW_NAMES = {"right": "right_reference", "back": "back_reference", "left": "left_reference"}


def _segment_clip(k: int, w: int, h: int, frames: int, content: str, rate=24, sound: bool = False) -> bytes:
    """One Seedance answer clip: H.264 yuv420p in MP4 at `rate` (an int or a
    Fraction), libx264 with one thread, every muxer and encoder bitexact (a second
    run writes the same bytes). `content` "smooth" (runner_media_fixtures.smooth_frame)
    or "noise" (R2.1's synth). `sound` (fix round 1): an AAC stereo 48 kHz track
    too, as Seedance 2.0's answers carry one, interleaved by the muxer."""
    import io
    import av
    import numpy as np
    import runner_media_fixtures as rmf
    buf = io.BytesIO()
    c = av.open(buf, "w", format="mp4", options=dict(rmf.BITEXACT))
    s = rmf.video_stream(c, "libx264", w, h, rate, "yuv420p", rmf.X264)
    t = rmf.sound_stream(c, "aac", 48000, "stereo", "fltp", 64000) if sound else None
    packets = []
    for i in range(frames):
        rgb = rmf.smooth_frame(w, h, 10 * k + i) if content == "smooth" else rmf.synth(w, h, 3, 100 * k + i + 1)
        f = av.VideoFrame.from_ndarray(np.frombuffer(rgb, np.uint8).reshape(h, w, 3), format="rgb24").reformat(format="yuv420p")
        f.pts = i
        packets += s.encode(f)
    packets += s.encode(None)
    if t is not None:
        x = rmf.tone(48000, frames / float(rate), 2) * (1.0 - 0.1 * k)
        for f in rmf.sound_frames(x.astype(np.float32), 48000, "stereo", "fltp", 1024):
            packets += t.encode(f)
        packets += t.encode(None)
    for p in packets:
        c.mux(p)
    c.close()
    return buf.getvalue()


def turntable_views_group() -> dict:
    """R3.17: Turntable (TurntableNode) with views, path B (nodes_turntable.py:80-97):
    one Seedance 2.0 first → last frame call on fal per arc plan_segments plans, the
    answers' clips joined by _turntable_stitch.stitch_clips, for
    frontend/server/runner/generators/turntable.ts
    (tests/unit/runner-paid-turntable-views.unit.spec.ts):
      clips — the Seedance answers (segment k answers clip k): small H.264 clips,
              base64, with their decoded rgb24 frames (sha256 each)
      cases — paid_case of every subset of the three views × both directions, a
              padded and a non-ASCII extra direction, noisy clips (the named
              case), a second clip of another size, and a failure at segment 3
              (Python raises: no stitch). Each stitched case records the clips in
              the order stitch_clips was handed them (sha256 of each source) and
              the stitched file twice (runner_media_fixtures.video_record): as
              Python writes it (libx264, one thread) with its PSNR against the
              kept source frames (every clip's decoded frames, the first frame of
              each clip after the first dropped), and switched to libopenh264 at
              OPENH264_FOR[20] (Sailor's encoder, rule 3)."""
    import hashlib
    import io
    import tempfile
    import runner_builder_fixtures as rbf
    import runner_media_fixtures as rmf
    from comfy_extras import _turntable_stitch as ts
    _nr, _fal, _extras = rbf._node_modules()
    from comfy_extras import nodes_turntable
    from comfy_extras.nodes_turntable import TurntableNode

    from fractions import Fraction

    def clip_set(content: str, sizes: list, rates=(24, 24, 24, 24), sound: bool = False) -> list:
        return [_segment_clip(k, w, h, 6, content, rates[k], sound) for k, (w, h) in enumerate(sizes)]

    ntsc = Fraction(30000, 1001)
    sets = {
        "smooth": clip_set("smooth", [(32, 32)] * 4),
        "noise": clip_set("noise", [(32, 32)] * 4),
        "sizes": clip_set("smooth", [(32, 32), (48, 48), (32, 32), (32, 32)]),
        # Fix round 1: other rates (the output takes the first clip's), and clips with a sound track.
        "fps25": clip_set("smooth", [(32, 32)] * 4, (25, 25, 25, 25)),
        "ntsc": clip_set("smooth", [(32, 32)] * 4, (ntsc, ntsc, ntsc, ntsc)),
        "mixed": clip_set("smooth", [(32, 32)] * 4, (25, 24, 24, 24)),
        "sound": clip_set("smooth", [(32, 32)] * 4, sound=True),
    }
    clips: dict = {}
    for set_name, blobs in sets.items():
        for k, b in enumerate(blobs):
            with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
                f.write(b)
                f.flush()
                frames = rmf.rgb_frames_of(f.name)
                head = rmf.header(f.name)
            clips[f"{set_name}{k}"] = {"b64": _b64(b), "sha256": hashlib.sha256(b).hexdigest(),
                                      "frames": [rmf.sha(x) for x in frames],
                                      "averageRate": head["video"][0]["averageRate"], "sounds": len(head["sound"])}

    cases: list = []
    real_stitch = ts.stitch_clips

    def add(name, views, direction, instructions="", clip_set_name="smooth", fail_at=None):
        blobs = sets[clip_set_name]
        widgets = {"direction": direction, "instructions": instructions}
        pictures = ["image", *[TURNTABLE_VIEW_NAMES[v] for v in views]]
        answers = []
        files = {}
        for k in range(4):
            url = TURNTABLE_SEG_URL.format(k=k + 1)
            answers.append({"__raise__": "The provider refused this prompt"} if fail_at == k + 1 else {"video": {"url": url}})
            files[url] = _b64(blobs[k])
        seen: dict = {}

        def recording_stitch(sources):
            data = []
            for src in sources:
                if hasattr(src, "seek"):
                    src.seek(0)
                data.append(src.read() if hasattr(src, "read") else open(src, "rb").read())
                if hasattr(src, "seek"):
                    src.seek(0)
            seen["order"] = [hashlib.sha256(d).hexdigest() for d in data]
            # Source frames: each clip's decoded frames, the first of every clip after the first dropped.
            source = []
            with tempfile.TemporaryDirectory() as tmp:
                paths = []
                for i, d in enumerate(data):
                    p = os.path.join(tmp, f"in{i}.mp4")
                    with open(p, "wb") as f:
                        f.write(d)
                    paths.append(p)
                    fr = rmf.rgb_frames_of(p)
                    source.extend(fr[1:] if i else fr)
                recs = {}
                for label, swap in (("x264", None), ("openh264", rmf.openh264_options(20))):
                    with rmf._patched(ts, rmf._AvShim(swap)):
                        buf = real_stitch([io.BytesIO(d) for d in data])
                    out = os.path.join(tmp, f"stitch_{label}.mp4")
                    with open(out, "wb") as f:
                        f.write(buf.getvalue())
                    # Only the first clip's size is a source's size: PSNR only where every clip already is it.
                    same = len({(len(x)) for x in source}) == 1
                    recs[label] = rmf.video_record(out, source if same else None, False)
                seen["stitch"] = recs
            with rmf._patched(ts, rmf._AvShim(None)):
                return real_stitch(sources)

        with mock.patch.object(nodes_turntable, "stitch_clips", recording_stitch), contextlib.redirect_stdout(io.StringIO()):
            case = paid_case(name, TurntableNode, widgets, answers, pictures=pictures, files=files)
        # Python stops at the failed call: the answers it never asked for are not the case's.
        case["answers"] = case["answers"][:len(case["calls"])]
        case["files"] = {u: b for u, b in case["files"].items() if u in {g["url"] for g in case["gets"]}}
        case["clip_set"] = clip_set_name
        if "order" in seen:
            case["stitch_order"] = seen["order"]
            case["stitch"] = seen["stitch"]
        cases.append(case)

    from itertools import combinations
    subsets = [list(c) for n in range(1, 4) for c in combinations(["right", "back", "left"], n)]
    for sub in subsets:
        for d in ("left", "right"):
            add(f"{'+'.join(sub)} · {d}", sub, d)
    add("right+back+left · left · instructions padded", ["right", "back", "left"], "left", "  slow and steady \n")
    add("back · right · instructions non-ASCII", ["back"], "right", "Café 日本 \U0001f98a — naïve")
    add("right+back+left · left · noisy clips", ["right", "back", "left"], "left", clip_set_name="noise")
    add("back · left · noisy clips", ["back"], "left", clip_set_name="noise")
    add("right+back+left · left · a clip of another size", ["right", "back", "left"], "left", clip_set_name="sizes")
    add("right+back+left · left · segment 3 fails", ["right", "back", "left"], "left", fail_at=3)
    add("right+back+left · left · 25 fps clips", ["right", "back", "left"], "left", clip_set_name="fps25")
    add("back · left · 30000/1001 fps clips", ["back"], "left", clip_set_name="ntsc")
    add("right+back+left · right · 30000/1001 fps clips", ["right", "back", "left"], "right", clip_set_name="ntsc")
    add("right+back+left · left · the first clip 25 fps, the rest 24", ["right", "back", "left"], "left", clip_set_name="mixed")
    add("right+back+left · left · clips with sound", ["right", "back", "left"], "left", clip_set_name="sound")
    return {"cases": cases, "clips": clips}


# ── e2e (R3.18): the controller check's chained workflows, node by node ──────

E2E_GENERATED = "https://f.test/e2e/generated.png"
E2E_UPSCALED = "https://r.test/e2e/upscaled.png"
E2E_CUTOUT = "https://r.test/e2e/cutout.png"
E2E_SUMMARY_TEXT = ("The lighthouse keeper climbs the spiral stairs each evening at dusk. He lights the lamp, "
                    "watches the fishing boats come home through the fog, and writes the weather in his log.")
E2E_FRAME_LAYERS = {
    "layer1_x": 0.0, "layer1_y": 0.0, "layer1_rotation": 0.0, "layer1_scale": 1.0, "layer1_opacity": 1.0,
    "layer1_blend": "normal", "layer1_z": 1.0, "layer1_protect": False, "layer1_cloner": "",
    "layer2_x": 0.1, "layer2_y": -0.05, "layer2_rotation": 10.0, "layer2_scale": 0.8, "layer2_opacity": 1.0,
    "layer2_blend": "normal", "layer2_z": 2.0, "layer2_protect": False, "layer2_cloner": "",
    "width": 0, "height": 0, "motion_params": "",
}


def _capture_chain_step(node_cls, answers: list, **kw) -> tuple:
    """capture_calls, and the node's own NodeOutput (the tensors a chain hands
    on to the next node, as ComfyUI hands them): `execute` is wrapped for the
    one run, nothing else changes."""
    kept: dict = {}
    real = node_cls.execute

    async def keep(**kwargs):
        out = await real(**kwargs)
        kept["out"] = out
        return out

    with mock.patch.object(node_cls, "execute", keep):
        got = capture_calls(node_cls, answers, **kw)
    return got, kept.get("out")


def _trunc8(t) -> dict:
    """A picture tensor as save_images writes it (np.clip(255·x).astype(uint8)): its shape, sha256 and bytes."""
    import hashlib
    import numpy as np
    arr = np.clip(255.0 * t.detach().cpu().float().numpy(), 0, 255).astype(np.uint8)
    return {"shape": list(arr.shape), "sha256": hashlib.sha256(arr.tobytes()).hexdigest(), "px": _b64(arr.tobytes())}


def _step(name: str, node_cls, widgets: dict, got: dict, answers: list, files: dict | None = None,
          pictures: dict | None = None) -> dict:
    """One node of a chain, in paid_case's shape (paidParity.ts PaidCase), plus what it handed on."""
    row = {"name": name, "class_type": node_cls.define_schema().node_id, "widgets": widgets, "answers": answers,
           "calls": got["calls"], "gets": got["gets"], "output": got.get("output"), "ui": got.get("ui"),
           "pictures": list(pictures or {}), "picture_files": {n: _b64(b) for n, b in (pictures or {}).items()},
           "sounds": [], "sound_files": {}}
    if files:
        row["files"] = files
    for key in ("error", "made", "loaded"):
        if key in got:
            row[key] = got[key]
    return row


def e2e_group() -> dict:
    """R3.18: the workflows of the controller check that no single-node case
    covers, run node by node as ComfyUI runs them (each node's real execute
    through capture_calls, its output handed to the next), for
    frontend/tests/unit/runner-paid-e2e.unit.spec.ts:
      summarize_generate — Text → Summarize text → Generate an image's
                           `prompt_in` (flux-schnell, fal) → Image card
      split_frame        — LoadImage → Separate background and foreground
                           (LaMa) → Frame (background on layer 1, the subject
                           turned and scaled on layer 2): the Frame's 8-bit
                           render as save_live_preview writes it
      upscale_remove_save — Image card → Upscale (Real-ESRGAN, ×2) → Remove
                           background → Save image: the picture Python hands
                           the remover (`made`) and Save image's pixels
      restyle_second     — Restyle an Image · Style LoRA, an illustration
                           target that holds on the second pass
      multi_lora_image   — Flux Dev + LoRAs with a picture, two public links
                           with no scheme (hosted takes them), the weights
                           loaded (one call)
    The other workflows are single-node cases of their own groups."""
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    import comfy_extras.nodes_compositor as nc
    from comfy_api.latest._io import HiddenHolder
    out: dict = {}

    # 1. Text → Summarize → Generate an image (prompt_in) → Image card.
    s_w = {"text": E2E_SUMMARY_TEXT, "length": "1 sentence", "model": "Gemini 3 Flash"}
    s_ans = [_llm_body(["The keeper", " lights the lamp", " at dusk", " and logs the weather."])]
    s_got = capture_calls(nr.SummarizeTextNode, s_ans, **s_w)
    assert "error" not in s_got, s_got
    summary = s_got["output"][0]
    g_w = {"model": "flux-schnell", "prompt": "", "aspect_ratio": "1:1", "seed": 7, "model_options": "{}", "prompt_in": summary}
    g_files = {E2E_GENERATED: _b64(png_bytes(8, 8, 601))}
    g_ans = [{"images": [{"url": E2E_GENERATED, "width": 8, "height": 8, "content_type": "image/png"}]}]
    g_got = capture_calls(nr.GenerateImageNode, g_ans, files=g_files, **g_w)
    assert "error" not in g_got, g_got
    assert [c["endpoint"] for c in g_got["calls"]] == ["fal-ai/flux/schnell"], g_got["calls"]
    out["summarize_generate"] = {"steps": [_step("summarize", nr.SummarizeTextNode, s_w, s_got, s_ans),
                                           _step("generate", nr.GenerateImageNode, g_w, g_got, g_ans, g_files)]}

    # 2. LoadImage → Separate background and foreground → Frame (both layers).
    W, H = 24, 18
    picture = png_bytes(W, H, 610)
    sp_files = {SPLIT_CUTOUT: _b64(_split_cutout(W, H, 611)), SPLIT_BACKGROUND: _b64(png_bytes(W, H, 612, "RGBA"))}
    sp_w = {"background_fill": "LaMa (fast)", "mask_grow": 12}
    sp_ans = [{"output": SPLIT_CUTOUT}, {"output": [SPLIT_BACKGROUND]}]
    sp_got, sp_out = _capture_chain_step(nr.SplitPhotoLayersNode, sp_ans, files=sp_files, pictures={"image": picture},
                                         made_pixels=True, **sp_w)
    assert "error" not in sp_got, sp_got
    subject, background = sp_out.args[0], sp_out.args[1]
    previews: list = []
    with mock.patch.object(nc.CompositorNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": "frame"})), \
            mock.patch.object(nc, "save_live_preview", lambda t, *_a, **_k: previews.append(t) or {}):
        res = nc.CompositorNode.execute(layer1=background, layer2=subject, **E2E_FRAME_LAYERS)
    image = res.result[0]
    assert previews and previews[0] is image
    out["split_frame"] = {
        "steps": [_step("split", nr.SplitPhotoLayersNode, sp_w, sp_got, sp_ans, sp_files, {"image": picture})],
        "handed_on": {"subject": _trunc8(subject[0]), "background": _trunc8(background[0])},
        "frame": {"widgets": E2E_FRAME_LAYERS, **_trunc8(image[0])},
    }

    # 3. Image card → Upscale (Real-ESRGAN) → Remove background → Save image.
    card = png_bytes(8, 6, 620)
    up_w = {**UPSCALE_DEFAULTS, "model": "Real-ESRGAN", "scale_factor": 2.0}
    up_files = {E2E_UPSCALED: _b64(png_bytes(16, 12, 621))}
    up_ans = [{"output": [E2E_UPSCALED]}]
    up_got, up_out = _capture_chain_step(nr.UpscaleImageNode, up_ans, files=up_files, pictures={"image": card}, **up_w)
    assert "error" not in up_got, up_got
    upscaled = up_out.args[0]
    rb_w = {"model": "851-labs/bg-remover"}
    rb_files = {E2E_CUTOUT: _b64(png_bytes(16, 12, 622, "RGBA"))}
    rb_ans = [{"output": [E2E_CUTOUT]}]
    rb_got, rb_out = _capture_chain_step(nr.RemoveBackgroundNode, rb_ans, files=rb_files, tensors={"image": upscaled},
                                         made_pixels=True, **rb_w)
    assert "error" not in rb_got, rb_got
    out["upscale_remove_save"] = {
        "steps": [_step("upscale", nr.UpscaleImageNode, up_w, up_got, up_ans, up_files, {"image": card}),
                  _step("remove", nr.RemoveBackgroundNode, rb_w, rb_got, rb_ans, rb_files)],
        "handed_on": {"upscaled": _trunc8(upscaled[0])},
        "saved": _trunc8(rb_out.args[0][0]),
    }

    # 4. Restyle an Image · Style LoRA: an illustration target held on the second pass.
    rs_w = {"lora_name": "[None]", "style_strength": 0.5, "resolution": "1K", "seed": 0, "lora_url": RESTYLE_LORA_URL,
            "lora_scale": 1.0, "flux_prompt_strength": 0.0, "flux_steps": 28, "flux_guidance": 3.5,
            "describe_prompt": nr._RESTYLE_DESCRIBE_PROMPT, "extra_style_direction": "", "output_format": "png"}
    rs_files = {RESTYLE_FLUX: _b64(png_bytes(8, 6, 41)), RESTYLE_NB[0]: _b64(png_bytes(8, 6, 43)), RESTYLE_NB[1]: _b64(png_bytes(8, 6, 44))}
    rs_ans = [{"output": ["A woman", " in a red coat", " walks a dog in a park."]}, {"output": [RESTYLE_FLUX]}, {"output": "illustration"},
              {"images": [{"url": RESTYLE_NB[0], "width": 8, "height": 6}]}, {"output": "photograph"},
              {"images": [{"url": RESTYLE_NB[1], "width": 8, "height": 6}]}, {"output": ["An ", "illustration."]}]
    rs = paid_case("restyle · illustration · second", nr.RestyleWithLoRANode, rs_w, rs_ans, pictures=["content_image"], files=rs_files)
    assert "error" not in rs, rs.get("error")
    assert len(rs["calls"]) == 7, [c["endpoint"] for c in rs["calls"]]
    out["restyle_second"] = rs

    # 5. Image card → Flux Dev + LoRAs → Image card: two public links (no scheme), the weights loaded.
    nr._MULTILORA_ROTATE["n"] = 0
    ml_w = {**LORA_MULTI, "lora_b_url": "huggingface.co/alice/one", "lora_d_url": "hf.co/alice/d", "prompt_strength": 0.2}
    ml = paid_case("multi-lora · image · two links · loaded", nr.FluxMultiLoRARemoteNode, ml_w,
                   [{"output": [LORA_OUT], "logs": LORA_MARKER_LOGS}], pictures=["image"],
                   files={LORA_OUT: _b64(png_bytes(8, 6, 31))})
    assert "error" not in ml, ml.get("error")
    assert len(ml["calls"]) == 1 and not ml["gets"][1:], ml["calls"]
    ml["rotate"] = 0
    ml["rotate_after"] = nr._MULTILORA_ROTATE["n"]
    nr._MULTILORA_ROTATE["n"] = 0
    out["multi_lora_image"] = ml
    return out


# ── R7.1: Background remove with a stand-in model (group local-cutout) ─────────

CUTOUT_W, CUTOUT_H = 48, 40
CUTOUT_INLINE_VALUES = 256


def _cutout_answer(w: int, h: int, seed: int, alpha: str, mode: str = "RGBA") -> bytes:
    """The stand-in model's answer as a PNG: random RGB and an alpha that is soft
    (a radial ramp with noise), hard (a disc, 0 or 255) or empty (all 0)."""
    import io
    import numpy as np
    from PIL import Image
    rng = np.random.default_rng(seed)
    rgb = rng.integers(0, 256, size=(h, w, 3), dtype=np.uint8)
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt((xx - w / 2.0) ** 2 + (yy - h / 2.0) ** 2) / (min(w, h) / 2.0)
    if alpha == "soft":
        a = np.clip((1.2 - r) * 255.0 + rng.integers(-40, 41, size=(h, w)), 0, 255).astype(np.uint8)
    elif alpha == "hard":
        a = np.where(r < 0.7, 255, 0).astype(np.uint8)
    else:
        a = np.zeros((h, w), dtype=np.uint8)
    img = Image.fromarray(np.dstack([rgb, a]), "RGBA")
    if mode != "RGBA":
        img = img.convert(mode)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _cutout_tensor_record(t) -> dict:
    """A float32 output as recorded: shape, sha256 of its float32 (whole when small), round-8 and trunc-8."""
    import hashlib
    import numpy as np
    f = np.ascontiguousarray(t.detach().cpu().float().numpy())
    raw = f.tobytes()
    rec = {
        "shape": list(f.shape),
        "f32_sha256": hashlib.sha256(raw).hexdigest(),
        "round8_sha256": hashlib.sha256((np.clip(f, 0, 1) * np.float32(255)).round().astype(np.uint8).tobytes()).hexdigest(),
        "trunc8_sha256": hashlib.sha256(np.clip(np.float32(255) * f, 0, 255).astype(np.uint8).tobytes()).hexdigest(),
    }
    if f.size <= CUTOUT_INLINE_VALUES:
        rec["f32"] = _b64(raw)
    return rec


def local_cutout_group() -> dict:
    """Background remove's real execute, its model a stand-in that answers recorded pictures (R7.1)."""
    import hashlib
    import io
    import shutil
    import tempfile
    import types
    import numpy as np
    import torch
    from PIL import Image, ImageFilter
    import folder_paths
    from comfy_api.latest._io import HiddenHolder
    from comfy_extras import nodes_bg_remove as bg

    answers: list = []
    seen: list = []

    def stand_in_remove(pil, session=None, post_process_mask=False):
        assert session == "stand-in session" and post_process_mask is True
        seen.append(list(pil.size) + [pil.mode])
        return Image.open(io.BytesIO(answers.pop(0)))

    fake_rembg = types.ModuleType("rembg")
    fake_rembg.remove = stand_in_remove
    real_isfile = os.path.isfile
    temp = tempfile.mkdtemp(prefix="local-cutout-")
    folder_paths.set_temp_directory(temp)
    cases: list = []

    def run(name: str, pictures: list, served: list, output: str, edge_softness: float, node_id: str = "7"):
        answers[:] = list(served)
        seen.clear()
        frames = torch.cat([_picture_tensor(p) for p in pictures], dim=0)
        with mock.patch.dict(sys.modules, {"rembg": fake_rembg}), \
                mock.patch.object(bg.os.path, "isfile", lambda path: path == bg._MODEL_PATH or real_isfile(path)), \
                mock.patch.object(bg, "_get_session", lambda: "stand-in session"), \
                mock.patch.object(bg.BackgroundRemoveNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": node_id})):
            res = bg.BackgroundRemoveNode.execute(frames=frames, output=output, edge_softness=edge_softness)
        assert not answers, f"{name}: {len(answers)} answers unused"
        image, mask = res.args
        ui = res.ui.as_dict() if hasattr(res.ui, "as_dict") else res.ui
        entry = dict(ui["images"][0])
        with Image.open(os.path.join(temp, entry["subfolder"], entry["filename"])) as im:
            im.load()
            px = im.tobytes()
            preview = {"filename": entry["filename"], "subfolder": entry["subfolder"], "type": entry["type"], "mode": im.mode,
                       "w": im.size[0], "h": im.size[1], "sha256": hashlib.sha256(px).hexdigest()}
        alpha8 = np.clip(np.rint(mask.numpy() * 255.0), 0, 255).astype(np.uint8)
        cases.append({
            "name": name, "class_type": "BackgroundRemove", "node_id": node_id,
            "widgets": {"output": output, "edge_softness": edge_softness},
            "pictures": [_b64(p) for p in pictures],
            "answers": [_b64(a) for a in served],
            "sent": [list(x) for x in seen],
            "image": _cutout_tensor_record(image),
            "mask": _cutout_tensor_record(mask),
            "alpha8": _b64(alpha8.tobytes()),
            "preview": preview,
            "animated": list(ui.get("animated", [])),
        })

    try:
        seed = 7100
        for alpha in ("soft", "hard", "empty"):
            for output in ("transparent", "premultiplied", "matte_only"):
                for soft in (0.0, 2.0, 10.0):
                    seed += 1
                    run(f"cutout · {alpha} alpha · {output} · edge {soft:g}", [png_bytes(CUTOUT_W, CUTOUT_H, seed)],
                        [_cutout_answer(CUTOUT_W, CUTOUT_H, seed, alpha)], output, soft)
        # A clip: three frames, one answer each (ruling (f): one call per frame).
        for output in ("transparent", "premultiplied", "matte_only"):
            frames = [png_bytes(24, 16, 7300 + i) for i in range(3)]
            run(f"cutout · a clip of three frames · {output}", frames,
                [_cutout_answer(24, 16, 7310 + i, ("soft", "hard", "empty")[i]) for i in range(3)], output, 0.0)
        run("cutout · a clip of three frames · transparent · edge 2", [png_bytes(24, 16, 7320 + i) for i in range(3)],
            [_cutout_answer(24, 16, 7330 + i, "soft") for i in range(3)], "transparent", 2.0)
        # A picture smaller than the blur's kernel (torchvision's would refuse it; the runner narrows it).
        run("cutout · a 7 × 5 picture · edge 2", [png_bytes(7, 5, 7400)], [_cutout_answer(7, 5, 7401, "soft")], "transparent", 2.0)
        # The answer PIL reads its own way (grey + alpha): convert("RGBA").
        run("cutout · an answer in grey and alpha · premultiplied", [png_bytes(CUTOUT_W, CUTOUT_H, 7500)],
            [_cutout_answer(CUTOUT_W, CUTOUT_H, 7501, "soft", "LA")], "premultiplied", 0.0)
    finally:
        shutil.rmtree(temp, ignore_errors=True)
    # Pillow's GaussianBlur alone, the one step the runner doesn't port (judged by eye): alphas at a
    # picture's size (160 × 120: the blur's reach far from every edge), zlib-compressed.
    import zlib
    bw, bh = 160, 120
    rng = np.random.default_rng(7600)
    yy, xx = np.mgrid[0:bh, 0:bw]
    r = np.sqrt((xx - bw / 2.0) ** 2 + (yy - bh / 2.0) ** 2) / (min(bw, bh) / 2.0)
    alphas = {
        "hard": np.where(r < 0.7, 255, 0).astype(np.uint8),
        "soft": np.clip((1.2 - r) * 255.0 + rng.integers(-40, 41, size=(bh, bw)), 0, 255).astype(np.uint8),
        "edge": np.where(yy > bh * 0.6, 255, 0).astype(np.uint8),
    }
    blur = []
    for kind, a in alphas.items():
        for radius in (0.5, 2.0, 10.0):
            out = np.asarray(Image.fromarray(a, "L").filter(ImageFilter.GaussianBlur(radius)))
            blur.append({"alpha": kind, "radius": radius, "w": bw, "h": bh,
                         "in": _b64(zlib.compress(a.tobytes(), 9)), "out": _b64(zlib.compress(out.tobytes(), 9))})
    return {"cases": cases, "size": [CUTOUT_W, CUTOUT_H], "blur": blur}


# ── R7.3: Object removal with a stand-in model (group local-erase) ──────────────

ERASE_W, ERASE_H = 29, 19


def _erase_masks(w: int, h: int, seed: int) -> dict:
    """The masks the erase cases grow, float32 [H, W]: LoadImage's own (1 − a/255, every
    alpha level: its truncation quirk), soft noise, a hard disc, one touching every edge
    and corner, and all black."""
    import numpy as np
    rng = np.random.default_rng(seed)
    a = rng.integers(0, 256, size=(h, w)).astype(np.float32)
    loader = (np.float32(1.0) - a / np.float32(255.0)).astype(np.float32)
    loader[rng.random((h, w)) < 0.5] = 0.0
    soft = rng.random((h, w)).astype(np.float32)
    soft[soft < 0.6] = 0.0
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt((xx - w / 2.0) ** 2 + (yy - h / 2.0) ** 2) / (min(w, h) / 2.0)
    hard = np.where(r < 0.5, 1.0, 0.0).astype(np.float32)
    edges = np.zeros((h, w), dtype=np.float32)
    for (y, x) in [(0, 0), (0, w - 1), (h - 1, 0), (h - 1, w - 1), (0, w // 2), (h - 1, w // 3), (h // 2, 0), (h // 3, w - 1)]:
        edges[y, x] = 1.0
    edges[h // 2, w // 2] = 0.5
    return {"loader": loader, "soft": soft, "hard": hard, "edges": edges, "black": np.zeros((h, w), dtype=np.float32)}


def _fill_png(w: int, h: int, seed: int) -> bytes:
    """A recorded full-size fill (the provider's answer): random RGB."""
    return png_bytes(w, h, seed)


def local_erase_group() -> dict:
    """Object removal's mask grow and composite (R7.3): cv2.dilate recorded directly, and the
    real execute with LaMa's 512 × 512 session and its resizes swapped for stand-ins, so the
    full-size fill the provider answers is what Python composites."""
    import hashlib
    import shutil
    import tempfile
    import cv2
    import numpy as np
    import torch
    from PIL import Image
    import folder_paths
    from comfy_api.latest._io import HiddenHolder
    from comfy_extras import _inpaint, nodes_object_remove as ob

    # cv2.dilate alone: Python's own 8 bits of the mask, grown by a 3 × 3 square `grow` times.
    dilate: list = []
    kernel = np.ones((3, 3), np.uint8)
    for (w, h, seed) in ((ERASE_W, ERASE_H, 7700), (3, 2, 7701), (1, 1, 7702)):
        for kind, m in _erase_masks(w, h, seed).items():
            for grow in (0, 1, 4, 64):
                m8 = (m * 255.0).clip(0, 255).astype(np.uint8)
                grown = cv2.dilate(m8, kernel, iterations=int(grow)) if grow > 0 else m8
                dilate.append({"name": f"dilate · {w} × {h} · {kind} · grow {grow}", "w": w, "h": h, "grow": grow,
                               "mask_f32": _b64(np.ascontiguousarray(m, dtype="<f4").tobytes()),
                               "m8": _b64(m8.tobytes()), "grown": _b64(grown.tobytes())})

    # The real execute: the session answers zeros at 512 × 512 (never read: the stand-in
    # resize back hands over the recorded full-size fill instead, as the provider would).
    fills: list = []
    session_calls: list = []

    class _In:
        def __init__(self, name):
            self.name = name

    class StandInSession:
        def get_inputs(self):
            return [_In("image"), _In("mask")]

        def run(self, _outputs, feed):
            assert feed["image"].shape == (1, 3, 512, 512) and feed["mask"].shape == (1, 1, 512, 512)
            session_calls.append(1)
            return [np.zeros((1, 3, 512, 512), dtype=np.float32)]

    real_resize = cv2.resize

    def stand_in_resize(src, dsize, interpolation=None):
        if tuple(dsize) == (512, 512):
            return real_resize(src, dsize, interpolation=interpolation)
        assert interpolation == cv2.INTER_CUBIC, interpolation
        fill = fills.pop(0)
        assert fill.shape[1] == dsize[0] and fill.shape[0] == dsize[1], (fill.shape, dsize)
        return fill

    temp = tempfile.mkdtemp(prefix="local-erase-")
    folder_paths.set_temp_directory(temp)
    cases: list = []

    def run(name: str, pictures: list, mask, grow: int, served: list, node_id: str = "9"):
        fills[:] = [np.array(Image.open(__import__("io").BytesIO(f)).convert("RGB")) for f in served]
        session_calls.clear()
        frames = torch.cat([_picture_tensor(p) for p in pictures], dim=0)
        with mock.patch.object(ob, "lama_ready", lambda: True), \
                mock.patch.object(_inpaint, "_get_session", lambda: StandInSession()), \
                mock.patch.object(cv2, "resize", stand_in_resize), \
                mock.patch.object(ob.ObjectRemoveNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": node_id})):
            res = ob.ObjectRemoveNode.execute(frames=frames, mask=torch.from_numpy(mask), mask_grow=grow)
        assert not fills, f"{name}: {len(fills)} fills unused"
        (image,) = res.args
        ui = res.ui.as_dict() if hasattr(res.ui, "as_dict") else res.ui
        entry = dict(ui["images"][0])
        with Image.open(os.path.join(temp, entry["subfolder"], entry["filename"])) as im:
            im.load()
            preview = {"filename": entry["filename"], "subfolder": entry["subfolder"], "type": entry["type"], "mode": im.mode,
                       "w": im.size[0], "h": im.size[1], "sha256": hashlib.sha256(im.tobytes()).hexdigest()}
        cases.append({
            "name": name, "class_type": "ObjectRemove", "node_id": node_id, "mask_grow": grow,
            "pictures": [_b64(p) for p in pictures],
            "mask_shape": list(mask.shape),
            "mask_f32": _b64(np.ascontiguousarray(mask, dtype="<f4").tobytes()),
            "fills": [_b64(f) for f in served],
            "calls": len(session_calls),
            "image": _cutout_tensor_record(image),
            "preview": preview,
            "animated": list(ui.get("animated", [])),
        })

    try:
        w, h = ERASE_W, ERASE_H
        masks = _erase_masks(w, h, 7710)
        seed = 7720
        for kind in ("loader", "soft", "hard", "edges"):
            for grow in (0, 4, 64):
                seed += 1
                run(f"erase · {kind} mask · grow {grow}", [png_bytes(w, h, seed)], masks[kind], grow, [_fill_png(w, h, seed + 500)])
        # Nothing to remove: the frame unchanged, no call.
        run("erase · an all-black mask · grow 4", [png_bytes(w, h, 7790)], masks["black"], 4, [])
        # A clip: one mask for every frame ([H, W] and [1, H, W]), and a mask per frame (the middle one black: no call).
        frames = [png_bytes(w, h, 7800 + i) for i in range(3)]
        run("erase · a clip of three frames · one mask", frames, masks["soft"], 2, [_fill_png(w, h, 7810 + i) for i in range(3)])
        run("erase · a clip of three frames · a batch of one mask", frames, masks["hard"][None], 1, [_fill_png(w, h, 7820 + i) for i in range(3)])
        per = np.stack([masks["loader"], masks["black"], masks["edges"]])
        run("erase · a clip of three frames · a mask per frame, one black", frames, per, 3, [_fill_png(w, h, 7830 + i) for i in (0, 2)])
    finally:
        shutil.rmtree(temp, ignore_errors=True)
    return {"dilate": dilate, "cases": cases, "size": [ERASE_W, ERASE_H]}


MASKS_W, MASKS_H = 24, 16


def _masks_disc(w: int, h: int, cx: float, cy: float, r: float):
    """A hard disc, float32 [H, W] of 0 and 1."""
    import numpy as np
    yy, xx = np.mgrid[0:h, 0:w]
    return (np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) < r).astype(np.float32)


def _masks_logits(w: int, h: int, seed: int, kind: str):
    """CLIPSeg's stand-in logits at the picture's own size (Python's resize is then the
    identity): `hard` ±1000 (sigmoid gives exactly 0 and 1, a hard mask as SAM 3's), `soft`
    random with every tenth one 0 (sigmoid 0.5: the threshold's edge)."""
    import numpy as np
    if kind == "hard":
        return np.where(_masks_disc(w, h, w * 0.4, h * 0.55, min(w, h) * 0.35) > 0, 1000.0, -1000.0).astype(np.float32)
    rng = np.random.default_rng(seed)
    lg = (rng.standard_normal((h, w)) * 3.0).astype(np.float32)
    lg.flat[::10] = 0.0
    return lg


def local_masks_group() -> dict:
    """Mask by text and Mask extractor (R7.4): the real execute with CLIPSeg and SAM swapped
    for stand-ins (no model, no network), so what follows the model (the threshold, the
    feather, the invert, the preview) is Python's own on a recorded mask, and the click
    points are what Python's processor receives."""
    import hashlib
    import io
    import shutil
    import tempfile
    import numpy as np
    import torch
    from PIL import Image
    import folder_paths
    from comfy_api.latest._io import HiddenHolder
    from comfy_extras import nodes_matte_ml as mm

    temp = tempfile.mkdtemp(prefix="local-masks-")
    folder_paths.set_temp_directory(temp)
    w, h = MASKS_W, MASKS_H
    seen: dict = {}

    class _Out:
        pass

    class ClipProc:
        def __call__(self, text, images, return_tensors, padding):
            assert return_tensors == "pt" and padding is True
            seen["text"] = list(text)
            seen["size"] = list(images[0].size)
            return {"input_ids": torch.zeros(1, 1)}

    def clip_model(logits):
        def run(**_inputs):
            o = _Out()
            o.logits = torch.from_numpy(logits.copy())
            return o
        return run

    class SamImageProcessor:
        def __init__(self, cands):
            self.cands = cands

        def post_process_masks(self, pred, orig, reshaped):
            return [torch.from_numpy(np.stack(self.cands)[None] > 0.5)]

    class SamProc:
        def __init__(self, cands):
            self.image_processor = SamImageProcessor(cands)

        def __call__(self, pil, input_points, input_labels, return_tensors):
            assert return_tensors == "pt"
            seen["size"] = list(pil.size)
            seen["coords"] = [list(map(int, c)) for c in input_points[0]]
            seen["labels"] = [int(x) for x in input_labels[0]]
            return {"original_sizes": torch.tensor([[h, w]]), "reshaped_input_sizes": torch.tensor([[h, w]])}

    def sam_model(scores):
        def run(**_inputs):
            assert _inputs.get("multimask_output") is True
            o = _Out()
            o.pred_masks = torch.zeros(1, 1, 3, 4, 4)
            o.iou_scores = torch.tensor([[scores]], dtype=torch.float32)
            return o
        return run

    def record_ui(res, inline: bool) -> dict:
        ui = res.ui.as_dict() if hasattr(res.ui, "as_dict") else res.ui
        entry = dict(ui["images"][0])
        with Image.open(os.path.join(temp, entry["subfolder"], entry["filename"])) as im:
            im.load()
            rec = {"filename": entry["filename"], "subfolder": entry["subfolder"], "type": entry["type"], "mode": im.mode,
                   "w": im.size[0], "h": im.size[1], "sha256": hashlib.sha256(im.tobytes()).hexdigest(), "animated": list(ui.get("animated", []))}
            if inline:
                rec["pixels"] = _b64(im.tobytes())
            return rec

    def mask_record(t, inline: bool) -> dict:
        """The float32 mask: its sha256, and the values themselves where a feather makes them LIBRARY (compared in a band)."""
        f = np.ascontiguousarray(t.detach().cpu().float().numpy())
        rec = {"shape": list(f.shape), "f32_sha256": hashlib.sha256(f.tobytes()).hexdigest()}
        if inline:
            rec["f32"] = _b64(f.tobytes())
        return rec

    cases: list = []
    answers: dict = {}

    def run_text(name, pictures, logits, prompt, threshold, feather, invert, node_id="7"):
        seen.clear()
        image = torch.cat([_picture_tensor(p) for p in pictures], dim=0)
        answer = torch.sigmoid(torch.from_numpy(logits.copy()).float())
        if answer.dim() == 3:
            answer = answer[0]
        key = hashlib.sha256(np.ascontiguousarray(answer.numpy()).tobytes()).hexdigest()[:16]
        answers.setdefault(key, _b64(np.ascontiguousarray(answer.numpy(), dtype="<f4").tobytes()))
        case = {"name": name, "class_type": "MaskByText", "node_id": node_id, "pictures": [_b64(p) for p in pictures],
                "widgets": {"prompt": prompt, "threshold": threshold, "feather": feather, "invert": invert},
                "logits_dims": int(logits.ndim), "answer": key}
        try:
            with mock.patch.object(mm, "_load_clipseg", lambda _d: (ClipProc(), clip_model(logits))), \
                    mock.patch.object(mm.MaskByTextNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": node_id})):
                res = mm.MaskByTextNode.execute(image=image, prompt=prompt, threshold=threshold, feather=feather, invert=invert)
        except Exception as e:  # noqa: BLE001 (Python's own failure is the record)
            case["error"] = type(e).__name__
            cases.append(case)
            return
        (mask,) = res.args
        if threshold == 0 and feather == 0 and not invert:
            assert torch.equal(mask[0], answer), f"{name}: CLIPSeg's resize is not the identity"
        case.update({"sent_text": seen["text"], "sent_size": seen["size"], "mask": mask_record(mask, feather > 0), "preview": record_ui(res, feather > 0)})
        cases.append(case)

    def run_clicks(name, picture, points, feather, invert, cands, scores, node_id="8"):
        seen.clear()
        image = _picture_tensor(picture)
        case = {"name": name, "class_type": "MaskExtractor", "node_id": node_id, "pictures": [_b64(picture)],
                "widgets": {"points": points, "feather": feather, "invert": invert},
                "scores": scores}
        try:
            with mock.patch.object(mm, "_load_sam", lambda _d: (SamProc(cands), sam_model(scores))), \
                    mock.patch.object(mm.MaskExtractorNode, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": node_id})):
                res = mm.MaskExtractorNode.execute(image=image, points=points, feather=feather, invert=invert)
        except Exception as e:  # noqa: BLE001 (Python's own failure is the record)
            case["error"] = type(e).__name__
            if "coords" in seen:
                case.update({"sent_coords": seen["coords"], "sent_labels": seen["labels"]})
            cases.append(case)
            return
        (mask,) = res.args
        best = int(np.argmax(np.asarray(scores, dtype=np.float32)))
        case.update({"best": best, "sent_coords": seen["coords"], "sent_labels": seen["labels"], "sent_size": seen["size"],
                     "mask": mask_record(mask, feather > 0), "preview": record_ui(res, feather > 0)})
        cases.append(case)

    try:
        hard = _masks_logits(w, h, 0, "hard")
        soft = _masks_logits(w, h, 7900, "soft")
        seed = 7910
        for (prompt, logits, lname) in (("", hard, "hard"), ("the dog", soft, "soft"), ("  ", soft[None], "soft, [1, H, W]")):
            for (thr, fe, inv) in ((0.0, 0.0, False), (0.0, 0.0, True), (0.5, 0.0, False), (0.3, 0.0, False), (1.0, 0.0, False),
                                   (0.0, 2.5, False), (0.5, 2.5, True), (0.0, 0.5, False), (0.0, 4.0, False)):
                seed += 1
                run_text(f"text · {lname} · prompt {prompt!r} · threshold {thr} · feather {fe} · invert {inv}",
                         [png_bytes(w, h, seed)], logits, prompt, thr, fe, inv)
        # A batch of two pictures: the mask from the first, the preview of the first.
        run_text("text · a batch of two pictures", [png_bytes(w, h, 7990), png_bytes(w, h, 7991)], soft, "sky", 0.0, 0.0, False)
        # A feather wider than the picture: torchvision's reflect padding raises (the runner narrows it: fix-bugs rule).
        run_text("text · feather 30 on 24 × 16 (Python fails)", [png_bytes(w, h, 7992)], hard, "x", 0.0, 30.0, False)

        cands = [_masks_disc(w, h, 7, 5, 4), _masks_disc(w, h, 15, 9, 6), _masks_disc(w, h, 12, 8, 30)]
        clicks = [
            ('[{"x":0.5,"y":0.5,"label":1}]', [0.2, 0.9, 0.5]),
            ("", [0.9, 0.2, 0.5]),
            ("not json", [0.1, 0.2, 0.95]),
            ("{}", [0.3, 0.3, 0.2]),
            ("[]", [0.5, 0.6, 0.4]),
            ("5", [0.5, 0.6, 0.4]),
            ("null", [0.5, 0.6, 0.4]),
            ('[{"x":0.25,"y":"0.75","label":0}]', [0.2, 0.9, 0.5]),
            ('[{"x":1.5,"y":-0.2}]', [0.2, 0.9, 0.5]),
            ('[{"x":0.999,"y":1}]', [0.2, 0.9, 0.5]),
            ('[{"x":"1e-1","y":" 0.5 ","label":"1"}]', [0.2, 0.9, 0.5]),
            ('[{"x":true,"y":false,"label":1.9}]', [0.2, 0.9, 0.5]),
            ('[{"x":"1_0e-1","y":0.5,"label":true}]', [0.2, 0.9, 0.5]),
            ('[{"x":0.1,"y":0.2,"label":1},{"x":0.9,"y":0.8,"label":0},{"x":0.5,"y":0.5}]', [0.7, 0.7, 0.1]),
            # Python fails on these (the runner leaves them to the engine, or fails plainly at the turn).
            ("[1, 2]", [0.2, 0.9, 0.5]),
            ('[{"y":0.5}]', [0.2, 0.9, 0.5]),
            ('[{"x":"abc","y":0.5}]', [0.2, 0.9, 0.5]),
            ('[{"x":0.5,"y":0.5,"label":null}]', [0.2, 0.9, 0.5]),
            ('[{"x":0.5,"y":0.5,"label":"1.0"}]', [0.2, 0.9, 0.5]),
            ('[{"x":1e400,"y":0.5}]', [0.2, 0.9, 0.5]),
            ('[{"x":NaN,"y":0.5}]', [0.2, 0.9, 0.5]),
            # Python runs these; SAM 3's schema takes labels 0 and 1 only (left to the engine).
            ('[{"x":0.5,"y":0.5,"label":2}]', [0.2, 0.9, 0.5]),
            ('[{"x":0.5,"y":0.5,"label":-1}]', [0.2, 0.9, 0.5]),
        ]
        seed = 8000
        for (points, scores) in clicks:
            seed += 1
            run_clicks(f"clicks · {points!r}", png_bytes(w, h, seed), points, 0.0, False, cands, scores)
        for (fe, inv) in ((0.0, True), (2.5, False), (2.5, True), (4.0, True)):
            seed += 1
            run_clicks(f"clicks · feather {fe} · invert {inv}", png_bytes(w, h, seed), '[{"x":0.3,"y":0.6,"label":1}]', fe, inv, cands, [0.4, 0.8, 0.3])
    finally:
        shutil.rmtree(temp, ignore_errors=True)
    return {"cases": cases, "size": [w, h], "answers": answers,
            "candidates": [_b64(np.ascontiguousarray(c, dtype="<f4").tobytes()) for c in cands]}


GROUPS = {
    "handoff": handoff_group,
    "handoff2": handoff2_group,
    "machinery": machinery_group,
    "llm": llm_group,
    "describe": describe_group,
    "repair": repair_group,
    "layers": layers_group,
    "split": split_group,
    "audio-gen": audio_gen_group,
    "sound-in": sound_in_group,
    "gen-3d": gen_3d_group,
    "film-shot": film_shot_group,
    "image-extras": image_extras_group,
    "lora": lora_group,
    "restyle-lora": restyle_lora_group,
    "nano-extras": nano_extras_group,
    "turntable": turntable_group,
    "turntable-views": turntable_views_group,
    "e2e": e2e_group,
    "local-cutout": local_cutout_group,
    "local-erase": local_erase_group,
    "local-masks": local_masks_group,
}


def self_check() -> None:
    """capture_calls on real classes (R3.2 fix round 1), nothing written:
    a node that works on a downloaded picture makes every call; GETs are
    recorded, a 404 is served as asked, an unserved GET fails the case even
    where the node catches every Exception; the wire text keeps 1.0."""
    import runner_builder_fixtures as rbf
    nr, _fal, _extras = rbf._node_modules()
    rgba = {"https://r.test/subject.png": _b64(png_bytes(8, 6, 7, "RGBA")), "https://r.test/bg.png": _b64(png_bytes(8, 6, 8, "RGBA"))}
    split = paid_case("split", nr.SplitPhotoLayersNode, {"background_fill": "LaMa (fast)", "mask_grow": 2},
                      [{"output": "https://r.test/subject.png"}, {"output": ["https://r.test/bg.png"]}],
                      pictures=["image"], files=rgba)
    assert "error" not in split, split.get("error")
    assert [c["endpoint"] for c in split["calls"]] == ["851-labs/background-remover", "zylim0702/remove-object"], split["calls"]
    assert split["calls"][1]["payload"]["image"] == "IMG:image"
    assert split["calls"][1]["payload"]["mask"].startswith("data:image/png;base64,")
    assert [g["status"] for g in split["gets"]] == [200, 200]
    assert split["output"][0] == {"image": "https://r.test/subject.png"} and "tensor" in split["output"][1]
    # The other fill engine. (A downloaded picture is always read as RGBA, bytesio_to_image_tensor, so the
    # remover's matte branch is never taken, even for an RGB answer: two calls either way.)
    rgb = {**rgba, "https://r.test/subject.png": _b64(png_bytes(8, 6, 7, "RGB"))}
    bria = paid_case("split, RGB answer", nr.SplitPhotoLayersNode, {"background_fill": "Bria Eraser (quality)", "mask_grow": 0},
                     [{"output": "https://r.test/subject.png"}, {"output": ["https://r.test/bg.png"]}],
                     pictures=["image"], files=rgb)
    assert [c["endpoint"] for c in bria["calls"]] == ["851-labs/background-remover", "bria/eraser"], bria["calls"]
    layer = {"model": "Ideogram Layerize", "prompt": "", "seed": 0}
    answer = [{"output": ["https://r.test/bg.png", "https://r.test/l.json"]}]
    gone = paid_case("layerize 404", nr.LayerizeGraphicNode, layer, answer, pictures=["image"], files=rgba,
                     links={"https://r.test/l.json": {"status": 404, "text": "gone"}})
    assert gone["gets"] == [{"url": "https://r.test/bg.png", "status": 200}, {"url": "https://r.test/l.json", "status": 404}], gone["gets"]
    try:
        paid_case("layerize unserved", nr.LayerizeGraphicNode, layer, answer, pictures=["image"], files=rgba)
    except UnservedGet:
        pass
    else:
        raise AssertionError("an unserved GET was not refused")
    music = paid_case("music", nr.GenerateMusicNode, {"model": "MusicGen", "prompt": "lofi", "duration": 8, "model_version": "stereo-large",
                                                      "temperature": 1.0, "top_p": 0.0, "seed": 3},
                      [{"__body__": '{"output": "https://r.test/m.wav"}'}], files={"https://r.test/m.wav": _b64(wav_bytes(0.1, 8000, 5))})
    assert '"temperature": 1.0' in music["calls"][0]["payload_json"], music["calls"][0]
    assert music["output"] == [{"audio": "https://r.test/m.wav"}], music["output"]
    print("self-check passed: split makes both calls (both engines), 404 served, unserved GET refused, wire text keeps 1.0")


def main(argv: list) -> None:
    if "--self-check" in argv:
        self_check()
        return
    if "--group" not in argv:
        raise SystemExit(f"usage: runner_paid_fixtures.py --group <{'|'.join(GROUPS)}>")
    group = argv[argv.index("--group") + 1]
    if group not in GROUPS:
        raise SystemExit(f"unknown group {group!r}; one of {', '.join(GROUPS)}")
    data = GROUPS[group]()
    path = os.path.join(FIXTURES, f"runner-paid-{group}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, sort_keys=True, ensure_ascii=True)
        f.write("\n")
    print(f"wrote {os.path.relpath(path, ROOT)}")


if __name__ == "__main__":
    main(sys.argv[1:])
