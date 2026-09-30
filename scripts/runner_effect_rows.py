"""Writes frontend/shared/runner/effectSchemas.generated.ts: the node schema of
every still-picture effect the Sailor runner ports (step 3, stage R2), read
from the REAL node classes, so the runner's eligibility rows (shared/runner/
effects.ts effectRows) carry ComfyUI's own widgets and limits.

For each class: its family (the list below), its IMAGE and MASK inputs (and
whether each is optional), its widgets as ComfyUI's validate_inputs reads them
(type, required, min, max, COMBO options), its outputs ('image' | 'mask') and
whether it is an output node. Inputs and widgets come from the class's
INPUT_TYPES(), which ComfyUI builds from define_schema() and which is what
validate_inputs and /object_info read; outputs and is_output_node from
define_schema() itself.

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_effect_rows.py

With `--media` (step 3, R6.1) it writes frontend/shared/runner/
mediaEffectSchemas.generated.ts instead: the video and sound effects of R6
(and Save audio (Opus), which joins R5's `media-sound`), each with its family,
its IMAGE (frame batch) and AUDIO inputs, its widgets as validate_inputs reads
them, its outputs ('image' | 'mask' | 'audio') and whether it is an output
node. A COMBO that lists the files of a folder (LUT's `lut_file`, Audio
waveform's `audio_file`) is written as a `fileList` widget with no options:
its list is whatever that machine's folder holds, so it can't be generated.

    cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python scripts/runner_effect_rows.py --media

Running either again gives identical bytes. The network is blocked (as in
runner_cards_fixtures.py) before any node module is imported.
"""
import importlib
import json
import os
import socket
import sys

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
OUT = os.path.join(ROOT, "frontend", "shared", "runner", "effectSchemas.generated.ts")

# The 78 still-picture effects of the toolbox (inventory §1(b)) and Painter
# (spec ruling 4), by family (plan R2): class → (module, family).
EFFECTS: dict[str, tuple[str, str]] = {}


def _family(family: str, module: str, *classes: str) -> None:
    for c in classes:
        assert c not in EFFECTS, c
        EFFECTS[c] = (module, family)


# effects-tone (R2.1 pilots, R2.4): 29
_family("effects-tone", "nodes_adjust_brightness_contrast", "AdjustBrightnessContrast")
_family("effects-tone", "nodes_adjust_color", "AdjustColor")
_family("effects-tone", "nodes_adjust_curves", "AdjustCurves")
_family("effects-tone", "nodes_adjust_exposure", "AdjustExposure")
_family("effects-tone", "nodes_adjust_levels", "AdjustLevels")
_family("effects-tone", "nodes_color_filters", "AdjustTemperature", "AdjustVibrance", "AdjustColorBalance", "AdjustBlackWhite",
        "AdjustPhotoFilter", "AdjustGradientMap", "AdjustChannelMixer", "AdjustInvert", "AdjustPosterize", "AdjustThreshold")
_family("effects-tone", "nodes_tone_extras", "AdjustVignette", "AdjustShadowsHighlights")
_family("effects-tone", "nodes_glsl_grading", "Duotone", "SplitToning")
_family("effects-tone", "nodes_glsl_unicorn", "GradientMap", "Posterize", "Hologram", "TwoDLight")
_family("effects-tone", "nodes_glsl_atmosphere", "LightLeak", "LensFlare")
_family("effects-tone", "nodes_glsl_lab", "Caustics", "Blinds")
_family("effects-tone", "nodes_glsl_stylize", "CrossHatch", "Dither")
# effects-blur (R2.5): 13
_family("effects-blur", "nodes_sharpen_noise", "Sharpen", "Denoise")
_family("effects-blur", "nodes_tone_extras", "AdjustGlow")
_family("effects-blur", "nodes_stylize", "HighPass", "Emboss", "FindEdges")
_family("effects-blur", "nodes_blur", "Blur")
_family("effects-blur", "nodes_glsl_lens", "Bokeh")
_family("effects-blur", "nodes_glsl_lab", "TiltShift", "FrequencySeparation", "HeightmapRelief")
_family("effects-blur", "nodes_glsl_unicorn", "Outline", "Sparkle")
# effects-cells (R2.6): 4
_family("effects-cells", "nodes_stylize", "Pixelate")
_family("effects-cells", "nodes_glsl_lens", "Halftone")
_family("effects-cells", "nodes_glsl_stylize", "Kuwahara", "Ascii")
# effects-warp (R2.7): 15
_family("effects-warp", "nodes_geometry", "CropImage", "ResizeImage", "RotateImage", "FlipImage")
_family("effects-warp", "nodes_distortion", "Pinch", "Twirl", "Wave", "LensCorrection")
_family("effects-warp", "nodes_glsl_distortion", "Kaleidoscope", "PolarCoords", "Fisheye")
_family("effects-warp", "nodes_glsl_lens", "ChromaticAberration", "CRT")
_family("effects-warp", "nodes_glsl_unicorn", "Mirror")
_family("effects-warp", "nodes_glsl_atmosphere", "GodRays")
# effects-mask (R2.8): 6 and Painter
_family("effects-mask", "nodes_composite", "Blend", "ApplyMask", "ThresholdMask", "ColorRangeMask")
_family("effects-mask", "nodes_matte", "MatteGrowShrink", "MergeAlpha")
_family("effects-mask", "nodes_painter", "Painter")
# effects-noise (R2.9): 11
_family("effects-noise", "nodes_glsl_atmosphere", "FilmGrain")
_family("effects-noise", "nodes_glsl_distortion", "Glitch")
_family("effects-noise", "nodes_glsl_generative", "PerlinNoise", "Voronoi", "GradientGenerator")
_family("effects-noise", "nodes_glsl_lab", "PaletteQuantize")
_family("effects-noise", "nodes_glsl_fractal", "ReactionDiffusion", "Fractal")
_family("effects-noise", "nodes_glsl_unicorn", "Stipple", "FlowField")
_family("effects-noise", "nodes_sharpen_noise", "AddNoise")

assert len(EFFECTS) == 79, len(EFFECTS)

WIDGET_TYPES = ("FLOAT", "INT", "BOOLEAN", "STRING", "COMBO", "COLOR")


# The video and sound effects of R6 (plan R6, the family table), and Save audio (Opus), which joins R5's
# `media-sound` (R6 ruling (o)): class → (module, family).
MEDIA: dict[str, tuple[str, str]] = {}


def _media(family: str, module: str, *classes: str) -> None:
    for c in classes:
        assert c not in MEDIA, c
        MEDIA[c] = (module, family)


_media("video-time", "nodes_video_effects", "FrameTrail", "VideoReverse", "VideoTrim", "TemporalMotionBlur", "SlitScan", "TimeDisplacement")
_media("video-time", "nodes_video_pro", "SpeedRamp")
_media("video-join", "nodes_video_effects", "VideoCrossfade")
_media("video-join", "nodes_video_pro", "Transition")
_media("video-look", "nodes_video_pro", "KenBurns", "AspectConvert", "ChromaKey", "LUT", "ThreeWayCC")
_media("video-stabilize", "nodes_video_pro", "Stabilize")
_media("video-flow", "nodes_frame_interp", "FrameInterpolate")
_media("video-draw", "nodes_video_effects", "AnimatedNoise")
_media("video-draw", "nodes_video_pro", "AudioWaveform")
_media("video-text", "nodes_text", "TextClip")
_media("video-text", "nodes_video_pro", "CaptionTrack")
_media("sound-effects", "nodes_audio", "TrimAudioDuration", "SplitAudioChannels", "JoinAudioChannels", "AudioConcat", "AudioMerge",
       "AudioAdjustVolume", "EmptyAudio", "AudioEqualizer3Band")
_media("sound-effects", "nodes_audio_effects", "AudioFade", "AudioNormalize", "AudioDuck", "VideoSilenceCut")
_media("sound-denoise", "nodes_audio_denoise", "AudioDenoise")
_media("media-sound", "nodes_audio", "SaveAudioOpus")

# 21 video, 12 sound, and Save audio (Opus).
assert len(MEDIA) == 34, len(MEDIA)

# The COMBOs that list a folder's files: written without their options (they differ by machine).
FILE_LIST_WIDGETS = {("LUT", "lut_file"), ("AudioWaveform", "audio_file")}

MEDIA_FAMILIES = ("video-time", "video-join", "video-look", "video-stabilize", "video-flow", "video-draw", "video-text",
                  "sound-effects", "sound-denoise", "media-sound")


def node_classes(table: dict[str, tuple[str, str]] = EFFECTS) -> dict[str, type]:
    """Every class of `table` by its node id, from its module."""
    import utils.install_util  # noqa: F401
    found: dict[str, type] = {}
    for module in sorted({m for m, _ in table.values()}):
        mod = importlib.import_module(f"comfy_extras.{module}")
        for name in dir(mod):
            obj = getattr(mod, name)
            if not isinstance(obj, type) or obj.__module__ != mod.__name__ or not hasattr(obj, "define_schema"):
                continue
            try:
                schema = obj.define_schema()
            except Exception:
                continue
            if schema.node_id in table and table[schema.node_id][0] == module:
                assert schema.node_id not in found, schema.node_id
                found[schema.node_id] = obj
    missing = sorted(set(table) - set(found))
    assert not missing, missing
    return found


def widget_row(kind: str, info: dict, required: bool) -> dict:
    if kind == "COMBO" or isinstance(kind, list):
        options = info.get("options", kind if isinstance(kind, list) else None)
        assert isinstance(options, list) and all(isinstance(o, str) for o in options), options
        return {"type": "COMBO", "required": required, "options": options}
    assert kind in WIDGET_TYPES, kind
    row: dict = {"type": kind, "required": required}
    if kind in ("FLOAT", "INT"):
        for key in ("min", "max"):
            if key in info:
                v = info[key]
                assert isinstance(v, (int, float)) and not isinstance(v, bool), (key, v)
                row[key] = v
    return row


def schema_row(cls: type, family: str) -> dict:
    schema = cls.define_schema()
    types = cls.INPUT_TYPES()
    images: list[dict] = []
    masks: list[dict] = []
    widgets: dict[str, dict] = {}
    for section in ("required", "optional"):
        for name, spec in (types.get(section) or {}).items():
            kind = spec[0]
            info = spec[1] if len(spec) > 1 else {}
            required = section == "required"
            if kind == "IMAGE":
                images.append({"name": name, "required": required})
            elif kind == "MASK":
                masks.append({"name": name, "required": required})
            else:
                widgets[name] = widget_row(kind, info, required)
    outputs = []
    for o in schema.outputs:
        io_type = o.io_type if hasattr(o, "io_type") else o.get_io_type()
        assert io_type in ("IMAGE", "MASK"), (schema.node_id, io_type)
        outputs.append("image" if io_type == "IMAGE" else "mask")
    return {
        "family": family,
        "images": images,
        "masks": masks,
        "widgets": widgets,
        "outputs": outputs,
        "outputNode": bool(schema.is_output_node),
    }


def ts_value(v, indent: int = 0) -> str:
    """JSON as TypeScript, one class per line block, keys in a fixed order."""
    return json.dumps(v, ensure_ascii=False, separators=(", ", ": "))


def media_schema_row(cls: type, family: str) -> dict:
    """A media effect's row: its frame-batch (IMAGE) and sound (AUDIO) inputs, widgets, outputs, output node."""
    schema = cls.define_schema()
    types = cls.INPUT_TYPES()
    frames: list[dict] = []
    sounds: list[dict] = []
    widgets: dict[str, dict] = {}
    for section in ("required", "optional"):
        for name, spec in (types.get(section) or {}).items():
            kind = spec[0]
            info = spec[1] if len(spec) > 1 else {}
            required = section == "required"
            if kind == "IMAGE":
                frames.append({"name": name, "required": required})
            elif kind == "AUDIO":
                sounds.append({"name": name, "required": required})
            elif (schema.node_id, name) in FILE_LIST_WIDGETS:
                assert kind == "COMBO" or isinstance(kind, list), (schema.node_id, name, kind)
                widgets[name] = {"type": "COMBO", "required": required, "fileList": True}
            else:
                assert kind != "MASK", (schema.node_id, name)
                widgets[name] = widget_row(kind, info, required)
    outputs = []
    for o in schema.outputs:
        io_type = o.io_type if hasattr(o, "io_type") else o.get_io_type()
        assert io_type in ("IMAGE", "MASK", "AUDIO"), (schema.node_id, io_type)
        outputs.append({"IMAGE": "image", "MASK": "mask", "AUDIO": "audio"}[io_type])
    return {
        "family": family,
        "frames": frames,
        "sounds": sounds,
        "widgets": widgets,
        "outputs": outputs,
        "outputNode": bool(schema.is_output_node),
    }


MEDIA_OUT = os.path.join(ROOT, "frontend", "shared", "runner", "mediaEffectSchemas.generated.ts")


def main_media() -> None:
    classes = node_classes(MEDIA)
    rows = {name: media_schema_row(classes[name], MEDIA[name][1]) for name in sorted(MEDIA)}
    fams = " | ".join(f"'{f}'" for f in MEDIA_FAMILIES)
    lines = [
        "/**",
        " * GENERATED by scripts/runner_effect_rows.py --media from the real node",
        " * classes (define_schema / INPUT_TYPES). Do not edit: run the script again.",
        " *",
        " * The video and sound effects the runner ports (step 3, R6): 21 video and",
        " * 12 sound effects, and Save audio (Opus) (R5's `media-sound`), each with its",
        " * family, frame-batch (IMAGE) and sound (AUDIO) inputs, widgets as ComfyUI's",
        " * validate_inputs reads them, outputs, and whether it is an output node. A",
        " * `fileList` widget is a COMBO of a folder's files (written with no options).",
        " */",
        "",
        f"export type MediaEffectSchemaFamily = {fams}",
        "",
        "export interface MediaEffectSchemaInput { name: string; required: boolean }",
        "",
        "export interface MediaEffectSchemaWidget {",
        "  type: 'FLOAT' | 'INT' | 'BOOLEAN' | 'STRING' | 'COMBO'",
        "  required: boolean",
        "  min?: number",
        "  max?: number",
        "  options?: readonly string[]",
        "  fileList?: true",
        "}",
        "",
        "export interface MediaEffectSchema {",
        "  family: MediaEffectSchemaFamily",
        "  frames: readonly MediaEffectSchemaInput[]",
        "  sounds: readonly MediaEffectSchemaInput[]",
        "  widgets: Readonly<Record<string, MediaEffectSchemaWidget>>",
        "  outputs: readonly ('image' | 'mask' | 'audio')[]",
        "  outputNode: boolean",
        "}",
        "",
        "export const MEDIA_EFFECT_SCHEMAS: Readonly<Record<string, MediaEffectSchema>> = {",
    ]
    for name, row in rows.items():
        lines.append(f"  {name}: {{")
        lines.append(f"    family: {json.dumps(row['family'])},")
        lines.append(f"    frames: {ts_value(row['frames'])},")
        lines.append(f"    sounds: {ts_value(row['sounds'])},")
        if row["widgets"]:
            lines.append("    widgets: {")
            for w, spec in row["widgets"].items():
                lines.append(f"      {json.dumps(w)}: {ts_value(spec)},")
            lines.append("    },")
        else:
            lines.append("    widgets: {},")
        lines.append(f"    outputs: {ts_value(row['outputs'])},")
        lines.append(f"    outputNode: {'true' if row['outputNode'] else 'false'},")
        lines.append("  },")
    lines.append("}")
    text = "\n".join(lines) + "\n"
    with open(MEDIA_OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"wrote {len(rows)} media effect schemas → {os.path.relpath(MEDIA_OUT, ROOT)}")


def main() -> None:
    if "--media" in sys.argv[1:]:
        main_media()
        return
    classes = node_classes()
    rows = {name: schema_row(classes[name], EFFECTS[name][1]) for name in sorted(EFFECTS)}
    lines = [
        "/**",
        " * GENERATED by scripts/runner_effect_rows.py from the real node classes",
        " * (define_schema / INPUT_TYPES). Do not edit: run the script again.",
        " *",
        " * The still-picture effects the runner ports (step 3, R2): 78 effects and",
        " * Painter, each with its family, IMAGE and MASK inputs, widgets as ComfyUI's",
        " * validate_inputs reads them, outputs, and whether it is an output node.",
        " */",
        "",
        "export type EffectSchemaFamily = 'effects-tone' | 'effects-blur' | 'effects-cells' | 'effects-warp' | 'effects-mask' | 'effects-noise'",
        "",
        "export interface EffectSchemaInput { name: string; required: boolean }",
        "",
        "export interface EffectSchemaWidget {",
        "  type: 'FLOAT' | 'INT' | 'BOOLEAN' | 'STRING' | 'COMBO' | 'COLOR'",
        "  required: boolean",
        "  min?: number",
        "  max?: number",
        "  options?: readonly string[]",
        "}",
        "",
        "export interface EffectSchema {",
        "  family: EffectSchemaFamily",
        "  images: readonly EffectSchemaInput[]",
        "  masks: readonly EffectSchemaInput[]",
        "  widgets: Readonly<Record<string, EffectSchemaWidget>>",
        "  outputs: readonly ('image' | 'mask')[]",
        "  outputNode: boolean",
        "}",
        "",
        "export const EFFECT_SCHEMAS: Readonly<Record<string, EffectSchema>> = {",
    ]
    for name, row in rows.items():
        lines.append(f"  {name}: {{")
        lines.append(f"    family: {json.dumps(row['family'])},")
        lines.append(f"    images: {ts_value(row['images'])},")
        lines.append(f"    masks: {ts_value(row['masks'])},")
        if row["widgets"]:
            lines.append("    widgets: {")
            for w, spec in row["widgets"].items():
                lines.append(f"      {json.dumps(w)}: {ts_value(spec)},")
            lines.append("    },")
        else:
            lines.append("    widgets: {},")
        lines.append(f"    outputs: {ts_value(row['outputs'])},")
        lines.append(f"    outputNode: {'true' if row['outputNode'] else 'false'},")
        lines.append("  },")
    lines.append("}")
    text = "\n".join(lines) + "\n"
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"wrote {len(rows)} effect schemas → {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
