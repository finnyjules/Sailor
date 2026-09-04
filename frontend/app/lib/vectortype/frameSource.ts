/**
 * Vector Type Studio → the cross-studio `StudioFrameSource` contract.
 *
 * The EASY case, and for a structural reason: Vector Type is `f(cfg, t) -> paths`
 * with no engine and no GPU context, so a frame source is just "render at that
 * time into a canvas I own". Gradient needed a snapshot pool because its single
 * page-wide WebGL renderer shares one canvas between every consumer; Scene3D
 * needed a whole rebake registry because its engine is stateful. Neither applies
 * here — this source owns its own 2D canvas, so nothing else can clobber it and
 * no snapshot copy is needed.
 *
 * The font is the only asynchronous part, and `loadVectorFont` caches the
 * promise, so `getFrame` awaiting it costs one fetch across every consumer.
 */
import type { StudioFrameSource } from '~/lib/studio/frameSource'
import type { VectorTypeConfig } from './config'
import type { VtFont } from './font'
import { drawVectorTypeToCanvas, vtIsAnimated } from './canvas'

export interface VtFrameSourceDeps {
  getConfig: () => VectorTypeConfig
  /** Resolves the font for the CURRENT config. A function, not a value: the user
   *  can switch family mid-session and a captured font would go stale. */
  getFont: () => Promise<VtFont>
  /** Logical output box, so the frame matches what the node bakes. */
  getSize: () => { width: number; height: number }
  getBackground?: () => string | null
}

export function makeVectorTypeFrameSource(deps: VtFrameSourceDeps): StudioFrameSource {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null

  const clock = () => {
    const cfg = deps.getConfig()
    const m = cfg?.motion
    const fps = m?.fps ?? 30
    // Tracks OR presets count (`vtIsAnimated` owns that question — it gated on
    // tracks alone until the preset engine landed). Stagger by itself animates
    // nothing: it only shifts the clock each glyph reads the others at.
    // Reporting a duration for it would make every downstream consumer run a
    // video pipeline over N identical frames.
    if (!vtIsAnimated(cfg)) return { duration: 0, fps }
    return { duration: m?.duration ?? 4, fps }
  }

  return {
    // Getters, not captured values — the config is edited live.
    get duration() { return clock().duration },
    get fps() { return clock().fps },
    get width() { return Math.max(1, Math.round(deps.getSize().width)) },
    get height() { return Math.max(1, Math.round(deps.getSize().height)) },
    getFrame: async (t01, w, h) => {
      const font = await deps.getFont()
      const cfg = deps.getConfig()
      const { duration } = clock()
      if (!canvas) throw new Error('vectortype frame source: no document')
      // The registry speaks normalised 0..1; the renderer takes absolute seconds.
      drawVectorTypeToCanvas(canvas, font, cfg, t01 * (duration || 0), {
        width: w,
        height: h,
        background: deps.getBackground?.() ?? null,
      })
      return canvas
    },
  }
}
