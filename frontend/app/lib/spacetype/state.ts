import { buildRibbonLabel } from './effects/ribbon'
import { getEffect } from './effects'
import { defaultsFromControls, RAW_WORD_EFFECTS } from './effect'
import { separatorFromParams } from './separator'
import { resolveFontFamily, fontHasWeightAxis } from '~/lib/font/resolveFamily'
import { parseLibraryFontValue } from '~/lib/scene3d/outlines'
import { googleFontCssUrl } from '~/data/google-fonts'
import { useLibraryFonts } from '~/composables/useLibraryFonts'
import type { SpaceTypeState } from '~~/shared/spacetype/state'

export type { SpaceTypeState } from '~~/shared/spacetype/state'

// Shared Space Type editor/node state. The modal (SpaceTypeSurface) DELEGATES
// its texOpts() to texOptsFromState below — one builder, three consumers (modal,
// node card + headless frame source, timeline clip renderer). It used to keep an
// inline copy while this module still resolved fonts against the retired
// VARIABLE_FONTS list, so any font the legacy list didn't know (every plain
// Google family the FontPicker emits, every `local:` library token) silently
// fell back to Inter on the card/wired path while the modal rendered it
// correctly — the render-parity drift class. Do not fork this logic again.

export const DIMS: Record<string, [number, number]> = {
  '1920 × 1080 (16:9)': [1920, 1080],
  '1080 × 1920 (9:16)': [1080, 1920],
  '1080 × 1080 (1:1)': [1080, 1080],
  '1280 × 720 (16:9)': [1280, 720],
  '960 × 540 (16:9)': [960, 540],
}

export function defaultSpaceTypeState(): SpaceTypeState {
  return {
    effectId: 'ribbon',
    params: defaultsFromControls(getEffect('ribbon').controls),
    gradientStops: [
      { color: '#3b5bff', on: true }, { color: '#ff3b3b', on: true },
      { color: '#ffd23b', on: true }, { color: '#ffffff', on: false },
    ],
    fps: 30, loopDuration: 6, dimsKey: '960 × 540 (16:9)', transparent: false, bgColor: '#0e0e10',
  }
}

export function dimsFromKey(key: string): [number, number] { return DIMS[key] ?? [960, 540] }

/** Output dims for a saved state. Explicit W/H win — the editor saves them for
 *  every selection, and for 'Custom' they are the only record of the real size
 *  (dimsFromKey would silently answer 960×540). Preset-key fallback covers
 *  configs saved before W/H existed. Completes the a4c55cd51 checkpoint, whose
 *  spec landed without this implementation. */
export function dimsFromState(s: Pick<SpaceTypeState, 'dimsKey' | 'W' | 'H'>): [number, number] {
  const w = Number(s.W), h = Number(s.H)
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return [Math.round(w), Math.round(h)]
  return dimsFromKey(s.dimsKey)
}

/** Resolve a stored font value (Google family, legacy VARIABLE_FONTS id, or
 *  `local:` library token) to the CSS family the atlas should rasterize with —
 *  the same branch the modal's displayFontFamily takes. */
function familyFromValue(value: string): string {
  const local = parseLibraryFontValue(value)
  return local ? local.family : resolveFontFamily(value || 'Inter')
}

// Families whose CSS has been injected this page load (Google <link> path only;
// library families are tracked by useLibraryFonts itself).
const loadedFontFamilies = new Set<string>()

/** Load the CSS face for a stored font value so the text atlas rasterizes with
 *  the real font. Mirrors the modal's ensureFont: `local:` tokens inject the
 *  library @font-face block; anything else resolves to a family and injects a
 *  Google Fonts stylesheet. Legacy VARIABLE_FONTS ids resolve via
 *  resolveFamily's LEGACY_FONT_IDS, so saved nodes keep working. */
export async function ensureSpaceTypeFont(value: string): Promise<void> {
  if (typeof document === 'undefined') return
  const local = parseLibraryFontValue(value)
  if (local) {
    useLibraryFonts().ensure(local.family)
    try { await document.fonts.load(`700 32px "${local.family}"`) } catch { /* best-effort */ }
    return
  }
  const family = resolveFontFamily(value || 'Inter')
  if (!loadedFontFamilies.has(family)) {
    const key = family.replace(/[^a-zA-Z0-9]/g, '_')
    if (!document.querySelector(`link[data-stg-font="${key}"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'; link.href = googleFontCssUrl(family); link.setAttribute('data-stg-font', key)
      document.head.appendChild(link)
    }
    loadedFontFamilies.add(family)
  }
  try { await document.fonts.load(`700 32px "${family}"`) } catch { /* best-effort */ }
}

/**
 * Text-texture options for one Space Type build — THE shared builder. The modal
 * passes its live variable-font axes via `extraAxes`; the card/headless/clip
 * paths have none (axes beyond weight aren't persisted), so they default empty.
 * Weight pinning for static families depends on the Google catalog cache
 * (setFontCatalog) — callers that can, should kick loadGoogleCatalog() and
 * rebuild when it lands (unknown families default to "variable", the same
 * optimistic default the modal shows).
 */
export function texOptsFromState(
  s: Pick<SpaceTypeState, 'effectId' | 'params' | 'gradientStops'>,
  extraAxes: Record<string, number> = {},
) {
  const effect = getEffect(s.effectId)
  const p = s.params
  const family = familyFromValue(String(p.font ?? ''))
  // Static families have no weight axis — pin to 400 so we don't faux-bold a single cut.
  const weight = fontHasWeightAxis(family) ? Number(p.typeWeight ?? 700) : 400
  // Multiple texts (one per line) → an N-row atlas the effect alternates between.
  // Only effects that DECLARE a `textList` control are multi-text-aware; others collapse
  // to the first text so an unwired effect never renders a stacked atlas by mistake.
  const multiAware = effect.controls.some(c => c.kind === 'textList')
  const rawTexts = String(p.text ?? '').split('\n').map(t => t.trim()).filter(Boolean)
  const texts = rawTexts.length ? rawTexts : ['']
  const rawWords = RAW_WORD_EFFECTS.has(effect.id)
  // Effects may opt out of the suite's force-uppercase default by declaring a `textCase`
  // control; when the param is unset, fall back to THAT control's declared default (not a
  // hardcoded 'upper'), otherwise an effect defaulting to 'asis' still force-uppercases.
  const textCaseDefault = String(effect.controls.find(c => c.key === 'textCase')?.default ?? 'upper')
  const asis = String(p.textCase ?? textCaseDefault) === 'asis'
  const caseMode = asis ? 'as-typed' as const : 'upper' as const
  const cased = (t: string) => (asis ? t : t.toUpperCase())
  const labels = multiAware
    ? texts.map(t => (rawWords ? cased(t) : buildRibbonLabel(t, caseMode)))
    : [rawWords ? cased(texts[0] ?? '') : buildRibbonLabel(texts[0] ?? '', caseMode)]
  // Atlas supersampling — see the modal's original comments: slit-scan fills the frame with
  // one quad (needs 3×), corner-pin posters one word per band (scale by band count), others 2×.
  const cpSS = texts.length <= 2 ? 5 : texts.length === 3 ? 4 : texts.length <= 5 ? 3 : 2
  const atlasSS = effect.id === 'cornerpin' ? cpSS : effect.id === 'slitscan' ? 3 : 2
  return {
    label: labels[0]!,
    labels,
    fontFamily: family,
    // STG-style names (typeWeight/typeYScale/typeXScale) with fallbacks so effects
    // that still use typeHeight keep working unchanged.
    fontWeight: weight,
    axes: { wght: weight, ...extraAxes },
    typeColor: String(p.typeColor),
    fontSizePx: Number(p.typeYScale ?? p.typeHeight ?? 180) * atlasSS,
    heightPx: 256 * atlasSS,
    scaleX: Number(p.typeXScale ?? 1),
    tracking: Number(p.tracking),
    strokeColor: '#000000',
    strokeWidth: Number(p.typeStroke),
    gradientStops: s.gradientStops.map(g => ({ ...g })),
    gradientOn: String(p.gradientMode) === 'on',
    uRepeat: Number(p.textRepeat),
    separator: separatorFromParams(effect.id, p),
  }
}
