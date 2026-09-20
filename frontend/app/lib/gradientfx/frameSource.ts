// frontend/app/lib/gradientfx/frameSource.ts
// Adapt Gradient Studio's renderer to the cross-studio StudioFrameSource contract.
// gradientFx.render(cfg, w, h, time) already returns a canvas, so this is mostly a
// parameter reorder plus the normalized-time conversion.
//
// `render` is injected so this stays unit-testable with no WebGL context.

import type { StudioFrameSource } from '~/lib/studio/frameSource'
import { aspectRatio } from '~/lib/gradientfx/types'

export interface GradientFrameDeps {
  getConfig: () => any
  render: (cfg: any, w: number, h: number, time: number) => TexImageSource
  /** Makes the canvases frames are copied into. Absent → the DOM's; absent AND no DOM
   *  (unit tests, server) → no copy, the live canvas is returned as before. */
  createCanvas?: () => HTMLCanvasElement
}

/**
 * Gradient Studio animates two independent ways, and either one makes it a real
 * clock: motion tracks, and flow.speed (a domain-warp churn that loops seamlessly
 * over motion.duration — see renderer.ts:234-245). With neither, it is a still and
 * reports duration 0 per the registry's `duration <= 0` rule.
 */
// gradientFx is ONE WebGL renderer per page (by design — renderer.ts keeps a single GL
// context to avoid HMR spawning a second one). So its canvas is shared across every
// consumer: the studio card, AND every frame-source consumer (a wired Frame, a chained
// Shader, the Compositor) — often at different sizes and loop-times in the same frame.
// getFrame returns the renderer's live canvas, but consumers copy it AFTER an await, and
// in that gap another consumer's render overwrites the shared canvas — so a consumer
// captured the WRONG frame (the gradient visibly snapped/reset inside a wired Frame while
// the studio's own card stayed smooth). Fix: snapshot the render into a per-call canvas
// SYNCHRONOUSLY, before returning (no await in between), so each consumer holds a stable
// frame no matter what renders next. A tiny round-robin pool bounds the allocation while
// staying larger than the number of consumers that can be mid-await at once.
const SNAP_POOL = 4

export function makeGradientFrameSource(deps: GradientFrameDeps): StudioFrameSource {
  const snaps: HTMLCanvasElement[] = []
  let snapIdx = 0
  const clock = () => {
    const cfg = deps.getConfig()
    const m = cfg?.motion ?? {}
    const hasTracks = (m.tracks?.length ?? 0) > 0
    const hasFlow = (cfg?.flow?.speed ?? 0) > 0
    if (!hasTracks && !hasFlow) return { duration: 0, fps: m.fps ?? 30 }
    return { duration: m.duration ?? 4, fps: m.fps ?? 30 }
  }

  return {
    // Getters, not captured values: the studio's config is edited live, so a
    // snapshot taken at registration time would go stale immediately.
    get duration() { return clock().duration },
    get fps() { return clock().fps },
    get width() { return deps.getConfig()?.motion?.size ?? 1080 },
    // aspectRatio() takes a string and calls .split on it — cfg.canvas may be
    // partial/absent on a fresh or migrating config, so guard the argument
    // (not just the result) before it ever reaches that call.
    get height() {
      const size = deps.getConfig()?.motion?.size ?? 1080
      const ar = aspectRatio(deps.getConfig()?.canvas?.aspect ?? '1:1') || 1
      return Math.max(1, Math.round(size / ar))
    },
    getFrame: async (t01, w, h) => {
      const cfg = deps.getConfig()
      // The registry speaks normalized 0..1; the renderer takes absolute seconds.
      const { duration } = clock()
      const live = deps.render(cfg, w, h, t01 * (duration || 0))
      // Snapshot NOW, synchronously — before any consumer can await and let another
      // render clobber the shared renderer canvas (see the note above makeGradientFrameSource).
      const make = deps.createCanvas ?? (typeof document === 'undefined' ? null : () => document.createElement('canvas'))
      if (!make) return live
      const snap = (snaps[snapIdx] ??= make())
      snapIdx = (snapIdx + 1) % SNAP_POOL
      if (snap.width !== w) snap.width = w
      if (snap.height !== h) snap.height = h
      const ctx = snap.getContext('2d')
      if (!ctx) return live   // no 2D context (shouldn't happen) → best-effort live canvas
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(live as CanvasImageSource, 0, 0, w, h)
      return snap
    },
  }
}
