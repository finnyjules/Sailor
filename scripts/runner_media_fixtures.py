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
  sound  — (R5.3) the sound nodes' own execute: LoadAudio, RecordAudio,
           the Audio card (a file, a wired source that wins over the file,
           nothing: 1 s of silence), PreviewAudio, SaveAudio and SaveAudioMP3
           over every sound clip (and the video with stereo AAC), each in a
           fresh output and temp folder; the card's export in every format and
           quality; SaveAudio of a two-item batch with and without
           `%batch_num%`, and twice for the counter; Opus export's resample
           (torchaudio's samples as save_audio makes them) from 44.1, 22.05,
           96 and 8 kHz; and a Generate music answer (WAV mono and stereo,
           _download_url_to_audio_dict) shown by the card. Each case records
           the ui, the saved names and subfolders, the file's decoded samples
           (nodes_audio.load) and its tags. The temp names' five letters are
           drawn from a seeded `random`.
  video  — (R5.4) the video nodes' own execute (comfy_extras/nodes_video.py):
           LoadVideo → GetVideoComponents over every standard clip (frames,
           sound, fps, or the error); CreateVideo → SaveVideo at 24, 29.97
           and 30 fps (from this group's smooth clip, g_video_smooth.mp4, and the
           named case from `synth` noise) with no sound, a mono and a stereo one, and with 3, 4
           and 6 channels; SaveVideo of an MP4, a WebM, a MOV, a file with an
           edit list and one with a subtitle stream (g_video_subs.mp4, this
           group's own clip), with `format` and `codec` each auto and set; the
           Video card with a source, a file, nothing, a source and a file, and
           with export on for a file and for a made video. Each case records
           the ui, the files written, and each saved file's header, Python's
           own numbers, decoded frames and sound, and tags; every H.264 case
           also with PyAV switched to libopenh264 (rule 3).
  frames — (R5.5) LoadVideoFrames over every standard clip (the frame
           choice: stride, start, max_seconds) and over this group's own
           clips g_frames_big.mp4 (160 × 90) and g_frames_odd.mkv (128 × 73,
           FFV1) at every max_size, where Pillow's resize(BILINEAR) runs;
           Pillow's resize(BILINEAR) of `synth` pictures; SaveVideoFrames of
           an even and an odd batch at 24 and 29.97 fps and CRF 10, 20 and
           32, and with each sound clip, a broken one (g_frames_broken.wav)
           and a missing one, its name made at a fixed second (time.strftime
           patched), with libx264 and switched to libopenh264.
  timeline-media — (R5.6) the Timeline's own readers in
           comfy_extras/nodes_timeline.py, the real functions lifted out with
           `ast` (as Phase A's parity oracle does): _probe_media over every
           standard clip, this group's clips g_thumbs_gop.mp4 / .mkv (160 × 90
           H.264, a keyframe every 6 frames, two B-frames) and two files no
           reader opens (g_timeline_junk.mp4 / .wav); _gen_thumbnails at 1, 5
           and 20 (each PNG's decoded pixels, and which frame the loop took:
           its target pts, the frame's pts, whether the file ran out first);
           _gen_waveform_peaks at 16, 256 and 2048 buckets (the route's cache
           JSON text, zlib + base64).
  vfx-time — (R6.1) the video effects' shared cases (R6 rule 13): the standard
           frame inputs (`synth` frames handed over as Get video components
           hands them, u8 / 255: clip8, clip8-odd, clip2, clip1, clip8-big,
           clip6-small), the real node's execute with its hidden unique_id,
           the live preview it wrote, and its output as float32 (base64 for
           the small ones), round-8 and trunc-8 (sha256); each class through
           Create video → Save video, libx264 and switched to libopenh264; and
           rule 12's synthetic graphs, one per R6 class. R6.1's pilots: Trim,
           Reverse / ping-pong and Frame trail.
  vfx-join — (R6.3) Crossfade and Transition over pairs of standard clips.
  vfx-look — (R6.4) Ken Burns, Aspect convert, Chroma key, LUT and 3-way
           color; this group's own inputs (clip8 turned upright, a green
           screen) and three .cube files (identity 2³, a warm grade 17³, a
           broken one) recorded whole.
  vfx-stabilize — (R6.5) Stabilize over the standard inputs and two shaking
           patterns (a `synth` frame cut at a seeded path of whole pixels:
           12 frames of 96 × 64, and of 600 × 338 so that pass 1 works at
           half size), with Python's shifts and each frame's two highest
           correlation values; and the shared FFT: numpy's fft and rfft of
           lengths 1–64, 256, 1000, 1024 and 4096 and fft2 of 9 × 16 and
           144 × 256 (float64), numpy's float32 rfft and torch's complex64
           fft2 of a few, all over a fixed exact formula.
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
    # e_*: the encode group's own inputs (Turntable's stitch), and g_*: the video group's (R5.4), not standard clips.
    return sorted(n for n in os.listdir(CLIPS) if not n.startswith(("e_", "g_")))


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


# ── sound (R5.3) ──────────────────────────────────────────────────────────────

# The sound nodes' hidden inputs as ComfyUI hands them over (the same as the encode group's save_audio).
SOUND_HIDDEN = {"PROMPT": _Hidden.prompt, "EXTRA_PNGINFO": _Hidden.extra_pnginfo}
# Clips whose saved sounds are kept whole (their decode is a named not-exact case, R5.1b).
SOUND_SAVED_WHOLE = {"a_opus.webm"}


def node_clone(cls):
    """The node class as the executor runs it: a clone with its hidden inputs set."""
    return cls.PREPARE_CLASS_CLONE({"hidden_inputs": SOUND_HIDDEN})


def ui_of(out) -> dict | None:
    ui = out.ui
    if ui is None:
        return None
    d = ui.as_dict() if hasattr(ui, "as_dict") else ui
    return {k: [dict(x) for x in v] for k, v in d.items()}


def saved_sound(folder: str, entry: dict, whole: bool = False) -> dict:
    """A saved sound as Python's own reader (nodes_audio.load) reads it back, with its tags and stream."""
    from comfy_extras.nodes_audio import load
    path = os.path.join(folder, entry["subfolder"], entry["filename"])
    wav, sr = load(path)
    with av.open(path) as c:
        tags = dict(c.metadata)
        for st in c.streams:
            tags.update({f"stream:{k}": v for k, v in st.metadata.items()})
        a = c.streams.audio[0]
        stream = {"codec": a.codec_context.name, "rate": int(a.codec_context.sample_rate), "channels": int(a.channels),
                  "bitRate": int(a.codec_context.bit_rate or 0)}
    return {"decoded": sound_digest(wav.numpy(), int(sr), whole), "tags": tags, "stream": stream}


def sound_digest(x: np.ndarray, rate: int, whole: bool = False) -> dict:
    """sound_record without the small sounds inline: a sha256 and the head, or (whole) every sample zlib'd."""
    rec = sound_record(x, rate, whole)
    if "f32" in rec:
        del rec["f32"]
        rec["head"] = b64(np.ascontiguousarray(np.ascontiguousarray(x, dtype=np.float32)[:, :SOUND_HEAD]).tobytes())
    return rec


def fresh_dirs(tmp: str, label: str) -> tuple[str, str]:
    out, temp = os.path.join(tmp, label, "output"), os.path.join(tmp, label, "temp")
    os.makedirs(out)
    os.makedirs(temp)
    folder_paths.set_output_directory(out)
    folder_paths.set_temp_directory(temp)
    return out, temp


def audio_value_record(v: dict, whole: bool = False) -> dict:
    w = v["waveform"]
    assert w.dtype == torch.float32 and w.shape[0] == 1, (w.dtype, w.shape)
    return sound_digest(w[0].numpy(), int(v["sample_rate"]), whole)


def files_written(folder: str) -> list[str]:
    return sorted(os.path.relpath(os.path.join(d, f), folder) for d, _, fs in os.walk(folder) for f in fs)


def group_sound(names: list[str]) -> dict:
    import random
    import tempfile
    import torchaudio
    from comfy_api.latest import _ui
    from comfy_extras import nodes_audio as na
    from comfy_extras.nodes_audio import load
    random.seed(20260929)
    folder_paths.set_input_directory(CLIPS)
    clips = [n for n in names if n.startswith("a_")] + ["v_stereo_aac.mp4"]
    LoadAudio, RecordAudio, Card = node_clone(na.LoadAudio), node_clone(na.RecordAudio), node_clone(na.Audio)
    Preview, Save, SaveMP3 = node_clone(na.PreviewAudio), node_clone(na.SaveAudio), node_clone(na.SaveAudioMP3)
    shim = _AvShim()
    cases: dict = {"prompt": _Hidden.prompt, "extraPnginfo": _Hidden.extra_pnginfo}
    with tempfile.TemporaryDirectory() as tmp, _patched(_ui, shim):
        # Each clip through every class, in a fresh output and temp folder, in this order:
        # the card (no export), PreviewAudio, SaveAudio, SaveAudioMP3 V0.
        per_clip = []
        for name in clips:
            out, temp = fresh_dirs(tmp, "clip_" + name)
            whole = name in SOUND_SAVED_WHOLE
            value = LoadAudio.execute(audio=name).result[0]
            rec_value = RecordAudio.execute(audio=name).result[0]
            assert torch.equal(value["waveform"], rec_value["waveform"]) and value["sample_rate"] == rec_value["sample_rate"]
            card = Card.execute(audio=name, export=False, filename_prefix="audio/ComfyUI", format="flac", quality="V0")
            assert torch.equal(card.result[0]["waveform"], value["waveform"])
            preview = Preview.execute(audio=value)
            save = Save.execute(audio=value, filename_prefix="audio/ComfyUI")
            mp3 = SaveMP3.execute(audio=value, filename_prefix="audio/ComfyUI", quality="V0")
            card_ui, preview_ui, save_ui, mp3_ui = ui_of(card), ui_of(preview), ui_of(save), ui_of(mp3)
            flac = saved_sound(temp, card_ui["audio"][0], whole)
            # One FLAC encoder, the same samples: the card's preview, PreviewAudio's and SaveAudio's decode alike.
            assert saved_sound(temp, preview_ui["audio"][0])["decoded"]["sha256"] == flac["decoded"]["sha256"]
            assert saved_sound(out, save_ui["audio"][0])["decoded"]["sha256"] == flac["decoded"]["sha256"]
            per_clip.append({
                "clip": name,
                "load": audio_value_record(value),
                "ui": {"card": card_ui, "preview": preview_ui, "save": save_ui, "mp3": mp3_ui},
                "flac": flac,
                "saveTags": saved_sound(out, save_ui["audio"][0])["tags"],
                "mp3": saved_sound(out, mp3_ui["audio"][0], whole),
                "written": {"output": files_written(out), "temp": files_written(temp)},
            })
        cases["clips"] = per_clip

        # The card: a wired source wins over the file; nothing at all is 1 s of silence (export or not).
        out, temp = fresh_dirs(tmp, "card_source")
        src = LoadAudio.execute(audio="a_s16.wav").result[0]
        wins = Card.execute(audio="a_mono.mp3", export=False, filename_prefix="audio/ComfyUI", format="flac", quality="V0", source=src)
        assert torch.equal(wins.result[0]["waveform"], src["waveform"])
        cases["cardSource"] = {"file": "a_mono.mp3", "source": "a_s16.wav", "value": audio_value_record(wins.result[0]),
                               "ui": ui_of(wins), "flac": saved_sound(temp, ui_of(wins)["audio"][0])}
        silence = []
        for export in (False, True):
            out, temp = fresh_dirs(tmp, f"card_silence_{export}")
            s = Card.execute(audio="", export=export, filename_prefix="audio/ComfyUI", format="mp3", quality="V0")
            silence.append({"export": export, "value": audio_value_record(s.result[0]), "ui": ui_of(s),
                            "written": {"output": files_written(out), "temp": files_written(temp)}})
        cases["cardSilence"] = silence

        # The card's export in every format and quality, in order into one output folder (the counter moves on).
        out, temp = fresh_dirs(tmp, "card_export")
        exports = []
        for fmt in ("flac", "mp3", "opus"):
            for q in ("V0", "128k", "192k", "320k"):
                try:
                    e = Card.execute(audio="a_min.wav", export=True, filename_prefix="audio/ComfyUI", format=fmt, quality=q)
                except Exception as x:  # noqa: BLE001
                    # PyAV refuses some settings (libopus with no bit rate): the node fails.
                    exports.append({"format": fmt, "quality": q, "error": err(x), "written": files_written(out)})
                    continue
                ui = ui_of(e)
                exports.append({"format": fmt, "quality": q, "ui": ui, "saved": saved_sound(out, ui["audio"][0], fmt == "opus")})
        cases["cardExport"] = {"clip": "a_min.wav", "cases": exports, "written": {"output": files_written(out), "temp": files_written(temp)}}

        # SaveAudio over a two-item batch: the clip, then the clip at half volume (exact in float32).
        one = load(os.path.join(CLIPS, "a_min.wav"))
        batch = {"waveform": torch.stack([one[0], one[0] * 0.5]), "sample_rate": one[1]}
        batches = []
        out, temp = fresh_dirs(tmp, "batch")
        for prefix in ("audio/b_%batch_num%", "audio/c", "audio/c"):
            b = Save.execute(audio=batch, filename_prefix=prefix)
            ui = ui_of(b)
            batches.append({"prefix": prefix, "ui": ui, "decoded": [saved_sound(out, e)["decoded"] for e in ui["audio"]]})
        cases["batch"] = {"clip": "a_min.wav", "scales": [1.0, 0.5], "runs": batches, "written": files_written(out)}

        # Opus export's resample, as save_audio makes it: torchaudio's own samples, captured.
        real = torchaudio.functional.resample
        seen: list = []

        def spy(w, orig, new, *a, **k):
            y = real(w, orig, new, *a, **k)
            seen.append((w.clone(), int(orig), int(new), y.clone()))
            return y
        resampled = []
        out, temp = fresh_dirs(tmp, "resample")
        _ui.torchaudio.functional.resample = spy
        try:
            for rate in (44100, 22050, 96000, 8000):
                seen.clear()
                x = tone_f32(rate, 0.05, 2)
                res = _ui.AudioSaveHelper.save_audio({"waveform": torch.from_numpy(x)[None], "sample_rate": rate}, f"r{rate}", _ui.FolderType.output, Save, "opus", "128k")
                s = shim.last.streams_made[0]
                rec = {"rate": rate, "input": b64(zlib.compress(np.ascontiguousarray(x).tobytes(), 9)),
                       "encoderRate": int(s.codec_context.sample_rate), "filename": res[0]["filename"],
                       "saved": saved_sound(out, dict(res[0]), True)}
                if seen:
                    (_w, o, n, y) = seen[0]
                    rec["resample"] = {"orig": o, "new": n, "samples": int(y.shape[-1]),
                                       "output": b64(zlib.compress(np.ascontiguousarray(y.numpy()).tobytes(), 9))}
                else:
                    rec["resample"] = None
                resampled.append(rec)
        finally:
            _ui.torchaudio.functional.resample = real
        cases["resample"] = resampled

        # A Generate music answer (WAV, mono and stereo) shown by the card: the value as it came in, and its FLAC.
        answers = []
        for name in ("a_min.wav", "a_s16.wav"):
            out, temp = fresh_dirs(tmp, "answer_" + name)
            import comfy_api_nodes.nodes_replicate as nr
            with open(os.path.join(CLIPS, name), "rb") as f:
                FakeSession.raw = f.read()
            orig = nr.aiohttp.ClientSession
            nr.aiohttp.ClientSession = FakeSession
            try:
                got = asyncio.run(nr._download_url_to_audio_dict("https://example.invalid/sound"))
            finally:
                nr.aiohttp.ClientSession = orig
            c = Card.execute(audio="", export=False, filename_prefix="audio/ComfyUI", format="flac", quality="V0", source=got)
            ui = ui_of(c)
            answers.append({"clip": name, "value": audio_value_record(c.result[0]), "ui": ui, "flac": saved_sound(temp, ui["audio"][0])})
        cases["answers"] = answers

        cases["validate"] = {"missing": na.LoadAudio.validate_inputs(audio="no_such_sound.wav"), "present": na.LoadAudio.validate_inputs(audio="a_min.wav")}
    return {"cases": cases}


# ── video (R5.4) ──────────────────────────────────────────────────────────────

# The video nodes' hidden inputs as ComfyUI hands them over (SaveVideo reads both; the card neither).
VIDEO_PROMPT = {"7": {"class_type": "SaveVideo", "inputs": {"filename_prefix": "video/ComfyUI", "format": "auto", "codec": "auto"}}}
VIDEO_EXTRA = {"workflow": {"nodes": [{"id": 7, "type": "SaveVideo"}], "note": "a=b;c#d\\e\nf é"}}
VIDEO_HIDDEN = {"PROMPT": VIDEO_PROMPT, "EXTRA_PNGINFO": VIDEO_EXTRA}

# mov_text's encoder opens only with an ASS header (it reads its style from it).
SUBTITLE_HEADER = (
    b"[Script Info]\nScriptType: v4.00+\nPlayResX: 384\nPlayResY: 288\n\n[V4+ Styles]\n"
    b"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, "
    b"StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
    b"Style: Default,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0\n\n"
    b"[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
)


def clip_video_subs() -> str:
    """This group's own clip (not a standard clip): 12 H.264 frames, stereo AAC and a mov_text
    subtitle stream of two cues, muxed by PyAV."""
    import struct
    name = "g_video_subs.mp4"
    path, c = open_out(name)
    s = video_stream(c, "libx264", 32, 24, 24, "yuv420p", X264)
    a = sound_stream(c, "aac", 44100, "stereo", "fltp", 64000)
    t = c.add_stream("mov_text")
    t.codec_context.subtitle_header = SUBTITLE_HEADER
    t.time_base = Fraction(1, 1000)
    packets = []
    for i in range(12):
        f = synth_frame(32, 24, 1200 + i).reformat(format="yuv420p")
        f.pts = i
        packets += s.encode(f)
    packets += s.encode(None)
    for f in sound_frames(tone(44100, 0.5, 2).astype(np.float32), 44100, "stereo", "fltp", 1024):
        packets += a.encode(f)
    packets += a.encode(None)
    for start, dur, text in [(0, 150, "Hello"), (160, 150, "World")]:
        body = text.encode("ascii")
        p = av.Packet(struct.pack(">H", len(body)) + body)
        p.stream = t
        p.pts = start
        p.dts = start
        p.duration = dur
        p.time_base = Fraction(1, 1000)
        packets.append(p)
    for p in packets:
        c.mux(p)
    c.close()
    return name


def clip_video_smooth() -> str:
    """This group's own clip (not a standard clip): 12 `smooth` frames at 64 × 48, H.264 at a high
    quality. The made videos are built from its frames: the kind of picture ruling (d)'s OpenH264
    table was measured on (the standard clips' `synth` noise is the named case, `madeNoise`)."""
    name = "g_video_smooth.mp4"
    path, c = open_out(name)
    s = video_stream(c, "libx264", 64, 48, 24, "yuv420p", {**X264, "crf": "10"})
    frames = []
    for i in range(12):
        f = av.VideoFrame.from_ndarray(np.frombuffer(smooth_frame(64, 48, i), np.uint8).reshape(48, 64, 3), format="rgb24").reformat(format="yuv420p")
        f.pts = i
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()
    return name


def clip_video_containers() -> list[str]:
    """This group's own clips (R5.4 fix round 1): the single-file containers a person can upload
    that Python's LoadVideo reads, beyond MP4, WebM/Matroska and AVI. 64 × 48, 8 frames at 24 fps,
    with sound: MPEG-TS (H.264 + AAC, a screen recording's), MPEG-PS (MPEG-1 video + MP2), FLV
    (Sorenson H.263 + MP3), ASF (WMV 8 + WMA 2), and QuickTime with no `ftyp` box (its first
    atom renamed `free`, as older cameras' files begin)."""
    made = []
    for name, fmt, vcodec, vfmt, acodec, afmt, vopts in [
        ("g_video_ts.ts", "mpegts", "libx264", "yuv420p", "aac", "fltp", X264),
        ("g_video_ps.mpg", "mpeg", "mpeg1video", "yuv420p", "mp2", "s16", {}),
        ("g_video_flv.flv", "flv", "flv", "yuv420p", "libmp3lame", "s16p", {}),
        ("g_video_asf.wmv", "asf", "wmv2", "yuv420p", "wmav2", "fltp", {}),
        ("g_video_noftyp.mov", "mov", "libx264", "yuv420p", "aac", "fltp", X264),
    ]:
        path, c = open_out(name, fmt)
        s = video_stream(c, vcodec, 64, 48, 24, vfmt, vopts)
        a = sound_stream(c, acodec, 44100, "stereo", afmt, 96000)
        packets = []
        for i in range(8):
            f = av.VideoFrame.from_ndarray(np.frombuffer(smooth_frame(64, 48, 40 + i), np.uint8).reshape(48, 64, 3), format="rgb24").reformat(format=vfmt)
            f.pts = i
            packets += s.encode(f)
        packets += s.encode(None)
        x = tone(44100, 8 / 24, 2)
        if afmt.startswith("s16"):
            x = to_int(x, 16)
        block = 1152 if acodec in ("mp2", "libmp3lame") else 2048 if acodec == "wmav2" else 1024
        for f in sound_frames(x, 44100, "stereo", afmt, block):
            packets += a.encode(f)
        packets += a.encode(None)
        for p in packets:
            c.mux(p)
        c.close()
        if name.endswith("noftyp.mov"):
            with open(path, "r+b") as fh:
                head = fh.read(8)
                assert head[4:8] == b"ftyp", head
                fh.seek(4)
                fh.write(b"free")
        made.append(name)
    return made


def clip_video_hvc1() -> str:
    """This group's own clip, NOT muxed by PyAV (R5.4 fix round 1): the standard HEVC clip copied by
    Sailor's ffmpeg as a phone writes it, `hvc1`-tagged, with its own stream tags (language
    `eng`, handler "Core Media Video"). Python's copy resets the codec tag and drops the stream tags."""
    import subprocess
    name = "g_video_hvc1.mp4"
    out = os.path.join(CLIPS, name)
    subprocess.run([media_tool("ffmpeg"), *FFMPEG_FIXED, "-y", "-i", os.path.join(CLIPS, "v_hevc10.mp4"), "-map", "0", "-c", "copy",
                    *FFMPEG_EXACT, "-tag:v", "hvc1", "-metadata:s:v:0", "language=eng", "-metadata:s:v:0", "handler_name=Core Media Video",
                    "-f", "mp4", out], check=True)
    return name


def video_ui_of(out) -> dict | None:
    """A video node's ui as ComfyUI sends it: PreviewVideo's {"images": [...], "animated": [true]}."""
    ui = out.ui
    if ui is None:
        return None
    d = ui.as_dict() if hasattr(ui, "as_dict") else ui
    return {k: ([dict(x) for x in v] if k == "images" else list(v)) for k, v in d.items()}


def images_record(imgs) -> dict:
    """An IMAGE batch as uint8 rgb24 frames (exact: every value came from 8 bits), sha256 each."""
    if not imgs.shape[0] or imgs.shape[-1] != 3:
        return {"w": 0, "h": 0, "list": []}
    h, w = int(imgs.shape[1]), int(imgs.shape[2])
    return {"w": w, "h": h, "list": [sha((imgs[i] * 255.0).round().to(torch.uint8).numpy().tobytes()) for i in range(imgs.shape[0])]}


def video_out(path: str, source: list[bytes] | None, keep_frames: bool, whole_sound: bool) -> dict:
    """A saved video as Python's own reader reads it back: video_record's numbers, frames and
    sound (the sound whole only where asked), every stream, and the tags."""
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
        mse = float(((a - b) ** 2).mean()) if a.size == b.size else None
        rec["psnr"] = (10 * math.log10(255 * 255 / mse) if mse else None) if mse is not None else None
    comp = v.get_components()
    rec["sound"] = sound_record(comp.audio["waveform"][0].numpy(), int(comp.audio["sample_rate"]), whole_sound) if comp.audio is not None else None
    with av.open(path) as c:
        rec["streams"] = [{"type": st.type, "codec": st.codec_context.name, "timeBase": rational(st.time_base),
                           "duration": st.duration, "frames": st.frames} for st in c.streams]
        tags = dict(c.metadata)
        for st in c.streams:
            tags.update({f"stream{st.index}:{k}": val for k, val in st.metadata.items()})
    rec["tags"] = tags
    return rec


def ui_file(out: str, temp: str, entry: dict) -> str:
    return os.path.join(out if entry["type"] == "output" else temp, entry["subfolder"], entry["filename"])


# SaveVideo's inputs: an MP4 with stereo AAC, VP9 in WebM at an odd size, ProRes in MOV, an edit list, subtitles,
# and (fix round 1) an hvc1-tagged HEVC with its own stream tags, not muxed by PyAV.
SAVE_VIDEO_CLIPS = ["v_stereo_aac.mp4", "v_vp9_odd.webm", "v_prores.mov", "v_editlist.mp4", "g_video_subs.mp4", "g_video_hvc1.mp4"]
# CreateVideo's frames: this clip's, through LoadVideo → GetVideoComponents; its sounds: LoadAudio's.
MADE_FRAMES_CLIP = "g_video_smooth.mp4"
# The named case: made from the standard clip's `synth` noise (32 × 24).
NOISE_FRAMES_CLIP = "v_h264_601.mp4"
MADE_SOUNDS = {"none": None, "mono": "a_min.wav", "stereo": "a_s16.wav"}


def channels_input(n: int) -> np.ndarray:
    """[n][N] float32 at 48 kHz, 0.1 s: tone's four rows, then two more at half volume."""
    x = np.concatenate([tone(48000, 0.1, 4), tone(48000, 0.1, 2) * 0.5])[:n]
    return np.ascontiguousarray(x.astype(np.float32))


def group_video(names: list[str]) -> dict:
    import tempfile
    from comfy_api.latest._input_impl import video_types
    from comfy_extras import nodes_video as nv
    from comfy_extras import nodes_audio as na
    subs = clip_video_subs()
    smooth = clip_video_smooth()
    hvc1 = clip_video_hvc1()
    containers = clip_video_containers()
    folder_paths.set_input_directory(CLIPS)

    def clone(cls):
        return cls.PREPARE_CLASS_CLONE({"hidden_inputs": VIDEO_HIDDEN})
    LoadVideo, GetComp, Create, Save, Card = (clone(nv.LoadVideo), clone(nv.GetVideoComponents), clone(nv.CreateVideo),
                                              clone(nv.SaveVideo), clone(nv.Video))
    LoadAudio = clone(na.LoadAudio)
    oh = openh264_options(23)
    cases: dict = {"prompt": VIDEO_PROMPT, "extraPnginfo": VIDEO_EXTRA, "openh264": oh,
                   "groupClips": {n: sha(open(os.path.join(CLIPS, n), "rb").read()) for n in (subs, smooth, hvc1, *containers)}}
    with tempfile.TemporaryDirectory() as tmp:
        # LoadVideo → GetVideoComponents over every standard clip.
        comps = []
        for name in names:
            rec: dict = {"clip": name}
            try:
                v = LoadVideo.execute(file=name).result[0]
                imgs, audio, fps = GetComp.execute(video=v).result
                rec["frames"] = images_record(imgs)
                rec["fps"] = fps
                rec["sound"] = sound_record(audio["waveform"][0].numpy(), int(audio["sample_rate"])) if audio is not None else None
            except Exception as e:  # noqa: BLE001
                rec["error"] = err(e)
            comps.append(rec)
        cases["components"] = comps

        # Fix round 1: the other containers a person can upload, through LoadVideo → GetVideoComponents,
        # and SaveVideo (auto, auto) of each: its stream copy into MP4, or the error Python raises.
        conts = []
        for name in containers:
            rec = {"clip": name}
            try:
                v = LoadVideo.execute(file=name).result[0]
                imgs, audio, fps = GetComp.execute(video=v).result
                rec["frames"] = images_record(imgs)
                rec["fps"] = fps
                rec["sound"] = sound_record(audio["waveform"][0].numpy(), int(audio["sample_rate"])) if audio is not None else None
            except Exception as e:  # noqa: BLE001 - PyAV can't seek an FLV: get_components raises
                rec["error"] = err(e)
            with av.open(os.path.join(CLIPS, name)) as c:
                rec["formatName"] = c.format.name
                rec["codecs"] = [st.codec_context.name for st in c.streams]
            out, temp = fresh_dirs(tmp, f"container_{name}")
            try:
                ui = video_ui_of(Save.execute(video=LoadVideo.execute(file=name).result[0], filename_prefix="video/ComfyUI", format="auto", codec="auto"))
                rec["save"] = {"ui": ui, "saved": video_out(ui_file(out, temp, ui["images"][0]), None, False, False), "written": files_written(out)}
            except Exception as e:  # noqa: BLE001
                rec["save"] = {"error": err(e), "written": files_written(out)}
            conts.append(rec)
        cases["containers"] = conts

        # CreateVideo → SaveVideo: MADE_FRAMES_CLIP's frames at three rates, with each sound; x264 and libopenh264.
        imgs = GetComp.execute(video=LoadVideo.execute(file=MADE_FRAMES_CLIP).result[0]).result[0]
        source = rgb_frames_of(os.path.join(CLIPS, MADE_FRAMES_CLIP))
        sounds = {k: (None if f is None else LoadAudio.execute(audio=f).result[0]) for k, f in MADE_SOUNDS.items()}
        made = []
        for fps in (24.0, 29.97, 30.0):
            for label, snd in sounds.items():
                rec = {"fps": fps, "sound": label}
                for run, swap in (("x264", None), ("openh264", oh)):
                    out, temp = fresh_dirs(tmp, f"made_{fps}_{label}_{run}")
                    vid = Create.execute(images=imgs, fps=fps, audio=snd).result[0]
                    with _patched(video_types, _AvShim(swap)):
                        ui = video_ui_of(Save.execute(video=vid, filename_prefix="video/ComfyUI", format="auto", codec="auto"))
                    rec[run] = {"ui": ui, "saved": video_out(ui_file(out, temp, ui["images"][0]), source, swap is None, False),
                                "written": files_written(out)}
                made.append(rec)
        # libx264's frames depend on the rate only (not the sound): each set kept whole once, by its frames' sha256s.
        rgbz: dict = {}
        for rec in made:
            saved = rec["x264"]["saved"]
            key = sha("".join(saved["frames"]).encode("ascii"))
            rgbz.setdefault(key, saved.pop("rgbz"))
            saved["rgbzKey"] = key
        cases["made"] = {"clip": MADE_FRAMES_CLIP, "sounds": MADE_SOUNDS, "cases": made, "rgbz": rgbz}

        # The named case: CreateVideo → SaveVideo of noise frames (24 fps and 30 fps, no sound).
        noise_imgs = GetComp.execute(video=LoadVideo.execute(file=NOISE_FRAMES_CLIP).result[0]).result[0]
        noise_source = rgb_frames_of(os.path.join(CLIPS, NOISE_FRAMES_CLIP))
        noisy = []
        for fps in (24.0, 30.0):
            rec = {"fps": fps, "sound": "none"}
            for run, swap in (("x264", None), ("openh264", oh)):
                out, temp = fresh_dirs(tmp, f"noise_{fps}_{run}")
                vid = Create.execute(images=noise_imgs, fps=fps, audio=None).result[0]
                with _patched(video_types, _AvShim(swap)):
                    ui = video_ui_of(Save.execute(video=vid, filename_prefix="video/ComfyUI", format="auto", codec="auto"))
                rec[run] = {"ui": ui, "saved": video_out(ui_file(out, temp, ui["images"][0]), noise_source, swap is None, False),
                            "written": files_written(out)}
            noisy.append(rec)
        cases["madeNoise"] = {"clip": NOISE_FRAMES_CLIP, "cases": noisy}

        # CreateVideo with 3, 4 and 6 channels (save_to's layouts: mono, stereo, 5.1, else stereo).
        chans = []
        for n in (3, 4, 6):
            x = channels_input(n)
            rec = {"channels": n, "rate": 48000, "input": b64(zlib.compress(x.tobytes(), 9))}
            out, temp = fresh_dirs(tmp, f"channels_{n}")
            vid = Create.execute(images=imgs, fps=24.0, audio={"waveform": torch.from_numpy(x)[None], "sample_rate": 48000}).result[0]
            try:
                ui = video_ui_of(Save.execute(video=vid, filename_prefix="video/ComfyUI", format="auto", codec="auto"))
                rec["ui"] = ui
                rec["saved"] = video_out(ui_file(out, temp, ui["images"][0]), source, False, False)
            except Exception as e:  # noqa: BLE001
                rec["error"] = err(e)
            rec["written"] = files_written(out)
            chans.append(rec)
        cases["channels"] = chans

        # SaveVideo of a file, with `format` and `codec` each auto and set.
        saves = []
        for name in SAVE_VIDEO_CLIPS:
            src = rgb_frames_of(os.path.join(CLIPS, name))
            for fmt in ("auto", "mp4"):
                for codec in ("auto", "h264"):
                    rec = {"clip": name, "format": fmt, "codec": codec}
                    for run, swap in (("x264", None), ("openh264", oh)):
                        out, temp = fresh_dirs(tmp, f"save_{name}_{fmt}_{codec}_{run}")
                        v = LoadVideo.execute(file=name).result[0]
                        try:
                            with _patched(video_types, _AvShim(swap)):
                                ui = video_ui_of(Save.execute(video=v, filename_prefix="video/ComfyUI", format=fmt, codec=codec))
                            rec[run] = {"ui": ui, "saved": video_out(ui_file(out, temp, ui["images"][0]), src, swap is None, False),
                                        "written": files_written(out)}
                        except Exception as e:  # noqa: BLE001
                            rec[run] = {"error": err(e), "written": files_written(out)}
                    # A stream copy (the same frames either way): its decoded frames needn't be kept whole.
                    if "saved" in rec["x264"] and "saved" in rec["openh264"] and rec["x264"]["saved"]["frames"] == rec["openh264"]["saved"]["frames"]:
                        rec["x264"]["saved"].pop("rgbz", None)
                    saves.append(rec)
        cases["saves"] = {"clips": SAVE_VIDEO_CLIPS, "cases": saves}

        # The Video card.
        stereo = sounds["stereo"]
        cards = []
        card_cases = [
            ("made", {"source": "made"}, False), ("made", {"source": "made"}, True),
            ("source file", {"source": "v_stereo_aac.mp4"}, False),
            ("file", {"file": "v_stereo_aac.mp4"}, False), ("file", {"file": "v_stereo_aac.mp4"}, True),
            ("nothing", {}, False), ("nothing", {}, True),
            ("source and file", {"source": "v_h264_601.mp4", "file": "v_stereo_aac.mp4"}, False),
        ]
        for label, how, export in card_cases:
            rec = {"label": label, "file": how.get("file", ""), "source": how.get("source"), "export": export}
            for run, swap in (("x264", None), ("openh264", oh)):
                if run == "openh264" and how.get("source") != "made":
                    continue
                out, temp = fresh_dirs(tmp, f"card_{label}_{export}_{run}")
                src = None
                if how.get("source") == "made":
                    src = Create.execute(images=imgs, fps=24.0, audio=stereo).result[0]
                elif how.get("source"):
                    src = LoadVideo.execute(file=how["source"]).result[0]
                with _patched(video_types, _AvShim(swap)):
                    res = Card.execute(file=how.get("file", ""), export=export, filename_prefix="video/ComfyUI", source=src)
                ui = video_ui_of(res)
                shown = [video_out(ui_file(out, temp, e), source if how.get("source") == "made" else None, swap is None and how.get("source") == "made", False)
                         for e in (ui or {}).get("images", [])]
                rec[run] = {"ui": ui, "shown": shown, "handsOn": res.result[0] is not None,
                            "written": {"output": files_written(out), "temp": files_written(temp)}}
            cards.append(rec)
        cases["cards"] = cards

        cases["validate"] = {"missing": nv.LoadVideo.validate_inputs(file="no_such_video.mp4"), "present": nv.LoadVideo.validate_inputs(file="v_h264_601.mp4")}
    return {"cases": cases}


# ── frame batches (R5.5) ──────────────────────────────────────────────────────

# LoadVideoFrames' settings over the standard clips (none is over 64 px, so no resize: the frame choice)
# and over this group's own clips (every combination, with the resize).
FRAMES_PAST_END = 100000
FRAMES_STANDARD_GRID = [
    {"max_size": 720, "stride": s, "start_frame": st, "max_seconds": ms, "max_frames": 600}
    for s in (1, 3) for st in (0, 5, FRAMES_PAST_END) for ms in (0.0, 0.5)
]
FRAMES_GROUP_GRID = [
    {"max_size": m, "stride": s, "start_frame": st, "max_seconds": ms, "max_frames": 600}
    for m in (64, 96, 720, 4096) for s in (1, 3) for st in (0, 5, FRAMES_PAST_END) for ms in (0.0, 0.5)
] + [{"max_size": 64, "stride": 2, "start_frame": 1, "max_seconds": 0.0, "max_frames": 2},
     {"max_size": 720, "stride": 1, "start_frame": 0, "max_seconds": 10.0, "max_frames": 600}]
# Pillow's resize(BILINEAR) of R2.1's `synth` pictures: (w, h, seed, ow, oh), down, up, one side, and odd sizes.
PIL_BILINEAR_CASES = [
    (64, 48, 11, 32, 24), (64, 48, 12, 17, 13), (33, 25, 13, 64, 48), (97, 61, 14, 40, 25), (200, 10, 15, 7, 3),
    (5, 5, 16, 1, 1), (64, 48, 17, 64, 20), (64, 48, 18, 21, 48), (160, 90, 19, 64, 36), (128, 73, 20, 64, 36),
    (3, 2, 21, 7, 5), (1, 1, 22, 4, 3),
]
# The fixed stamp SaveVideoFrames' names take here (time.strftime patched): the runner's names are checked at the same second.
FRAMES_STAMP = "20260930_120000"
FRAMES_SOUNDS = ["a_mono.mp3", "a_s16.wav", "a_s24.wav", "a_s32.wav", "a_16.flac", "a_24.flac", "a_vorbis.ogg",
                 "a_opus.webm", "a_aac.m4a", "a_long_8k.wav", "a_min.wav", "g_frames_broken.wav", "no_such_sound.wav",
                 # Fix round 1: sounds that open, then fail partway (PyAV raises InvalidDataError on the 6th frame).
                 "g_frames_badmid.m4a", "g_frames_badmid.mp3"]
# Fix round 1: sounds made from standard clips with three bytes flipped (offset: xor 0xA5 each), so their
# decode fails partway: SaveVideoFrames keeps the video and the sound up to there.
FRAMES_BAD_MID = {"g_frames_badmid.m4a": ("a_aac.m4a", 1539), "g_frames_badmid.mp3": ("a_mono.mp3", 2526)}
# Fix round 1: SaveVideoFrames' rates where Python's round of the float fps·1000 lands on a .5 the exact
# value doesn't (Fraction(round(fps * 1000), 1000)): 23.9765 → 23976, 12.3455 → 12346.
FRAMES_ODD_RATES = [23.9765, 12.3455]
# Fix round 1: a clip whose frames change size partway (96 × 72, then 128 × 72), resized frame by frame.
FRAMES_RESIZE_GRID = [
    {"max_size": m, "stride": s, "start_frame": st, "max_seconds": 0.0, "max_frames": 600}
    for m in (64, 720) for s in (1, 3) for st in (0, 5)
]


def clip_frames_big() -> str:
    """This group's own clip: 30 `smooth` frames at 160 × 90, H.264 at 24 fps (resized by every max_size under 160)."""
    name = "g_frames_big.mp4"
    path, c = open_out(name)
    s = video_stream(c, "libx264", 160, 90, 24, "yuv420p", {**X264, "crf": "18"})
    frames = []
    for i in range(30):
        f = av.VideoFrame.from_ndarray(np.frombuffer(smooth_frame(160, 90, i), np.uint8).reshape(90, 160, 3), format="rgb24").reformat(format="yuv420p")
        f.pts = i
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()
    return name


def clip_frames_odd() -> str:
    """This group's own clip: 8 `smooth` frames at 128 × 73 (an odd height), FFV1 RGB in Matroska at 25 fps.
    At max_size 64 the height is 36.5, which Python's round() takes to 36 (half to even)."""
    name = "g_frames_odd.mkv"
    path, c = open_out(name, "matroska")
    s = video_stream(c, "ffv1", 128, 73, 25, "bgr0")
    frames = []
    for i in range(8):
        f = av.VideoFrame.from_ndarray(np.frombuffer(smooth_frame(128, 73, i), np.uint8).reshape(73, 128, 3), format="rgb24").reformat(format="bgr0")
        f.pts = i
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()
    return name


def clip_frames_bad_mid() -> list[str]:
    for name, (src, off) in FRAMES_BAD_MID.items():
        b = bytearray(open(os.path.join(CLIPS, src), "rb").read())
        for i in range(off, off + 3):
            b[i] ^= 0xA5
        with open(os.path.join(CLIPS, name), "wb") as f:
            f.write(bytes(b))
    return list(FRAMES_BAD_MID)


def clip_frames_resize() -> str:
    """This group's own clip: 4 `smooth` frames at 96 × 72, then 4 at 128 × 72, VP9 in one WebM track (two
    encoders, as x_vp9_resize.webm). LoadVideoFrames resizes each to the header's scale at max_size 64."""
    name = "g_frames_resize.webm"
    path, c = open_out(name, "webm")
    opts = {"cpu-used": "8", "deadline": "realtime", "row-mt": "0", "lag-in-frames": "0"}
    s = video_stream(c, "libvpx-vp9", 96, 72, 24, "yuv420p", opts)
    second = av.CodecContext.create("libvpx-vp9", "w")
    second.width, second.height, second.pix_fmt = 128, 72, "yuv420p"
    second.time_base = Fraction(1, 24)
    second.thread_count = 1
    second.flags |= av.codec.context.Flags.bitexact
    second.options = dict(opts)
    packets = []
    for i in range(4):
        f = av.VideoFrame.from_ndarray(np.frombuffer(smooth_frame(96, 72, i), np.uint8).reshape(72, 96, 3), format="rgb24").reformat(format="yuv420p")
        f.pts = i
        packets += s.encode(f)
    packets += s.encode(None)
    for i in range(4, 8):
        f = av.VideoFrame.from_ndarray(np.frombuffer(smooth_frame(128, 72, i), np.uint8).reshape(72, 128, 3), format="rgb24").reformat(format="yuv420p")
        f.pts = i
        f.time_base = Fraction(1, 24)
        packets += second.encode(f)
    packets += second.encode(None)
    for p in packets:
        p.stream = s
        c.mux(p)
    c.close()
    return name


def clip_frames_broken() -> str:
    """A WAV that won't open: its RIFF and WAVE marks, then no format chunk (SaveVideoFrames skips its sound)."""
    name = "g_frames_broken.wav"
    body = b"WAVE" + b"junk" + (8).to_bytes(4, "little") + b"notsound" + b"data" + (16).to_bytes(4, "little") + bytes(range(16))
    with open(os.path.join(CLIPS, name), "wb") as f:
        f.write(b"RIFF" + len(body).to_bytes(4, "little") + body)
    return name


class _Stamp:
    """time.strftime giving FRAMES_STAMP for SaveVideoFrames' name (and the real one otherwise)."""

    def __enter__(self):
        import time
        self.real = time.strftime
        time.strftime = lambda fmt, *a: FRAMES_STAMP if fmt == "%Y%m%d_%H%M%S" else self.real(fmt, *a)

    def __exit__(self, *a):
        import time
        time.strftime = self.real
        return False


class _AvModule:
    """sys.modules['av'] as an _AvShim while SaveVideoFrames runs (it imports av inside execute)."""

    def __init__(self, shim):
        self.shim = shim

    def __enter__(self):
        self.real = sys.modules["av"]
        sys.modules["av"] = self.shim

    def __exit__(self, *a):
        sys.modules["av"] = self.real
        return False


def frames_u8(imgs) -> list[bytes]:
    """An IMAGE batch as the uint8 rgb24 frames it holds (exact: each value came from 8 bits)."""
    return [(imgs[i] * 255.0).round().to(torch.uint8).numpy().tobytes() for i in range(imgs.shape[0])]


def padded(frames: list[bytes], w: int, h: int) -> list[bytes]:
    """SaveVideoFrames' padding: black at the right and bottom up to even sizes."""
    ew, eh = w + (w % 2), h + (h % 2)
    out = []
    for b in frames:
        a = np.zeros((eh, ew, 3), np.uint8)
        a[:h, :w] = np.frombuffer(b, np.uint8).reshape(h, w, 3)
        out.append(a.tobytes())
    return out


def kept_sound_samples(path: str, target: float):
    """The samples SaveVideoFrames' loop hands the AAC encoder from a sound file (its first stream's
    decoded frames up to the first whose time is past `target`), and the frames' sizes; None when it
    won't open (Python skips the sound)."""
    try:
        c = av.open(path)
    except Exception as e:  # noqa: BLE001
        return {"error": err(e)}
    with c:
        s = c.streams.audio[0]
        kept, sizes = 0, []
        try:
            for f in c.decode(s):
                if f.time is not None and f.time > target:
                    break
                kept += f.samples
                sizes.append(f.samples)
        except Exception as e:  # noqa: BLE001 - fix round 1: the decode fails partway; Python keeps what came
            return {"kept": kept, "rate": s.rate or 48000, "frameSizes": sizes[:4], "lastFrame": sizes[-1] if sizes else 0, "broken": err(e)}
        return {"kept": kept, "rate": s.rate or 48000, "frameSizes": sizes[:4], "lastFrame": sizes[-1] if sizes else 0}


def group_frames(names: list[str]) -> dict:
    """(R5.5) LoadVideoFrames and SaveVideoFrames (comfy_extras/nodes_video_effects.py) as Python runs them."""
    import tempfile
    from PIL import Image
    from comfy_extras import nodes_video_effects as nve
    big, odd, broken = clip_frames_big(), clip_frames_odd(), clip_frames_broken()
    bad_mid = clip_frames_bad_mid()
    resize = clip_frames_resize()
    folder_paths.set_input_directory(CLIPS)
    Load = nve.LoadVideoFramesNode.PREPARE_CLASS_CLONE({"hidden_inputs": {}})
    Save = nve.SaveVideoFramesNode.PREPARE_CLASS_CLONE({"hidden_inputs": {}})
    cases: dict = {"groupClips": {n: sha(open(os.path.join(CLIPS, n), "rb").read()) for n in (big, odd, broken, *bad_mid, resize)},
                   "stamp": FRAMES_STAMP, "pastEnd": FRAMES_PAST_END}

    # LoadVideoFrames: each case's frames as indices into its clip's table of distinct frames (sha256).
    tables: dict = {}
    loads = []
    for clip, grid in [(n, FRAMES_STANDARD_GRID) for n in names] + [(big, FRAMES_GROUP_GRID), (odd, FRAMES_GROUP_GRID), (resize, FRAMES_RESIZE_GRID)]:
        table = tables.setdefault(clip, [])
        for g in grid:
            rec: dict = {"clip": clip, **g}
            try:
                imgs, fps = Load.execute(file=clip, **g).result
                shas = [sha(b) for b in frames_u8(imgs)]
                for s in shas:
                    if s not in table:
                        table.append(s)
                rec.update({"w": int(imgs.shape[2]), "h": int(imgs.shape[1]), "frames": [table.index(s) for s in shas], "fps": fps})
            except Exception as e:  # noqa: BLE001
                rec["error"] = err(e)
            loads.append(rec)
    cases["loads"] = loads
    cases["tables"] = tables
    cases["black64"] = sha(bytes(64 * 64 * 3))
    cases["validate"] = {"missing": nve.LoadVideoFramesNode.validate_inputs(file="no_such_video.mp4"),
                         "present": nve.LoadVideoFramesNode.validate_inputs(file=big)}

    # Pillow's resize(BILINEAR) of `synth` pictures (the resize LoadVideoFrames makes).
    pil = []
    for w, h, seed, ow, oh in PIL_BILINEAR_CASES:
        src = synth(w, h, 3, seed)
        got = np.asarray(Image.frombytes("RGB", (w, h), src).resize((ow, oh), Image.BILINEAR)).tobytes()
        pil.append({"w": w, "h": h, "seed": seed, "ow": ow, "oh": oh, "sha256": sha(got), **({"rgb": b64(got)} if ow * oh <= 64 * 48 else {})})
    cases["pilBilinear"] = pil

    # SaveVideoFrames: frames from LoadVideoFrames (an even and an odd size), 24 and 29.97 fps, CRF 10/20/32,
    # without sound; then each sound clip (and a broken and a missing one) at 24 fps, CRF 20. libx264 as
    # ComfyUI runs it, and the same call switched to libopenh264 at the CRF's OPENH264_FOR row.
    sources = {
        "even": {"clip": big, "max_size": 96, "max_seconds": 0.25},
        "odd": {"clip": "v_vp9_odd.webm", "max_size": 720, "max_seconds": 0.25},
    }
    batches = {}
    for key, s in sources.items():
        imgs, _fps = Load.execute(file=s["clip"], max_seconds=s["max_seconds"], max_frames=600, max_size=s["max_size"], start_frame=0, stride=1).result
        batches[key] = imgs
    cases["sources"] = {k: {**sources[k], "w": int(v.shape[2]), "h": int(v.shape[1]), "count": int(v.shape[0])} for k, v in batches.items()}
    saves = []
    runs = [(k, fps, crf, "(none)") for k in ("even", "odd") for fps in (24.0, 29.97) for crf in (10, 20, 32)]
    runs += [("even", 24.0, 20, a) for a in FRAMES_SOUNDS]
    runs += [("even", r, 20, "(none)") for r in FRAMES_ODD_RATES]
    rgbz: dict = {}
    with tempfile.TemporaryDirectory() as tmp:
        for k, fps, crf, audio in runs:
            imgs = batches[k]
            T, H, W = int(imgs.shape[0]), int(imgs.shape[1]), int(imgs.shape[2])
            source = padded(frames_u8(imgs), W, H)
            rec: dict = {"source": k, "fps": fps, "crf": crf, "audio": audio}
            if audio != "(none)":
                rec["kept"] = kept_sound_samples(os.path.join(CLIPS, audio), T / float(fps)) if os.path.exists(os.path.join(CLIPS, audio)) else None
            for run, swap in (("x264", None), ("openh264", openh264_options(crf))):
                out, _temp = fresh_dirs(tmp, f"save_{k}_{fps}_{crf}_{audio}_{run}")
                shim = _AvShim(swap)
                with _Stamp(), _AvModule(shim):
                    res = Save.execute(frames=imgs, fps=fps, filename_prefix="video", audio_file=audio, preset="veryfast", crf=crf)
                ui = video_ui_of(res)
                saved = video_out(os.path.join(out, ui["images"][0]["subfolder"], ui["images"][0]["filename"]), source, swap is None, False)
                rec[run] = {"ui": ui, "saved": saved, "written": files_written(out), "result": list(res.result or [])}
            saved = rec["x264"]["saved"]
            key = sha("".join(saved["frames"]).encode("ascii"))
            rgbz.setdefault(key, saved.pop("rgbz"))
            saved["rgbzKey"] = key
            saves.append(rec)
        # The name: (filename_prefix or 'video').rstrip('_'), then the stamp.
        names_rec = []
        for prefix in ("video", "clip__", "", "a_b_"):
            out, _temp = fresh_dirs(tmp, f"name_{prefix or 'empty'}")
            with _Stamp(), _AvModule(_AvShim(openh264_options(20))):
                ui = video_ui_of(Save.execute(frames=batches["even"][:1], fps=24.0, filename_prefix=prefix, audio_file="(none)", preset="veryfast", crf=20))
            names_rec.append({"prefix": prefix, "ui": ui, "written": files_written(out)})
        cases["names"] = names_rec
    cases["saves"] = saves
    cases["rgbz"] = rgbz
    return {"cases": cases}


# ── timeline-media (R5.6) ─────────────────────────────────────────────────────

TIMELINE_THUMB_COUNTS = (1, 5, 20)
TIMELINE_WAVE_BUCKETS = (16, 256, 2048)
# The handlers of comfy_extras/nodes_timeline.py this group runs, lifted out with `ast` (they are nested
# inside the PromptServer try-block, so they can't be imported), as Phase A's parity oracle does
# (frontend/tests/unit/fixtures/native-media-python-oracle.py).
TIMELINE_FUNCS = {"_probe_media", "_thumb_height_px", "_gen_thumbnails", "_gen_waveform_peaks"}


def timeline_handlers() -> dict:
    import ast
    from PIL import Image as PILImage
    src_path = os.path.join(ROOT, "comfy_extras", "nodes_timeline.py")
    tree = ast.parse(open(src_path, encoding="utf-8").read())
    body = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name in TIMELINE_FUNCS]
    missing = TIMELINE_FUNCS - {n.name for n in body}
    if missing:
        raise SystemExit(f"handlers not found in nodes_timeline.py: {sorted(missing)}")
    for n in body:
        n.decorator_list = []
    module = ast.Module(body=body, type_ignores=[])
    ast.fix_missing_locations(module)
    ns = {"os": os, "np": np, "json": json, "PILImage": PILImage}
    exec(compile(module, src_path, "exec"), ns)
    return ns


def clip_thumbs_gop(name: str, fmt: str | None) -> str:
    """This group's own clips: 36 `smooth` frames at 160 × 90 (a thumbnail is a downscale), H.264 at
    24 fps with a keyframe every 6 frames and two B-frames, in MP4 and in Matroska: a thumbnail's seek
    lands on a keyframe that isn't the first, and decodes forward from it."""
    path, c = open_out(name, fmt)
    s = video_stream(c, "libx264", 160, 90, 24, "yuv420p", {**X264, "g": "6", "keyint_min": "6", "bf": "2", "sc_threshold": "0"})
    frames = []
    for i in range(36):
        f = av.VideoFrame.from_ndarray(np.frombuffer(smooth_frame(160, 90, i), np.uint8).reshape(90, 160, 3), format="rgb24").reformat(format="yuv420p")
        f.pts = i
        frames.append(f)
    encode_frames(c, s, frames)
    c.close()
    return name


def clip_timeline_junk() -> list[str]:
    """Files no reader opens: bytes with no container, under a video and a sound name."""
    out = []
    for name in ("g_timeline_junk.mp4", "g_timeline_junk.wav"):
        with open(os.path.join(CLIPS, name), "wb") as f:
            f.write(bytes((i * 73 + 11) & 255 for i in range(4096)))
        out.append(name)
    return out


def thumb_picks(path: str, count: int):
    """_gen_thumbnails' video loop (nodes_timeline.py:2208-2240) as it runs, recording which frame it
    takes for each thumbnail: the target pts, the frame's pts, and whether the decode ran out before
    reaching the target (then the last frame decoded is taken). For the seek-parity finding."""
    try:
        with av.open(path) as c:
            vs = c.streams.video[0]
            tb = vs.time_base
            dur_sec = float((vs.duration or 0) * tb) if tb else 0.0
            if dur_sec <= 0:
                dur_sec = float((c.duration or 0) / 1_000_000.0)
            if dur_sec <= 0:
                return []
            picks = []
            step = dur_sec / max(1, count)
            for i in range(count):
                t = step * (i + 0.5)
                target = int(t / float(tb))
                try:
                    c.seek(max(0, target), stream=vs, any_frame=False, backward=True)
                except Exception:  # noqa: BLE001 - as the handler
                    pass
                frame, reached = None, False
                for f in c.decode(vs):
                    frame = f
                    if f.pts is not None and f.pts >= target:
                        reached = True
                        break
                if frame is None:
                    continue
                picks.append({"target": target, "pts": frame.pts, "ranOut": not reached,
                              "sha256": sha(frame.to_ndarray(format="rgb24").tobytes())})
            return picks
    except Exception as e:  # noqa: BLE001
        return {"error": err(e)}


def png_pixels(data_url: str) -> dict:
    from io import BytesIO
    from PIL import Image
    im = Image.open(BytesIO(base64.b64decode(data_url.split(",", 1)[1])))
    im.load()
    rgb = im.convert("RGB").tobytes()
    return {"mode": im.mode, "w": im.size[0], "h": im.size[1], "sha256": sha(rgb)}


def group_timeline_media(names: list[str]) -> dict:
    """(R5.6) The Timeline's _probe_media, _gen_thumbnails and _gen_waveform_peaks, the real handlers."""
    ns = timeline_handlers()
    gop = [clip_thumbs_gop("g_thumbs_gop.mp4", None), clip_thumbs_gop("g_thumbs_gop.mkv", "matroska")]
    junk = clip_timeline_junk()
    clips = names + gop + junk
    cases: dict = {"groupClips": {n: sha(open(os.path.join(CLIPS, n), "rb").read()) for n in gop + junk}}
    cases["probe"] = [{"clip": n, "info": ns["_probe_media"](os.path.join(CLIPS, n))} for n in clips]
    thumbs = []
    for n in clips:
        for count in TIMELINE_THUMB_COUNTS:
            got = ns["_gen_thumbnails"](os.path.join(CLIPS, n), count)
            thumbs.append({"clip": n, "count": count, "thumbnails": [png_pixels(u) for u in got],
                           "picks": thumb_picks(os.path.join(CLIPS, n), count)})
    cases["thumbnails"] = thumbs
    waves = []
    for n in clips:
        for buckets in TIMELINE_WAVE_BUCKETS:
            peaks = ns["_gen_waveform_peaks"](os.path.join(CLIPS, n), buckets)
            # The route's own cache file: json.dump of this payload (the asset id is the test's).
            text = json.dumps({"peaks": peaks, "asset_id": "A", "buckets": buckets})
            waves.append({"clip": n, "buckets": buckets, "count": len(peaks), "sha256": sha(text.encode("ascii")),
                          "textz": b64(zlib.compress(text.encode("ascii"), 9))})
    cases["waveforms"] = waves
    return {"cases": cases}


# ── the video effects (R6) ────────────────────────────────────────────────────

# R6 rule 13's standard frame inputs: name → (frames, w, h, seed); frame i is synth(w, h, 3, seed + i).
VFX_CLIPS = {
    "clip8": (8, 24, 16, 1000),
    "clip8-odd": (8, 23, 15, 2000),
    "clip2": (2, 24, 16, 3000),
    "clip1": (1, 24, 16, 4000),
    "clip8-big": (8, 160, 90, 5000),
    "clip6-small": (6, 16, 12, 6000),
}
# The inputs every class runs its defaults on (clip6-small is the two-clip effects' second clip).
VFX_STANDARD = ("clip8", "clip8-odd", "clip2", "clip1", "clip8-big")
# A batch recorded whole (float32, base64) up to this many values (frames × h × w × 3); above it, sha256 only.
VFX_INLINE_VALUES = 8 * 24 * 16 * 3
# The node id every case runs as (its preview is live_preview_7.png).
VFX_NODE_ID = "7"


def vfx_clip(name: str) -> torch.Tensor:
    """A standard input as Get video components hands it: [T, H, W, 3] float32, u8 / 255."""
    n, w, h, seed = VFX_CLIPS[name]
    frames = [np.frombuffer(synth(w, h, 3, seed + i), np.uint8).reshape(h, w, 3) for i in range(n)]
    return torch.from_numpy(np.stack(frames).copy()) / 255.0


def vfx_run(cls, node_id: str, **inputs):
    """The real node's execute with its hidden unique_id set: its outputs and ui."""
    from unittest import mock
    from comfy_api.latest._io import HiddenHolder
    with mock.patch.object(cls, "hidden", HiddenHolder.from_dict({"UNIQUE_ID": node_id})):
        res = cls.execute(**inputs)
    return res.args, res.ui


def vfx_round8(t: torch.Tensor) -> bytes:
    """Rule 4's hand-off: round(f32(clamp(x) · 255)), halves to even, as uint8."""
    return (t.clamp(0, 1) * 255.0).round().to(torch.uint8).numpy().tobytes()


def vfx_trunc8(t: torch.Tensor) -> bytes:
    """Rule 4's savers and rule 9's preview: np.clip(255 · x, 0, 255).astype(uint8)."""
    return np.clip(255.0 * t.numpy(), 0, 255).astype(np.uint8).tobytes()


def vfx_batch(t: torch.Tensor) -> dict:
    """A frame batch as recorded: its shape, its float32 (T, H, W, 3 order; whole when small) and its 8-bit forms."""
    assert t.dtype == torch.float32 and t.ndim == 4 and t.shape[-1] == 3, (t.dtype, t.shape)
    f = np.ascontiguousarray(t.numpy()).tobytes()
    rec = {"count": int(t.shape[0]), "h": int(t.shape[1]), "w": int(t.shape[2]),
           "f32_sha256": sha(f), "round8_sha256": sha(vfx_round8(t)), "trunc8_sha256": sha(vfx_trunc8(t))}
    if t.numel() <= VFX_INLINE_VALUES:
        rec["f32"] = b64(f)
    return rec


def vfx_preview(temp: str, ui) -> dict | None:
    """The live preview the node wrote (rule 9), decoded: its name, size, pixels, and PNG settings."""
    from PIL import Image
    if ui is None:
        return None
    d = ui.as_dict() if hasattr(ui, "as_dict") else ui
    entry = dict(d["images"][0])
    with Image.open(os.path.join(temp, entry["subfolder"], entry["filename"])) as im:
        im.load()
        px = im.convert("RGB").tobytes()
        rec = {"filename": entry["filename"], "mode": im.mode, "w": im.size[0], "h": im.size[1], "sha256": sha(px)}
    if im.size[0] * im.size[1] <= 64 * 48:
        rec["px"] = b64(px)
    return rec


def vfx_ui(ui) -> dict | None:
    if ui is None:
        return None
    d = ui.as_dict() if hasattr(ui, "as_dict") else ui
    return {k: ([dict(x) for x in v] if k == "images" else list(v)) for k, v in d.items()}


def vfx_cases(tmp: str, cls, class_type: str, grid: list[tuple[str, dict, str]]) -> list[dict]:
    """Each (name, widgets, input) through the real node, in a fresh temp folder."""
    out = []
    for name, widgets, clip in grid:
        rec: dict = {"name": name, "class_type": class_type, "node_id": VFX_NODE_ID, "widgets": widgets, "input": clip}
        _o, temp = fresh_dirs(tmp, f"{class_type}_{len(out)}")
        try:
            args, ui = vfx_run(cls, VFX_NODE_ID, frames=vfx_clip(clip), **widgets)
            rec["out"] = vfx_batch(args[0])
            rec["ui"] = vfx_ui(ui)
            rec["preview"] = vfx_preview(temp, ui)
        except Exception as e:  # noqa: BLE001 - the error itself is the record
            rec["error"] = err(e)
        out.append(rec)
    return out


def vfx_grid(defaults: dict, numeric: dict[str, tuple], options: dict[str, list], extra: list[tuple[str, dict, str]] = ()) -> list[tuple[str, dict, str]]:
    """R6 rule 13's case set: every widget at its default over each standard input; each numeric widget at its
    min, its max and one value between (one at a time); every option; and the class's own extra cases."""
    grid = [(f"defaults, {c}", dict(defaults), c) for c in VFX_STANDARD]
    for k, (lo, hi, mid) in numeric.items():
        for label, v in (("min", lo), ("max", hi), ("between", mid)):
            grid.append((f"{k} {label} ({v})", {**defaults, k: v}, "clip8"))
    for k, opts in options.items():
        for o in opts:
            grid.append((f"{k} {o}", {**defaults, k: o}, "clip8"))
    grid += list(extra)
    return grid


def vfx_saved(tmp: str, cls, class_type: str, widgets: dict) -> dict:
    """The effect on clip8 → Create video (24 fps) → Save video, libx264 as ComfyUI runs it and switched to libopenh264."""
    from comfy_api.latest._input_impl import video_types
    from comfy_extras import nodes_video as nv
    Create, Save = (c.PREPARE_CLASS_CLONE({"hidden_inputs": VIDEO_HIDDEN}) for c in (nv.CreateVideo, nv.SaveVideo))
    args, _ui = vfx_run(cls, VFX_NODE_ID, frames=vfx_clip("clip8"), **widgets)
    rec: dict = {"class_type": class_type, "widgets": widgets, "input": "clip8", "fps": 24.0}
    for run, swap in (("x264", None), ("openh264", openh264_options(23))):
        out, temp = fresh_dirs(tmp, f"saved_{class_type}_{run}")
        vid = Create.execute(images=args[0], fps=24.0, audio=None).result[0]
        with _patched(video_types, _AvShim(swap)):
            ui = video_ui_of(Save.execute(video=vid, filename_prefix="video/ComfyUI", format="auto", codec="auto"))
        saved = video_out(ui_file(out, temp, ui["images"][0]), None, False, False)
        rec[run] = {"ui": ui, "header": saved["header"], "frameCount": saved["frameCount"], "frameRate": saved["frameRate"],
                    "duration": saved["duration"], "frames": saved["frames"]}
    return rec


# Rule 12: every R6 class and where its inputs come from.
VFX_GRAPH_CLASSES = {
    "nodes_video_effects": ["FrameTrail", "TemporalMotionBlur", "SlitScan", "TimeDisplacement", "VideoReverse", "VideoTrim", "VideoCrossfade", "AnimatedNoise"],
    "nodes_video_pro": ["SpeedRamp", "KenBurns", "AspectConvert", "ChromaKey", "CaptionTrack", "LUT", "ThreeWayCC", "AudioWaveform", "Transition", "Stabilize"],
    "nodes_frame_interp": ["FrameInterpolate"],
    "nodes_audio_effects": ["AudioFade", "AudioNormalize", "AudioDuck", "VideoSilenceCut"],
    "nodes_text": ["TextClip"],
    "nodes_audio": ["TrimAudioDuration", "SplitAudioChannels", "JoinAudioChannels", "AudioConcat", "AudioMerge", "AudioAdjustVolume",
                    "EmptyAudio", "AudioEqualizer3Band", "SaveAudioOpus"],
    "nodes_audio_denoise": ["AudioDenoise"],
}


def vfx_graphs() -> dict:
    """Rule 12's synthetic graphs, one per R6 class (and Save audio (Opus)): Load video → Get video components feeding
    every frame-batch input and Load audio every sound input, each widget at its default, and every picture output
    read by Create video → Save video, every sound output by Save audio."""
    import importlib
    graphs = {}
    for module, ids in VFX_GRAPH_CLASSES.items():
        mod = importlib.import_module(f"comfy_extras.{module}")
        found = {}
        for name in dir(mod):
            obj = getattr(mod, name)
            if isinstance(obj, type) and obj.__module__ == mod.__name__ and hasattr(obj, "define_schema"):
                try:
                    sch = obj.define_schema()
                except Exception:  # noqa: BLE001
                    continue
                if sch.node_id in ids:
                    found[sch.node_id] = obj
        assert sorted(found) == sorted(ids), (module, sorted(found))
        for cid in ids:
            cls = found[cid]
            types = cls.INPUT_TYPES()
            inputs: dict = {}
            for section in ("required", "optional"):
                for k, spec in (types.get(section) or {}).items():
                    kind = spec[0]
                    info = spec[1] if len(spec) > 1 else {}
                    if kind == "IMAGE":
                        inputs[k] = ["2", 0]
                    elif kind == "AUDIO":
                        inputs[k] = ["3", 0]
                    elif isinstance(kind, list) or kind == "COMBO":
                        opts = kind if isinstance(kind, list) else info.get("options", [])
                        # A folder's file list differs by machine: its first entry is not recorded, "(none)" stands in.
                        inputs[k] = info.get("default", "(none)" if cid in ("LUT", "AudioWaveform") else (opts[0] if opts else ""))
                    else:
                        inputs[k] = info.get("default", "" if kind == "STRING" else False if kind == "BOOLEAN" else 0)
            g = {"1": {"class_type": "LoadVideo", "inputs": {"file": "a.mp4"}},
                 "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
                 "3": {"class_type": "LoadAudio", "inputs": {"audio": "a.wav"}},
                 "4": {"class_type": cid, "inputs": inputs}}
            for slot, o in enumerate(cls.define_schema().outputs):
                t = o.io_type if hasattr(o, "io_type") else o.get_io_type()
                if t == "IMAGE":
                    g[f"c{slot}"] = {"class_type": "CreateVideo", "inputs": {"images": ["4", slot], "fps": 24.0}}
                    g[f"s{slot}"] = {"class_type": "SaveVideo", "inputs": {"video": [f"c{slot}", 0], "filename_prefix": "video/ComfyUI", "format": "auto", "codec": "auto"}}
                elif t == "AUDIO":
                    g[f"s{slot}"] = {"class_type": "SaveAudio", "inputs": {"audio": ["4", slot], "filename_prefix": "audio/ComfyUI"}}
            graphs[cid] = g
    return graphs


# R6.1's acceptance: a standard clip (32 × 24, stereo AAC) through Load video → Get video components → Reverse →
# Create video (its own rate) → Save video.
VFX_ACCEPTANCE_CLIP = "v_stereo_aac.mp4"


def vfx_acceptance(tmp: str) -> dict:
    """The acceptance chain as Python runs it, libx264 and switched to libopenh264."""
    from comfy_api.latest._input_impl import video_types
    from comfy_extras import nodes_video as nv
    from comfy_extras import nodes_video_effects as nve
    folder_paths.set_input_directory(CLIPS)
    LoadVideo, GetComp, Create, Save = (c.PREPARE_CLASS_CLONE({"hidden_inputs": VIDEO_HIDDEN}) for c in (nv.LoadVideo, nv.GetVideoComponents, nv.CreateVideo, nv.SaveVideo))
    imgs, _audio, fps = GetComp.execute(video=LoadVideo.execute(file=VFX_ACCEPTANCE_CLIP).result[0]).result
    args, _ui = vfx_run(nve.VideoReverseNode, VFX_NODE_ID, frames=imgs, mode="reverse")
    rec: dict = {"clip": VFX_ACCEPTANCE_CLIP, "fps": fps, "reversed": vfx_batch(args[0])}
    for run, swap in (("x264", None), ("openh264", openh264_options(23))):
        out, temp = fresh_dirs(tmp, f"acceptance_{run}")
        vid = Create.execute(images=args[0], fps=fps, audio=None).result[0]
        with _patched(video_types, _AvShim(swap)):
            ui = video_ui_of(Save.execute(video=vid, filename_prefix="video/ComfyUI", format="auto", codec="auto"))
        saved = video_out(ui_file(out, temp, ui["images"][0]), None, False, False)
        rec[run] = {"ui": ui, "header": saved["header"], "frameCount": saved["frameCount"], "frameRate": saved["frameRate"],
                    "duration": saved["duration"], "frames": saved["frames"]}
    return rec


def vfx_threads() -> dict:
    """R6 rule 13: torch at its default thread count (as R2 rule 11), recorded; OpenCV's too."""
    import subprocess
    assert torch.get_num_threads() > 1, "Run on a machine with more than one CPU thread: ComfyUI's nodes do"
    # OpenCV in a process of its own: its bundled libavdevice would clash with PyAV's in this one.
    got = subprocess.run([sys.executable, "-c", "import cv2; print(cv2.getNumThreads())"], capture_output=True, text=True, check=True)
    return {"torch": torch.get_num_threads(), "opencv": int(got.stdout.strip())}


# ── R6.2: the other time effects' own records ──────────────────────────────────


def vfx_ramp_sources(T: int, mode: str, speed: float, start_speed: float) -> dict:
    """Speed ramp's output count and source positions (nodes_video_pro.py:95-122, repeated line for line; the case
    checks them against the real node's frames): N, src_idx (float32, b64), idx_lo, idx_hi, frac (float32, b64)
    and the nearest frame; ramps add rate.mean().item()."""
    from comfy_extras.nodes_video_pro import _ease
    rec: dict = {}
    if mode == "constant":
        r = max(0.05, float(speed))
        N = max(1, int(round(T / r)))
        src_idx = torch.linspace(0, T - 1, N, dtype=torch.float32)
    else:
        r0 = max(0.05, float(start_speed))
        r1 = max(0.05, float(speed))
        K = 4096
        u = torch.linspace(0.0, 1.0, K, dtype=torch.float32)
        ease = _ease(u, {"ramp_in": "ease_in", "ramp_out": "ease_out"}.get(mode, "ease_in_out"))
        rate = r0 + (r1 - r0) * ease
        mean_rate = rate.mean().item()
        rec["meanRate"] = mean_rate
        N = max(1, int(round((T - 1) / max(1e-6, mean_rate))))
        cum = torch.cumsum(rate, dim=0)
        rec["cum_sha256"] = sha(cum.numpy().tobytes())
        if mode == "ramp_in_out":
            # torch's float cos (SLEEF, not correctly rounded) makes this sum LIBRARY: recorded whole, to measure against.
            rec["cum"] = b64(cum.numpy().tobytes())
        cum = cum / cum[-1] * (T - 1)
        probe_pos = torch.linspace(0.0, K - 1, N, dtype=torch.float32)
        lo = probe_pos.floor().long().clamp(0, K - 1)
        hi = (lo + 1).clamp(0, K - 1)
        f = probe_pos - lo.float()
        src_idx = (cum[lo] * (1.0 - f) + cum[hi] * f).clamp(0, T - 1)
    idx_lo = src_idx.floor().long().clamp(0, T - 1)
    idx_hi = (idx_lo + 1).clamp(0, T - 1)
    frac = (src_idx - idx_lo.float())
    nearest = src_idx.round().long().clamp(0, T - 1)
    rec.update({"N": N, "src": b64(src_idx.numpy().tobytes()), "lo": idx_lo.tolist(), "hi": idx_hi.tolist(),
                "frac": b64(frac.numpy().tobytes()), "nearest": nearest.tolist()})
    return rec


def vfx_ramp_check(rec: dict, frames: torch.Tensor, out: torch.Tensor, interpolation: str) -> None:
    """The repeated mapping is the node's: its frames equal the ones the mapping makes."""
    lo, hi, nearest = (torch.tensor(rec[k]) for k in ("lo", "hi", "nearest"))
    frac = torch.from_numpy(np.frombuffer(base64.b64decode(rec["frac"]), np.float32).copy()).view(-1, 1, 1, 1)
    want = frames[nearest] if interpolation == "nearest" else frames[lo] * (1.0 - frac) + frames[hi] * frac
    assert out.shape[0] == rec["N"] and torch.equal(want.clamp(0.0, 1.0), out), "the repeated Speed ramp mapping is not the node's"


def group_vfx_time(names: list[str]) -> dict:
    """The time effects: the pilots Trim, Reverse / ping-pong and Frame trail (R6.1); Motion blur (time), Slit scan,
    Time displacement and Speed ramp (R6.2)."""
    from comfy_extras import nodes_video_pro as nvp
    import tempfile
    from comfy_extras import nodes_video_effects as nve
    trail_defaults = {"decay": 0.85, "blend_mode": "screen", "intensity": 1.0, "threshold": 0.0}
    trim_defaults = {"start": 0, "end": -1}
    blur_defaults = {"radius": 2, "falloff": "gaussian"}
    slit_defaults = {"delay": 1.0, "axis": "horizontal", "wrap": False}
    disp_defaults = {"strength": 4.0, "noise_scale": 120.0, "wrap": True, "seed": 0}
    ramp_defaults = {"mode": "constant", "speed": 2.0, "start_speed": 1.0, "interpolation": "blend"}
    grids = {
        "FrameTrail": (nve.FrameTrailNode, vfx_grid(
            trail_defaults,
            {"decay": (0.0, 0.99, 0.5), "intensity": (0.0, 2.0, 0.7), "threshold": (0.0, 1.0, 0.37)},
            {"blend_mode": ["screen", "add", "max"]},
            [("threshold 0.37, add, intensity 1.6", {**trail_defaults, "threshold": 0.37, "blend_mode": "add", "intensity": 1.6}, "clip8-odd")],
        )),
        "VideoTrim": (nve.VideoTrimNode, vfx_grid(
            trim_defaults,
            {"start": (0, 10000, 3), "end": (-1, 10000, 5)},
            {},
            [
                ("end before start (5, 2): the first frame", {"start": 5, "end": 2}, "clip8"),
                ("end at start (4, 4): the first frame", {"start": 4, "end": 4}, "clip8"),
                ("end past the end (2, 50)", {"start": 2, "end": 50}, "clip8"),
                ("start past the end (20, -1): the first frame", {"start": 20, "end": -1}, "clip8"),
                ("one frame kept (7, 8)", {"start": 7, "end": 8}, "clip8-odd"),
                ("start 1 of two", {"start": 1, "end": -1}, "clip2"),
                ("start 1 of one: the first frame", {"start": 1, "end": -1}, "clip1"),
            ],
        )),
        "VideoReverse": (nve.VideoReverseNode, [
            (f"{mode}, {c}", {"mode": mode}, c) for mode in ("reverse", "ping_pong") for c in VFX_STANDARD
        ]),
        "TemporalMotionBlur": (nve.TemporalMotionBlurNode, vfx_grid(
            blur_defaults,
            {"radius": (1, 12, 5)},
            {"falloff": ["uniform", "linear", "gaussian"]},
            [(f"radius {r}, {fo}, {c}", {"radius": r, "falloff": fo}, c)
             for r, fo, c in ((3, "linear", "clip2"), (12, "gaussian", "clip8-odd"), (7, "uniform", "clip8-big"), (1, "linear", "clip8-odd"))],
        )),
        "SlitScan": (nve.SlitScanNode, vfx_grid(
            slit_defaults,
            {"delay": (0.0, 4.0, 1.35)},
            {"axis": ["horizontal", "vertical"], "wrap": [False, True]},
            [(f"delay {d}, {ax}, wrap {w}, {c}", {"delay": d, "axis": ax, "wrap": w}, c)
             for d in (0.0, 4.0) for ax in ("horizontal", "vertical") for w in (False, True) for c in ("clip8-odd",)]
            + [("delay 2.5, vertical, wrap, clip8-big", {"delay": 2.5, "axis": "vertical", "wrap": True}, "clip8-big")],
        )),
        "TimeDisplacement": (nve.TimeDisplacementNode, vfx_grid(
            disp_defaults,
            {"strength": (0.0, 30.0, 7.5), "noise_scale": (8.0, 400.0, 50.0), "seed": (0, 2**31 - 1, 12345)},
            {"wrap": [True, False]},
            [(f"noise_scale {ns}, seed {sd}, clip8-big", {**disp_defaults, "noise_scale": ns, "seed": sd}, "clip8-big")
             for ns in (8.0, 400.0) for sd in (0, 2**31 - 1)]
            + [("strength 30, no wrap, clip8-odd", {**disp_defaults, "strength": 30.0, "wrap": False}, "clip8-odd"),
               ("strength 0.5, noise_scale 8, clip2", {**disp_defaults, "strength": 0.5, "noise_scale": 8.0}, "clip2")],
        )),
        "SpeedRamp": (nvp.SpeedRampNode, vfx_grid(
            ramp_defaults,
            {"speed": (0.05, 10.0, 1.35), "start_speed": (0.05, 10.0, 0.7)},
            {"mode": ["constant", "ramp_in", "ramp_out", "ramp_in_out"], "interpolation": ["nearest", "blend"]},
            [(f"{m}, speed {sp}, start {st}", {**ramp_defaults, "mode": m, "speed": sp, "start_speed": st}, "clip8")
             for m in ("constant", "ramp_in", "ramp_out", "ramp_in_out") for sp in (0.05, 1.0, 10.0) for st in (0.05, 10.0)]
            + [(f"{m}, nearest, speed {sp}, start {st}, {c}", {**ramp_defaults, "mode": m, "speed": sp, "start_speed": st, "interpolation": "nearest"}, c)
               for m, sp, st, c in (("constant", 0.35, 1.0, "clip8-odd"), ("ramp_in", 3.0, 0.4, "clip8-big"), ("ramp_out", 0.3, 2.5, "clip8"),
                                    ("ramp_in_out", 0.5, 4.0, "clip8-odd"), ("constant", 0.4, 1.0, "clip2"))]
            + [("ramp_in_out, blend, speed 0.3, start 3, clip8-big", {**ramp_defaults, "mode": "ramp_in_out", "speed": 0.3, "start_speed": 3.0}, "clip8-big")],
        )),
    }
    cases: dict = {"threads": vfx_threads(), "clips": {k: {"frames": v[0], "w": v[1], "h": v[2], "seed": v[3]} for k, v in VFX_CLIPS.items()},
                   "inlineValues": VFX_INLINE_VALUES}
    with tempfile.TemporaryDirectory() as tmp:
        runs = []
        for class_type, (cls, grid) in grids.items():
            runs += vfx_cases(tmp, cls, class_type, grid)
        # Speed ramp's count and source frames (the brief: N and every index equal Python's), checked against its frames.
        for rec in runs:
            if rec["class_type"] == "SpeedRamp" and "out" in rec:
                w = rec["widgets"]
                frames = vfx_clip(rec["input"])
                if frames.shape[0] > 1:
                    rec["ramp"] = vfx_ramp_sources(int(frames.shape[0]), w["mode"], w["speed"], w["start_speed"])
                    args, _ui = vfx_run(nvp.SpeedRampNode, VFX_NODE_ID, frames=frames, **w)
                    vfx_ramp_check(rec["ramp"], frames, args[0], w["interpolation"])
        cases["runs"] = runs
        cases["saved"] = [
            vfx_saved(tmp, nve.FrameTrailNode, "FrameTrail", trail_defaults),
            vfx_saved(tmp, nve.VideoTrimNode, "VideoTrim", {"start": 2, "end": 6}),
            vfx_saved(tmp, nve.VideoReverseNode, "VideoReverse", {"mode": "ping_pong"}),
            vfx_saved(tmp, nve.SlitScanNode, "SlitScan", slit_defaults),
            vfx_saved(tmp, nve.TimeDisplacementNode, "TimeDisplacement", {**disp_defaults, "noise_scale": 8.0}),
            vfx_saved(tmp, nvp.SpeedRampNode, "SpeedRamp", {**ramp_defaults, "mode": "ramp_in_out", "speed": 0.5, "start_speed": 2.0}),
        ]
        cases["acceptance"] = vfx_acceptance(tmp)
    cases["graphs"] = vfx_graphs()
    return {"cases": cases}


# ── R6.3: joining two clips ────────────────────────────────────────────────────

# Rule 5's band, in 255-scale: where Python's 255·x (as each 8-bit form computes it) lies this close to the edge the
# form cuts at, a LIBRARY kernel may land on the other side (one step). R6.3's kernels differ from torch's by at most
# one float32 ulp (≈ 3 × 10⁻⁵ in 255-scale, measured): the band is eight times that.
VFX_BAND = 2.0 ** -12


def vfx_band(t: torch.Tensor, lo: int, hi: int, sums: tuple = ()) -> dict:
    """Rule 5's band list for frames [lo, hi) of a batch (the frames a LIBRARY kernel made): the flat indices (into the
    whole batch's T·H·W·3 values) where round-8's f32(clamp(x)·255) lies within VFX_BAND of a half, or trunc-8's
    f32(255·x) within VFX_BAND of a whole number; Python's 8-bit value at each; and each 8-bit form's sha256 with those
    places zeroed (the rest must be equal). An 8-bit level itself (x = f32(k / 255)) is left out (a kernel that lands
    exactly on one does so on both sides), except in the frames `sums` names, made by a sum whose order differs (the whip
    pan's box blur: a sum of equal parts lands on a level in one order and an ulp off it in another)."""
    x = np.ascontiguousarray(t.numpy()).reshape(-1)
    per = int(np.prod(t.shape[1:]))
    idx = np.arange(lo * per, hi * per)
    v = x[idx]
    levels = (np.arange(256, dtype=np.float32) / np.float32(255.0)).astype(np.float32)
    level = np.isin(v, levels) & ~np.isin(idx // per, np.array(sums, dtype=np.int64))
    r = (np.clip(v, 0, 1) * np.float32(255.0)).astype(np.float32)
    tr = (np.float32(255.0) * v).astype(np.float32)
    near_half = np.abs(r - np.floor(r) - 0.5) < VFX_BAND
    near_whole = (np.abs(tr - np.round(tr)) < VFX_BAND) & (tr > 0) & (tr < 255)
    rec: dict = {"round": idx[near_half & ~level].tolist(), "trunc": idx[near_whole & ~level].tolist()}
    for form, whole in (("round", vfx_round8(t)), ("trunc", vfx_trunc8(t))):
        b = np.frombuffer(whole, np.uint8).copy()
        at = np.array(rec[form], dtype=np.int64)
        rec[f"{form}_py"] = b[at].tolist()
        b[at] = 0
        rec[f"{form}8_masked_sha256"] = sha(b.tobytes())
    return rec


def vfx_join_layout(class_type: str, widgets: dict, ta: int, tb: int) -> dict:
    """The join's frame layout as the node works it out (nodes_video_effects.py:377-386, nodes_video_pro.py:858-860):
    each clip's kept range, the overlap d, and the output's head (A alone), transition and tail (B alone)."""
    if class_type == "VideoCrossfade":
        ia = max(0, min(int(widgets["trim_in_a"]), ta - 1))
        oa = ta if int(widgets["trim_out_a"]) < 0 else max(ia + 1, min(int(widgets["trim_out_a"]), ta))
        ib = max(0, min(int(widgets["trim_in_b"]), tb - 1))
        ob = tb if int(widgets["trim_out_b"]) < 0 else max(ib + 1, min(int(widgets["trim_out_b"]), tb))
    else:
        ia, oa, ib, ob = 0, ta, 0, tb
    d = max(1, min(int(widgets["duration"]), oa - ia, ob - ib))
    return {"a": [ia, oa], "b": [ib, ob], "d": d, "head": oa - ia - d, "tail": ob - ib - d}


def vfx_join_library(class_type: str, widgets: dict) -> bool:
    """Whether a case's transition frames are LIBRARY (the brief's classes): torch's cos (ease_in_out), affine_grid and
    conv2d (whip pan), the zoom's affine_grid, light leak's exp. Glitch is selection: its decisions are recorded exactly."""
    if widgets.get("style", "dissolve") in ("whip_pan_left", "whip_pan_right", "zoom_in", "zoom_out", "light_leak"):
        return True
    return widgets.get("style") != "glitch" and widgets["curve"] == "ease_in_out"


def vfx_blurred_frames(widgets: dict, lay: dict) -> tuple:
    """The output frames a whip pan blurs (kw > 1, nodes_video_pro.py:891-894, repeated): a sum in torch's order."""
    from comfy_extras.nodes_video_pro import TransitionNode
    if widgets.get("style") not in ("whip_pan_left", "whip_pan_right"):
        return ()
    alpha = TransitionNode._alpha_ramp(lay["d"], widgets["curve"], "cpu", torch.float32)
    return tuple(lay["head"] + i for i in range(lay["d"]) if max(1, int(15 * float(alpha[i] * (1 - alpha[i])) * 4 + 1)) > 1)


def vfx_join_cases(tmp: str, cls, class_type: str, grid: list[tuple]) -> list[dict]:
    """Each (name, widgets, clip A, clip B, seed) through the real node, in a fresh temp folder. A seed (the glitch)
    seeds torch's global generator first (ruling (e)), as R2.9 does."""
    out = []
    for name, widgets, ca, cb, seed in grid:
        rec: dict = {"name": name, "class_type": class_type, "node_id": VFX_NODE_ID, "widgets": widgets, "input": ca, "input_b": cb}
        if seed is not None:
            rec["seed"] = str(seed)
        _o, temp = fresh_dirs(tmp, f"{class_type}_{len(out)}")
        a, b = vfx_clip(ca), vfx_clip(cb)
        rec["layout"] = vfx_join_layout(class_type, widgets, int(a.shape[0]), int(b.shape[0]))
        try:
            if seed is not None:
                torch.manual_seed(seed)
            args, ui = vfx_run(cls, VFX_NODE_ID, clip_a=a, clip_b=b, **widgets)
            rec["out"] = vfx_batch(args[0])
            rec["ui"] = vfx_ui(ui)
            rec["preview"] = vfx_preview(temp, ui)
            lay = rec["layout"]
            assert rec["out"]["count"] == lay["head"] + lay["d"] + lay["tail"], (name, rec["out"]["count"], lay)
            if "f32" not in rec["out"] and vfx_join_library(class_type, widgets):
                rec["band"] = vfx_band(args[0], lay["head"], lay["head"] + lay["d"], vfx_blurred_frames(widgets, lay))
        except Exception as e:  # noqa: BLE001 - the error itself is the record
            rec["error"] = err(e)
        out.append(rec)
    return out


def vfx_glitch_draws(widgets: dict, ta: int, tb: int, seed: int) -> dict:
    """The glitch's decisions, repeated line for line (nodes_video_pro.py:913-930) from the same seed: per transition
    frame its alpha, the clip it reads, the colour offset, the band count and height, and each band's shift."""
    from comfy_extras.nodes_video_pro import TransitionNode
    d = max(1, min(int(widgets["duration"]), ta, tb))
    alpha = TransitionNode._alpha_ramp(d, widgets["curve"], "cpu", torch.float32)
    torch.manual_seed(seed)
    frames = []
    for i in range(d):
        t = float(alpha[i])
        intensity = 1.0 - abs(2.0 * t - 1.0)
        n = max(1, int(intensity * 12))
        dx = [int((torch.rand(1).item() - 0.5) * intensity * 80) for _ in range(n)]
        frames.append({"t": t, "fromB": not (t < 0.5), "offset": int(intensity * 30), "slices": n, "dx": dx})
    return {"d": d, "frames": frames}


def vfx_saved_join(tmp: str, cls, class_type: str, widgets: dict, ca: str, cb: str, seed: int | None = None) -> dict:
    """A join of two standard clips → Create video (24 fps) → Save video, libx264 as ComfyUI runs it and switched to
    libopenh264 (the glitch seeded first)."""
    from comfy_api.latest._input_impl import video_types
    from comfy_extras import nodes_video as nv
    Create, Save = (c.PREPARE_CLASS_CLONE({"hidden_inputs": VIDEO_HIDDEN}) for c in (nv.CreateVideo, nv.SaveVideo))
    if seed is not None:
        torch.manual_seed(seed)
    args, _ui = vfx_run(cls, VFX_NODE_ID, clip_a=vfx_clip(ca), clip_b=vfx_clip(cb), **widgets)
    rec: dict = {"class_type": class_type, "widgets": widgets, "input": ca, "input_b": cb, "fps": 24.0}
    if seed is not None:
        rec["seed"] = str(seed)
    for run, swap in (("x264", None), ("openh264", openh264_options(23))):
        out, temp = fresh_dirs(tmp, f"saved_{class_type}_{len(os.listdir(tmp))}_{run}")
        vid = Create.execute(images=args[0], fps=24.0, audio=None).result[0]
        with _patched(video_types, _AvShim(swap)):
            ui = video_ui_of(Save.execute(video=vid, filename_prefix="video/ComfyUI", format="auto", codec="auto"))
        saved = video_out(ui_file(out, temp, ui["images"][0]), None, False, False)
        rec[run] = {"ui": ui, "header": saved["header"], "frameCount": saved["frameCount"], "frameRate": saved["frameRate"],
                    "duration": saved["duration"], "frames": saved["frames"]}
    return rec


# The glitch's seeds (ruling (e)): torch keeps a seed's low 32 bits, so one past 2³² checks the runner does too.
VFX_GLITCH_SEEDS = (0, 12345, 2**64 - 1)


def group_vfx_join(names: list[str]) -> dict:
    """Crossfade and Transition (R6.3): two clips joined, the second resized to the first."""
    import tempfile
    from comfy_extras import nodes_video_effects as nve
    from comfy_extras import nodes_video_pro as nvp
    curves = ["linear", "ease_in_out", "ease_in", "ease_out"]
    styles = ["dissolve", "whip_pan_left", "whip_pan_right", "zoom_in", "zoom_out", "glitch", "light_leak"]
    pairs = [(c, "clip6-small") for c in VFX_STANDARD] + [("clip6-small", "clip8"), ("clip8", "clip8-odd"), ("clip8-big", "clip8"), ("clip8", "clip8-big")]
    xf = {"duration": 12, "curve": "ease_in_out", "trim_in_a": 0, "trim_out_a": -1, "trim_in_b": 0, "trim_out_b": -1}
    xf_grid = [(f"defaults, {a} + {b}", dict(xf), a, b, None) for a, b in pairs]
    for k, (lo, hi, mid) in {"duration": (1, 2400, 3), "trim_in_a": (0, 100000, 3), "trim_out_a": (-1, 100000, 5),
                             "trim_in_b": (0, 100000, 2), "trim_out_b": (-1, 100000, 4)}.items():
        for label, v in (("min", lo), ("max", hi), ("between", mid)):
            xf_grid.append((f"{k} {label} ({v})", {**xf, k: v}, "clip8", "clip6-small", None))
    for c in curves:
        for a, b in (("clip8", "clip6-small"), ("clip6-small", "clip8")):
            xf_grid.append((f"curve {c}, {a} + {b}", {**xf, "curve": c}, a, b, None))
    xf_grid += [
        ("duration 7 (past B only), linear", {**xf, "duration": 7, "curve": "linear"}, "clip8", "clip6-small", None),
        ("duration 1, ease_out", {**xf, "duration": 1, "curve": "ease_out"}, "clip8", "clip6-small", None),
        ("duration 3, ease_in, clip8-odd + clip2", {**xf, "duration": 3, "curve": "ease_in"}, "clip8-odd", "clip2", None),
        ("clip1 + clip1", {**xf, "curve": "linear"}, "clip1", "clip1", None),
        ("trim_in_a at the last frame (7)", {**xf, "trim_in_a": 7, "curve": "linear"}, "clip8", "clip6-small", None),
        ("trim_in_a past the end (8)", {**xf, "trim_in_a": 8, "curve": "linear"}, "clip8", "clip6-small", None),
        ("trim_out_a 0: one frame", {**xf, "trim_out_a": 0, "curve": "linear"}, "clip8", "clip6-small", None),
        ("trim_out_a before trim_in_a (5, 2): one frame", {**xf, "trim_in_a": 5, "trim_out_a": 2, "curve": "linear"}, "clip8", "clip6-small", None),
        ("trim_out_a at trim_in_a (4, 4): one frame", {**xf, "trim_in_a": 4, "trim_out_a": 4, "curve": "ease_in"}, "clip8", "clip6-small", None),
        ("trim_out_a at the end (8)", {**xf, "trim_out_a": 8, "curve": "linear"}, "clip8", "clip6-small", None),
        ("trim_in_b at the last frame (5)", {**xf, "trim_in_b": 5, "curve": "linear"}, "clip8", "clip6-small", None),
        ("trim_in_b past the end (6)", {**xf, "trim_in_b": 6, "curve": "ease_out"}, "clip8", "clip6-small", None),
        ("trim_out_b 0: one frame", {**xf, "trim_out_b": 0, "curve": "linear"}, "clip8", "clip6-small", None),
        ("trim_out_b before trim_in_b (4, 1): one frame", {**xf, "trim_in_b": 4, "trim_out_b": 1, "curve": "linear"}, "clip8", "clip6-small", None),
        ("trims on both (2, 7, 1, 5), duration 3", {**xf, "trim_in_a": 2, "trim_out_a": 7, "trim_in_b": 1, "trim_out_b": 5, "duration": 3, "curve": "linear"}, "clip8", "clip6-small", None),
        ("trims on both, sizes swapped", {**xf, "trim_in_a": 1, "trim_out_a": 4, "trim_in_b": 3, "trim_out_b": 8, "duration": 2, "curve": "ease_in"}, "clip6-small", "clip8", None),
    ]
    tr = {"style": "dissolve", "duration": 12, "curve": "ease_in_out"}
    tr_grid = [(f"defaults, {a} + {b}", dict(tr), a, b, None) for a, b in pairs]
    tr_grid += [(f"duration {label} ({v})", {**tr, "duration": v}, "clip8", "clip6-small", None) for label, v in (("min", 1), ("max", 240), ("between", 3))]
    for s in styles:
        for c in curves:
            for a, b in (("clip8", "clip6-small"), ("clip6-small", "clip8")):
                tr_grid.append((f"{s}, {c}, {a} + {b}", {**tr, "style": s, "curve": c}, a, b, 0 if s == "glitch" else None))
        for dur in (1, 3, 240):
            tr_grid.append((f"{s}, duration {dur}", {**tr, "style": s, "duration": dur, "curve": "linear"}, "clip8", "clip6-small", 0 if s == "glitch" else None))
    for s in styles:
        tr_grid.append((f"{s}, clip8-odd + clip8", {**tr, "style": s, "duration": 5, "curve": "ease_in"}, "clip8-odd", "clip8", 0 if s == "glitch" else None))
        tr_grid.append((f"{s}, clip8-big + clip8", {**tr, "style": s, "duration": 6, "curve": "linear"}, "clip8-big", "clip8", 0 if s == "glitch" else None))
    for seed in VFX_GLITCH_SEEDS:
        for c, a, b, dur in (("linear", "clip8", "clip8-odd", 8), ("ease_in_out", "clip8-odd", "clip6-small", 6), ("ease_out", "clip8-big", "clip8", 7)):
            tr_grid.append((f"glitch, seed {seed}, {c}, {a} + {b}, duration {dur}", {**tr, "style": "glitch", "duration": dur, "curve": c}, a, b, seed))
    cases: dict = {"threads": vfx_threads(), "clips": {k: {"frames": v[0], "w": v[1], "h": v[2], "seed": v[3]} for k, v in VFX_CLIPS.items()},
                   "inlineValues": VFX_INLINE_VALUES, "band": VFX_BAND}
    with tempfile.TemporaryDirectory() as tmp:
        runs = vfx_join_cases(tmp, nve.VideoCrossfadeNode, "VideoCrossfade", xf_grid)
        runs += vfx_join_cases(tmp, nvp.TransitionNode, "Transition", tr_grid)
        # The glitch's decisions, repeated line for line from the same seed (the brief: equal to Python exactly).
        for rec in runs:
            if rec["class_type"] == "Transition" and rec["widgets"]["style"] == "glitch" and "out" in rec:
                rec["glitch"] = vfx_glitch_draws(rec["widgets"], VFX_CLIPS[rec["input"]][0], VFX_CLIPS[rec["input_b"]][0], int(rec["seed"]))
        cases["runs"] = runs
        cases["saved"] = [
            vfx_saved_join(tmp, nve.VideoCrossfadeNode, "VideoCrossfade", {**xf, "duration": 4, "curve": "linear"}, "clip8", "clip6-small"),
            vfx_saved_join(tmp, nvp.TransitionNode, "Transition", {**tr, "duration": 5, "curve": "ease_in"}, "clip8", "clip6-small"),
            vfx_saved_join(tmp, nvp.TransitionNode, "Transition", {**tr, "style": "glitch", "duration": 6, "curve": "linear"}, "clip8", "clip8-odd", seed=12345),
        ]
    return {"cases": cases}


# ── R6.4: the frame looks ──────────────────────────────────────────────────────


def vfx_cube_identity() -> str:
    """The identity LUT at 2³ points (R changes fastest, as .cube files list them)."""
    rows = [f"{r} {g} {b}" for b in range(2) for g in range(2) for r in range(2)]
    return "LUT_3D_SIZE 2\n" + "\n".join(rows) + "\n"


def vfx_cube_warm() -> str:
    """A warm grade at 17³ points with a title, comments, blank lines, the domain lines (read, unused) and CRLF ends."""
    n = 17
    lines = ["# A warm grade (Sailor's fixture)", 'TITLE "Warm"', "", "LUT_3D_SIZE 17", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0", "# the table"]
    for b in range(n):
        for g in range(n):
            for r in range(n):
                x, y, z = r / (n - 1), g / (n - 1), b / (n - 1)
                lines.append(f"{min(1.0, x ** 0.9 * 1.06):.6f} {y ** 1.02:.6f} {z ** 1.1 * 0.9:.6f}")
    return "\r\n".join(lines) + "\r\n"


def vfx_cube_broken() -> str:
    """A LUT whose table is one row short of its stated size (Python prints the failure and hands the frames on)."""
    rows = [f"{r} {g} {b}" for b in range(2) for g in range(2) for r in range(2)][:-1]
    return "LUT_3D_SIZE 2\n" + "\n".join(rows) + "\n"


VFX_CUBES = {"identity.cube": vfx_cube_identity, "warm.cube": vfx_cube_warm, "broken.cube": vfx_cube_broken}


def vfx_look_clips() -> dict:
    """R6.4's own inputs, recorded whole (u8): clip8 turned upright (np.rot90: 16 × 24), and a green screen: `synth` noise
    in a box over a slightly varied green, 4 frames of 24 × 16."""
    base = (vfx_clip("clip8") * 255.0).round().to(torch.uint8).numpy()
    tall = np.ascontiguousarray(np.stack([np.rot90(f) for f in base]))
    green = []
    for i in range(4):
        f = np.zeros((16, 24, 3), np.uint8)
        yy, xx = np.mgrid[0:16, 0:24]
        f[..., 0] = (xx * 3 + i) % 40
        f[..., 1] = 200 + (yy * 5 + xx + i) % 56
        f[..., 2] = (xx + yy * 2) % 30
        box = np.frombuffer(synth(10, 8, 3, 7000 + i), np.uint8).reshape(8, 10, 3)
        f[4 + i % 2:12 + i % 2, 7 + i:17 + i] = box
        green.append(f)
    return {"clip8-tall": tall, "clip-green": np.stack(green)}


def vfx_look_input(extra: dict, name: str) -> torch.Tensor:
    if name in extra:
        return torch.from_numpy(extra[name].copy()) / 255.0
    return vfx_clip(name)


def vfx_autopan(frames: torch.Tensor, target: str) -> list[dict]:
    """Aspect convert's auto_pan choice per frame (nodes_video_pro.py:228-252, repeated line for line): the crop's edge
    (argmax) and every score it chose from (float32, b64), so a sum in another order is judged by rule 5's band."""
    import torch.nn.functional as F
    T, H, W, _ = frames.shape
    tw_, th_ = target.split(":")
    ar = float(tw_) / float(th_)
    if W / H > ar:
        ch, cw = H, int(round(H * ar))
    else:
        cw, ch = W, int(round(W / ar))
    lum = (0.2126 * frames[..., 0] + 0.7152 * frames[..., 1] + 0.0722 * frames[..., 2])
    if W > cw:
        var, k = lum.var(dim=1), cw
    else:
        var, k = lum.var(dim=2), ch
    kernel = torch.ones(k, dtype=frames.dtype) / k
    score = F.conv1d(var.unsqueeze(1), kernel.view(1, 1, -1), padding=0).squeeze(1)
    edge = score.argmax(dim=1)
    return [{"edge": int(edge[i]), "scores": b64(score[i].numpy().tobytes()), "var": b64(var[i].numpy().tobytes())} for i in range(T)]


def vfx_look_library(class_type: str, widgets: dict) -> bool:
    """The cases a band is recorded for (rule 5): every Ken Burns (its grid and cos) and LUT (its trilinear) case, and
    3-way color with a gamma other than 1 (pow); the spec decides each case's class and uses the band where it needs it."""
    if class_type == "KenBurns":
        return True
    if class_type == "ThreeWayCC":
        return any(float(widgets[k]) != 1.0 for k in ("gamma_r", "gamma_g", "gamma_b"))
    return class_type == "LUT"


def vfx_look_cases(tmp: str, cls, class_type: str, grid: list[tuple], extra: dict, input_name: str = "frames") -> list[dict]:
    """Each (name, widgets, input) through the real node, in a fresh temp folder (3-way color's input is `image`)."""
    out = []
    for name, widgets, clip in grid:
        rec: dict = {"name": name, "class_type": class_type, "node_id": VFX_NODE_ID, "widgets": widgets, "input": clip}
        _o, temp = fresh_dirs(tmp, f"{class_type}_{len(out)}")
        try:
            frames = vfx_look_input(extra, clip)
            args, ui = vfx_run(cls, VFX_NODE_ID, **{input_name: frames}, **widgets)
            rec["out"] = vfx_batch(args[0])
            rec["ui"] = vfx_ui(ui)
            rec["preview"] = vfx_preview(temp, ui)
            if "f32" not in rec["out"] and vfx_look_library(class_type, widgets):
                rec["band"] = vfx_band(args[0], 0, int(args[0].shape[0]))
            if class_type == "AspectConvert" and widgets["method"] == "auto_pan":
                rec["autopan"] = vfx_autopan(frames, widgets["target"])
            if class_type == "ChromaKey":
                rec["mask"] = {"count": int(args[1].shape[0]), "sha256": sha(np.ascontiguousarray(args[1].numpy()).tobytes())}
        except Exception as e:  # noqa: BLE001 - the error itself is the record
            rec["error"] = err(e)
        out.append(rec)
    return out


def group_vfx_look(names: list[str]) -> dict:
    """Ken Burns, Aspect convert, Chroma key, LUT and 3-way color (R6.4)."""
    import tempfile
    from comfy_extras import nodes_video_pro as nvp
    extra = vfx_look_clips()
    kb = {"start_zoom": 1.0, "end_zoom": 1.4, "start_x": 0.0, "start_y": 0.0, "end_x": 0.0, "end_y": 0.0, "easing": "ease_in_out"}
    ac = {"target": "9:16", "method": "crop_center", "pad_color": "#000000"}
    ck = {"key_color": "#00ff00", "tolerance": 0.25, "smoothness": 0.1, "spill_suppression": 0.5, "bg_color": "#000000"}
    lut = {"lut_file": "(none)", "strength": 1.0}
    tw = {"lift_r": 0.0, "lift_g": 0.0, "lift_b": 0.0, "gamma_r": 1.0, "gamma_g": 1.0, "gamma_b": 1.0, "gain_r": 1.0, "gain_g": 1.0, "gain_b": 1.0}
    targets = ["9:16", "1:1", "4:5", "16:9", "21:9", "4:3", "3:4"]
    methods = ["crop_center", "pad", "auto_pan"]
    grids = {
        "KenBurns": (nvp.KenBurnsNode, "frames", vfx_grid(
            kb,
            {"start_zoom": (1.0, 4.0, 2.35), "end_zoom": (1.0, 4.0, 1.85), "start_x": (-0.5, 0.5, 0.13), "start_y": (-0.5, 0.5, -0.21),
             "end_x": (-0.5, 0.5, -0.37), "end_y": (-0.5, 0.5, 0.29)},
            {"easing": ["linear", "ease_in", "ease_out", "ease_in_out"]},
            [("drift and zoom, clip8-odd", {**kb, "start_zoom": 1.2, "end_zoom": 3.1, "start_x": -0.3, "end_x": 0.25, "start_y": 0.1, "end_y": -0.4, "easing": "linear"}, "clip8-odd"),
             ("drift and zoom, clip8-big", {**kb, "start_zoom": 2.0, "end_zoom": 1.0, "start_x": 0.4, "end_y": 0.3, "easing": "ease_out"}, "clip8-big")],
        )),
        "AspectConvert": (nvp.AspectConvertNode, "frames", vfx_grid(
            ac, {}, {},
            [(f"{t}, {m}, {c}", {**ac, "target": t, "method": m, "pad_color": "#3a7fc2" if m == "pad" else ac["pad_color"]}, c)
             for c in ("clip8", "clip8-tall") for t in targets for m in methods]
            + [(f"pad colour {p!r}", {**ac, "method": "pad", "target": "1:1", "pad_color": p}, "clip8")
               for p in ("#fff", "  ##00ff7f ", "zz", "#12345", "-f0000", "#FFCC00")]
            + [("auto_pan 21:9, clip8-big", {**ac, "target": "21:9", "method": "auto_pan"}, "clip8-big"),
               ("auto_pan 9:16, clip8-big", {**ac, "target": "9:16", "method": "auto_pan"}, "clip8-big"),
               ("auto_pan 3:4, clip8-odd", {**ac, "target": "3:4", "method": "auto_pan"}, "clip8-odd"),
               ("pad 9:16, clip8-odd", {**ac, "target": "9:16", "method": "pad", "pad_color": "#808080"}, "clip8-odd")],
        )),
        "ChromaKey": (nvp.ChromaKeyNode, "frames", vfx_grid(
            ck,
            {"tolerance": (0.0, 1.0, 0.4), "smoothness": (0.0, 0.5, 0.2), "spill_suppression": (0.0, 1.0, 0.75)},
            {},
            [(f"green screen, tolerance {t}, smoothness {s}", {**ck, "tolerance": t, "smoothness": s}, "clip-green")
             for t, s in ((0.0, 0.0), (0.25, 0.0), (0.25, 0.25), (0.1, 0.5), (1.0, 0.5), (0.3, 0.1))]
            + [(f"green screen, spill {sp}", {**ck, "spill_suppression": sp}, "clip-green") for sp in (0.0, 0.01, 1.0)]
            + [(f"green screen, key {k!r}, bg {b!r}", {**ck, "key_color": k, "bg_color": b}, "clip-green")
               for k, b in (("#0f0", "#123456"), ("#00FF00", "#fff"), ("zz", "nope"), ("#808080", "#000"), ("#0000ff", "#ff00ff"), (" #20c040 ", "-f0000"))],
        )),
        "LUT": (nvp.LUTNode, "frames", vfx_grid(
            lut, {"strength": (0.0, 1.0, 0.5)}, {},
            [(f"{f}, strength {s}", {"lut_file": f, "strength": s}, "clip8") for f in VFX_CUBES for s in (0.0, 0.5, 1.0)]
            + [(f"{f}, strength {s}, {c}", {"lut_file": f, "strength": s}, c) for f, s, c in
               (("warm.cube", 1.0, "clip8-big"), ("warm.cube", 0.5, "clip8-odd"), ("warm.cube", 0.998, "clip8"), ("warm.cube", 0.999, "clip8"),
                ("identity.cube", 1.0, "clip8-big"), ("broken.cube", 1.0, "clip8-odd"), ("", 1.0, "clip8"))],
        )),
        "ThreeWayCC": (nvp.ThreeWayCCNode, "image", vfx_grid(
            tw,
            {"lift_r": (-0.5, 0.5, 0.12), "lift_g": (-0.5, 0.5, -0.07), "lift_b": (-0.5, 0.5, 0.2),
             "gamma_r": (0.1, 4.0, 1.7), "gamma_g": (0.1, 4.0, 0.6), "gamma_b": (0.1, 4.0, 2.2),
             "gain_r": (0.0, 4.0, 1.3), "gain_g": (0.0, 4.0, 0.8), "gain_b": (0.0, 4.0, 2.5)},
            {},
            [("a teal and orange grade, clip8-big", {"lift_r": 0.03, "lift_g": -0.02, "lift_b": 0.08, "gamma_r": 0.9, "gamma_g": 1.05, "gamma_b": 1.2,
                                                     "gain_r": 1.15, "gain_g": 1.0, "gain_b": 0.85}, "clip8-big"),
             ("lift only, clip8-odd", {**tw, "lift_r": 0.1, "lift_g": 0.1, "lift_b": -0.1}, "clip8-odd")],
        )),
    }
    cases: dict = {"threads": vfx_threads(), "clips": {k: {"frames": v[0], "w": v[1], "h": v[2], "seed": v[3]} for k, v in VFX_CLIPS.items()},
                   "inlineValues": VFX_INLINE_VALUES, "band": VFX_BAND,
                   "extraClips": {k: {"frames": int(v.shape[0]), "w": int(v.shape[2]), "h": int(v.shape[1]), "u8": b64(v.tobytes())} for k, v in extra.items()},
                   "cubes": {k: fn() for k, fn in VFX_CUBES.items()}}
    with tempfile.TemporaryDirectory() as tmp:
        inp = os.path.join(tmp, "input")
        os.makedirs(inp)
        for k, text in cases["cubes"].items():
            with open(os.path.join(inp, k), "w", encoding="ascii", newline="") as f:
                f.write(text)
        folder_paths.set_input_directory(inp)
        runs = []
        for class_type, (cls, input_name, grid) in grids.items():
            runs += vfx_look_cases(tmp, cls, class_type, grid, extra, input_name)
        # The LUT's own parse (nodes_video_pro.py:474-509), and its failures as Python words them.
        cases["cubeParse"] = {}
        for k in VFX_CUBES:
            try:
                size, arr = nvp._load_cube_lut(os.path.join(inp, k))
                cases["cubeParse"][k] = {"size": size, "f32_sha256": sha(np.ascontiguousarray(arr).tobytes())}
            except Exception as e:  # noqa: BLE001
                cases["cubeParse"][k] = {"error": err(e)}
        cases["runs"] = runs
        cases["saved"] = [
            vfx_saved(tmp, nvp.KenBurnsNode, "KenBurns", kb),
            vfx_saved(tmp, nvp.AspectConvertNode, "AspectConvert", {**ac, "target": "1:1"}),
            vfx_saved(tmp, nvp.LUTNode, "LUT", {"lut_file": "warm.cube", "strength": 1.0}),
        ]
    return {"cases": cases}


# ── R6.5: Stabilize and the shared FFT ────────────────────────────────────────

# The shaking patterns: name → (frames, w, h, margin, seed). Frame i is synth(w + 2m, h + 2m, 3, seed) cut at
# (m + dy_i, m + dx_i), the path drawn by numpy.random.default_rng(seed).integers(−m, m + 1, (frames, 2)).
VFX_SHAKES = {
    "shake-96x64": (12, 96, 64, 6, 8100),
    "shake-600x338": (12, 600, 338, 8, 8200),
}
# A frame's two highest correlation values closer than this (relatively) make its shift a tie (rule 5's band).
VFX_SHIFT_TIE = 1e-4


def vfx_shake(name: str) -> tuple[torch.Tensor, list[list[int]]]:
    n, w, h, m, seed = VFX_SHAKES[name]
    base = np.frombuffer(synth(w + 2 * m, h + 2 * m, 3, seed), np.uint8).reshape(h + 2 * m, w + 2 * m, 3)
    path = np.random.default_rng(seed).integers(-m, m + 1, size=(n, 2)).tolist()
    frames = np.stack([base[m + dy:m + dy + h, m + dx:m + dx + w] for dy, dx in path])
    return torch.from_numpy(np.ascontiguousarray(frames)) / 255.0, path


def vfx_stab_input(name: str) -> torch.Tensor:
    return vfx_shake(name)[0] if name in VFX_SHAKES else vfx_clip(name)


def vfx_stab_shifts(frames: torch.Tensor) -> list[dict]:
    """Stabilize's pass 1 (nodes_video_pro.py:986-1011, repeated line for line): each frame's (dy, dx), and the two
    highest values of its correlation (for rule 5's band: a tie within VFX_SHIFT_TIE may pick another place)."""
    import torch.nn.functional as F
    T, H, W, _ = frames.shape
    scale = max(1, max(H, W) // 256)
    lum = (0.2126 * frames[..., 0] + 0.7152 * frames[..., 1] + 0.0722 * frames[..., 2])
    small = F.avg_pool2d(lum.unsqueeze(1), kernel_size=scale).squeeze(1)
    Th, Tw = small.shape[-2], small.shape[-1]
    wy = torch.hann_window(Th, periodic=False, dtype=frames.dtype).view(-1, 1)
    wx = torch.hann_window(Tw, periodic=False, dtype=frames.dtype).view(1, -1)
    win = wy * wx
    f_prev = torch.fft.fft2(small[0] * win)
    out = [{"dy": 0, "dx": 0}]
    for i in range(1, T):
        f_cur = torch.fft.fft2(small[i] * win)
        R = f_cur * torch.conj(f_prev)
        R = R / (R.abs() + 1e-8)
        r = torch.fft.ifft2(R).real
        idx = torch.argmax(r)
        dy = int(idx // Tw)
        dx = int(idx % Tw)
        if dy > Th // 2: dy -= Th
        if dx > Tw // 2: dx -= Tw
        top = torch.topk(r.reshape(-1), 2).values.tolist() if r.numel() > 1 else [float(r.reshape(-1)[0]), float("-inf")]
        out.append({"dy": dy * scale, "dx": dx * scale, "top": top,
                    "tie": bool(r.numel() > 1 and top[0] - top[1] <= VFX_SHIFT_TIE * max(abs(top[0]), 1e-12))})
        f_prev = f_cur
    return out


def vfx_stab_cases(tmp: str, grid: list[tuple]) -> list[dict]:
    from comfy_extras import nodes_video_pro as nvp
    out = []
    for name, widgets, clip in grid:
        rec: dict = {"name": name, "class_type": "Stabilize", "node_id": VFX_NODE_ID, "widgets": widgets, "input": clip}
        _o, temp = fresh_dirs(tmp, f"Stabilize_{len(out)}")
        try:
            frames = vfx_stab_input(clip)
            args, ui = vfx_run(nvp.StabilizeNode, VFX_NODE_ID, frames=frames, **widgets)
            rec["out"] = vfx_batch(args[0])
            rec["ui"] = vfx_ui(ui)
            rec["preview"] = vfx_preview(temp, ui)
            if frames.shape[0] > 1:
                rec["shifts"] = vfx_stab_shifts(frames)
        except Exception as e:  # noqa: BLE001 - the error itself is the record
            rec["error"] = err(e)
        out.append(rec)
    return out


def vfx_fft_input(n: int, k: int) -> np.ndarray:
    """A fixed exact formula (the spec makes the same doubles): part k of n values."""
    j = np.arange(n, dtype=np.int64)
    if k == 0:
        return ((j * 7919 + 13) % 1000).astype(np.float64) / 1000.0 - 0.5
    return ((j * 104729 + 7) % 997).astype(np.float64) / 997.0 - 0.5


def c128(z: np.ndarray) -> str:
    """A complex array as interleaved float64 (re, im), base64."""
    return b64(np.ascontiguousarray(np.stack([z.real, z.imag], axis=-1).astype(np.float64)).tobytes())


def c64(z) -> str:
    z = np.asarray(z)
    return b64(np.ascontiguousarray(np.stack([z.real, z.imag], axis=-1).astype(np.float32)).tobytes())


def vfx_fft_cases() -> dict:
    lengths = list(range(1, 65)) + [256, 1000, 1024, 4096]
    one = []
    for n in lengths:
        x = vfx_fft_input(n, 0) + 1j * vfx_fft_input(n, 1)
        one.append({"n": n, "fft": c128(np.fft.fft(x)), "ifft": c128(np.fft.ifft(x)), "rfft": c128(np.fft.rfft(x.real))})
    two = []
    for h, w in ((9, 16), (144, 256)):
        x = (vfx_fft_input(h * w, 0) + 1j * vfx_fft_input(h * w, 1)).reshape(h, w)
        two.append({"h": h, "w": w, "fft2": c128(np.fft.fft2(x)), "ifft2": c128(np.fft.ifft2(x)),
                    "torch_fft2_c64": c64(torch.fft.fft2(torch.from_numpy(x.astype(np.complex64))).numpy())})
    f32 = []
    for n in (8, 64, 256, 1000, 1024, 4096):
        x = vfx_fft_input(n, 0).astype(np.float32)
        got = np.fft.rfft(x)
        assert got.dtype == np.complex64, got.dtype
        f32.append({"n": n, "rfft_c64": c64(got)})
    return {"numpy": np.__version__, "one": one, "two": two, "rfft32": f32}


def group_vfx_stabilize(names: list[str]) -> dict:
    """Stabilize (R6.5) and the shared FFT."""
    import tempfile
    from comfy_extras import nodes_video_pro as nvp
    st = {"smoothing": 0.85, "edge_mode": "crop", "crop_pad": 0.05}
    grid = vfx_grid(
        st, {"smoothing": (0.0, 0.99, 0.5), "crop_pad": (0.0, 0.3, 0.15)}, {"edge_mode": ["crop", "border"]},
        [(f"{c}, {e}, smoothing {s}, crop_pad {p}", {"smoothing": s, "edge_mode": e, "crop_pad": p}, c)
         for c in VFX_SHAKES for e in ("crop", "border") for s in (0.0, 0.85, 0.99) for p in (0.0, 0.3)
         if not (e == "border" and p == 0.3)]
        + [("border, clip8-odd", {**st, "edge_mode": "border"}, "clip8-odd"),
           ("crop 0.3, clip8-big", {**st, "crop_pad": 0.3}, "clip8-big")],
    )
    cases: dict = {"threads": vfx_threads(), "clips": {k: {"frames": v[0], "w": v[1], "h": v[2], "seed": v[3]} for k, v in VFX_CLIPS.items()},
                   "inlineValues": VFX_INLINE_VALUES, "band": VFX_BAND, "shiftTie": VFX_SHIFT_TIE,
                   "shakes": {k: {"frames": v[0], "w": v[1], "h": v[2], "margin": v[3], "seed": v[4], "path": vfx_shake(k)[1]} for k, v in VFX_SHAKES.items()}}
    with tempfile.TemporaryDirectory() as tmp:
        cases["runs"] = vfx_stab_cases(tmp, grid)
        cases["saved"] = [vfx_saved(tmp, nvp.StabilizeNode, "Stabilize", st)]
    cases["fft"] = vfx_fft_cases()
    return {"cases": cases}


GROUPS = {"probe": group_probe, "decode": group_decode, "encode": group_encode, "sound": group_sound, "video": group_video,
          "frames": group_frames, "timeline-media": group_timeline_media, "vfx-time": group_vfx_time, "vfx-join": group_vfx_join,
          "vfx-look": group_vfx_look, "vfx-stabilize": group_vfx_stabilize}


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
