"""Writes frontend/tests/unit/fixtures/runner-lipsync-engines.json: the first
provider call the REAL LipSyncNode.execute makes (step 3, R11.3) on its
Fabric and Kling engines ("sync"), over the widget engine, the studio's
`model_options` (engine, resolution, face_image / face_video / audio), and a
wired sound. Python's raises (no sound, no picture, no video) are recorded in
Python's words.

Stand-ins, so the payload names what was sent:
  - a wired sound's WAV (`_audio_dict_to_wav_data_url`) is
    `data:audio/wav;base64,V0FW` (Fabric sends it as is; Kling uploads it to
    fal storage as "lipsync-voice.mp3", which `_upload_public_file` records as
    `UPLOAD:lipsync-voice.mp3`);
  - a `/view` upload is `FILE:<name>` for Fabric (`_local_ref_to_data_url`)
    and `UPLOAD:<name>` for Kling (`_lipsync_hosted_media_url` reads the file
    from a temporary input folder and uploads it).

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_lipsync_engines_fixtures.py

The network is blocked and the provider keys are removed before any node
module is imported.
"""
import json
import os
import sys
import tempfile
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from runner_video_leftovers_fixtures import block_network  # noqa: E402  (already blocked on import)

sys.path.insert(0, ROOT)
import runner_builder_fixtures  # noqa: E402

OUT = os.path.join(ROOT, "frontend", "tests", "unit", "fixtures", "runner-lipsync-engines.json")

FACE_PNG = "/view?filename=face.png&type=input"
FACE_MP4 = "/view?filename=face.mp4&type=input"
VOICE_MP3 = "/view?filename=voice.mp3&type=input"
HTTPS_PNG = "https://example.com/face.png"
HTTPS_MP4 = "https://example.com/face.mp4"
HTTPS_MP3 = "https://example.com/voice.mp3"


def opts(**kw) -> str:
    return json.dumps(kw)


# (name, widget engine, widget resolution, model_options text, wired sound?)
CASES = [
    # The studio's own options (app/lib/lipsync/compile.ts).
    ("Fabric from the studio, 720p", "auto", "720p", opts(engine="fabric", resolution="720p", audio=VOICE_MP3, face_image=FACE_PNG), False),
    ("Fabric from the studio, 480p", "auto", "720p", opts(engine="fabric", resolution="480p", audio=VOICE_MP3, face_image=FACE_PNG), False),
    ("Fabric from the studio, 1080p", "auto", "720p", opts(engine="fabric", resolution="1080p", audio=VOICE_MP3, face_image=FACE_PNG), False),
    ("Kling from the studio", "auto", "720p", opts(engine="sync", resolution="720p", audio=VOICE_MP3, face_video=FACE_MP4, sync_mode="cut_off"), False),
    # auto: a video → Kling, otherwise Fabric.
    ("auto with a face video", "auto", "720p", opts(audio=VOICE_MP3, face_video=FACE_MP4), False),
    ("auto with a face picture", "auto", "720p", opts(audio=VOICE_MP3, face_image=FACE_PNG), False),
    ("auto with both: the video wins", "auto", "720p", opts(audio=VOICE_MP3, face_image=FACE_PNG, face_video=FACE_MP4), False),
    ("an unknown engine is auto", "auto", "720p", opts(engine="mystery", audio=VOICE_MP3, face_image=FACE_PNG), False),
    ("the widget's engine without options", "fabric", "480p", opts(audio=VOICE_MP3, face_image=FACE_PNG), False),
    ("the widget's sync engine", "sync", "720p", opts(audio=VOICE_MP3, face_video=FACE_MP4), False),
    ("the options' engine wins over the widget", "sync", "720p", opts(engine="fabric", audio=VOICE_MP3, face_image=FACE_PNG), False),
    ("an empty face video is no video", "auto", "720p", opts(audio=VOICE_MP3, face_image=FACE_PNG, face_video=""), False),
    # Resolutions as Python reads them.
    ("Fabric, the widget's resolution", "fabric", "480p", opts(audio=VOICE_MP3, face_image=FACE_PNG), False),
    ("Fabric, an upper-case resolution", "fabric", "720p", opts(resolution="480P", audio=VOICE_MP3, face_image=FACE_PNG), False),
    ("Fabric, a number for the resolution", "fabric", "720p", opts(resolution=480, audio=VOICE_MP3, face_image=FACE_PNG), False),
    # Web addresses, sent as typed.
    ("Fabric, an https face", "fabric", "720p", opts(audio=VOICE_MP3, face_image=HTTPS_PNG), False),
    ("Kling, an https sound", "sync", "720p", opts(audio=HTTPS_MP3, face_video=FACE_MP4), False),
    # A wired sound: Python's WAV of its first 60 s.
    ("Fabric, a wired sound", "fabric", "720p", opts(face_image=FACE_PNG), True),
    ("Fabric, a wired sound wins over the options' sound", "fabric", "480p", opts(face_image=FACE_PNG, audio=VOICE_MP3), True),
    ("Kling, a wired sound", "sync", "720p", opts(face_video=FACE_MP4), True),
    # Broken or odd options: {} (the widget then decides).
    ("broken options", "fabric", "720p", '{"engine":', False),
    ("options that are not an object", "sync", "720p", '["sync"]', False),
    # Python's raises.
    ("no sound", "fabric", "720p", opts(face_image=FACE_PNG), False),
    ("Fabric with no face picture", "fabric", "720p", opts(audio=VOICE_MP3), False),
    ("Kling with no face video", "sync", "720p", opts(audio=VOICE_MP3), False),
]


def main() -> None:
    nr = runner_builder_fixtures._node_modules()[0]
    out = []
    with tempfile.TemporaryDirectory() as folder:
        for name in ("face.png", "face.mp4", "voice.mp3"):
            with open(os.path.join(folder, name), "wb") as f:
                f.write(name.encode())
        patches = [
            mock.patch.object(nr, "_audio_dict_to_wav_data_url", lambda a, max_seconds=None: (
                "data:audio/wav;base64,V0FW" if max_seconds == 60 else f"WRONG-CAP:{max_seconds}")),
            mock.patch.object(nr, "_local_ref_to_data_url", lambda name: f"FILE:{name}"),
            mock.patch.object(nr.folder_paths, "get_input_directory", lambda: folder),
        ]
        for p in patches:
            p.start()
        try:
            for name, engine, resolution, options, wired in CASES:
                kwargs = {"engine": engine, "resolution": resolution, "sync_mode": "cut_off", "model_options": options}
                if wired:
                    kwargs["audio"] = {"waveform": "SOUND", "sample_rate": 44100}
                case = {"name": name, "engine": engine, "resolution": resolution, "model_options": options, "wired_audio": wired}
                try:
                    call = runner_builder_fixtures.capture_first_call(nr.LipSyncNode, **kwargs)
                except RuntimeError as e:
                    case["error"] = str(e)
                    out.append(case)
                    continue
                assert not call.get("passthrough"), name
                case.update(provider=call["provider"], endpoint=call["endpoint"], payload=call["payload"])
                out.append(case)
        finally:
            for p in patches:
                p.stop()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"cases": out}, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {OUT}: {len(out)} cases")


if __name__ == "__main__":
    block_network()
    main()
