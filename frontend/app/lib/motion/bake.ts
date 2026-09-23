/**
 * Client-side motion bake: render the full layer stack at every frame time to
 * an offscreen canvas, collect PNG blobs (alpha preserved), upload via the
 * existing /upload/image batch helper, and produce the motion_params payload
 * the Compositor backend node consumes.
 */
import type { LocalLayer, TextLayer, StackItem, PostEffect } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import {
  paintLayerStack, ensureLayerFonts, ensureLayerImages,
} from '~/composables/useCompositorLayers'
import './paint' // ensure the motion painter is registered
import { motionUsesShaderStyle } from '~/lib/motionx/reveal'
import { ensureRevealShadersReady } from '~/lib/motionx/reveal/paintPixels'
import { uploadFrameBatch } from '~/lib/studio/frameUpload'
import { useLibraryFonts } from '~/composables/useLibraryFonts'
import type { FrameMotion } from './types'

/**
 * FNV-1a over the JSON of everything that affects baked pixels.
 * NOTE: live-slot visual state (wired studio content) is NOT part of this key —
 * only localLayers+motion+W+H are hashed. So editing a studio wired into this
 * frame doesn't flip motionStale. Accepted blind spot, not fixed here.
 */
export function motionSourceKey(
  localLayers: LocalLayer[],
  motion: FrameMotion,
  W: number,
  H: number,
): string {
  const s = JSON.stringify({ localLayers, motion, W, H })
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export interface MotionParams {
  fps: number
  duration: number
  rendered: string[]   // uploaded input/ filenames, frame order
  source_key: string
}

/** What a motion export needs per frame, prepared once: fonts, images and any
 *  reveal shaders loaded, the layer stack snapshotted (later edits must not leak
 *  into later frames). `paint(i, ctx)` pulls wired sources to frame i's time
 *  (via `prepareFrame`) and paints the stack onto `ctx` — used by both the PNG
 *  bake below and the browser video recorder, so the two draw identically. */
export interface MotionFramePainter {
  total: number
  time(i: number): number
  paint(i: number, ctx: CanvasRenderingContext2D): Promise<void>
}

/** Doc-level parts of the Frame the painter draws around the layers — the same four the
 *  editor's live view passes. Absent ⇒ layers only (the old bake behaviour). */
export interface FrameDocPaint {
  treatments?: Record<string, { maskedByKey?: string; showSource?: boolean }>
  background?: Paint
  groups?: LayerGroup[]
  post?: PostEffect[]
}

export async function prepareMotionFramePainter(
  buildItems: () => StackItem[],
  localLayers: LocalLayer[],
  W: number,
  H: number,
  motion: FrameMotion,
  prepareFrame?: (t: number) => Promise<void>,
  deps: { paint?: typeof paintLayerStack; ensure?: () => Promise<void> } = {},
  doc?: FrameDocPaint,
): Promise<MotionFramePainter> {
  if (deps.ensure) {
    await deps.ensure()
  } else {
    for (const l of localLayers) if (l.kind === 'text') useLibraryFonts().ensure((l as TextLayer).fontFamily)
    await ensureLayerFonts(localLayers, W)
    await ensureLayerImages(localLayers)
    // …and the SHADERS, when a Dither bar is set to Pixels or Assemble — the BARS are handed
    // over, so a bake needing both the ASCII and the Dither effect waits for both. The loop
    // below yields to the event loop every frame (toBlob), so a glyph atlas landing mid-bake
    // would render the early frames as the Dissolve fallback and the later ones as characters —
    // one video, two styles, with nothing anywhere reporting it. Resolves false rather than
    // throwing if a shader never arrives: the bake then goes ahead in the fallback look,
    // consistently, which is what a cold live frame already does.
    if (motionUsesShaderStyle(motion.behaviours)) await ensureRevealShadersReady(motion.behaviours)
  }
  const paint = deps.paint ?? paintLayerStack
  // Snapshot the stack and layer list ONCE — buildItems() and localLayers
  // close over live reactive state, and the bake loop yields to the event
  // loop every frame (toBlob), so a user edit mid-bake would otherwise leak
  // into later frames and produce an inconsistent sequence.
  const items = buildItems()
  const frozenLayers = [...localLayers]
  // …and the doc-level parts with them (a reassigned background or post chain mid-bake
  // must not change the look part-way through).
  const d: FrameDocPaint = { ...doc }
  const total = Math.max(1, Math.round(motion.duration * motion.fps))
  const time = (i: number) => i / motion.fps
  // The Frame's own size, not the target canvas' — the browser recorder hands a
  // canvas rounded UP to even dimensions (e.g. 1081px wide -> a 1082px canvas),
  // so the layout must be painted at the Frame's true size or it stretches by a
  // pixel. The clear below still covers the whole (possibly larger) ctx canvas.
  const pw = Math.max(1, Math.round(W))
  const ph = Math.max(1, Math.round(H))
  return {
    total,
    time,
    async paint(i, ctx) {
      const t = time(i)
      if (prepareFrame) await prepareFrame(t)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height) // transparent background
      // bake=true (Task 10): this IS the final motion export — shader-fill fields must
      // render unclamped (full res) and stay live past LIVE_FIELD_CEILING, matching the
      // bake/preview split every other export path now honours.
      // The doc-level parts (background, groups, wired treatments, post effects) come
      // from the caller — the editor passes the same four its live view draws with, so a
      // Frame on a red ground records on a red ground, not a transparent (→ black) one.
      paint(ctx, pw, ph, items, frozenLayers, undefined, t, motion,
        d.treatments, d.background, d.groups, d.post, true)
    },
  }
}

export async function bakeMotionFrames(
  buildItems: () => StackItem[],
  localLayers: LocalLayer[],
  W: number,
  H: number,
  motion: FrameMotion,
  onProgress?: (done: number, total: number) => void,
  // Optional hook run before each frame is painted, so the caller can pull
  // time-parameterized wired sources (live studio slots) to frame time t
  // before the stack is painted.
  prepareFrame?: (t: number) => Promise<void>,
  doc?: FrameDocPaint,
): Promise<Blob[]> {
  const painter = await prepareMotionFramePainter(buildItems, localLayers, W, H, motion, prepareFrame, {}, doc)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(W))
  canvas.height = Math.max(1, Math.round(H))
  const ctx = canvas.getContext('2d')!
  const blobs: Blob[] = []
  for (let i = 0; i < painter.total; i++) {
    await painter.paint(i, ctx)
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'))
    if (!blob) throw new Error(`motion bake: frame ${i} produced no blob`)
    blobs.push(blob)
    onProgress?.(i + 1, painter.total)
  }
  return blobs
}

export async function bakeAndUpload(
  buildItems: () => StackItem[],
  localLayers: LocalLayer[],
  W: number,
  H: number,
  motion: FrameMotion,
  onProgress?: (done: number, total: number) => void,
  prepareFrame?: (t: number) => Promise<void>,
  doc?: FrameDocPaint,
): Promise<MotionParams> {
  const blobs = await bakeMotionFrames(buildItems, localLayers, W, H, motion, onProgress, prepareFrame, doc)
  const rendered = await uploadFrameBatch(blobs, 'slate')
  if (rendered.length !== blobs.length) {
    throw new Error(`motion bake: uploaded ${rendered.length}/${blobs.length} frames — retry`)
  }
  return {
    fps: motion.fps,
    duration: motion.duration,
    rendered,
    source_key: motionSourceKey(localLayers, motion, W, H),
  }
}
