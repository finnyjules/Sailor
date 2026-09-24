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
import { layersNeedPaper } from './needs'
import type { DepthRef } from '~/lib/compositor/depthRegistry'
import type { EffectDef } from '~/lib/shaderfx/types'
import type { FontWeightSpec } from '../fontFace'
import type { FramePlan } from './plan'
import { assetKey, type FrameFontAsset, type FrameFontOrigin, type FrameNotice, type FrameSnapshot, type FrameVariant, type WiredEntry } from './types'

export interface FontSource { url: string; origin: FrameFontOrigin; weight: FontWeightSpec }

/** A wired clip's pull: the encoded frames, or — when the source's export session named assets
 *  that could not load (`name`: what a person calls it, `model "Sneaker"`) — none and those. */
export interface WiredFrames { frames: string[]; failures: { name: string; reason: string }[] }

export interface FrameExportIO {
  fetchBlob(url: string): Promise<Blob>
  blobToImage(blob: Blob): Promise<CanvasImageSource>
  imageToDataUrl(img: CanvasImageSource, maxPx: number, mime: 'image/webp' | 'image/png'): Promise<string>
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
  shaderDefs(ids: string[]): EffectDef[]
}

const ORIGIN_LABEL: Record<FrameFontOrigin, string> = {
  uploaded: 'uploaded', google: 'Google', library: 'library', variable: 'Google, variable',
}
const DEPTH_MAX_PX = 4096

/** Size of a data URL's payload, for the sheet. */
function dataUrlBytes(u: string): number {
  const i = u.indexOf(',')
  return i < 0 ? u.length : Math.floor((u.length - i - 1) * 3 / 4)
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

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
export function computeNeedsOutlines(plan: Pick<FramePlan, 'fonts'>, variant: Pick<FrameVariant, 'layers'>): boolean {
  if (plan.fonts.some(f => f.outline)) return true
  if (layersNeedPaper(variant.layers)) return true
  for (const l of variant.layers as ReadonlyArray<{ kind?: unknown }>) {
    for (const e of effectStackOf(l as Parameters<typeof effectStackOf>[0])) {
      if (isGeometryKind(e.type) && l.kind === 'text') return true // needs fontkit's outline mode — any visibility
    }
  }
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
    if (!shaders.some(d => d.id === id)) block('A shader this Frame uses isn\'t available. Open Shader Studio once, then export again.')
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

  const wired: Record<number, WiredEntry> = {}
  for (const w of plan.wiredStills) {
    const src = io.wiredStill(w.slot)
    if (src) wired[w.slot] = { kind: 'still', dataUrl: await io.imageToDataUrl(src, w.maxPx, 'image/webp') }
  }
  // An animated wired slot: its loop, pre-rendered from the live source (the editor's
  // `slotPhase01` timing — frame i at i / count). Frames that cannot be rendered BLOCK: a still in
  // their place would be a plausible wrong picture.
  // An asset the source could not load BLOCKS too, named: the frames would show a hole (an
  // unloaded model) or a stand-in (a grey box for a failed font) where it belongs.
  for (const c of plan.wiredClips) {
    const count = Math.max(1, Math.round(c.duration * c.fps))
    let bytes = 0
    try {
      const got = await io.wiredFrames(c.slot, count, c.maxPx, async (img) => {
        const u = await io.imageToDataUrl(img, c.maxPx, 'image/webp')
        bytes += dataUrlBytes(u)
        return u
      })
      if (got.failures.length) {
        for (const f of got.failures) block(`${c.label} · ${f.name} couldn't load — re-generate or re-upload it`, c.layerId)
        continue
      }
      if (got.frames.length !== count) throw new Error(`wired slot ${c.slot}: ${got.frames.length} of ${count} frames`)
      wired[c.slot] = { kind: 'clip', frames: got.frames, fps: c.fps, duration: c.duration }
      liveNotices.push({ group: 'live', text: `${c.label} · adds ${formatBytes(bytes)}`, layerId: c.layerId, bytes })
    } catch { block(`${c.label} couldn't be rendered as frames.`, c.layerId) }
  }

  return {
    version: 1, fit: plan.fit, duration: plan.duration, still: plan.still,
    variants: [variant], assets: { urls, fonts, shaders, depth }, wired,
    notices: [...notices.filter(n => n.group === 'fonts'), ...liveNotices, ...notices.filter(n => n.group !== 'fonts')],
    needsOutlines: computeNeedsOutlines(plan, variant),
  }
}
