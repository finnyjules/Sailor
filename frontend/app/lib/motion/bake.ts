/**
 * Client-side motion bake: render the full layer stack at every frame time to
 * an offscreen canvas, collect PNG blobs (alpha preserved), upload via the
 * existing /upload/image batch helper, and produce the motion_params payload
 * the Compositor backend node consumes.
 */
import type { LocalLayer, TextLayer, StackItem } from '~/composables/useCompositorLayers'
import {
  paintLayerStack, ensureLayerFonts, ensureLayerImages,
} from '~/composables/useCompositorLayers'
import './paint' // ensure the motion painter is registered
import { motionUsesPixels } from '~/lib/motionx/reveal'
import { ensureRevealPixelsReady } from '~/lib/motionx/reveal/paintPixels'
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
): Promise<Blob[]> {
  for (const l of localLayers) if (l.kind === 'text') useLibraryFonts().ensure((l as TextLayer).fontFamily)
  await ensureLayerFonts(localLayers, W)
  await ensureLayerImages(localLayers)
  // …and the SHADER, when a Dither bar is set to Pixels. The loop below yields to the event
  // loop every frame (toBlob), so a glyph atlas landing mid-bake would render the early
  // frames as the Dissolve fallback and the later ones as characters — one video, two
  // styles, with nothing anywhere reporting it. Resolves false rather than throwing if the
  // shader never arrives: the bake then goes ahead in the fallback look, consistently, which
  // is what a cold live frame already does.
  if (motionUsesPixels(motion.behaviours)) await ensureRevealPixelsReady()
  // Snapshot the stack and layer list ONCE — buildItems() and localLayers
  // close over live reactive state, and the bake loop yields to the event
  // loop every frame (toBlob), so a user edit mid-bake would otherwise leak
  // into later frames and produce an inconsistent sequence.
  const items = buildItems()
  const frozenLayers = [...localLayers]
  const total = Math.max(1, Math.round(motion.duration * motion.fps))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(W))
  canvas.height = Math.max(1, Math.round(H))
  const ctx = canvas.getContext('2d')!
  const blobs: Blob[] = []
  for (let i = 0; i < total; i++) {
    const t = i / motion.fps
    if (prepareFrame) await prepareFrame(t)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height) // transparent background
    // bake=true (Task 10): this IS the final motion export — shader-fill fields must
    // render unclamped (full res) and stay live past LIVE_FIELD_CEILING, matching the
    // bake/preview split every other export path now honours.
    paintLayerStack(ctx, canvas.width, canvas.height, items, frozenLayers, undefined, t, motion,
      undefined, undefined, undefined, undefined, true)
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'))
    if (!blob) throw new Error(`motion bake: frame ${i} produced no blob`)
    blobs.push(blob)
    onProgress?.(i + 1, total)
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
): Promise<MotionParams> {
  const blobs = await bakeMotionFrames(buildItems, localLayers, W, H, motion, onProgress, prepareFrame)
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
