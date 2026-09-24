// The Scene3D start tile: the SAME starter doc the node is created with
// (VueNodeCanvas.materializeStart serializes starterSceneDoc()), rendered once by a
// throwaway headless engine exactly as Scene3DStudioNode.renderPreview does, then
// disposed so an idle modal holds no WebGL context.
import { createPrimitive, defaultDoc, PLACEABLE_PRIMITIVE_KINDS, type PrimitiveKind, type SceneDoc } from '~/lib/scene3d/config'
import { blitCover } from './blit'

/** A 3D scene with one object, so the studio never starts empty. */
export function starterSceneDoc(): SceneDoc {
  const doc = defaultDoc()
  const kind = (['torusKnot', 'sphere', 'box'] as const).find(k => (PLACEABLE_PRIMITIVE_KINDS as string[]).includes(k))
    ?? PLACEABLE_PRIMITIVE_KINDS[0]!
  doc.objects.push(createPrimitive(kind as PrimitiveKind, doc.objects))
  return doc
}

export async function renderScene3DStill(canvas: HTMLCanvasElement): Promise<void> {
  const [{ SceneEngine }, { renderMotionFrameSettled }] = await Promise.all([
    import('~/lib/scene3d/engine'),
    import('~/lib/scene3d/motion/render'),
  ])
  const doc = starterSceneDoc()
  // The doc's own aspect at roughly the tile's size; blitCover crops to the tile.
  const scale = Math.max(canvas.width / doc.output.width, canvas.height / doc.output.height)
  const w = Math.max(1, Math.round(doc.output.width * scale))
  const h = Math.max(1, Math.round(doc.output.height * scale))
  const eng = new SceneEngine(document.createElement('canvas'), w, h) // throws without WebGL
  try {
    const out = await renderMotionFrameSettled(eng, doc, 0)
    blitCover(canvas, out, out.width, out.height)
  } finally {
    eng.dispose()
  }
}
