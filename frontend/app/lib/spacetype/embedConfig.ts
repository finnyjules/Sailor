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
import { parseContent } from './tile'
import { effectiveLoopSeconds } from '~/lib/compositor/loopReconcile'
import { resolveFontFamily, fontHasWeightAxis } from '~/lib/font/resolveFamily'
import { fontSourceUrl, parseLibraryFontValue } from '~/lib/scene3d/outlines'
import { bufferToBase64, subsetFontBase64 } from '~/lib/embed/fontBytes'
import { bundleNameFor } from '~/lib/embed/surfaces'
import type { SpaceTypeEmbedConfig } from '~/lib/embed/surfaces/spacetype'
import type { StudioEmbed } from '~/lib/studio/frameSource'

/** Effects whose embed player was measured to match the editor (Task 4 of the Frame
 *  live-wired plan fills this from a pixel comparison). Until an effect is on this list, a
 *  wired layer of it keeps the pre-rendered route — which is always correct.
 *  Measured by tests/spacetype-live-parity.spec.ts on each effect's default state; exactly the
 *  effects that passed. That spec fails if one of these stops matching. */
export const LIVE_VERIFIED_EFFECTS: ReadonlySet<string> = new Set<string>([
  'ribbon', 'ticker', 'field', 'coil', 'streamer', 'spiral', 'tunnel', 'contour', 'ring', 'slot',
  'showcoverring', 'showsphere', 'showglobe', 'showcloud', 'showdome', 'showspiral', 'showbloom',
  'showcoverflow', 'showfocus', 'showfilmstrip', 'showtotem', 'showfeed', 'showcascade', 'showgrid',
  'showmarquee', 'showiso', 'showturntable', 'showparallax', 'showorbit', 'showhalo', 'showwheel',
  'showvortex', 'showstack', 'showtunnel', 'showdeck', 'showslide', 'showfan', 'showstage',
  'showfocusshift', 'showtrail', 'showburst', 'showtoss', 'showdance', 'showmedley',
])

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

/** Effects that draw every glyph themselves at the CSS default weight — their own canvas
 *  text names no weight (ctx.font = '<px>px "<family>", …') — and never show the shared
 *  text atlas (their buildScene ignores it). They have no Type weight control. Whatever the
 *  family, the one weight they draw is 400, so 400 is the face the embed must carry.
 *  tests/unit/spacetype-embed-config.unit.spec.ts scans the effect sources to keep this list
 *  complete. */
export const DEFAULT_WEIGHT_EFFECTS: ReadonlySet<string> = new Set(['contour', 'spiral', 'tunnel', 'streamer'])

/** The weight the effects' own glyph code asks for on a family with a weight axis. */
function requestedWeight(p: SpaceTypeState['params']): number {
  return Number(p.typeWeight ?? 700)
}

/** The family a state's font value names, resolved the way the app does (an unset font is
 *  Inter, as texOptsFromState's familyFromValue and the embed's buildTexOpts both default). */
function familyOf(p: SpaceTypeState['params']): string {
  return resolveFontFamily(String(p.font ?? ''))
}

/** The face the embed inlines for a state: the family, and the one weight the effect draws.
 *  That is the weight texOptsFromState / the embed's buildTexOpts resolve (a static family
 *  pins to 400 so a single cut is never faux-bolded), except for DEFAULT_WEIGHT_EFFECTS,
 *  which draw at 400 whatever the Type weight says. The proxy serves one STATIC instance
 *  per weight (never the variable file), so the inlined face covers exactly this weight. */
export function spaceTypeEmbedFace(state: SpaceTypeState): { family: string; weight: number } {
  const family = familyOf(state.params)
  if (DEFAULT_WEIGHT_EFFECTS.has(getEffect(state.effectId).id)) return { family, weight: 400 }
  const weight = fontHasWeightAxis(family) ? requestedWeight(state.params) : 400
  return { family, weight }
}

/** Every character the chosen effect can draw for this state, for the font subset: each
 *  text the effect's Type controls hold (the text, Slot's filler tokens, Loft's word, …) as
 *  typed; the words of Showcase's content list; the upper-cased form of all of those when
 *  the text case is capitals ("crème" is drawn "CRÈME", and "È" is not "è"); and basic
 *  Latin (U+0020–U+007E, which covers Slot's built-in glyph sets). Each character once, in
 *  first-seen order. Pure. */
export function spaceTypeSubsetText(state: SpaceTypeState): string {
  const effect = getEffect(state.effectId)
  const p = state.params
  const texts: string[] = []
  for (const c of effect.controls) {
    if (c.kind === 'text' || c.kind === 'textList') {
      texts.push(String(p[c.key] ?? c.default ?? ''))
    } else if (c.kind === 'contentList') {
      for (const item of parseContent(String(p[c.key] ?? c.default ?? '[]'))) {
        if (item.kind === 'word') texts.push(String(item.text ?? ''))
      }
    }
  }
  // Capitals unless the piece says as-typed on an effect that honours it. An effect with no
  // Case control capitalises (the app and the player agree), and so does an unset case
  // (the player's default), so the only as-typed-only case is an explicit 'asis' that the
  // effect's own Case control reads.
  const honoursCase = effect.controls.some(c => c.key === 'textCase')
  const upper = !(honoursCase && String(p.textCase ?? 'upper') === 'asis')
  const chars = new Set<string>()
  const add = (t: string) => { for (const ch of t) chars.add(ch) }
  for (const t of texts) {
    add(t)
    if (upper) add(t.toUpperCase())
  }
  for (let cp = 0x20; cp <= 0x7e; cp++) chars.add(String.fromCharCode(cp))
  return [...chars].join('')
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
    // Bounded: once wired layers take the live route, a stalled proxy would otherwise stall
    // the whole Frame export here. A timeout is a failure like any other (frames).
    const res = await fetch(fontSourceUrl(`google:${family}@${weight}`), { signal: AbortSignal.timeout(10_000) })
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
 *  Subsetted to every character the effect can draw (spaceTypeSubsetText, basic Latin
 *  included) via `/sailor/font_subset`; a subsetting
 *  failure alone falls back to the full font. Null only when the font could not be fetched
 *  at all — the caller decides what that means (the studio export degrades to the viewer's
 *  system font and says so; the Frame's live route falls back to frames). */
export async function spaceTypeEmbedFont(state: SpaceTypeState): Promise<SpaceTypeEmbedConfig['font']> {
  const { family, weight } = spaceTypeEmbedFace(state)
  const buf = await fetchFontBytes(family, weight)
  if (!buf) return null
  const fullB64 = bufferToBase64(buf)
  const subsetB64 = await subsetFontBase64(fullB64, spaceTypeSubsetText(state), '[space-type] embed export:')
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
  // the chosen weight and the browser would thicken the one cut it has. Two kinds of effect
  // ask the same weight in both places, so they are fine: Pile never pins (it asks the Type
  // weight in the app too), and DEFAULT_WEIGHT_EFFECTS always ask 400.
  const pinsWeight = effect.id !== 'pile' && !DEFAULT_WEIGHT_EFFECTS.has(effect.id)
  if (pinsWeight && !fontHasWeightAxis(familyOf(p)) && requestedWeight(p) !== 400) return 'the player would thicken its single-weight font'
  // An unset text case falls back to the effect's own default in the app (texOptsFromState)
  // but to capitals in the player (buildTexOpts).
  const caseDefault = String(effect.controls.find(c => c.key === 'textCase')?.default ?? 'upper')
  if (p.textCase == null && caseDefault !== 'upper') return 'the player would capitalise its text'
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
    // debug, not info: a fallback is not an error, and until the verified list fills most
    // wired layers take it on every export.
    console.debug(`[space-type] wired layer exports as frames: ${blocker}`)
    return null
  }
  const font = await (opts.loadFont ?? spaceTypeEmbedFont)(state)
  if (!font && !SYSTEM_FAMILIES.has(spaceTypeEmbedFace(state).family.toLowerCase())) {
    console.debug('[space-type] wired layer exports as frames: its font could not be inlined')
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
