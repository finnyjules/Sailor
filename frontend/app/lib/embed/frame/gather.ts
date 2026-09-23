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
import { effectStackOf } from '~/lib/compositor/effectStack'
import type { DepthRef } from '~/lib/compositor/depthRegistry'
import type { EffectDef } from '~/lib/shaderfx/types'
import type { FontWeightSpec } from '../fontFace'
import type { FramePlan } from './plan'
import { assetKey, type FrameFontAsset, type FrameFontOrigin, type FrameNotice, type FrameSnapshot, type FrameVariant, type WiredEntry } from './types'

export interface FontSource { url: string; origin: FrameFontOrigin; weight: FontWeightSpec }

export interface FrameExportIO {
  fetchBlob(url: string): Promise<Blob>
  blobToImage(blob: Blob): Promise<CanvasImageSource>
  imageToDataUrl(img: CanvasImageSource, maxPx: number, mime: 'image/webp' | 'image/png'): Promise<string>
  blobToDataUrl(blob: Blob): Promise<string>
  blobToBase64(blob: Blob): Promise<string>
  subsetFont(fontB64: string, text: string): Promise<string | null>
  fontSource(family: string, weight: number): FontSource | null
  wiredStill(slot: number): CanvasImageSource | null
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

/** Task 10's brief for `needsOutlines`. `boolean` and `shatter` genuinely read paper.js
 *  (booleanGeometry.ts); `morph` (blendPath, in ~/lib/vector/morph.ts) is pure JS with NO paper
 *  dependency today, but ships in the same group here — it is the third sibling-reference (`ref
 *  LayerId`) F3 geometry kind alongside boolean, so a Frame using it keeps the full bundle rather
 *  than betting on morph never growing a paper dependency later. Trim/offset/round_corners/
 *  roughen/warp/long_shadow are all self-contained and never touch paper. */
const FULL_BUNDLE_GEOMETRY_KINDS = new Set(['boolean', 'shatter', 'morph'])

/**
 * Task 10: true when this Frame needs the full `frame.js` bundle (paper.js and/or fontkit) rather
 * than the lean one — `bundleNameFor('frame', snap)` (surfaces.ts) reads `FrameSnapshot.needsOutlines`,
 * this function's result, to choose between them. Pure and exported for the unit test.
 *
 * A geometry effect gates on VISIBILITY, same as `applyGeometry`'s own `e.visible !== false` filter
 * (geometryEffects.ts) and plan.ts's `textNeedsOutline`/`textDrawsFromOutlines` for text: a
 * disabled boolean/shatter/morph never actually runs, so it never calls `warmPaperBoolean` either
 * — gating on presence alone would force the full bundle for Frames that will never touch paper.
 */
export function computeNeedsOutlines(plan: Pick<FramePlan, 'fonts'>, variant: Pick<FrameVariant, 'layers'>): boolean {
  if (plan.fonts.some(f => f.outline)) return true
  return variant.layers.some(l => effectStackOf(l as any).some(
    e => FULL_BUNDLE_GEOMETRY_KINDS.has(e.type) && e.visible !== false,
  ))
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

  return {
    version: 1, fit: plan.fit, duration: plan.duration, still: plan.still,
    variants: [variant], assets: { urls, fonts, shaders, depth }, wired,
    notices: [...notices.filter(n => n.group === 'fonts'), ...liveNotices, ...notices.filter(n => n.group !== 'fonts')],
    needsOutlines: computeNeedsOutlines(plan, variant),
  }
}
