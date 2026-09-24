// frontend/app/lib/shaderstudio/frameSource.ts
// Shader Studio as a live Frame source. The node already renders frames for its
// card (renderFrame in ShaderStudioNode.vue); this adapts that to the registry
// contract. A shader with no picture wired in has nothing to show — reject, so the
// Frame reports it instead of painting an empty layer silently.
import type { StudioFrameSource } from '~/lib/studio/frameSource'

export interface ShaderFrameDeps {
  getSize: () => { w: number; h: number }
  getDuration: () => number
  render: (t01: number, w: number, h: number) => Promise<TexImageSource | null>
}

export function makeShaderFrameSource(deps: ShaderFrameDeps): StudioFrameSource {
  return {
    fps: 30,
    get duration() { return deps.getDuration() },
    get width() { return deps.getSize().w },
    get height() { return deps.getSize().h },
    getFrame: async (t01, w, h) => {
      const out = await deps.render(t01, w, h)
      if (!out) throw new Error('shader studio: no picture wired in')
      return out
    },
  }
}

/** The duration a wired Frame should see. A shader only animates when something in it
 *  moves (its own tracks, a moving source, or an effect on the clock); a still shader
 *  reports 0 so the Frame treats it as a picture — downloads stay stills and the live
 *  loop stays off. The node's clock never drops below 0.1 s, so it can't be the test. */
export function shaderFrameDuration(moving: boolean, clockSeconds: () => number): number {
  return moving ? clockSeconds() : 0
}
