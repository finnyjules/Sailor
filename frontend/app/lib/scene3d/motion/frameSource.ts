// frontend/app/lib/scene3d/motion/frameSource.ts
// Adapt Scene3D's engine to the cross-studio StudioFrameSource contract.
//
// Mirrors spacetype/frameSource.ts: getters read the live clock each pull so a
// downstream Frame always sees the latest duration/fps/size. `getFrame` delegates
// to `renderAt` and throws if it returns null.
//
// Dependencies are injected so the module stays unit-testable with no WebGL
// context and no Vue component around it.

import { StudioExportFailed, type StudioExportFailure, type StudioExportSession, type StudioFrameSource } from '~/lib/studio/frameSource'
import type { AssetFailure } from '~/lib/scene3d/assetTracker'
import { failureClause, failureName } from '~/lib/scene3d/assetNames'

/** A 3D asset failure as the Frame reads it: named for a sentence, and the whole clause worded as
 *  3D Studio's own Export embed sheet words it (`failureClause`, mid-sentence). */
function frameFailure(f: AssetFailure): StudioExportFailure {
  return { name: failureName(f), reason: f.reason, text: failureClause(f, { lower: true }) }
}

/** What a scene export session's `frame` throws when that frame's sync started a load that
 *  failed (`openSceneExport`). Structural, so this module needs no import of the renderer. */
function assetFailuresOf(err: unknown): AssetFailure[] | null {
  const list = (err as { assetFailures?: unknown } | null)?.assetFailures
  return Array.isArray(list) && list.length ? list as AssetFailure[] : null
}

export interface Scene3DFrameSourceDeps {
  getClock: () => { duration: number; fps: number; width: number; height: number }
  /** Render at normalized loop time t01 (0..1) and return the canvas, or null if
   *  the engine is not ready. May be async: the settled render path awaits decal
   *  texture builds before its one-shot render (see renderMotionFrameSettled). */
  renderAt: (t01: number, w: number, h: number) => HTMLCanvasElement | null | Promise<HTMLCanvasElement | null>
  /** An export session on an engine of its own (`openSceneExport`): the export path, apart from
   *  `renderAt`'s preview path. Its failures come back named for a sentence (`failureName`),
   *  worded whole (`failureClause`) — and a frame that finds a failed load stops the pull with
   *  them (`StudioExportFailed`). */
  openExport?: (size: { width: number; height: number }) => Promise<{
    failures: AssetFailure[]; frame(t01: number): HTMLCanvasElement | Promise<HTMLCanvasElement>; close(): void
  }>
}

/** Live frame puller for a 3D Studio node — mirrors spacetype/frameSource.ts.
 *  Getters read the current clock each pull so a downstream Frame always sees
 *  the latest duration/fps/size. */
export function makeScene3DFrameSource(deps: Scene3DFrameSourceDeps): StudioFrameSource {
  return {
    // Getters, not captured values: the studio's config is edited live, so a
    // snapshot taken at registration time would go stale immediately.
    get duration() { return deps.getClock().duration },
    get fps() { return deps.getClock().fps },
    get width() { return deps.getClock().width },
    get height() { return deps.getClock().height },
    getFrame: async (t01, w, h) => {
      // Await, don't just return: a pending Promise is truthy, so the not-ready
      // guard below must see the RESOLVED value.
      const surface = await deps.renderAt(t01, w, h)
      // Fail loudly here rather than returning null: a not-yet-mounted engine
      // would otherwise surface several frames later as an opaque WebGL
      // "invalid texture source" error at the consumer's upload call.
      if (!surface) throw new Error('scene3d frame source: engine not ready')
      return surface as unknown as TexImageSource
    },
    ...(deps.openExport ? { openExport: async (size: { width: number; height: number }): Promise<StudioExportSession> => {
      const session = await deps.openExport!(size)
      return {
        failures: session.failures.map(frameFailure),
        frame: async (t01) => {
          try {
            return (await session.frame(t01)) as unknown as TexImageSource
          } catch (err) {
            const failed = assetFailuresOf(err)
            throw failed ? new StudioExportFailed(failed.map(frameFailure)) : err
          }
        },
        close: () => session.close(),
      }
    } } : {}),
  }
}
