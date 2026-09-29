"""Writes frontend/tests/unit/fixtures/runner-media-<group>.json: what the REAL
Python video and sound readers (PyAV 17 inside ComfyUI) make of Sailor's
standard clips, for the runner's media module (frontend/server/media/, step 3,
stage R5) to be measured against. One file per group; writing one group leaves
the others untouched.

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_media_fixtures.py --group probe

The standard clips themselves are written by every group into
frontend/tests/unit/fixtures/media/, made here with PyAV from `synth` frames
(R2.1's, tests/unit/__runner__/effectsParity.ts) and tones from a fixed
formula. Encoders run with one thread and every muxer and encoder is bitexact,
so a second run writes the same bytes.

Groups:
  probe  — (R5.1b) for every clip: what PyAV reads from its header
           (container.duration, format name, each stream's rate, frames,
           duration, time base, size, pixel and sample formats, colour
           tags) and what VideoFromFile's own helpers answer
           (_get_raw_duration, get_frame_count, get_frame_rate,
           get_dimensions), or the error they raise.
  decode — (R5.1b) for every clip: VideoFromFile.get_components' frames
           (rgb24, sha256 per frame, base64 for clips up to 64 × 48) and
           sound (float32), nodes_audio.load, and
           nodes_replicate._download_url_to_audio_dict (run for real, with
           its download answered from the file, never the network).
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import math
import os
import platform
import socket
import sys
import zlib
from fractions import Fraction

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


if __name__ == "__main__":
    block_network()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
FIXTURES = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures")
CLIPS = os.path.join(FIXTURES, "media")

import av  # noqa: E402
import logging  # noqa: E402

# PyAV hands libav's own log lines to Python's logging. Reading the live Opus clip makes libopus
# say "Error parsing Opus packet header." (its end-of-stream packet) on every run: silenced here,
# as it is noise in a determinism check and changes no recorded value.
logging.getLogger("libav").setLevel(logging.CRITICAL)
import numpy as np  # noqa: E402
import torch  # noqa: E402

import utils.install_util  # noqa: E402,F401
import folder_paths  # noqa: E402,F401

# The largest sound kept whole in the JSON (bytes of float32); above it, a sha256 and the head.
SOUND_INLINE_BYTES = 64 * 1024
# The samples of each channel kept as a head when the sound is hashed (for reading a mismatch).
SOUND_HEAD = 256
# Pictures kept whole (base64) up to this size; above it, sha256 only.
FRAME_INLINE_PIXELS = 64 * 48


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ── synth: the same pictures in Python and TypeScript (R2.1) ─────────────────

def synth(w: int, h: int, channels: int, seed: int) -> bytes:
    s = (seed & 0xFFFFFFFF) or 0x9E3779B9

    def nxt() -> int:
        nonlocal s
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        return s

    out = bytearray()
    for y in range(h):
        for x in range(w):
            for k in range(channels):
                if k < 3:
                    out.append(((x * 37 + y * 11 + k * 71) & 255) ^ (nxt() & 31))
                else:
                    r = nxt()
                    out.append(0 if (x + y) % 5 == 0 else 255 if (x * y) % 3 == 0 else r & 255)
    return bytes(out)


def synth_frame(w: int, h: int, seed: int) -> av.VideoFrame:
    px = np.frombuffer(synth(w, h, 3, seed), dtype=np.uint8).reshape(h, w, 3)
    return av.VideoFrame.from_ndarray(px, format="rgb24")


# ── tones: a fixed formula ────────────────────────────────────────────────────

TONE_HZ = (440.0, 660.0, 550.0, 330.0)
TONE_AMP = (0.5, 0.3, 0.4, 0.2)


def tone(rate: int, seconds: float, channels: int) -> np.ndarray:
    """[C][N] float64: channel c is a sine at TONE_HZ[c] (amplitude TONE_AMP[c]) plus a
    quiet 3 kHz sine, so every channel differs and has some top end."""
    n = int(round(rate * seconds))
    t = np.arange(n, dtype=np.float64) / rate
    rows = [TONE_AMP[c] * np.sin(2 * np.pi * TONE_HZ[c] * t) + 0.02 * np.sin(2 * np.pi * 3000.0 * t) for c in range(channels)]
    return np.stack(rows)


def to_int(x: np.ndarray, bits: int) -> np.ndarray:
    scale = float(2 ** (bits - 1))
    return np.clip(np.round(x * scale), -scale, scale - 1).astype(np.int64)


# ── writing clips ─────────────────────────────────────────────────────────────

BITEXACT = {"fflags": "+bitexact"}


def open_out(name: str, fmt: str | None = None, live: bool = False):
    """live: a Matroska written as a browser's recorder writes it, with no length in its header."""
    path = os.path.join(CLIPS, name)
    return path, av.open(path, "w", format=fmt, options={**BITEXACT, **({"live": "1"} if live else {})})


def video_stream(c, codec: str, w: int, h: int, rate, pix_fmt: str, options: dict | None = None, time_base=None):
    s = c.add_stream(codec, rate=rate, options=dict(options or {}))
    s.width = w
    s.height = h
    s.pix_fmt = pix_fmt
    s.codec_context.thread_count = 1
    s.codec_context.flags |= av.codec.context.Flags.bitexact
    if time_base is not None:
        s.codec_context.time_base = time_base
    return s


def encode_frames(c, s, frames: list[av.VideoFrame]) -> None:
    for f in frames:
        for p in s.encode(f):
            c.mux(p)
    for p in s.encode(None):
        c.mux(p)


def sound_stream(c, codec: str, rate: int, layout: str, fmt: str, bit_rate: int | None = None, options: dict | None = None):
    s = c.add_stream(codec, rate=rate, options=dict(options or {}))
    s.layout = layout
    s.format = fmt
    if bit_rate:
        s.bit_rate = bit_rate
    s.codec_context.thread_count = 1
    s.codec_context.flags |= av.codec.context.Flags.bitexact
    return s


def sound_frames(x: np.ndarray, rate: int, layout: str, fmt: str, block: int) -> list[av.AudioFrame]:
    """x: [C][N] already in the sample format's own values (floats for flt/fltp, ints for s16/s32)."""
    planar = fmt.endswith("p")
    dtype = {"s16": np.int16, "s16p": np.int16, "s32": np.int32, "s32p": np.int32, "flt": np.float32, "fltp": np.float32}[fmt]
    out = []
    n = x.shape[1]
    for at in range(0, n, block):
        part = x[:, at:at + block].astype(dtype)
        arr = part if planar else np.ascontiguousarray(part.T).reshape(1, -1)
        f = av.AudioFrame.from_ndarray(arr, format=fmt, layout=layout)
        f.sample_rate = rate
        f.pts = at
        f.time_base = Fraction(1, rate)
        out.append(f)
    return out


def encode_sound(c, s, frames: list[av.AudioFrame]) -> None:
    for f in frames:
        for p in s.encode(f):
            c.mux(p)
    for p in s.encode(None):
        c.mux(p)


X264 = {"x264-params": "threads=1:lookahead-threads=1:sliced-threads=0"}


def clip_h264(name: str, colour: str) -> None:
    path, c = open_out(name)
    fmt = "yuvj420p" if colour == "full" else "yuv420p"
    s = video_stream(c, "libx264", 32, 24, 24, fmt, X264)
    if colour == "bt709":
        s.codec_context.colorspace = 1
        s.codec_context.color_primaries = 1
        s.codec_context.color_trc = 1
        s.codec_context.color_range = 1
    if colour == "full":
        s.codec_context.color_range = 2
    frames = []
    for i in range(8):
        f = synth_frame(32, 24, 100 + i).reformat(format=fmt)
        if colour == "bt709":
            f = synth_frame(32, 24, 100 + i).reformat(format=fmt, dst_colorspace="itu709")
        f.pts = i
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()


def clip_h264_chroma(name: str, fmt: str, full: bool = False) -> None:
    """H.264 with chroma that isn't 4:2:0 (libx264 tags its siting 'left'): 4:4:4 at 8 bits,
    full-range 4:4:4, 4:4:4 at 10 bits and 4:2:2 at 10 bits. PyAV's conversion ignores the
    siting on an axis that isn't subsampled (R5.1b review, Important 1)."""
    path, c = open_out(name)
    s = video_stream(c, "libx264", 32, 24, 24, fmt, X264)
    if full:
        s.codec_context.color_range = 2
    frames = []
    for i in range(8):
        f = synth_frame(32, 24, 1000 + i).reformat(format=fmt)
        f.pts = i
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()


def clip_hevc10() -> None:
    path, c = open_out("v_hevc10.mp4")
    s = video_stream(c, "libx265", 32, 24, 24, "yuv420p10le", {"x265-params": "pools=none:frame-threads=1:log-level=error"})
    frames = []
    for i in range(8):
        f = synth_frame(32, 24, 200 + i).reformat(format="yuv420p10le")
        f.pts = i
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()


def clip_vp9_odd() -> None:
    path, c = open_out("v_vp9_odd.webm")
    s = video_stream(c, "libvpx-vp9", 63, 47, 24, "yuv420p", {"cpu-used": "8", "deadline": "realtime", "row-mt": "0", "lag-in-frames": "0"})
    frames = []
    for i in range(8):
        f = synth_frame(63, 47, 300 + i).reformat(format="yuv420p")
        f.pts = i
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()


def clip_vp9_live() -> None:
    """No length anywhere in the header: Python's helpers fall back to counting packets."""
    path, c = open_out("v_vp9_live.webm", "webm", live=True)
    s = video_stream(c, "libvpx-vp9", 32, 24, 24, "yuv420p", {"cpu-used": "8", "deadline": "realtime", "row-mt": "0", "lag-in-frames": "0"})
    frames = []
    for i in range(8):
        f = synth_frame(32, 24, 800 + i).reformat(format="yuv420p")
        f.pts = i
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()


def clip_vp9_resize() -> None:
    """Not a standard clip: three 32 × 24 frames, then three 48 × 32 ones in the same
    stream (two encoders, one track). Python's get_components fails at torch.stack."""
    path, c = open_out("x_vp9_resize.webm", "webm")
    opts = {"cpu-used": "8", "deadline": "realtime", "row-mt": "0", "lag-in-frames": "0"}
    s = video_stream(c, "libvpx-vp9", 32, 24, 24, "yuv420p", opts)
    second = av.CodecContext.create("libvpx-vp9", "w")
    second.width, second.height, second.pix_fmt = 48, 32, "yuv420p"
    second.time_base = Fraction(1, 24)
    second.thread_count = 1
    second.flags |= av.codec.context.Flags.bitexact
    second.options = dict(opts)
    packets = []
    for i in range(3):
        f = synth_frame(32, 24, 900 + i).reformat(format="yuv420p")
        f.pts = i
        packets += s.encode(f)
    packets += s.encode(None)
    for i in range(3, 6):
        f = synth_frame(48, 32, 900 + i).reformat(format="yuv420p")
        f.pts = i
        f.time_base = Fraction(1, 24)
        packets += second.encode(f)
    packets += second.encode(None)
    for p in packets:
        p.stream = s
        c.mux(p)
    c.close()


def clip_prores() -> None:
    path, c = open_out("v_prores.mov")
    s = video_stream(c, "prores_ks", 32, 24, 24, "yuv422p10le", {"profile": "2"})
    frames = []
    for i in range(8):
        f = synth_frame(32, 24, 400 + i).reformat(format="yuv422p10le")
        f.pts = i
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()


def clip_editlist() -> None:
    """Leading frames stamped before zero: the mov muxer writes an edit list that starts at 0."""
    path, c = open_out("v_editlist.mp4")
    s = video_stream(c, "libx264", 32, 24, 24, "yuv420p", {**X264, "bf": "3"})
    frames = []
    for i in range(8):
        f = synth_frame(32, 24, 500 + i).reformat(format="yuv420p")
        f.pts = i - 2
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()


def clip_vfr() -> None:
    path, c = open_out("v_vfr.mp4")
    s = video_stream(c, "libx264", 32, 24, 25, "yuv420p", X264, time_base=Fraction(1, 1000))
    stamps = [0, 40, 70, 130, 160, 230, 250, 300]
    frames = []
    for i, t in enumerate(stamps):
        f = synth_frame(32, 24, 600 + i).reformat(format="yuv420p")
        f.pts = t
        f.time_base = Fraction(1, 1000)
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()


def clip_with_sound(name: str, sounds: list[tuple[str, int]], seconds: float = 1.0) -> None:
    """A 24 fps H.264 picture track and AAC sound tracks (layout, rate), interleaved by the muxer."""
    path, c = open_out(name)
    n = int(round(24 * seconds))
    s = video_stream(c, "libx264", 32, 24, 24, "yuv420p", X264)
    tracks = [sound_stream(c, "aac", rate, layout, "fltp", 64000) for layout, rate in sounds]
    packets = []
    for i in range(n):
        f = synth_frame(32, 24, 700 + i).reformat(format="yuv420p")
        f.pts = i
        packets += s.encode(f)
    packets += s.encode(None)
    for k, (t, (layout, rate)) in enumerate(zip(tracks, sounds)):
        chans = 1 if layout == "mono" else 2
        x = tone(rate, seconds, chans) * (1.0 - 0.3 * k)
        for f in sound_frames(x.astype(np.float32), rate, layout, "fltp", 1024):
            packets += t.encode(f)
        packets += t.encode(None)
    for p in packets:
        c.mux(p)
    c.close()


def clip_sound(name: str, codec: str, rate: int, layout: str, fmt: str, seconds: float, bits: int | None = None,
               bit_rate: int | None = None, container: str | None = None, options: dict | None = None,
               extreme: bool = False, live: bool = False) -> None:
    path, c = open_out(name, container, live)
    chans = 1 if layout == "mono" else 2
    s = sound_stream(c, codec, rate, layout, fmt, bit_rate, options)
    x = tone(rate, seconds, chans)
    if bits is not None:
        v = to_int(x, 16 if bits == 16 else 32 if bits in (24, 32) else bits)
        if bits == 24:
            v = (v >> 8) << 8
        if extreme:
            v[:, 10:20] = -32768
            v[:, 20:30] = 32767
        x = v
    block = 4608 if codec == "flac" else 1152 if codec == "libmp3lame" else 1024 if codec in ("aac", "libvorbis") else 960 if codec == "libopus" else 4096
    if codec == "libopus":
        block = 960
    encode_sound(c, s, sound_frames(x, rate, layout, fmt, block))
    c.close()


def make_clips() -> list[str]:
    os.makedirs(CLIPS, exist_ok=True)
    clip_h264("v_h264_601.mp4", "untagged")
    clip_h264("v_h264_709.mp4", "bt709")
    clip_h264("v_h264_full.mp4", "full")
    clip_h264_chroma("v_h264_444.mp4", "yuv444p")
    clip_h264_chroma("v_h264_444_full.mov", "yuvj444p", full=True)
    clip_h264_chroma("v_h264_444_10.mp4", "yuv444p10le")
    clip_h264_chroma("v_h264_422_10.mp4", "yuv422p10le")
    clip_hevc10()
    clip_vp9_odd()
    clip_vp9_live()
    clip_vp9_resize()
    clip_prores()
    clip_editlist()
    clip_vfr()
    clip_with_sound("v_stereo_aac.mp4", [("stereo", 44100)])
    clip_with_sound("v_two_sounds.mkv", [("mono", 22050), ("stereo", 48000)])
    clip_sound("a_mono.mp3", "libmp3lame", 44100, "mono", "s16p", 1.0, bit_rate=128000)
    clip_sound("a_s16.wav", "pcm_s16le", 44100, "stereo", "s16", 1.0, bits=16)
    clip_sound("a_s24.wav", "pcm_s24le", 44100, "stereo", "s32", 1.0, bits=24)
    clip_sound("a_s32.wav", "pcm_s32le", 44100, "stereo", "s32", 1.0, bits=32)
    clip_sound("a_16.flac", "flac", 44100, "stereo", "s16", 1.0, bits=16)
    clip_sound("a_24.flac", "flac", 44100, "stereo", "s32", 1.0, bits=24, options={"bits_per_raw_sample": "24"})
    clip_sound("a_vorbis.ogg", "libvorbis", 44100, "stereo", "fltp", 1.0, bit_rate=96000)
    clip_sound("a_opus.webm", "libopus", 48000, "stereo", "flt", 1.0, bit_rate=96000, container="webm", live=True)
    clip_sound("a_aac.m4a", "aac", 44100, "stereo", "fltp", 1.0, bit_rate=96000)
    clip_sound("a_long_8k.wav", "pcm_s16le", 8000, "mono", "s16", 75.0, bits=16)
    clip_sound("a_min.wav", "pcm_s16le", 44100, "mono", "s16", 0.25, bits=16, extreme=True)
    return sorted(os.listdir(CLIPS))


# ── reading ───────────────────────────────────────────────────────────────────

def rational(r) -> dict | None:
    if r is None:
        return None
    r = Fraction(r)
    return {"num": r.numerator, "den": r.denominator}


def err(e: Exception) -> str:
    """An error as recorded: its type and words, with the clips folder taken out of any path
    (the fixture must be the same in every checkout, and names no one's home folder)."""
    return f"{type(e).__name__}: {e}".replace(CLIPS + os.sep, "")


def attempt(fn):
    try:
        v = fn()
    except Exception as e:  # noqa: BLE001 - the error itself is the record
        return {"error": err(e)}
    if isinstance(v, Fraction):
        return {"value": rational(v)}
    if isinstance(v, tuple):
        return {"value": list(v)}
    return {"value": v}


def enum_name(v) -> str | None:
    if v is None:
        return None
    return getattr(v, "name", None) or str(v)


def header(path: str) -> dict:
    with av.open(path) as c:
        video = []
        sound = []
        for s in c.streams:
            if s.type == "video":
                cc = s.codec_context
                video.append({
                    "index": s.index, "w": s.width, "h": s.height, "codec": cc.name, "pixFmt": cc.pix_fmt,
                    "averageRate": rational(s.average_rate), "frames": s.frames,
                    "duration": s.duration, "timeBase": rational(s.time_base),
                    "colorRange": int(cc.color_range), "colorSpace": int(cc.colorspace),
                })
            elif s.type == "audio":
                cc = s.codec_context
                sound.append({
                    "index": s.index, "rate": cc.sample_rate, "channels": s.channels, "layout": cc.layout.name,
                    "codec": cc.name, "sampleFmt": cc.format.name if cc.format else None,
                    "duration": s.duration, "timeBase": rational(s.time_base),
                })
        return {"formatName": c.format.name, "containerDuration": c.duration, "video": video, "sound": sound,
                "bytes": os.path.getsize(path)}


def intended_frame_count(path: str):
    """get_frame_count's last branch (video_types.py:180-208) as it means to count: the same
    seek and demux, minus the empty flush packet at the end, whose pts (None) makes Python's own
    loop raise TypeError. Recorded beside Python's answer for the runner's named difference."""
    with av.open(path) as c:
        if not c.streams.video:
            return None
        vs = c.streams.video[0]
        c.seek(0, stream=vs)
        packets = [p for p in c.demux(vs) if p.size or p.pts is not None]
        first = next((i for i, p in enumerate(packets) if p.pts is not None and p.pts >= 0), None)
        return None if first is None else len(packets) - first


def group_probe(names: list[str]) -> dict:
    from comfy_api.latest._input_impl.video_types import VideoFromFile
    cases = []
    for name in names:
        path = os.path.join(CLIPS, name)
        v = VideoFromFile(path)
        cases.append({
            "clip": name,
            "header": header(path),
            "rawDuration": attempt(v._get_raw_duration),
            "frameCount": attempt(v.get_frame_count),
            "frameRate": attempt(v.get_frame_rate),
            "dimensions": attempt(v.get_dimensions),
            "frameCountIntended": intended_frame_count(path),
        })
    return {"cases": cases}


# Sounds kept whole (zlib, base64) however large: the named not-exact cases, so their bound is
# checked on every sample (R5.1b review, Minor 5). Opus decodes a few floats a last bit apart.
SOUND_KEPT_WHOLE = {"a_opus.webm"}


def sound_record(x: np.ndarray, rate: int, whole: bool = False) -> dict:
    """x: [C][N] float32 (a 'download' of a packed file is one interleaved row, as Python leaves it)."""
    x = np.ascontiguousarray(x, dtype=np.float32)
    rows = x.shape[0]
    raw = x.tobytes()
    rec = {"rate": rate, "rows": rows, "samples": int(x.shape[1]), "sha256": sha(raw)}
    if whole:
        rec["f32z"] = b64(zlib.compress(raw, 9))
    elif len(raw) <= SOUND_INLINE_BYTES:
        rec["f32"] = b64(raw)
    else:
        rec["head"] = b64(np.ascontiguousarray(x[:, :SOUND_HEAD]).tobytes())
    return rec


class FakeResponse:
    def __init__(self, raw: bytes):
        self.status = 200
        self._raw = raw

    async def read(self) -> bytes:
        return self._raw

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class FakeSession:
    """nodes_replicate's aiohttp.ClientSession, answering the one GET from a local file."""
    raw = b""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def get(self, _url):
        return FakeResponse(FakeSession.raw)


def run_download(path: str) -> dict:
    import comfy_api_nodes.nodes_replicate as nr
    with open(path, "rb") as f:
        FakeSession.raw = f.read()
    real = nr.aiohttp.ClientSession
    nr.aiohttp.ClientSession = FakeSession
    try:
        d = asyncio.run(nr._download_url_to_audio_dict("https://example.invalid/sound"))
    finally:
        nr.aiohttp.ClientSession = real
    w = d["waveform"]
    assert w.dtype == torch.float32
    return sound_record(w[0].numpy(), int(d["sample_rate"]))


def group_decode(names: list[str]) -> dict:
    from comfy_api.latest._input_impl.video_types import VideoFromFile
    from comfy_extras.nodes_audio import load
    cases = []
    for name in names:
        path = os.path.join(CLIPS, name)
        case: dict = {"clip": name}
        try:
            comp = VideoFromFile(path).get_components()
            imgs = comp.images
            frames = []
            if imgs.shape[0] and imgs.shape[-1] == 3:
                h, w = int(imgs.shape[1]), int(imgs.shape[2])
                for i in range(imgs.shape[0]):
                    b = (imgs[i] * 255.0).round().to(torch.uint8).numpy().tobytes()
                    rec = {"sha256": sha(b)}
                    if w * h <= FRAME_INLINE_PIXELS:
                        rec["rgb"] = b64(b)
                    frames.append(rec)
                case["frames"] = {"w": w, "h": h, "list": frames}
            else:
                case["frames"] = {"w": 0, "h": 0, "list": []}
            case["frameRate"] = rational(comp.frame_rate)
            if comp.audio is not None:
                wav = comp.audio["waveform"]
                assert wav.dtype == torch.float32, wav.dtype
                case["components"] = sound_record(wav[0].numpy(), int(comp.audio["sample_rate"]))
            else:
                case["components"] = None
        except Exception as e:  # noqa: BLE001
            case["frames"] = {"error": err(e)}
        try:
            wav, sr = load(path)
            case["load"] = {**sound_record(wav.numpy(), int(sr), name in SOUND_KEPT_WHOLE), "dtype": str(wav.dtype)}
        except Exception as e:  # noqa: BLE001
            case["load"] = {"error": err(e)}
        try:
            case["download"] = run_download(path)
        except Exception as e:  # noqa: BLE001
            case["download"] = {"error": err(e)}
        cases.append(case)
    return {"cases": cases}


GROUPS = {"probe": group_probe, "decode": group_decode}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", required=True, choices=sorted(GROUPS))
    args = ap.parse_args()
    names = make_clips()
    body = GROUPS[args.group](names)
    out = {
        "note": f"Written by scripts/runner_media_fixtures.py --group {args.group}. Do not edit.",
        "av": av.__version__,
        "libraries": {k: list(v) for k, v in sorted(av.library_versions.items())},
        "platform": f"{platform.system()}-{platform.machine()}",
        "clips": {n: sha(open(os.path.join(CLIPS, n), "rb").read()) for n in names},
        **body,
    }
    path = os.path.join(FIXTURES, f"runner-media-{args.group}.json")
    with open(path, "w", encoding="ascii") as f:
        json.dump(out, f, indent=1, sort_keys=True, ensure_ascii=True)
        f.write("\n")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
