// frontend/app/lib/texturefx/frameSource.ts
// Pattern (Texture Studio) as a live Frame source — a still: the Frame pulls the
// same full sheet the studio exports (renderSheetCanvas), at the sheet's own size.
// Same shape as lib/geoshape/frameSource.ts. `render` is injected for unit tests.

import type { StudioFrameSource } from '~/lib/studio/frameSource'
import type { Params } from '~/lib/spacetype/effect'

export interface TextureFrameDeps {
  getParams: () => Params
  render: (p: Params) => HTMLCanvasElement
  size: (p: Params) => { w: number; h: number }
}

export function makeTextureFrameSource(deps: TextureFrameDeps): StudioFrameSource {
  return {
    duration: 0,
    fps: 30,
    // Getters, not captured values: the studio's params are edited live, so a
    // snapshot taken at registration time would go stale immediately.
    get width() { return deps.size(deps.getParams()).w },
    get height() { return deps.size(deps.getParams()).h },
    getFrame: async () => deps.render(deps.getParams()),
  }
}
