// Written by scripts/runner_effects_fixtures.py --group cells. Do not edit.
/**
 * The characters the Ascii glyph atlas holds (server/runner/effects/asciiGlyphs.bin, step 3 R2.6):
 * the union of the node's eight presets and printable ASCII 32–126, by code point. A custom
 * `characters` ramp with any other character leaves the node to the engine.
 */
export const ASCII_GLYPH_CHARACTERS = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u00b7\u2022\u2261\u2588\u2591\u2592\u2593\u25cf\u2801\u2807\u283f\u28ff"

/** The node's preset ramps (nodes_glsl_stylize.py _ASCII_PRESETS), light to dark. */
export const ASCII_PRESETS: Readonly<Record<string, string>> = {"classic": " .:-=+*#%@", "blocks": " \u2591\u2592\u2593\u2588", "dots": " .\u00b7\u2022\u25cf", "lines": " -=\u2261", "letters": " EFTLIVH#", "numbers": " 1234567890", "binary": " 01", "braille": " \u2801\u2807\u283f\u28ff"}

/** The ramp a custom text shorter than two characters falls back to (_ASCII_DEFAULT). */
export const ASCII_DEFAULT = " .'`-:_+=<>*xX$#@%"
