"""Compare two video files frame by frame.

    .venv/bin/python frontend/tests/tools/compare_videos.py A.mp4 B.mp4

Prints JSON: per file — codec, frame count, frame rate, colour tags, alpha
range; and the mean absolute RGB difference between the two (0–255 scale),
over the frames both have. The two files are decoded in lockstep and the
difference summed frame by frame, so memory stays flat however long they are.
Different frame counts: the JSON still prints, with "frame_count_mismatch",
and the exit status is 1. VP9 is decoded with libvpx-vp9: ffmpeg's native
vp9 decoder silently drops a WebM's alpha plane and would report it opaque.

"tags" are the container's colour tags (what a player reads: the MP4 colr/SPS,
the WebM Colour element), named as ffmpeg names them; "bitstream_space" is the
matrix the first decoded frame carries (for VP9, the colour-space field in the
key frame header). RGB is converted with each frame's own matrix, so the
difference honours the tags.
"""
import json
import sys

import av
import numpy as np

# ffmpeg's AVColorPrimaries / AVColorTransferCharacteristic / AVColorSpace /
# AVColorRange numbers (PyAV exposes them as plain ints).
PRIMARIES = {1: "bt709", 2: "unknown", 4: "bt470m", 5: "bt470bg", 6: "smpte170m", 7: "smpte240m", 9: "bt2020", 12: "smpte432"}
TRC = {1: "bt709", 2: "unknown", 4: "gamma22", 5: "gamma28", 6: "smpte170m", 8: "linear", 13: "iec61966-2-1", 16: "smpte2084", 18: "arib-std-b67"}
SPACE = {0: "rgb", 1: "bt709", 2: "unknown", 5: "bt470bg", 6: "smpte170m", 7: "smpte240m", 9: "bt2020nc"}
RANGE = {0: "unknown", 1: "tv", 2: "pc"}


def named(table, value):
    return table.get(int(value), str(value))


class Video:
    """One file, decoded a frame at a time. Keeps only its own summary (codec,
    frame count, fps, tags, alpha range, size) — never the frames, so a long
    1080p pair costs two frames of memory, not the whole of both files."""

    def __init__(self, path):
        self.container = av.open(path)
        self.stream = self.container.streams.video[0]
        self.codec = self.stream.codec_context.name
        self.count = 0
        self.first_space = None
        self.alpha_min = 255
        self.alpha_max = 0
        self.size = None

    def frames(self):
        container, stream = self.container, self.stream
        if self.codec == "vp9":
            dec = av.codec.CodecContext.create("libvpx-vp9", "r")
            for packet in container.demux(stream):
                # demux() ends with an empty packet, which already flushes the
                # decoder; flushing a second time raises EOFError.
                for f in dec.decode(packet):
                    yield f
        else:
            yield from container.decode(stream)

    def take(self, f):
        """RGBA of one decoded frame, with this file's summary updated."""
        if self.first_space is None:
            self.first_space = f.colorspace
        rgba = f.to_ndarray(format="rgba").astype(np.int16)
        self.count += 1
        self.alpha_min = min(self.alpha_min, int(rgba[..., 3].min()))
        self.alpha_max = max(self.alpha_max, int(rgba[..., 3].max()))
        self.size = [int(rgba.shape[1]), int(rgba.shape[0])]
        return rgba

    def info(self):
        cc = self.stream.codec_context
        tags = {
            "primaries": named(PRIMARIES, cc.color_primaries),
            "trc": named(TRC, cc.color_trc),
            "space": named(SPACE, cc.colorspace),
            "range": named(RANGE, cc.color_range),
        }
        return {
            "codec": self.codec,
            "frames": self.count,
            "fps": float(self.stream.average_rate or 0),
            "tags": tags,
            "bitstream_space": named(SPACE, self.first_space) if self.first_space is not None else None,
            "alpha_min": int(self.alpha_min) if self.count else None,
            "alpha_max": int(self.alpha_max) if self.count else None,
            "size": self.size,
        }


def main():
    a, b = Video(sys.argv[1]), Video(sys.argv[2])
    fa_iter, fb_iter = a.frames(), b.frames()
    diff_sum = 0      # sum of |A - B| over R, G, B of the frames both have
    diff_count = 0    # number of values summed
    while True:
        fa = next(fa_iter, None)
        fb = next(fb_iter, None)
        if fa is None and fb is None:
            break
        ra = a.take(fa) if fa is not None else None
        rb = b.take(fb) if fb is not None else None
        if ra is not None and rb is not None:
            h = min(ra.shape[0], rb.shape[0])
            w = min(ra.shape[1], rb.shape[1])
            diff_sum += int(np.abs(ra[:h, :w, :3] - rb[:h, :w, :3]).sum(dtype=np.int64))
            diff_count += h * w * 3
    mae = diff_sum / diff_count if diff_count else None
    out = {"a": a.info(), "b": b.info(), "mae_rgb": mae}
    mismatch = a.count != b.count
    if mismatch:
        out["frame_count_mismatch"] = True
    print(json.dumps(out, indent=2))
    if mismatch:
        sys.exit(1)


if __name__ == "__main__":
    main()
