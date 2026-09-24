// The pre-rendered route's bake (spec Part 2): render the scene's loop through the shared export
// renderer and keep each frame as a WebP data URI. The loop itself is pure (renderAt/encode are
// injected) so its ordering, progress and cancelling are unit-tested without a GPU.
import type { SceneDoc } from '~/lib/scene3d/config'
import { sceneLoop } from '~/lib/scene3d/motion/render'
import { prepareExportEngine, renderExportFrame, settleFrameLoads, appExportIO, SceneExportFailed, type ExportIO } from '~/lib/scene3d/exportRender'
import type { SceneEngine } from '~/lib/scene3d/engine'
import type { AssetFailure } from '~/lib/scene3d/assetTracker'

export const WEBP_QUALITY = 0.82

export function frameCountFor(loop: { animated: boolean; duration: number }, fps: number): number {
  return loop.animated ? Math.max(1, Math.round(loop.duration * fps)) : 1
}

export async function bakeFrameSequence(opts: {
  count: number
  renderAt(t01: number): HTMLCanvasElement | Promise<HTMLCanvasElement>
  encode(c: HTMLCanvasElement): Promise<string>
  onProgress?(done: number, total: number): void
  signal?: AbortSignal
}): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < opts.count; i++) {
    if (opts.signal?.aborted) throw new DOMException('Bake aborted', 'AbortError')
    const canvas = await opts.renderAt(i / opts.count)
    out.push(await opts.encode(canvas))            // before the next render reuses the canvas
    opts.onProgress?.(i + 1, opts.count)
  }
  return out
}

export function encodeWebp(canvas: HTMLCanvasElement, quality = WEBP_QUALITY): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Could not encode a frame'))
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(r.error ?? new Error('Could not read a frame'))
      r.readAsDataURL(blob)
    }, 'image/webp', quality)
  })
}

export interface SceneBakeResult { frames: string[]; fps: number; duration: number; width: number; height: number; failures: AssetFailure[] }

/** Accumulate one cinematic frame to `target` REPORTED samples (`cinematicStatus().samples`), not
 *  `target` raw `render()` calls: `ScenePathTracer` tiles its GPU work (`tiles.set(3, 3)`, to keep
 *  the live viewport responsive while path-tracing), so one `render()` covers one tile, not one
 *  full frame — measured at 9 `render()` calls per reported sample. A bake has no responsiveness
 *  to protect, so it drives the tracer to convergence by the number a person actually asked for.
 *  Capped at `target * TILE_CALL_CEILING` `render()` calls so a tracer stuck mid-compile (a lost
 *  GL context, `isCompiling` never clearing) cannot hang the bake forever; falling short of
 *  `target` there just means a noisier frame, not a thrown error — the bake still finishes. */
// ~2x the measured 9 calls/sample (3x3 tiles, see PathTracer.ts's `tiles.set(3, 3)`), headroom for
// a finer tile grid
export const TILE_CALL_CEILING = 20

export function finishCinematicSample(engine: Pick<SceneEngine, 'render' | 'cinematicStatus'>, target: number): void {
  const ceiling = target * TILE_CALL_CEILING
  for (let calls = 0; engine.cinematicStatus().samples < target && calls < ceiling; calls++) engine.render()
}

export async function bakeSceneFrames(doc: SceneDoc, opts: {
  width: number; height: number; fps: 24 | 30; transparent: boolean
  cinematic?: { samples: number }
  io?: ExportIO
  onProgress?(done: number, total: number): void
  signal?: AbortSignal
}): Promise<SceneBakeResult> {
  const loop = sceneLoop(doc)
  const bakeDoc = opts.transparent ? { ...doc, background: 'transparent' as const } : doc
  const { engine, failures } = await prepareExportEngine(bakeDoc, { width: opts.width, height: opts.height, io: opts.io ?? appExportIO })
  try {
    const base = { fps: opts.fps, duration: loop.duration, width: opts.width, height: opts.height }
    if (failures.length) return { ...base, frames: [], failures }
    if (opts.cinematic) await engine.setCinematic(true)
    let frames: string[]
    try {
      frames = await bakeFrameSequence({
        count: frameCountFor(loop, opts.fps),
        renderAt: async (t01) => {
          // A load this frame's sync started (a decal rebuilt on a text or mesh object) is waited
          // for before the render, and one that fails stops the bake by name — as at t=0.
          const late = await settleFrameLoads(engine, bakeDoc, t01)
          if (late.length) throw new SceneExportFailed(late)
          if (!opts.cinematic) return renderExportFrame(engine, bakeDoc, t01)
          // Path-traced: pose the scene at t01 first (syncs objects/camera — one throwaway raster/
          // trace sample against the STALE BVH, discarded below). `cinematicReset` only clears the
          // accumulation buffer, it does not rebuild the BVH (see PathTracer.reset vs .rebuild), so
          // after every frame's objects have actually moved (motion moves them every frame) it would
          // keep accumulating samples traced against the PREVIOUS frame's geometry. `cinematicRefresh`
          // is what the live surface calls after every doc change for exactly this reason (see
          // Scene3DStudioSurface's doc watcher) — it rebuilds the BVH from the now-current pose AND
          // restarts accumulation (PathTracer.rebuild's own doc: "restart accumulation"), so the
          // samples below all trace the correct, freshly-synced frame.
          renderExportFrame(engine, bakeDoc, t01)
          engine.cinematicRefresh()
          finishCinematicSample(engine, opts.cinematic!.samples)
          return engine.renderer.domElement as HTMLCanvasElement
        },
        encode: c => encodeWebp(c),
        onProgress: opts.onProgress,
        signal: opts.signal,
      })
    } catch (err) {
      if (err instanceof SceneExportFailed) return { ...base, frames: [], failures: err.assetFailures }
      throw err
    }
    return { ...base, frames, failures: [] }
  } finally {
    engine.dispose()
  }
}
