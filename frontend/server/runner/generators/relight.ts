/**
 * The Relight node's instruction, ported whole from
 * comfy_extras/_relight_prompts.py, plus the tolerant light-JSON reading
 * RelightNode.execute (comfy_extras/nodes_relight.py) does before it.
 * The gimbal's {azimuth, elevation, intensity}, the preset, the background
 * toggle and the optional reference become one director's note.
 */
import { pyMod } from '#shared/runner/pyText'
import { pyFloatOf } from './opts'

/** Preset → mood/colour/quality clause. "Custom" = neutral white, gimbal only. */
export const PRESET_PHRASES: Readonly<Record<string, string>> = {
  'Custom': '',
  'Golden hour': 'warm golden-hour sunlight, long soft shadows, amber tones',
  'Studio softbox': 'clean studio softbox lighting, gentle falloff, neutral white balance',
  'Hard noon': 'harsh midday sun, hard-edged shadows, high contrast, cool daylight',
  'Blue hour': 'cool blue-hour twilight, soft ambient light, moody desaturated tones',
  'Rim/backlight': 'strong rim/backlight separating the subject from the background, glowing edges',
  'Window light': 'soft directional window light, natural indoor falloff',
  'Neon night': 'colourful neon night lighting, saturated magenta and cyan accents, urban glow',
  'Candlelit': 'warm low-key candlelight, flickering amber glow, deep shadows',
  'Overcast soft': 'flat overcast daylight, very soft shadows, even cool illumination',
}

export const PRESETS: readonly string[] = Object.keys(PRESET_PHRASES)

/** Python's max(lo, min(hi, v)), argument order kept: a NaN reads as `hi`, as in Python. */
function pyClamp(v: number, lo: number, hi: number): number {
  const m = v < hi ? v : hi
  return m > lo ? m : lo
}

/** Azimuth in [-180, 180]: 0 = front, +90 = right, ±180 = behind. 45° buckets. */
function directionPhrase(azimuthDeg: number): string {
  const a = pyMod(azimuthDeg + 180, 360) - 180
  const aa = Math.abs(a)
  if (aa < 22.5) return 'from the front'
  if (aa > 157.5) return 'from behind'
  if (a > 0) {
    if (aa < 67.5) return 'from the front-right'
    if (aa < 112.5) return 'from the right'
    return 'from the back-right'
  }
  if (aa < 67.5) return 'from the front-left'
  if (aa < 112.5) return 'from the left'
  return 'from the back-left'
}

/** Elevation in [-90, 90]: 0 = eye level (omitted), + = above, - = below. */
function elevationPhrase(elevationDeg: number): string | null {
  const e = pyClamp(elevationDeg, -90, 90)
  if (Math.abs(e) < 15) return null
  if (e > 0) {
    if (e < 45) return 'above'
    if (e < 75) return 'high above'
    return 'directly overhead'
  }
  const ae = Math.abs(e)
  if (ae < 45) return 'slightly below'
  if (ae < 75) return 'below'
  return 'far below'
}

/** Intensity in [0, 1] → strength/quality word. */
function intensityPhrase(intensity: number): string {
  const i = pyClamp(intensity, 0, 1)
  if (i < 0.25) return 'soft, diffused'
  if (i < 0.5) return 'moderate'
  if (i < 0.75) return 'strong, defined'
  return 'dramatic, high-contrast'
}

/** e.g. (0, 0, 0.6) → "a strong, defined key light from the front". */
export function lightToPhrase(azimuth: number, elevation: number, intensity: number): string {
  let phrase = `a ${intensityPhrase(intensity)} key light ${directionPhrase(azimuth)}`
  const height = elevationPhrase(elevation)
  if (height) phrase += `, positioned ${height}`
  return phrase
}

/** The full nano-banana-2 relight instruction. */
export function relightInstruction(
  preset: string,
  azimuth: number,
  elevation: number,
  intensity: number,
  keepBackground: boolean,
  hasReference: boolean,
  instructions = '',
): string {
  const parts = [`Relight the image with ${lightToPhrase(azimuth, elevation, intensity)}.`]
  const presetPhrase = Object.prototype.hasOwnProperty.call(PRESET_PHRASES, preset) ? PRESET_PHRASES[preset]! : ''
  if (presetPhrase) parts.push(`Lighting style: ${presetPhrase}.`)
  if (keepBackground) {
    parts.push(
      'Keep the subject, composition, pose, background and colours exactly as '
      + 'they are — change ONLY the lighting and the shadows it casts.',
    )
  }
  else {
    parts.push(
      'You may transform the surrounding environment and background to suit the '
      + 'new lighting; keep the subject\'s identity and pose.',
    )
  }
  if (hasReference) {
    parts.push(
      'A second image is provided as a lighting reference — match its lighting '
      + 'direction, quality and colour temperature.',
    )
  }
  const extra = (instructions || '').trim()
  if (extra) parts.push(`Additional direction: ${extra}.`)
  parts.push('Output only the edited image.')
  return parts.join(' ')
}

const UNREADABLE = 'The light setting can’t be read'

/**
 * `float(cfg.get(key, def) or def)`: a missing or falsy value (0, "", null,
 * false, [] or {}) is the default — so an intensity of 0 reads as 0.6, as in
 * Python. true is 1. A numeric string is read. Anything else fails the node,
 * as float() raises in Python.
 */
function pyFloatOr(v: unknown, def: number): number {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return def
  if (typeof v === 'number') return v
  if (v === true) return 1
  if (typeof v === 'string') {
    const f = pyFloatOf(v)
    if (f === null) throw new Error(UNREADABLE)
    return f
  }
  if (Array.isArray(v) && v.length === 0) return def
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) return def
  throw new Error(UNREADABLE)
}

/**
 * RelightNode.execute's reading of the gimbal JSON: unreadable text, or JSON
 * that is not an object, reads as {} (every value at its default).
 */
export function parseLight(raw: unknown): { azimuth: number; elevation: number; intensity: number } {
  let cfg: Record<string, unknown> = {}
  if (typeof raw === 'string' && raw) {
    try {
      const v: unknown = JSON.parse(raw)
      if (v && typeof v === 'object' && !Array.isArray(v)) cfg = v as Record<string, unknown>
    }
    catch { cfg = {} }
  }
  return {
    azimuth: pyFloatOr(cfg.azimuth, 0),
    elevation: pyFloatOr(cfg.elevation, 0),
    intensity: pyFloatOr(cfg.intensity, 0.6),
  }
}
