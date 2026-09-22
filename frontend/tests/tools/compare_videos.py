"""Compare two video files frame by frame.

    .venv/bin/python frontend/tests/tools/compare_videos.py A.mp4 B.mp4

Prints JSON: per file — codec, frame count, frame rate, colour tags, alpha
range; and the mean absolute RGB difference between the two (0–255 scale),
over the frames both have. VP9 is decoded with libvpx-vp9: ffmpeg's native
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


def load(path):
    container = av.open(path)
    stream = container.streams.video[0]
    codec = stream.codec_context.name
    frames = []
    if codec == "vp9":
        dec = av.codec.CodecContext.create("libvpx-vp9", "r")
        for packet in container.demux(stream):
            # demux() ends with an empty packet, which already flushes the
            # decoder; flushing a second time raises EOFError.
            for f in dec.decode(packet):
                frames.append(f)
    else:
        frames = list(container.decode(stream))
    first = frames[0]
    cc = stream.codec_context
    tags = {
        "primaries": named(PRIMARIES, cc.color_primaries),
        "trc": named(TRC, cc.color_trc),
        "space": named(SPACE, cc.colorspace),
        "range": named(RANGE, cc.color_range),
    }
    rgba = np.stack([f.to_ndarray(format="rgba") for f in frames]).astype(np.int16)
    info = {
        "codec": codec,
        "frames": len(frames),
        "fps": float(stream.average_rate or 0),
        "tags": tags,
        "bitstream_space": named(SPACE, first.colorspace),
        "alpha_min": int(rgba[..., 3].min()),
        "alpha_max": int(rgba[..., 3].max()),
        "size": [int(rgba.shape[2]), int(rgba.shape[1])],
    }
    return info, rgba


def main():
    a_info, a = load(sys.argv[1])
    b_info, b = load(sys.argv[2])
    n = min(len(a), len(b))
    h = min(a.shape[1], b.shape[1])
    w = min(a.shape[2], b.shape[2])
    mae = float(np.abs(a[:n, :h, :w, :3] - b[:n, :h, :w, :3]).mean()) if n else None
    print(json.dumps({"a": a_info, "b": b_info, "mae_rgb": mae}, indent=2))


if __name__ == "__main__":
    main()
