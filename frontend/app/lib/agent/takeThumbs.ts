/**
 * Four Takes (Task 3) — per-studio thumbnail adapters.
 *
 * `TakeStrip.vue` (Task 2) shows four proposed takes as small tiles; each tile
 * needs a picture of what the take's config actually LOOKS like. This module
 * is the registry `TakeStrip`'s host wires up: one function per studio that
 * renders a take's config through THAT STUDIO'S OWN renderer, at thumbnail
 * size. Nothing here is a new renderer — every adapter is a thin wrapper
 * around the exact function the studio's own node-card preview or headless
 * bake already calls (named in each adapter's own comment, the house "source
 * pin" convention). See docs/superpowers/specs/2026-08-25-four-takes-design.md
 * scope item 3.
 *
 * Contract: `takeThumbFor(studioId)` always returns a function, even for an
 * unknown id (a no-op that resolves `null`). The returned function never
 * throws — any failure inside an adapter (WebGL unavailable, a font that
 * fails to load, a malformed take config, a network hiccup fetching the
 * shader catalog) resolves to `null`, and the strip shows that tile as an
 * error rather than blocking the other three or blanking the row.
 *
 * WebGL singleton caution: `gradientFx`/`textureFx`/`shaderFx` each render
 * into ONE shared canvas and return it (see e.g. `GradientFxRenderer.render`'s
 * own doc: "into the shared canvas; returns it") — a second call (another
 * take, or the studio's own live preview) repaints that same canvas. Every
 * WebGL adapter below copies the pixels out via `drawImage` into a fresh
 * canvas BEFORE returning, immediately after the render call and before any
 * `await` — the same safe-copy pattern `dev/pattern-gallery.vue`'s
 * `renderItem()` uses for `textureFx.render()`.
 */

import { gradientFx } from '~/lib/gradientfx/renderer'
import { aspectRatio, type GradientConfig } from '~/lib/gradientfx/types'

import { textureFx } from '~/lib/texturefx/renderer'
import { textureDefaults } from '~/lib/texturefx/controls'
import type { Params as TextureParams } from '~/lib/spacetype/effect'

import { shaderFx } from '~/lib/shaderfx/renderer'
import { fetchShaderFxCatalog, resolveEffectId } from '~/lib/shaderfx/catalog'
import { composePasses } from '~/lib/shaderstudio/passes'
import { hydrateConfig as hydrateShaderConfig, type ShaderStudioConfig } from '~/lib/shaderstudio/types'
import { migrateShaderConfig } from '~/lib/shaderstudio/migrate'

import { renderStudio, drawToCanvas, studioFramePad } from '~/lib/geoshape/render'
import { studioDocFromPersisted, type GeoStudioDoc } from '~/lib/geoshape/studio'

import { drawVectorTypeToCanvas } from '~/lib/vectortype/canvas'
import { loadVectorFont } from '~/lib/vectortype/font'
import { mergeConfig as mergeVectorTypeConfig } from '~/lib/vectortype/config'
import { vtStillTime } from '~/lib/vectortype/presetMotion'

/** The five studios Milestone A covers (spec scope item, "the five fast
 *  studios"). Exported so Task 4 and this module's own tests can iterate the
 *  registry without hand-duplicating the id list. */
export const TAKE_THUMB_STUDIO_IDS = ['gradient', 'texture', 'shader', 'shape', 'vectortype'] as const
export type TakeThumbStudioId = typeof TAKE_THUMB_STUDIO_IDS[number]

/** What a tile can be handed: a live canvas, a serialised data URL (either is
 *  accepted by `TakeStrip.vue`'s thumb prop, per Task 2's interface), or
 *  `null` for the error tile. */
export type TakeThumb = HTMLCanvasElement | string | null
/**
 * `aspect` is the studio's own document ratio (w/h) when the CONFIG cannot say —
 * Shape and Vector Type keep their canvas dimensions on the node, not in the
 * config a take carries. Omitted, an adapter falls back to whatever its config
 * knows, or to square.
 */
export type TakeThumbAdapter = (config: unknown, size?: number, aspect?: number) => Promise<TakeThumb>

const DEFAULT_SIZE = 160

function freshCanvas(w: number, h = w): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

/**
 * The tile's pixel size for a document of the given aspect, fitted inside a
 * `size`-square box.
 *
 * A tile is a PICTURE OF THE DOCUMENT, and a 16:9 design rendered into a square
 * is a different picture — the field gets sampled over a square window, so the
 * proportions the user will actually see are not the ones on the tile. That is
 * not only a cosmetic lie: the promise checker measures the tile, so it was
 * judging a render nobody gets. Measured on a real liquid 16:9 document, the
 * square tile read "none" where the real render read "horizontal" — a sideways
 * gradient walking straight past its own direction check.
 *
 * Defensive about its input because `aspectRatio` reads a persisted string: a
 * zero, a NaN or an absurd ratio yields a usable canvas rather than a crash.
 */
/**
 * A document's width/height ratio, guaranteed finite and positive whatever the
 * two numbers are. The surfaces whose canvas size is NODE state (Shape, Vector
 * Type) hand their ratio over through this — one tested helper rather than an
 * inline `w / h` per surface, which is exactly where a 0 or a NaN slips in
 * unseen and turns a whole strip into error tiles.
 *
 * If EITHER dimension is unusable the answer is 1, a square. Substituting a
 * fallback per COMPONENT is the trap: it turns `(0, 720)` into a 1:720 ratio and
 * a three-pixel sliver of a tile, which looks like a deliberate shape rather
 * than the missing information it is. A dimension we do not have is no evidence
 * about the document, and a square is this codebase's standing answer to no
 * evidence — the same posture the promise checkers take.
 */
export function docAspect(w: number, h: number): number {
  const usable = (n: number) => Number.isFinite(n) && n > 0
  return usable(w) && usable(h) ? w / h : 1
}

/**
 * The tile dimensions for one studio, given the config a take carries and the
 * aspect the studio supplied.
 *
 * Lives here, exported and tested, rather than inline in five adapters: the
 * decision depends on the SHAPE of a persisted config (Gradient reads an aspect
 * STRING that a `.split` would throw on if it were ever a number), and a throw
 * inside an adapter is swallowed into a "couldn't draw" tile where no test can
 * see it. Answering this question separately means it can be asked of the real
 * configs the studios really produce.
 */
export function thumbDimsFor(studioId: string, config: unknown, size: number, aspect?: number): { w: number, h: number } {
  if (studioId === 'gradient') {
    const raw = (config as { canvas?: { aspect?: unknown } } | null | undefined)?.canvas?.aspect
    return thumbDims(typeof raw === 'string' ? aspectRatio(raw) : 1, size)
  }
  // Shape and Vector Type: the studio knows, the config does not.
  if (studioId === 'shape' || studioId === 'vectortype') return thumbDims(aspect ?? 1, size)
  // Texture and Shader are genuinely square — see their adapters for why. A
  // supplied aspect is ignored rather than obeyed.
  return thumbDims(1, size)
}

export function thumbDims(aspect: number, size: number): { w: number, h: number } {
  const box = Math.max(1, Math.round(size))
  const a = Number.isFinite(aspect) && aspect > 0 ? Math.min(64, Math.max(1 / 64, aspect)) : 1
  return a >= 1
    ? { w: box, h: Math.max(1, Math.round(box / a)) }
    : { w: Math.max(1, Math.round(box * a)), h: box }
}

// Shader thumbnails have no upstream image to sample (a take is a config, not
// a wired frame source) — a tiny neutral canvas stands in as the base, the
// identical fallback `ShaderStudioSurface.vue`'s `GENERATIVE_BASE` (its
// generative-effect preview/bake path) and `ShaderEffectNode`'s
// `baseImage.value ?? placeholder` use for a source-less/generative effect.
// Built once and reused — it is read-only, never rendered into.
let _shaderBase: HTMLCanvasElement | null = null
function shaderPlaceholderBase(): HTMLCanvasElement {
  if (_shaderBase) return _shaderBase
  const c = document.createElement('canvas')
  c.width = 8
  c.height = 8
  c.getContext('2d')!.fillRect(0, 0, 8, 8)
  _shaderBase = c
  return c
}

/**
 * Gradient — wraps `gradientFx.render(cfg, w, h, t)`, the exact call
 * `GradientStudioNode.vue`'s card preview (`renderFrame`) makes every frame.
 */
async function gradientThumb(config: unknown, size = DEFAULT_SIZE): Promise<TakeThumb> {
  const cfg = config as GradientConfig
  // At the DOCUMENT's aspect, not the box's — see `thumbDimsFor`.
  const { w, h } = thumbDimsFor('gradient', config, size)
  const gpu = gradientFx.render(cfg, w, h, 0)
  const out = freshCanvas(w, h)
  out.getContext('2d')!.drawImage(gpu, 0, 0)
  return out
}

/**
 * Texture — wraps `textureFx.render(params, w, h, t)`, the SAME call and the
 * SAME copy-before-return shape `dev/pattern-gallery.vue`'s `renderItem()`
 * uses to draw every pattern's small tile (this studio's own gallery-preview
 * precedent, per the brief). Defended over `textureDefaults()` the way
 * `TextureStudioNode.vue`'s card preview merges a saved/partial params bag.
 */
async function textureThumb(config: unknown, size = DEFAULT_SIZE): Promise<TakeThumb> {
  // SQUARE on purpose, and not an oversight: what this renders is one repeating
  // TILE, which has no aspect of its own — the sheet it eventually prints on is
  // a separate Output concern the take vocabulary does not touch. A tile drawn
  // wide would be a lie about the unit, not a truer picture of the document.
  // Same merge shape `TextureStudioNode.vue`'s card preview uses for a saved
  // params bag (`{ ...textureDefaults(), ...saved }`, `saved` typed as a full
  // `Params`, not a `Partial` — a `Partial<Params>` spread widens every value
  // to `ParamValue | undefined`, which `textureFx.render` correctly refuses).
  const p: TextureParams = { ...textureDefaults(), ...(config as TextureParams) }
  const gpu = textureFx.render(p, size, size, 0)
  const out = freshCanvas(size)
  out.getContext('2d')!.drawImage(gpu, 0, 0)
  return out
}

/**
 * Shader — wraps `shaderFx.render(passes, base, w, h)` through the SAME
 * `composePasses` pipeline `ShaderStudioSurface.vue`'s own live preview
 * (`renderFrame`, :226-249) and its export bake (`renderBlob`, :501-512) both
 * build their pass list with — NOT its effect-picker gallery's `renderThumb`
 * (:358-365), which hand-builds a single-pass array for one effect at a time
 * and never calls `composePasses`. Normalized with the same
 * `hydrateConfig(migrateShaderConfig(...))` `ShaderStudioNode.vue`'s card
 * preview applies to a saved config.
 */
async function shaderThumb(config: unknown, size = DEFAULT_SIZE): Promise<TakeThumb> {
  // SQUARE on purpose: this studio has no canvas dimensions anywhere — it
  // processes whatever upstream frame it is wired to, and a take has no wired
  // frame (hence the neutral placeholder base below). There is no document
  // shape to be truer to.
  const cfg: ShaderStudioConfig = hydrateShaderConfig(migrateShaderConfig(config))
  const catalog = await fetchShaderFxCatalog()
  const resolveDef = (id: string) => catalog.effects.find(e => e.id === resolveEffectId(id)) ?? null
  const passes = composePasses(cfg, resolveDef, 0)
  const gpu = shaderFx.render(passes, shaderPlaceholderBase(), size, size)
  const out = freshCanvas(size)
  out.getContext('2d')!.drawImage(gpu, 0, 0)
  return out
}

/**
 * Shape — wraps `renderStudio(doc)` + `drawToCanvas(shapes, ctx, w, h, pad)`,
 * the exact pair `ShapeStudioNode.vue`'s `bakeOutput()` (the node-card
 * headless bake) calls. `studioDocFromPersisted` is the same normalizer that
 * bake and `studioControls.ts`'s agent-controls adapter both use, so it
 * accepts either shape a take's config can arrive in: a full layered
 * `GeoStudioDoc` (has a `layers` array) or a flat single-mark
 * `GeoShapeConfig` (what `geoAgentControls` actually describes/patches) —
 * wrapped `{ doc }` or `{ config }` respectively, mirroring the legacy-blob
 * migration `studioDocFromPersisted` already performs for a persisted node.
 */
async function shapeThumb(config: unknown, size = DEFAULT_SIZE, aspect?: number): Promise<TakeThumb> {
  const looksLikeDoc = !!config && typeof config === 'object' && Array.isArray((config as { layers?: unknown }).layers)
  const doc: GeoStudioDoc = studioDocFromPersisted(looksLikeDoc ? { doc: config } : { config })
  const { w, h } = thumbDimsFor('shape', config, size, aspect)
  const shapes = await renderStudio(doc)
  const out = freshCanvas(w, h)
  drawToCanvas(shapes, out.getContext('2d')!, w, h, studioFramePad(doc))
  return out
}

/**
 * Vector Type — wraps `drawVectorTypeToCanvas(canvas, font, cfg, t, opts)`,
 * the same call `VectorTypeNode.vue`'s card preview AND its `bakeOutput()`
 * headless bake both make — but at `vtStillTime(cfg)`, the time ONLY
 * `bakeOutput()` uses (the preset's settled rest frame; an entrance preset's
 * true frame 0 is deliberately empty, so baking literal t=0 would render a
 * blank tile). The card preview instead drives `t` off a live rAF clock,
 * which a static thumbnail has no equivalent of — `bakeOutput()`'s still
 * frame is the one this adapter matches.
 */
async function vectorTypeThumb(config: unknown, size = DEFAULT_SIZE, aspect?: number): Promise<TakeThumb> {
  const cfg = mergeVectorTypeConfig(config)
  const font = await loadVectorFont(cfg.fontId)
  const { w, h } = thumbDimsFor('vectortype', config, size, aspect)
  const out = freshCanvas(w, h)
  drawVectorTypeToCanvas(out, font, cfg, vtStillTime(cfg), { width: w, height: h, background: null })
  return out
}

const ADAPTERS: Record<TakeThumbStudioId, TakeThumbAdapter> = {
  gradient: gradientThumb,
  texture: textureThumb,
  shader: shaderThumb,
  shape: shapeThumb,
  vectortype: vectorTypeThumb,
}

/** True for exactly the five ids this registry covers. */
export function isTakeThumbStudioId(studioId: string): studioId is TakeThumbStudioId {
  return (TAKE_THUMB_STUDIO_IDS as readonly string[]).includes(studioId)
}

/**
 * The adapter for `studioId` — always a function, never `undefined`, so a
 * caller never has to null-check before calling it. An id outside the five
 * (a typo, a future studio not yet wired, Scene3D before Milestone B) gets a
 * function that resolves `null` on every call, same as a real adapter's own
 * failure path — the strip renders it as one more error tile rather than
 * throwing.
 */
export function takeThumbFor(studioId: string): TakeThumbAdapter {
  const adapter = isTakeThumbStudioId(studioId) ? ADAPTERS[studioId] : null
  if (!adapter) return async () => null
  return async (config: unknown, size = DEFAULT_SIZE, aspect?: number) => {
    try {
      return await adapter(config, size, aspect)
    } catch (e) {
      // NEVER silent. A graceful fallback that says nothing turns an integration
      // failure into a strip of "couldn't draw" tiles with no way to tell a
      // missing WebGL context from a broken adapter — which is exactly how one
      // report cost a day. The tile still degrades; it just stops being a
      // mystery.
      console.warn(`[takes] the ${studioId} thumbnail could not be drawn:`, e)
      return null
    }
  }
}
