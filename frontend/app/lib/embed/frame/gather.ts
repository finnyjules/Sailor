/**
 * Turns a FramePlan into a FrameSnapshot: every asset fetched once, re-encoded to the size it is
 * drawn at, and inlined as a data URL under the key the painter will ask for. Everything that
 * touches the browser or the server goes through `io`, so this file is unit-tested in node.
 *
 * Failure policy (spec, "Failure handling"): a missing image, font or shader BLOCKS the export
 * with a sentence naming it — it would otherwise ship a plausible wrong picture. A missing depth
 * map is LEFT OUT with a sentence: the layer then paints unblurred, exactly as the editor does
 * until a map arrives.
 */
import { imageLayerUrl } from '~/composables/useCompositorLayers'
import { clipFrameUrl, clipFrameKey } from '~/lib/compositor/clip'
import { shaderTextureUrl, shaderTextureKey } from '~/lib/shaderfill/field'
import { compositorFontToken } from '~/lib/compositor/textOutline'
import { effectStackOf, isGeometryKind } from '~/lib/compositor/effectStack'
import { layersNeedPaper, frameNeedsFullBundle } from './needs'
import { formatBytes } from '../formatBytes'
import { depthKey, type DepthRef } from '~/lib/compositor/depthRegistry'
import type { EffectDef } from '~/lib/shaderfx/types'
import { MY_EFFECT_ID_BODY } from '~~/shared/myEffects/record'
import type { FontWeightSpec } from '../fontFace'
import { outlinePartnerIds, type FramePlan } from './plan'
import type { StudioEmbed } from '~/lib/studio/frameSource'
import { assetKey, type FrameFontAsset, type FrameFontOrigin, type FrameNotice, type FrameSnapshot, type FrameVariant, type WiredEntry } from './types'

export interface FontSource { url: string; origin: FrameFontOrigin; weight: FontWeightSpec }

/** A wired clip's pull: the encoded frames, or — when the source's export session named assets
 *  that could not load (`name`: what a person calls it, `model "Sneaker"`; `text`: the whole
 *  clause when the source words it itself, `model "Sneaker" couldn't load — re-generate or
 *  re-upload it`) — none and those. */
export interface WiredFrames { frames: string[]; failures: { name: string; reason: string; text?: string }[] }

/** The pre-rendered route's one WebP quality (the 3D web export plan's Global Constraints:
 *  "one WebP quality (0.82)" — `WEBP_QUALITY` in lib/scene3d/bakeFrames). Repeated here rather
 *  than imported so the Frame gatherer does not pull 3D Studio's renderer into its imports. */
export const WIRED_CLIP_WEBP_QUALITY = 0.82

const MY_EFFECT_REF = new RegExp(`^${MY_EFFECT_ID_BODY}(?:~v\\d+)?$`)

/** Why a shader the Frame uses can't be exported, in a plain sentence. A My effect that isn't
 *  registered is gone (removed, or a shared copy that never loaded): opening a studio won't
 *  bring it back, so say so and name it when its name is known. */
export function missingShaderMessage(id: string, name: string | null): string {
  if (MY_EFFECT_REF.test(id)) {
    return `${name ? `“${name}”` : 'One of the effects this Frame uses'} isn’t in My effects any more, so it can’t be exported. Pick another effect for this layer.`
  }
  return 'A shader this Frame uses isn’t available. Open Shader studio once, then export again.'
}

export interface FrameExportIO {
  fetchBlob(url: string): Promise<Blob>
  blobToImage(blob: Blob): Promise<CanvasImageSource>
  /** `quality`: the lossy encoder's quality (0–1); absent, the IO's own default. */
  imageToDataUrl(img: CanvasImageSource, maxPx: number, mime: 'image/webp' | 'image/png', quality?: number): Promise<string>
  blobToDataUrl(blob: Blob): Promise<string>
  blobToBase64(blob: Blob): Promise<string>
  subsetFont(fontB64: string, text: string): Promise<string | null>
  fontSource(family: string, weight: number): FontSource | null
  wiredStill(slot: number): CanvasImageSource | null
  /** `count` pictures of a wired slot's live source, frame `i` at `i / count` of its loop, each
   *  at most `maxPx` on its long side, each handed to `encode` as it arrives (the picture need
   *  only stay valid until `encode` resolves) — or, when the source's own export session could
   *  not load an asset, no frames and the failures. */
  wiredFrames(slot: number, count: number, maxPx: number, encode: (frame: CanvasImageSource) => Promise<string>): Promise<WiredFrames>
  depthImage(ref: DepthRef): CanvasImageSource | null
  /** A Relight photo's surfaces (MoGe-2 normals) when the editor holds them, else null. */
  surfacesImage?(ref: DepthRef): CanvasImageSource | null
  shaderDefs(ids: string[]): EffectDef[]
  /** A My effect's own name by any of its ids, when the user's library still knows it. */
  shaderName?(id: string): string | null
  /** An animated wired slot's studio embed player (StudioFrameSource.embed), or null when the
   *  source cannot play live faithfully. With `bundleBytes`, the live route; either absent, none. */
  wiredEmbed?(slot: number): Promise<StudioEmbed | null>
  /** The size in bytes of the embed bundle `bundle` (`/embed/{bundle}.js`), for the sheet. */
  bundleBytes?(bundle: string): Promise<number>
}

const ORIGIN_LABEL: Record<FrameFontOrigin, string> = {
  uploaded: 'uploaded', google: 'Google', library: 'library', variable: 'Google, variable',
}
const DEPTH_MAX_PX = 4096
/** Relight's depth and surfaces maps: never bigger than the photo is exported, and at most this.
 *  The depth field and the normals are smooth data — past ~1k they only add file size. */
export const RELIGHT_MAP_MAX_PX = 1024

/** Size of a data URL's payload, for the sheet. */
function dataUrlBytes(u: string): number {
  const i = u.indexOf(',')
  return i < 0 ? u.length : Math.floor((u.length - i - 1) * 3 / 4)
}

// Kept importable from here: the Frame editor and its sheet read it from the gatherer.
export { formatBytes }

export function isBlocked(snapshot: FrameSnapshot): boolean {
  return snapshot.notices.some(n => n.group === 'blocked')
}

/**
 * Task 10: true when this Frame needs the full `frame.js` bundle (paper.js and/or fontkit) rather
 * than the lean one — `bundleNameFor('frame', snap)` (surfaces.ts) reads `FrameSnapshot.needsOutlines`,
 * this function's result, to choose between them. Pure and exported for the unit test.
 *
 * The paper.js half (`boolean`/`shatter`/`morph` anywhere in the Frame) is `layersNeedPaper`
 * (./needs.ts) — a SEPARATE, bundle-safe module `surfaces/frame.ts`'s `mount()` also imports
 * directly, as defence in depth (R14a, fix round 2): if this function's result ever disagreed with
 * `layersNeedPaper`'s own read of the SAME layers (a bug here, not there), the adapter's
 * independent re-check still catches it — `needsOutlines` alone is no longer the only thing
 * standing between a wrong-bundle case and a silent wrong picture. See needs.ts's doc for why that
 * matters and surfaces/frame.ts's `mount()` for the other half of the fix.
 *
 * R14f (fix round 1) — deliberately IGNORES each effect's `visible` flag, unlike the render path's
 * own gates (`applyGeometry`'s `e.visible !== false`, `layerGeometryEffects`'s `e.visible`). Traced
 * on request: `Track.path` (motionx) is an open string with no allowlist, and its generic apply
 * (`applyResolvedValue`'s `effects.<id>.<dial>` branch, ~/lib/motionx/adapter/frame.ts) writes
 * WHATEVER `dial` name a track names onto the effect object, `visible` included — the picker never
 * offers it (`effectDials.ts`: "`visible` — the show/hide toggle, not a dial"), but nothing at the
 * type or runtime level refuses a hand-built or legacy track that targets it anyway. Because
 * motionx's `PropertyValue` is `number | string | GradientStop[]` — never `boolean` — such a track
 * can only push a STORED `visible: false` towards some non-`false` value (a number/string), and
 * every visibility check in this codebase is `!== false`, so a non-`false` value reads as VISIBLE.
 * The gap is one-directional but real: an effect stored `visible: false` (this function, reading
 * the static document, would count it as absent) could still render as active for some frames if a
 * track like this existed — a plan built on the static flag would then under-count what the
 * playback actually needs. Gating on presence instead closes that gap by never depending on
 * `visible`'s trustworthiness at all. The cost is a false positive (the full bundle for a Frame
 * whose boolean/shatter/morph effect is disabled and no track ever revives it) — accepted, since a
 * false NEGATIVE here is the "still Frame draws unclipped" bug this whole fix round exists to close.
 *
 * The same reasoning applies to TEXT: `textDrawsFromOutlines`/`layerGeometryEffects`
 * (useCompositorLayers.ts) gate outline-mode drawing on `e.visible` too, so `plan.fonts[].outline`
 * (which this function otherwise trusts) inherits the same gap for a text layer's geometry effect.
 * This function does not modify that render-path gate (out of scope — it governs the LIVE editor,
 * not just this export heuristic) but independently re-checks every text layer for ANY geometry
 * effect (not just the three paper kinds — trim/offset/etc. force outline mode on text too, which
 * needs fontkit even though it never touches paper), regardless of `visible`, as a second, cheaper
 * safety net alongside `plan.fonts[].outline`.
 */
export function computeNeedsOutlines(
  plan: Pick<FramePlan, 'fonts'>,
  variant: Pick<FrameVariant, 'layers'> & { motion?: FrameVariant['motion'] },
): boolean {
  if (plan.fonts.some(f => f.outline)) return true
  if (layersNeedPaper(variant.layers)) return true
  for (const l of variant.layers as ReadonlyArray<{ kind?: unknown }>) {
    for (const e of effectStackOf(l as Parameters<typeof effectStackOf>[0])) {
      if (isGeometryKind(e.type) && l.kind === 'text') return true // needs fontkit's outline mode — any visibility
    }
  }
  // A text layer another layer outlines — a geometry partner, or either end of a Motion
  // "Morph into" — needs fontkit even when it draws itself with fillText (plan.ts's
  // `outlinePartnerIds`, the same set the plan's per-font `outline` flag reads).
  const partners = outlinePartnerIds(variant.layers, variant.motion?.behaviours)
  if (partners.size && variant.layers.some(l => l.kind === 'text' && partners.has(l.id))) return true
  return false
}

export async function buildFrameSnapshot(plan: FramePlan, variant: FrameVariant, io: FrameExportIO): Promise<FrameSnapshot> {
  const urls: Record<string, string> = {}
  const notices: FrameNotice[] = plan.notices.filter(n => n.group !== 'live')
  const liveNotices: FrameNotice[] = plan.notices.filter(n => n.group === 'live')
  const block = (text: string, layerId?: string) => notices.push({ group: 'blocked', text, ...(layerId ? { layerId } : {}) })

  for (const im of plan.images) {
    try {
      const img = await io.blobToImage(await io.fetchBlob(imageLayerUrl(im.filename)))
      urls[assetKey('image', im.filename)] = await io.imageToDataUrl(img, im.maxPx, 'image/webp')
    } catch {
      // A stand-in's file that is not there: the editor's own load fails the same way and it
      // draws the grey stand-in box. `data:,` never decodes, so the exported painter draws that
      // same box — and the key is present, so nothing falls back to the server.
      if (im.optional) urls[assetKey('image', im.filename)] = 'data:,'
      else block(`The image "${im.filename}" couldn't be loaded.`)
    }
  }

  for (const c of plan.clips) {
    let bytes = 0
    try {
      for (let i = 0; i < c.clip.frames; i++) {
        const img = await io.blobToImage(await io.fetchBlob(clipFrameUrl(c.clip, i)))
        const u = await io.imageToDataUrl(img, c.maxPx, 'image/webp')
        urls[assetKey('clipFrame', clipFrameKey(c.clip, i))] = u
        bytes += dataUrlBytes(u)
      }
      liveNotices.push({ group: 'live', text: `Image clip · adds ${formatBytes(bytes)}`, layerId: c.layerId, bytes })
    } catch { block('An image clip is missing some of its frames.', c.layerId) }
  }

  for (const src of plan.fillImages) {
    try {
      const img = await io.blobToImage(await io.fetchBlob(src))
      urls[assetKey('fillImage', src)] = await io.imageToDataUrl(img, 2 * Math.max(variant.width, variant.height), 'image/webp')
    } catch { block('An image used as a fill couldn\'t be loaded.') }
  }

  const shaders = io.shaderDefs(plan.shaderIds)
  for (const id of plan.shaderIds) {
    if (!shaders.some(d => d.id === id)) block(missingShaderMessage(id, io.shaderName?.(id) ?? null))
  }
  for (const def of shaders) {
    for (const t of def.textures ?? []) {
      try { urls[assetKey('shaderTexture', shaderTextureKey(t.file, t.v))] = await io.blobToDataUrl(await io.fetchBlob(shaderTextureUrl(t.file, t.v))) }
      catch { block('A texture one of the shaders needs couldn\'t be loaded.') }
    }
  }

  // Fonts: one face per file+weight (a variable file serves every weight at once), text merged.
  const faces = new Map<string, { src: FontSource; family: string; text: string; outlineTokens: Set<string> }>()
  for (const f of plan.fonts) {
    const src = io.fontSource(f.family, f.weight)
    if (!src) continue // a system family: the viewer's browser has it
    const key = `${src.url}|${JSON.stringify(src.weight)}`
    const face = faces.get(key) ?? { src, family: f.family, text: '', outlineTokens: new Set<string>() }
    face.text += f.text
    if (f.outline) {
      const token = compositorFontToken({ fontFamily: f.family, fontWeight: f.weight })
      if (token) face.outlineTokens.add(token)
    }
    faces.set(key, face)
  }
  const fonts: FrameFontAsset[] = []
  for (const face of faces.values()) {
    try {
      const b64 = await io.blobToBase64(await io.fetchBlob(face.src.url))
      const subset = await io.subsetFont(b64, face.text)
      const dataUrl = `data:font/ttf;base64,${subset ?? b64}`
      fonts.push({ family: face.family, weight: face.src.weight, dataUrl, origin: face.src.origin })
      for (const token of face.outlineTokens) urls[assetKey('outlineFont', token)] = dataUrl
      notices.push({ group: 'fonts', text: `${face.family} · ${ORIGIN_LABEL[face.src.origin]}` })
    } catch { block(`The font "${face.family}" couldn't be loaded, so the export would draw the wrong typeface.`) }
  }

  const depth: FrameSnapshot['assets']['depth'] = []
  for (const d of plan.depth) {
    const img = io.depthImage(d.ref)
    if (img) depth.push({ ref: d.ref, dataUrl: await io.imageToDataUrl(img, DEPTH_MAX_PX, 'image/png') })
    else notices.push({ group: 'leftOut', text: `Depth blur on ${d.label} · needs a depth map`, layerId: d.layerId })
  }
  // Relight: the depth map (shared with Depth blur when both use it) and the surfaces. The file
  // builds the depth field from the map and lights the photo as the editor does; without
  // surfaces it uses normals from depth alone, and the sheet says so. Both are PNG: they are data.
  const surfaces: NonNullable<FrameSnapshot['assets']['surfaces']> = []
  const seenDepth = new Set(depth.map(d => depthKey(d.ref)))
  const seenSurfaces = new Set<string>()
  // One map per photo source, sized for the largest copy of it: min(its export size, 1024).
  const mapPx = new Map<string, number>()
  for (const r of plan.relight ?? []) {
    const key = depthKey(r.ref), px = r.maxPx > 0 ? r.maxPx : RELIGHT_MAP_MAX_PX
    mapPx.set(key, Math.max(mapPx.get(key) ?? 0, Math.min(RELIGHT_MAP_MAX_PX, px)))
  }
  for (const r of plan.relight ?? []) {
    const key = depthKey(r.ref)
    const px = mapPx.get(key) ?? RELIGHT_MAP_MAX_PX
    if (!seenDepth.has(key)) {
      const img = io.depthImage(r.ref)
      if (!img) { notices.push({ group: 'leftOut', text: `Relight on ${r.label} · needs a depth map`, layerId: r.layerId }); continue }
      depth.push({ ref: r.ref, dataUrl: await io.imageToDataUrl(img, px, 'image/png') })
      seenDepth.add(key)
    }
    if (seenSurfaces.has(key)) continue
    const normals = io.surfacesImage?.(r.ref) ?? null
    if (normals) {
      surfaces.push({ ref: r.ref, dataUrl: await io.imageToDataUrl(normals, px, 'image/png') })
      seenSurfaces.add(key)
    } else notices.push({ group: 'leftOut', text: `Relight on ${r.label} · shape not read — lit from depth only`, layerId: r.layerId })
  }

  const wired: Record<number, WiredEntry> = {}
  for (const w of plan.wiredStills) {
    const src = io.wiredStill(w.slot)
    if (src) wired[w.slot] = { kind: 'still', dataUrl: await io.imageToDataUrl(src, w.maxPx, 'image/webp') }
  }
  // The live route first: a studio that can play its slot faithfully ships its own embed player
  // (the bundle once per file, the config per slot) instead of frames. A source that cannot — no
  // embed, null, a rejection, or a bundle that cannot be measured — takes the frames path below,
  // which is today's route: a fallback, never a block.
  const bundlesCounted = new Set<string>()
  const liveEntry = async (slot: number): Promise<{ entry: WiredEntry; bytes: number } | null> => {
    if (!io.wiredEmbed || !io.bundleBytes) return null
    try {
      const e = await io.wiredEmbed(slot)
      if (!e) return null
      const bundle = bundlesCounted.has(e.bundle) ? 0 : await io.bundleBytes(e.bundle)
      bundlesCounted.add(e.bundle)
      const config = new TextEncoder().encode(JSON.stringify(e.config)).length
      const { surface, bundle: name, config: cfg, width, height, duration } = e
      return { entry: { kind: 'live', surface, bundle: name, config: cfg, width, height, duration }, bytes: bundle + config }
    } catch { return null }
  }
  // Otherwise an animated wired slot: its loop, pre-rendered from the live source (the editor's
  // `slotPhase01` timing — frame i at i / count). Frames that cannot be rendered BLOCK: a still in
  // their place would be a plausible wrong picture.
  // An asset the source could not load BLOCKS too, named: the frames would show a hole (an
  // unloaded model) or a stand-in (a grey box for a failed font) where it belongs.
  // The size is counted from the frames handed back, not inside `encode`: the app may hand back
  // frames it pulled for an earlier build (the Frame editor keeps them while the sheet is open).
  for (const c of plan.wiredClips) {
    const live = await liveEntry(c.slot)
    if (live) {
      wired[c.slot] = live.entry
      liveNotices.push({ group: 'live', text: `${c.label} · plays live · adds ${formatBytes(live.bytes)}`, layerId: c.layerId, bytes: live.bytes })
      continue
    }
    const count = Math.max(1, Math.round(c.duration * c.fps))
    try {
      const got = await io.wiredFrames(c.slot, count, c.maxPx,
        img => io.imageToDataUrl(img, c.maxPx, 'image/webp', WIRED_CLIP_WEBP_QUALITY))
      if (got.failures.length) {
        // The source words the clause itself when it can (3D: what to do depends on the kind —
        // `failureClause`); otherwise the plain fact. Mid-sentence, so the subject is lower case.
        for (const f of got.failures) block(`${c.label} · ${f.text ?? `${f.name} couldn't load`}`, c.layerId)
        continue
      }
      if (got.frames.length !== count) throw new Error(`wired slot ${c.slot}: ${got.frames.length} of ${count} frames`)
      wired[c.slot] = { kind: 'clip', frames: got.frames, fps: c.fps, duration: c.duration }
      const bytes = got.frames.reduce((n, u) => n + dataUrlBytes(u), 0)
      liveNotices.push({ group: 'live', text: `${c.label} · pre-rendered · ${count} frames · adds ${formatBytes(bytes)}`, layerId: c.layerId, bytes })
    } catch { block(`${c.label} couldn't be rendered as frames.`, c.layerId) }
  }

  return {
    version: 1, fit: plan.fit, duration: plan.duration, still: plan.still,
    variants: [variant], assets: { urls, fonts, shaders, depth, ...(surfaces.length ? { surfaces } : {}) }, wired,
    notices: [...notices.filter(n => n.group === 'fonts'), ...liveNotices, ...notices.filter(n => n.group !== 'fonts')],
    // Brush tips, Pixel reveal, Relight and Morph are not in frame-lean.js either: same full bundle.
    needsOutlines: computeNeedsOutlines(plan, variant) || frameNeedsFullBundle(variant.layers, variant.motion?.behaviours, variant.motion?.motionx) !== null,
  }
}
