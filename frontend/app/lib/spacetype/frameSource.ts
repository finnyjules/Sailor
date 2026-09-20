// frontend/app/lib/spacetype/frameSource.ts
// Adapt Space Type's engine to the cross-studio StudioFrameSource contract.
//
// Unlike Gradient Studio (see lib/gradientfx/frameSource.ts), whose renderer
// RETURNS a canvas, SpaceTypeEngine.renderFrameAt(t01, params) draws into a
// canvas it already owns and returns nothing — so this renders first, then hands
// that canvas back.
//
// Dependencies are injected so the module stays unit-testable with no WebGL
// context and no Vue component around it.

import type { StudioFrameSource } from '~/lib/studio/frameSource'

export interface SpaceTypeFrameDeps {
  getClock: () => { duration: number; fps: number; width: number; height: number }
  /** Render into the engine's canvas and return it, or null if the engine is not ready.
   *  May be async: a Showcase must load its image cards before the engine's (synchronous)
   *  build, or the first pulled frames carry blank cards. */
  renderAt: (t01: number, w: number, h: number) => TexImageSource | null | Promise<TexImageSource | null>
}

export function makeSpaceTypeFrameSource(deps: SpaceTypeFrameDeps): StudioFrameSource {
  return {
    // Getters, not captured values: the studio's config is edited live, so a
    // snapshot taken at registration time would go stale immediately.
    get duration() { return deps.getClock().duration },
    get fps() { return deps.getClock().fps },
    get width() { return deps.getClock().width },
    get height() { return deps.getClock().height },
    getFrame: async (t01, w, h) => {
      const surface = await deps.renderAt(t01, w, h)
      // Fail loudly here rather than returning null: a not-yet-mounted engine
      // would otherwise surface several frames later as an opaque WebGL
      // "invalid texture source" error at the consumer's upload call.
      if (!surface) throw new Error('space-type frame source: engine not ready')
      return surface
    },
  }
}
