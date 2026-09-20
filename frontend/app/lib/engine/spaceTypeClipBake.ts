// frontend/app/lib/engine/spaceTypeClipBake.ts
/** Bake a Space Type clip to PNG frames for the Python export path, which
 *  cannot run three.js.
 *
 *  We bake ONE seamless cycle — k loops, where k comes from loopMultiplier so
 *  every motion rate completes whole cycles — and let the exporter tile it. A
 *  6s loop on a 60s clip is 180 frames, not 1800.
 *
 *  The cache key deliberately EXCLUDES clip placement, trim, opacity and
 *  keyframes: those composite at export time, so moving or fading a clip must
 *  not invalidate the bake. It deliberately INCLUDES post-processing,
 *  projection, pan and the gradient — see bakeCfg. */
import type { SpaceTypeClip, MotionBake } from '~~/shared/timeline/types'
import { ensureSpaceTypeBake } from '~/lib/spacetype/bake'
import { dimsFromState } from '~/lib/spacetype/state'
import { spaceTypeSourceFrameCount } from '~/composables/timelineSpaceTypeClip'
import { fetchShaderFxCatalog } from '~/lib/shaderfx/catalog'
import { renderSpaceTypeClipToCanvas, spaceTypeLoopMultiplier } from './spaceTypeClipRenderer'
import { acquireSpaceTypeEngine, releaseSpaceTypeEngine } from './spaceTypeEnginePool'

// spaceTypeLoopMultiplier now lives in spaceTypeClipRenderer.ts (re-exported
// here for existing importers) so sourceT01 (preview) and this bake share the
// exact same k — see that file's docstring on why the two must not drift.
export { spaceTypeLoopMultiplier }

/** Frames in one seamless bake cycle (k whole loops). */
export function spaceTypeBakeFrameCount(clip: SpaceTypeClip): number {
  return spaceTypeSourceFrameCount(clip) * spaceTypeLoopMultiplier(clip)
}

/** The hashed bake input.
 *
 *  post / projection / pan / gradient MUST be in here. `spaceTypeSourceKey`'s
 *  own SourceKeyInput omits them, which is fine for the studio's mp4 button
 *  (it always re-bakes) but wrong here: this bake is cached and skipped on a
 *  key match, so a user who changed bloom, exposure or pan would export stale
 *  frames showing the OLD look, silently. Folding them into the hashed params
 *  bag is the cheapest correct fix — the key is opaque, so extra entries only
 *  ever cause a (correct) re-bake. */
export function bakeCfg(clip: SpaceTypeClip) {
  const [W, H] = dimsFromState(clip.state)
  const k = spaceTypeLoopMultiplier(clip)
  return {
    effectId: clip.state.effectId,
    params: {
      ...clip.state.params,
      __post: JSON.stringify(clip.state.post ?? null),
      __projection: clip.state.projection ?? 'perspective',
      __pan: `${clip.state.panX ?? 0},${clip.state.panY ?? 0}`,
      __gradient: JSON.stringify(clip.state.gradientStops ?? []),
    },
    fps: clip.state.fps,
    loopDuration: clip.state.loopDuration * k,   // k loops in one bake
    W,
    H,
    alpha: clip.state.transparent,
    bgColor: clip.state.bgColor,
  }
}

async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      b => b ? resolve(b) : reject(new Error('space type bake: toBlob returned null')),
      'image/png',
    )
  })
}

/** Bake if missing or stale. Returns a MotionBake with external: true, so the
 *  export-side skip in TimelineEditor leaves these frames alone (they were not
 *  produced from a MotionClip text layer). */
export async function ensureSpaceTypeClipBake(
  clip: SpaceTypeClip,
  onProgress?: (done: number, total: number) => void,
): Promise<MotionBake> {
  // Item 8 (final review): renderSpaceTypeClipToCanvas's engine.buildKeyed() below is a
  // synchronous, one-shot-per-structural-key build — a shader fill whose effect isn't in
  // the catalog YET at frame 0's build gets no guaranteed second chance before its fallback
  // pixels are PNG-encoded and uploaded as this clip's persisted bake (buildKeyed's cache-hit
  // path never re-invokes shaderFieldTexture on later frames — see fills.ts's doc). Await the
  // catalog before the very first frame, same guard as every other one-shot bake in this
  // feature (ShapeStudioNode.bakeOutput, SpaceTypeNode.bakeOutput, Scene3DStudioNode.rebakePasses).
  // A plain `try`, not `.catch()` on the call's return value: `fetchShaderFxCatalog` uses
  // Nuxt's auto-imported `$fetch`, which throws SYNCHRONOUSLY (not a rejected promise) outside
  // a Nuxt runtime context (e.g. this module imported directly by a plain vitest unit test) —
  // `.catch()` never even gets attached in that case, since the expression throws before
  // returning a promise to call `.catch` on.
  try { await fetchShaderFxCatalog() } catch { /* offline/backend down, or non-Nuxt context — bake proceeds and falls back same as before */ }
  const cfg = bakeCfg(clip)
  // Acquire ONCE for the whole bake, release in `finally` — never per frame.
  // See the ownership contract at the top of spaceTypeEnginePool.ts.
  const handle = acquireSpaceTypeEngine()
  if (!handle) throw new Error(`space type bake: no WebGL2 — cannot bake clip ${clip.id}`)
  try {
    const bake = await ensureSpaceTypeBake(cfg, clip.spacetype_bake, {
      renderFrame: async (index: number) => {
        // A bake index IS a source frame (0..k*T-1) — sourceT01 no longer reads
        // clip.in_frame at all (see its doc comment), so cloning with in_frame:0
        // would be dead weight now; only `loop: true` still needs forcing, so a
        // clip authored with loop:false doesn't clamp mid-cycle while baking the
        // one full seamless cycle the export tiles from.
        const src = { ...clip, loop: true } as SpaceTypeClip
        // bake:true — this produces the final exported PNG sequence, so any shader fill on
        // the clip must render at full resolution, not the live-preview/scrub clamp. See
        // renderSpaceTypeClipToCanvas's doc.
        const canvas = renderSpaceTypeClipToCanvas(handle, src, index, clip.state.fps, true)
        if (!canvas) throw new Error(`space type bake: engine unavailable at frame ${index} of clip ${clip.id}`)
        return await canvasToPngBlob(canvas)
      },
      onProgress,
    })
    return { ...bake, external: true }
  } finally {
    releaseSpaceTypeEngine(handle)
  }
}
