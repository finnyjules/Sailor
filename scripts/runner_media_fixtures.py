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
  encode — (R5.1c) what Python WRITES: VideoFromComponents.save_to of `smooth`
           frames at 24, 29.97 and 30 fps, without sound and with a mono or
           stereo one (libx264 as ComfyUI runs it, and the same call switched
           to libopenh264 at the matching OPENH264_FOR row); save_to switched
           to libopenh264 at every OPENH264_FOR row; AudioSaveHelper.save_audio
           for FLAC, MP3 (V0, 128k, 320k) and Opus (128k) from mono and
           stereo float input, with prompt and workflow tags;
           torchaudio.functional.resample at the rates Opus export meets;
           _turntable_stitch.stitch_clips of three small clips (one at another
           size), with libx264 and with libopenh264; and PyAV's own
           reformat('yuv420p') planes of three rgb24 pictures. The three
           stitch clips are written beside the standard clips as e_*.mp4 and
           are not standard clips (the probe and decode groups skip them).
           Every encoder runs with one thread.
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


def media_tool(name: str) -> str:
    """Sailor's own build (scripts/media-tools/build.sh), for the clips a real ffmpeg muxes."""
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}[platform.machine().lower()]
    path = os.path.join(ROOT, "frontend", ".media-tools", f"{sys.platform}-{arch}", "bin", name)
    if not os.path.isfile(path):
        raise SystemExit("The video tools aren't built on this machine: run scripts/media-tools/build.sh")
    return path


FFMPEG_FIXED = ["-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-filter_threads", "1"]
FFMPEG_EXACT = ["-fflags", "+bitexact", "-flags", "+bitexact", "-map_metadata", "-1"]


def clip_ffmpeg_muxed() -> None:
    """MP4s muxed by ffmpeg's own CLI, not PyAV (R5.1c review: every other clip is PyAV-muxed).
    ffmpeg interleaves by decode time, so its packet order differs from PyAV's save_to:
      - v_ffmux_copy.mp4: v_stereo_aac.mp4's packets copied as they are (H.264 with B-frames, so
        the video's first decode time is below 0, and AAC);
      - v_ffmux_nob.mp4: H.264 without B-frames (OpenH264) and AAC, both encoded by the CLI: the
        video starts at decode time 0 and the AAC priming packet (pts -1024) comes first. Python's
        get_components seeks the video to 0 before reading the sound, so that packet is where a
        reader can differ."""
    import subprocess
    ff = media_tool("ffmpeg")
    subprocess.run([ff, *FFMPEG_FIXED, "-y", "-i", os.path.join(CLIPS, "v_stereo_aac.mp4"), "-map", "0", "-c", "copy",
                    *FFMPEG_EXACT, "-f", "mp4", os.path.join(CLIPS, "v_ffmux_copy.mp4")], check=True)
    frames = b"".join(synth(32, 24, 3, 1100 + i) for i in range(24))
    raw = os.path.join(CLIPS, ".v_ffmux_nob.f32")
    with open(raw, "wb") as f:
        f.write(np.ascontiguousarray(tone(44100, 1.0, 2).astype(np.float32).T).tobytes())
    try:
        subprocess.run([ff, *FFMPEG_FIXED, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "32x24", "-framerate", "24", "-i", "pipe:0",
                        "-f", "f32le", "-ar", "44100", "-ch_layout", "stereo", "-i", raw,
                        "-map", "0:v", "-map", "1:a", "-c:v", "libopenh264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96000",
                        *FFMPEG_EXACT, "-f", "mp4", os.path.join(CLIPS, "v_ffmux_nob.mp4")], input=frames, check=True)
    finally:
        os.remove(raw)


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
    clip_ffmpeg_muxed()
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
    # e_*: the encode group's own inputs (Turntable's stitch), not standard clips.
    return sorted(n for n in os.listdir(CLIPS) if not n.startswith("e_"))


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


# ── encode (R5.1c) ────────────────────────────────────────────────────────────

# OpenH264 settings for each libx264 CRF, measured (ruling d): the TypeScript
# table frontend/server/media/h264Quality.ts must list the same rows, and the
# encode spec checks that it does. Every row runs with h264Args' fixed part.
OPENH264_QP = {10: 12, 11: 12, 12: 12, 13: 12, 14: 12, 15: 12, 16: 13, 17: 16, 18: 17, 19: 20, 20: 21,
               21: 22, 22: 23, 23: 24, 24: 25, 25: 25, 26: 26, 27: 28, 28: 28, 29: 29, 30: 30, 31: 31, 32: 32}


def openh264_options(crf: int) -> dict:
    """h264Args' OpenH264 options for a CRF, as PyAV codec options (the ffmpeg CLI's
    `-coder cabac -rc_mode quality -qmin Q -qmax Q`)."""
    q = str(OPENH264_QP[crf])
    return {"coder": "cabac", "rc_mode": "quality", "qmin": q, "qmax": q}


def smooth_frame(w: int, h: int, i: int) -> bytes:
    """A picture an H.264 encoder can keep close (integer-only, so TypeScript makes the same
    bytes): two wrapping ramps and a disc that moves with i."""
    y, x = np.mgrid[0:h, 0:w]
    r = (x * 7 + y * 3 + i * 4) % 256
    g = (y * 9 + i * 2) % 256
    cx = w // 2 + (i * 3) % 16 - 8
    cy = h // 2
    b = np.where((x - cx) ** 2 + (y - cy) ** 2 < (h // 3) ** 2, 220, 40 + y)
    return np.stack([r, g, b], -1).astype(np.uint8).tobytes()


class _StreamProxy:
    """A stream whose `options` keep the swapped encoder's own: stitch_clips sets
    `out_stream.options = {preset, crf}` after add_stream, which would otherwise drop them
    (libopenh264 has neither option)."""

    def __init__(self, real, keep: dict):
        object.__setattr__(self, "_real", real)
        object.__setattr__(self, "_keep", keep)

    def __getattr__(self, k):
        return getattr(self._real, k)

    def __setattr__(self, k, v):
        if k == "options":
            v = {**self._keep}
        setattr(self._real, k, v)


class _Proxy:
    """Stands in for a PyAV output container: every call goes to the real one, except
    add_stream, which may change the codec and its options (a Python run switched to
    libopenh264), and sets one thread on every encoder (rule 4)."""

    def __init__(self, real, swap):
        self._real = real
        self._swap = swap
        self.streams_made = []

    def __getattr__(self, k):
        return getattr(self._real, k)

    def __enter__(self):
        self._real.__enter__()
        return self

    def __exit__(self, *a):
        return self._real.__exit__(*a)

    def add_stream(self, codec, rate=None, options=None, **kw):
        opts = dict(options or {})
        if codec == "h264" and self._swap is not None:
            codec = "libopenh264"
            opts.update(self._swap)
        s = self._real.add_stream(codec, rate=rate, options=opts, **kw)
        s.codec_context.thread_count = 1
        self.streams_made.append(s)
        return _StreamProxy(s, opts) if codec == "libopenh264" else s


class _AvShim:
    """A module that is `av` except for `open`, which hands back a _Proxy."""

    def __init__(self, swap=None):
        self._swap = swap
        self.last = None

    def __getattr__(self, k):
        return getattr(av, k)

    def open(self, *a, **kw):
        c = av.open(*a, **kw)
        if kw.get("mode", a[1] if len(a) > 1 else "r") != "w":
            return c
        self.last = _Proxy(c, self._swap)
        return self.last


def _patched(module, shim):
    class Ctx:
        def __enter__(self):
            self.real = module.av
            module.av = shim
            return shim

        def __exit__(self, *a):
            module.av = self.real
            return False
    return Ctx()


def rgb_frames_of(path: str) -> list[bytes]:
    from comfy_api.latest._input_impl.video_types import VideoFromFile
    imgs = VideoFromFile(path).get_components().images
    return [(imgs[i] * 255.0).round().to(torch.uint8).numpy().tobytes() for i in range(imgs.shape[0])]


def video_record(path: str, source: list[bytes] | None, keep_frames: bool) -> dict:
    """What a saved H.264 file is: its header, VideoFromFile's numbers, its decoded frames
    (sha256 each; zlib'd whole when kept), the PSNR against the source, and its sound."""
    from comfy_api.latest._input_impl.video_types import VideoFromFile
    v = VideoFromFile(path)
    frames = rgb_frames_of(path)
    rec = {
        "header": header(path),
        "frameCount": v.get_frame_count(),
        "frameRate": rational(v.get_frame_rate()),
        "duration": v._get_raw_duration(),
        "frames": [sha(b) for b in frames],
    }
    if keep_frames:
        rec["rgbz"] = b64(zlib.compress(b"".join(frames), 9))
    if source is not None:
        a = np.frombuffer(b"".join(source), np.uint8).astype(np.float64)
        b = np.frombuffer(b"".join(frames), np.uint8).astype(np.float64)
        mse = float(((a - b) ** 2).mean())
        rec["psnr"] = 10 * math.log10(255 * 255 / mse) if mse else None
    comp = v.get_components()
    rec["sound"] = sound_record(comp.audio["waveform"][0].numpy(), int(comp.audio["sample_rate"]), True) if comp.audio is not None else None
    return rec


def tone_f32(rate: int, seconds: float, channels: int) -> np.ndarray:
    return tone(rate, seconds, channels).astype(np.float32)


def save_to_case(tmp: str, name: str, fps: float, n: int, sound, swap, W: int = 64, H: int = 48, content: str = "smooth") -> dict:
    from comfy_api.latest._input_impl import video_types
    from comfy_api.latest._input_impl.video_types import VideoFromComponents
    from comfy_api.latest._util import VideoComponents
    src = [smooth_frame(W, H, i) if content == "smooth" else synth(W, H, 3, 4000 + i) for i in range(n)]
    images = torch.from_numpy(np.frombuffer(b"".join(src), np.uint8).reshape(n, H, W, 3).astype(np.float32) / 255.0)
    audio = None
    if sound is not None:
        audio = {"waveform": torch.from_numpy(sound[0])[None], "sample_rate": sound[1]}
    comp = VideoComponents(images=images, audio=audio, frame_rate=Fraction(fps))
    path = os.path.join(tmp, name + ".mp4")
    shim = _AvShim(swap)
    with _patched(video_types, shim):
        VideoFromComponents(comp).save_to(path, metadata={"prompt": {"1": {"class_type": "SaveVideo"}}, "workflow": {"nodes": [], "note": "a=b;c#d\\e\nf"}})
    rec = video_record(path, src, swap is None)
    with av.open(path) as c:
        rec["tags"] = dict(c.metadata)
    return rec


class _Hidden:
    prompt = {"3": {"class_type": "SaveAudio", "inputs": {"filename_prefix": "audio/x"}}}
    extra_pnginfo = {"workflow": {"nodes": [{"id": 3, "type": "SaveAudio"}], "note": "a=b;c#d\\e\nf \u00e9"}}


class _Cls:
    hidden = _Hidden()


def save_audio_case(tmp: str, fmt: str, quality: str, channels: int, rate: int) -> dict:
    from comfy_api.latest import _ui
    from comfy_api.latest._io import FolderType
    from comfy_extras.nodes_audio import load
    x = tone_f32(rate, 0.1, channels)
    out = os.path.join(tmp, f"{fmt}_{quality}_{channels}")
    os.makedirs(out, exist_ok=True)
    folder_paths.set_output_directory(out)
    shim = _AvShim()
    with _patched(_ui, shim):
        res = _ui.AudioSaveHelper.save_audio({"waveform": torch.from_numpy(x)[None], "sample_rate": rate}, "a", FolderType.output, _Cls, fmt, quality)
    path = os.path.join(out, res[0]["filename"])
    s = shim.last.streams_made[0]
    wav, sr = load(path)
    with av.open(path) as c:
        tags = dict(c.metadata)
        for st in c.streams:
            tags.update({f"stream:{k}": v for k, v in st.metadata.items()})
    return {
        "format": fmt, "quality": quality, "channels": channels, "rate": rate,
        "input": b64(zlib.compress(np.ascontiguousarray(x).tobytes(), 9)),
        "encoderSampleFmt": s.codec_context.format.name, "encoderRate": s.codec_context.sample_rate,
        "filename": res[0]["filename"],
        "decoded": sound_record(wav.numpy(), int(sr), True),
        "tags": tags,
    }


RESAMPLE_PAIRS = [(44100, 48000), (22050, 24000), (32000, 48000), (96000, 48000), (11025, 12000), (8000, 12000), (44100, 16000)]


# The lengths each pair is also resampled at, mono (R5.1c review, Minor 7): tiny, odd, around one
# ratio block (147/148 at 44.1 → 48 kHz), and longer.
RESAMPLE_LENGTHS = [1, 2, 3, 5, 7, 146, 147, 148, 1001, 4801]


def resample_case(orig: int, new: int) -> dict:
    import torchaudio
    x = torch.from_numpy(tone_f32(orig, 0.05, 2))
    y = torchaudio.functional.resample(x, orig, new)
    assert y.dtype == torch.float32
    lengths = []
    mono = np.ascontiguousarray(tone_f32(orig, 1.0, 3)[2, :max(RESAMPLE_LENGTHS)])
    for n in RESAMPLE_LENGTHS:
        xm = torch.from_numpy(np.ascontiguousarray(mono[:n]))
        ym = torchaudio.functional.resample(xm, orig, new)
        lengths.append({"length": n, "samples": int(ym.shape[-1]), "output": b64(zlib.compress(ym.numpy().tobytes(), 9))})
    return {"orig": orig, "new": new,
            "input": b64(zlib.compress(x.numpy().tobytes(), 9)),
            "output": b64(zlib.compress(np.ascontiguousarray(y.numpy()).tobytes(), 9)), "samples": int(y.shape[-1]),
            "lengths": lengths, "lengthInput": b64(zlib.compress(mono.tobytes(), 9))}


def stitch_inputs() -> list[str]:
    """Three H.264 clips at 24 fps: 32 × 24, 32 × 24, then 48 × 32 (the size differs)."""
    names = []
    for k, (w, h) in enumerate([(32, 24), (32, 24), (48, 32)]):
        name = f"e_stitch_{k}.mp4"
        path, c = open_out(name)
        s = video_stream(c, "libx264", w, h, 24, "yuv420p", X264)
        frames = []
        for i in range(5):
            f = av.VideoFrame.from_ndarray(np.frombuffer(smooth_frame(w, h, 10 * k + i), np.uint8).reshape(h, w, 3), format="rgb24").reformat(format="yuv420p")
            f.pts = i
            frames.append(f)
        encode_frames(c, s, frames)
        c.close()
        names.append(name)
    return names


def stitch_case(tmp: str, names: list[str], swap) -> dict:
    from comfy_extras import _turntable_stitch as ts
    shim = _AvShim(swap)
    with _patched(ts, shim):
        buf = ts.stitch_clips([os.path.join(CLIPS, n) for n in names])
    path = os.path.join(tmp, "stitch_%s.mp4" % ("x264" if swap is None else "openh264"))
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return video_record(path, None, swap is None)


def plane_bytes(p, w: int, h: int) -> bytes:
    raw = bytes(p)
    return b"".join(raw[r * p.line_size: r * p.line_size + w] for r in range(h))


def reformat_case(name: str, w: int, h: int, rgb: bytes) -> dict:
    f = av.VideoFrame.from_ndarray(np.frombuffer(rgb, np.uint8).reshape(h, w, 3), format="rgb24").reformat(format="yuv420p")
    cw, ch = (w + 1) // 2, (h + 1) // 2
    planes = plane_bytes(f.planes[0], w, h) + plane_bytes(f.planes[1], cw, ch) + plane_bytes(f.planes[2], cw, ch)
    return {"name": name, "w": w, "h": h, "yuv": b64(planes), "sha256": sha(planes)}


def group_encode(names: list[str]) -> dict:
    import tempfile
    stitch_names = stitch_inputs()
    cases: dict = {"openh264Qp": {str(k): v for k, v in OPENH264_QP.items()}}
    with tempfile.TemporaryDirectory() as tmp:
        mono = (tone_f32(44100, 0.3, 1), 44100)
        stereo = (tone_f32(48000, 0.3, 2), 48000)
        videos = []
        stereo44 = (tone_f32(44100, 0.5, 2), 44100)
        mono22 = (tone_f32(22050, 0.4, 1), 22050)
        for name, fps, n, snd, W, H, content in [
            ("v24", 24.0, 8, None, 64, 48, "smooth"), ("v2997_mono", 29.97, 8, mono, 64, 48, "smooth"),
            ("v30_stereo", 30.0, 8, stereo, 64, 48, "smooth"),
            # R5.1c review: 23.976 and 59.94 fps at other sizes, and noise (synth) pictures.
            ("v23976_stereo", 23.976, 10, stereo44, 128, 72, "smooth"), ("v5994", 59.94, 5, None, 96, 64, "smooth"),
            ("v25_noise_mono", 25.0, 7, mono22, 80, 60, "synth"),
        ]:
            videos.append({
                "name": name, "fps": fps, "frames": n, "w": W, "h": H, "content": content,
                "sound": None if snd is None else {"rate": snd[1], "channels": int(snd[0].shape[0]),
                                                   "f32z": b64(zlib.compress(np.ascontiguousarray(snd[0]).tobytes(), 9))},
                "x264": save_to_case(tmp, name + "_x264", fps, n, snd, None, W, H, content),
                "openh264": save_to_case(tmp, name + "_oh", fps, n, snd, openh264_options(23), W, H, content),
            })
        cases["saveTo"] = videos
        rows = []
        for crf in sorted(OPENH264_QP):
            rec = save_to_case(tmp, f"row{crf}", 24.0, 6, None, openh264_options(crf))
            rows.append({"crf": crf, "frames": rec["frames"], "frameCount": rec["frameCount"]})
        cases["rows"] = rows
        audio = []
        for fmt, qualities in [("flac", ["128k"]), ("mp3", ["V0", "128k", "320k"]), ("opus", ["128k"])]:
            for q in qualities:
                for chans in (1, 2):
                    audio.append(save_audio_case(tmp, fmt, q, chans, 44100))
        cases["saveAudio"] = audio
        cases["resample"] = [resample_case(a, b) for a, b in RESAMPLE_PAIRS]
        cases["stitch"] = {
            "clips": stitch_names,
            "x264": stitch_case(tmp, stitch_names, None),
            "openh264": stitch_case(tmp, stitch_names, openh264_options(20)),
        }
        cases["reformat"] = [
            reformat_case("synth 64×48", 64, 48, synth(64, 48, 3, 1)),
            reformat_case("smooth 64×48", 64, 48, smooth_frame(64, 48, 3)),
            reformat_case("synth 33×25", 33, 25, synth(33, 25, 3, 2)),
        ]
    return {"cases": cases, "encodeClips": {n: sha(open(os.path.join(CLIPS, n), "rb").read()) for n in stitch_names}}


GROUPS = {"probe": group_probe, "decode": group_decode, "encode": group_encode}


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
