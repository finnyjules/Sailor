// frontend/app/lib/spacetype/wiredRenderer.ts
// The Space Type node's headless frame-source engine — what a wired consumer (a Frame, a
// directly-wired Shader Studio, a Frame export's pre-rendered route) pulls frames from.
// MOVED verbatim from SpaceTypeNode.vue (createHeadless / ensureHeadless / renderAt, plus the
// `headlessDirty` flag the node sets on config changes, now `markDirty()`), so the node and the
// Frame-export parity harness render through ONE code path. Keep it that way: same setters in
// the same order, same font priming, same syncImageTextures handling, same wiredLoopFrameArg
// timing. A change here changes what every wired Space Type layer shows.

import { SpaceTypeEngine } from './engine'
import { detectWebGL } from './webgl'
import { getEffect } from './effects'
import { loopMultiplier, wiredLoopFrameArg } from './loop'
import { ensureSpaceTypeFont, texOptsFromState, type SpaceTypeState } from './state'
import { DEFAULT_POST } from './post'
import { syncImageTextures } from './imageTextures'

export interface WiredSpaceTypeRenderer {
  /** Render the state at `t01` (over the FULL seamless loop) into the renderer's own offscreen
   *  canvas at w×h and return it, or null when WebGL is unavailable. `state` may be a getter:
   *  the node passes one so a config saved while image cards load is read fresh after the
   *  await, exactly as it always did. */
  render(state: SpaceTypeState | (() => SpaceTypeState), t01: number, w: number, h: number): Promise<HTMLCanvasElement | null>
  /** The state changed since the last build: the next render rebuilds (deferred to that pull
   *  rather than rebuilding an offscreen engine per config keystroke). */
  markDirty(): void
  /** Free the engine and its WebGL context. Later renders return null. */
  dispose(): void
}

export function createWiredSpaceTypeRenderer(): WiredSpaceTypeRenderer {
  // A dedicated engine, separate from any card preview, lazily created on the first pull, so
  // a Space Type node with no live downstream consumer never pays the extra WebGL context.
  // Its own offscreen canvas — never the card's — so the two never fight over one canvas at
  // different frame indices (which would ghost the card).
  let headlessEngine: SpaceTypeEngine | null = null
  let headlessCanvas: HTMLCanvasElement | null = null
  let headlessDirty = true   // config changed since the last headless build
  let disposed = false

  function createHeadless(s: SpaceTypeState, w: number, h: number): SpaceTypeEngine | null {
    if (!detectWebGL()) return null
    if (!headlessEngine) {
      headlessCanvas = document.createElement('canvas')
      // Construct at the requested size, not the preview size: aspect-dependent
      // effects (string/contour/tunnel/…) read env.width/height at BUILD time.
      headlessEngine = new SpaceTypeEngine(headlessCanvas, {
        effect: getEffect(s.effectId), width: w, height: h,
        fps: s.fps, loopDuration: s.loopDuration, alpha: s.transparent, bgColor: s.bgColor,
        projection: s.projection ?? 'perspective',
      })
      headlessDirty = true
      // A card mount usually primes the font first (shared global cache), but if a pull
      // races ahead, force one rebuild once the font resolves so text isn't baked with
      // a fallback face. Config-driven font changes are primed by the card's own await.
      void ensureSpaceTypeFont(String(s.params.font)).then(() => { headlessDirty = true })
    }
    return headlessEngine
  }

  function ensureHeadless(s: SpaceTypeState, w: number, h: number): SpaceTypeEngine | null {
    const eng = createHeadless(s, w, h)
    if (!eng) return null
    if (headlessDirty) {
      eng.setSize(w, h)   // BEFORE build — geometry layout reads the size
      eng.setBackground(s.transparent, s.bgColor)
      eng.setProjection(s.projection ?? 'perspective')
      eng.setPost({ ...(s.post ?? DEFAULT_POST) })
      eng.setPan(s.panX ?? 0, s.panY ?? 0)
      eng.setFps(s.fps)
      eng.setLoopDuration(s.loopDuration)
      eng.setEffect(getEffect(s.effectId))
      eng.build(s.params, texOptsFromState(s))
      headlessDirty = false
    }
    return eng
  }

  return {
    async render(state, t01, w, h) {
      if (disposed) return null
      const read = typeof state === 'function' ? state : () => state
      // A Showcase's image cards must be loaded into THIS engine before its synchronous
      // build. A no-op (no await on anything real) unless the image set changed.
      const fresh = createHeadless(read(), w, h)
      if (fresh && await syncImageTextures(fresh, read().effectId, read().params, () => headlessEngine === fresh)) headlessDirty = true
      if (disposed) return null
      const eng = ensureHeadless(read(), w, h)
      if (!eng || !headlessCanvas) return null
      const s = read()
      eng.setSize(w, h)   // covers a scale change between pulls (same aspect, no rebuild)
      // Match the studio's own export (SpaceTypeSurface bakeSpaceTypeVideo): spans the
      // FULL seamless k-loop, not just one base loop, so motion plays at native speed
      // and seams only at the k-loop wrap.
      const k = s.seamless ? loopMultiplier(getEffect(s.effectId).loopRates?.(s.params) ?? []) : 1
      eng.renderFrameAt(wiredLoopFrameArg(t01, s.fps, s.loopDuration, k), s.params)
      return headlessCanvas
    },
    markDirty() { headlessDirty = true },
    dispose() {
      disposed = true
      headlessEngine?.dispose()
      headlessEngine = null
      headlessCanvas = null
    },
  }
}
