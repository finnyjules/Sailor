// frontend/app/lib/spacetype/embedConfig.ts
// The ONE Space Type embed config builder. The studio's own "Export embed"
// (SpaceTypeSurface.vue's exportWebEmbed) and the Frame export's live route (the node's
// frame source `embed()`) both build their config here, so a wired Space Type layer that
// plays live in a Frame is exactly the piece a standalone embed plays.
//
// App-side only: this module imports the full effect registry and fetches fonts. It never
// travels into an embed bundle (the bundle only receives the config it builds).

import { getEffect } from './effects'
import { loopMultiplier } from './loop'
import { dimsFromState, type SpaceTypeState } from './state'
import { DEFAULT_POST } from './postSettings'
import { resolveShape } from './effects/loft'
import { effectiveLoopSeconds } from '~/lib/compositor/loopReconcile'
import { resolveFontFamily, fontHasWeightAxis } from '~/lib/font/resolveFamily'
import { fontSourceUrl, parseLibraryFontValue } from '~/lib/scene3d/outlines'
import { bufferToBase64, subsetFontBase64 } from '~/lib/embed/fontBytes'
import { bundleNameFor } from '~/lib/embed/surfaces'
import type { SpaceTypeEmbedConfig } from '~/lib/embed/surfaces/spacetype'
import type { StudioEmbed } from '~/lib/studio/frameSource'

/** Effects whose embed player was measured to match the editor (Task 4 of the Frame
 *  live-wired plan fills this from a pixel comparison). Until an effect is on this list, a
 *  wired layer of it keeps the pre-rendered route — which is always correct. */
export const LIVE_VERIFIED_EFFECTS: ReadonlySet<string> = new Set<string>([])

/** The seamless multiplier k: base loops one pass spans (1 unless the piece is seamless). */
function seamlessLoops(state: SpaceTypeState): number {
  return state.seamless ? loopMultiplier(getEffect(state.effectId).loopRates?.(state.params) ?? []) : 1
}

/** Seconds one pass lasts: effectiveLoopSeconds(loopDuration, loops). */
export function spaceTypeEmbedDuration(state: SpaceTypeState): number {
  return effectiveLoopSeconds(state.loopDuration, seamlessLoops(state))
}

/** The embed config for a saved Space Type state — the ONE builder the studio's own export
 *  and the Frame's live route share. `font` is the inlined face (or null). */
export function spaceTypeEmbedConfig(state: SpaceTypeState, font: SpaceTypeEmbedConfig['font']): SpaceTypeEmbedConfig {
  const [width, height] = dimsFromState(state)
  const config: SpaceTypeEmbedConfig = {
    // Canonical id (getEffect is case-insensitive) — what the studio export always sent.
    effectId: getEffect(state.effectId).id,
    params: { ...state.params },
    opts: {
      width, height, fps: state.fps, loopDuration: state.loopDuration,
      alpha: state.transparent, bgColor: state.bgColor,
      projection: state.projection ?? 'perspective',
      panX: state.panX ?? 0, panY: state.panY ?? 0,
    },
    duration: spaceTypeEmbedDuration(state),
    font,
    gradientStops: state.gradientStops.map(g => ({ ...g })),
    post: { ...(state.post ?? DEFAULT_POST) },
  }
  if (state.seamless) config.loops = seamlessLoops(state)
  return config
}

/** The face the embed inlines for a state: the family and weight resolved exactly as
 *  texOptsFromState / the embed's buildTexOpts resolve them (a static family pins to 400 so a
 *  single cut is never faux-bolded). */
export function spaceTypeEmbedFace(state: SpaceTypeState): { family: string; weight: number } {
  const family = resolveFontFamily(String(state.params.font))
  const weight = fontHasWeightAxis(family) ? Number(state.params.typeWeight ?? 700) : 400
  return { family, weight }
}

// Raw font bytes by family+weight, so re-exporting (or several wired layers on one face)
// doesn't re-fetch the file. Keyed by family+weight only, NOT text: the bytes are the same
// whatever the piece says. Subsetting depends on text and is NOT cached — it re-runs every
// export, a single local POST. Only successes are cached: a failed fetch is retried next
// time rather than pinning the face to "unavailable" for the rest of the page's life.
const fontBytesCache = new Map<string, ArrayBuffer>()

/** Fetch the actual font FILE for family+weight via fontSourceUrl (~/lib/scene3d/outlines) —
 *  the same `/api/scene3d/google-font-file` proxy the 3D Studio's text-extrude uses, which
 *  hands back a parseable TTF rather than the woff2 Google serves browsers. Null on any
 *  failure (a family Google doesn't have, a network error, …). */
async function fetchFontBytes(family: string, weight: number): Promise<ArrayBuffer | null> {
  const key = `${family}@${weight}`
  const hit = fontBytesCache.get(key)
  if (hit) return hit
  try {
    const res = await fetch(fontSourceUrl(`google:${family}@${weight}`))
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    fontBytesCache.set(key, buf)
    return buf
  } catch (e) {
    console.error('[space-type] embed export: font fetch failed', e)
    return null
  }
}

/** Fetch and subset the state's font as a data URL (moved from SpaceTypeSurface.vue).
 *  Subsetted to the piece's text plus basic Latin via `/sailor/font_subset`; a subsetting
 *  failure alone falls back to the full font. Null only when the font could not be fetched
 *  at all — the caller decides what that means (the studio export degrades to the viewer's
 *  system font and says so; the Frame's live route falls back to frames). */
export async function spaceTypeEmbedFont(state: SpaceTypeState): Promise<SpaceTypeEmbedConfig['font']> {
  const { family, weight } = spaceTypeEmbedFace(state)
  const buf = await fetchFontBytes(family, weight)
  if (!buf) return null
  const fullB64 = bufferToBase64(buf)
  const text = String(state.params.text ?? '')
  const subsetB64 = await subsetFontBase64(fullB64, text, '[space-type] embed export:')
  return { family, weight, dataUrl: `data:font/ttf;base64,${subsetB64 ?? fullB64}` }
}

// CSS generic families every browser provides — nothing to inline, so a null font is fine.
const SYSTEM_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'math', 'emoji', 'fangsong',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
])

/** Walk every JSON-valued param (fill lists, word/slot fills, Showcase content, …) and
 *  report the first thing in it the embed player cannot draw from the config alone. */
function jsonParamBlocker(params: SpaceTypeState['params']): string | null {
  let found: string | null = null
  const visit = (v: unknown): void => {
    if (found || !v || typeof v !== 'object') return
    if (Array.isArray(v)) { v.forEach(visit); return }
    const o = v as Record<string, unknown>
    // A Showcase image card (`fillKind: 'image'`, or a legacy card/image item that has a
    // `src` and no fillKind — tile.ts's parseContent migrates those to image cards).
    const hasSrc = typeof o.src === 'string' && o.src.length > 0
    if (hasSrc && (o.fillKind === 'image' || (o.fillKind === undefined && (o.kind === 'card' || o.kind === 'image')))) {
      found = 'it shows photos, which the player cannot carry'
      return
    }
    // A shader fill (Holographic included) resolves its effect from the app's shader
    // catalog, which the player does not have — it would draw the fallback instead.
    if (o.type === 'shader') { found = 'it uses a shader fill, which the player cannot draw'; return }
    Object.values(o).forEach(visit)
  }
  for (const value of Object.values(params)) {
    if (typeof value !== 'string') continue
    const t = value.trim()
    if (!(t.startsWith('[') || t.startsWith('{'))) continue
    let parsed: unknown
    try { parsed = JSON.parse(t) } catch { continue }
    visit(parsed)
    if (found) return found
  }
  return null
}

const NOT_VERIFIED = 'its effect has not been checked against the editor yet'

/** Why this state cannot play live faithfully, in words for the report/log — or null.
 *
 *  The "cannot carry" reasons are checked first, the verified list last, so a caller that
 *  wants only the former (Task 4's parity harness) passes `verified` containing the effect. */
export function liveEmbedBlocker(
  state: SpaceTypeState,
  verified: ReadonlySet<string> = LIVE_VERIFIED_EFFECTS,
): string | null {
  const effect = getEffect(state.effectId)
  const p = state.params
  // Boost builds its letters from vector outlines fetched at runtime (fontkit + a CDN woff2,
  // see ensureBoostFont); the player never loads them and would draw the bundled fallback.
  if (effect.id === 'boost') return 'it draws its letters from font outlines loaded from the web'
  // Loft's word shape reads real glyph outlines from scene3d/outlines' cache (warmed by the
  // studio's ensureEffectFonts); the player never warms it and would loft a plain oval.
  if (effect.id === 'loft' && resolveShape(p) === 'word') return 'its word shape needs the font\'s outlines, which the player cannot load'
  const fromJson = jsonParamBlocker(p)
  if (fromJson) return fromJson
  // A library font (`local:` token) resolves to its family only in the app; the player
  // would take the raw token as a family name and fall back to a system face.
  if (parseLibraryFontValue(String(p.font ?? ''))) return 'it uses a font from your library'
  // A single-weight family is pinned to 400 in the app (the catalog knows it is static).
  // The player has no catalog: effects that build their own glyph textures would ask for
  // the chosen weight and the browser would thicken the one cut it has.
  const family = resolveFontFamily(String(p.font))
  if (!fontHasWeightAxis(family) && Number(p.typeWeight ?? 700) !== 400) return 'the player would thicken its single-weight font'
  // An unset text case falls back to the effect's own default in the app (texOptsFromState)
  // but to capitals in the player (buildTexOpts).
  const caseDefault = String(effect.controls.find(c => c.key === 'textCase')?.default ?? 'upper')
  if (p.textCase === undefined && caseDefault !== 'upper') return 'the player would capitalise its text'
  if (!verified.has(effect.id)) return NOT_VERIFIED
  return null
}

/** For the node's frame source: null when blocked or when the font could not be inlined.
 *  `size` is the source's native size (the aspect the nested player keeps). `opts` exists
 *  for tests and the parity harness: the verified set and the font loader. */
export async function spaceTypeWiredEmbed(
  state: SpaceTypeState,
  size: { width: number; height: number },
  opts: { verified?: ReadonlySet<string>; loadFont?: (s: SpaceTypeState) => Promise<SpaceTypeEmbedConfig['font']> } = {},
): Promise<StudioEmbed | null> {
  const blocker = liveEmbedBlocker(state, opts.verified ?? LIVE_VERIFIED_EFFECTS)
  if (blocker) {
    console.info(`[space-type] wired layer exports as frames: ${blocker}`)
    return null
  }
  const font = await (opts.loadFont ?? spaceTypeEmbedFont)(state)
  if (!font && !SYSTEM_FAMILIES.has(spaceTypeEmbedFace(state).family.toLowerCase())) {
    console.info('[space-type] wired layer exports as frames: its font could not be inlined')
    return null
  }
  const config = spaceTypeEmbedConfig(state, font)
  return {
    surface: 'spacetype',
    bundle: bundleNameFor('spacetype', config),
    config,
    width: size.width,
    height: size.height,
    duration: spaceTypeEmbedDuration(state),
  }
}
