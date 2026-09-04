// frontend/app/lib/geoshape/frameSource.ts
// Adapt Shape Studio's 2D vector renderer to the cross-studio StudioFrameSource
// contract, so wiring a Shape Studio node directly into a Frame paints its content
// live — the SAME live-source path Gradient/Vector/Space/Scene3D already use
// (frameResolve.ts prefers a live source over a baked file). Without this a direct
// Shape→Frame wire resolves to null: the node registers only a still-bake baker,
// and the Frame's resolver finds no live source and no data.images, so the slot is
// skipped and nothing paints.
//
// Shape Studio is a STILL (no motion), so duration is 0 and t01 is ignored.
// `render` is injected so this unit-tests with no canvas/DOM.

import type { StudioFrameSource } from '~/lib/studio/frameSource'

export interface ShapeFrameDeps {
  /** The node's persisted Shape Studio blob (properties.sailor_shapeStudio). */
  getPersisted: () => { canvasW?: number; canvasH?: number } | undefined
  /** Render the persisted config to a texture-uploadable surface at the given size. */
  render: (w: number, h: number) => Promise<TexImageSource>
}

const DEFAULT_DIM = 1024

export function makeShapeFrameSource(deps: ShapeFrameDeps): StudioFrameSource {
  // Getter, not a captured value: the studio's config is edited live, so a
  // snapshot taken at registration time would go stale immediately.
  const dim = (k: 'canvasW' | 'canvasH') => {
    const v = deps.getPersisted()?.[k]
    return typeof v === 'number' && v > 0 ? Math.round(v) : DEFAULT_DIM
  }
  return {
    duration: 0,   // still — no clock; the Frame pulls one frame, no preview loop
    fps: 30,
    get width() { return dim('canvasW') },
    get height() { return dim('canvasH') },
    getFrame: (_t01, w, h) => deps.render(w, h),
  }
}
