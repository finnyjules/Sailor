// Real stills for the start modal's studio tiles, drawn by each studio's own
// renderer from the settings a fresh node starts with (spec: "the tile shows
// what you'll get"). A failure leaves the tile's placeholder and logs — never a
// stand-in picture that hides the failure. Every renderer imports its studio
// lazily, so the modal does not pull every studio into the initial bundle.
import type { StartPickId } from '~/data/start-modal'
import { blitCover } from './blit'

/** Paint one frame into `canvas` at its current pixel size; `t` is seconds. */
export type StillRenderer = (canvas: HTMLCanvasElement, t: number) => void | Promise<void>

/** Studios whose still is cheap and time-driven, so the tile plays on hover. */
export const ANIMATED_STILLS: ReadonlySet<StartPickId> = new Set<StartPickId>(['gradient', 'pattern', 'vectortype', 'expressive'])

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2D context on the tile canvas')
  return ctx
}

// Vector Type: one scratch canvas per tile (drawVectorTypeToCanvas resizes its
// target to the output box, so it can't draw straight into the tile).
const vtScratch = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>()

const RENDERERS: Partial<Record<StartPickId, StillRenderer>> = {
  gradient: async (canvas, t) => {
    const [{ gradientFx }, { defaultConfig }, { aspectRatio }] = await Promise.all([
      import('~/lib/gradientfx/renderer'),
      import('~/lib/gradientfx/randomize'),
      import('~/lib/gradientfx/types'),
    ])
    // GradientStudioNode's config for a node with no saved properties, rendered at
    // the config's own aspect (as the card does) and cropped to the tile.
    const cfg = defaultConfig('#default0')
    const ar = aspectRatio(cfg.canvas.aspect) || 1
    const w = Math.max(1, Math.round(Math.max(canvas.width, canvas.height * ar)))
    const h = Math.max(1, Math.round(w / ar))
    const out = gradientFx.render(cfg, w, h, t)
    blitCover(canvas, out, out.width, out.height)
  },

  pattern: async (canvas, t) => {
    const [{ textureFx }, { textureDefaults }, { preloadStylize, stylizeTile }, { drawSheet, fitLetterbox, isSheetFramed, sheetFromParams }] = await Promise.all([
      import('~/lib/texturefx/renderer'),
      import('~/lib/texturefx/controls'),
      import('~/lib/texturefx/stylize'),
      import('~/lib/texturefx/sheet'),
    ])
    await preloadStylize().catch(() => {}) // as TextureStudioNode: stylize is optional
    // TextureStudioNode.renderFrame at the tile's size.
    const p = textureDefaults()
    const W = canvas.width, H = canvas.height
    const s = sheetFromParams(p)
    const framed = isSheetFramed(p)
    const box = framed ? fitLetterbox(s, W, H) : { w: W, h: H, x: 0, y: 0 }
    const view = framed ? s : { w: W, h: H, tile: H }
    const TILE = Math.max(32, Math.min(256, Math.round(view.tile * (box.w / view.w))))
    const out = stylizeTile(textureFx.render(p, TILE, TILE, t), p, TILE, TILE)
    const ctx = ctx2d(canvas)
    ctx.clearRect(0, 0, W, H)
    ctx.save()
    try {
      ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip()
      ctx.translate(box.x, box.y)
      drawSheet(ctx, out, view, box.w, box.h)
    } finally { ctx.restore() }
  },

  shape: async (canvas) => {
    const [{ studioDocFromPersisted }, { renderStudio, drawToCanvas, studioFramePad, studioWarmPaints, hasAsyncPaint, warmPaints }] = await Promise.all([
      import('~/lib/geoshape/studio'),
      import('~/lib/geoshape/render'),
    ])
    // ShapeStudioNode.bakeOutput's path for a node with no saved blob.
    const doc = studioDocFromPersisted(undefined)
    const bg = doc.background
    const shapes = await renderStudio(doc)
    const paints = studioWarmPaints(shapes, bg)
    if (hasAsyncPaint(paints)) await warmPaints(paints, { w: canvas.width, h: canvas.height })
    drawToCanvas(shapes, ctx2d(canvas), canvas.width, canvas.height, studioFramePad(doc), bg)
  },

  vectortype: async (canvas, t) => {
    const [{ mergeConfig }, { loadVectorFont }, { drawVectorTypeToCanvas }, { vtStillTime }] = await Promise.all([
      import('~/lib/vectortype/config'),
      import('~/lib/vectortype/font'),
      import('~/lib/vectortype/canvas'),
      import('~/lib/vectortype/presetMotion'),
    ])
    // VectorTypeNode's defaults for a node with no saved blob: 1280×720 on #0b0d12.
    const cfg = mergeConfig(undefined)
    const outW = 1280, outH = 720
    const font = await loadVectorFont(cfg.fontId)
    // t = 0 is the card's poster (vtStillTime); hover plays t % duration, as the card does.
    const time = t === 0 ? vtStillTime(cfg) : t % Math.max(0.1, cfg.motion?.duration ?? 4)
    let off = vtScratch.get(canvas)
    if (!off) { off = document.createElement('canvas'); vtScratch.set(canvas, off) }
    const k = Math.max(canvas.width / outW, canvas.height / outH)
    drawVectorTypeToCanvas(off, font, cfg, time, { width: outW, height: outH, background: '#0b0d12', pixelRatio: k })
    blitCover(canvas, off, off.width, off.height)
  },

  shader: async (canvas) => {
    const { renderShaderStill } = await import('~/lib/startModal/shaderStill')
    await renderShaderStill(canvas, '/start-modal/shader-starter.webp')
  },

  scene3d: async (canvas) => {
    const { renderScene3DStill } = await import('~/lib/startModal/scene3dStill')
    await renderScene3DStill(canvas)
  },

  expressive: async (canvas, t) => {
    const { renderSpaceTypeStill } = await import('~/lib/startModal/spaceTypeStill')
    await renderSpaceTypeStill(canvas, t)
  },

  moodboard: async (canvas) => {
    // Moodboard has no renderer of its own — its card is a pile of the user's references.
    // The tile shows the same pile made from the shipped house-style pictures.
    const urls = ['/house-styles/azure-bloom/thumb-2.webp', '/house-styles/luminous-prism/thumb-1.webp', '/house-styles/ribbons/thumb-1.webp']
    const imgs = await Promise.all(urls.map(u => new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(`load ${u}`)); i.src = u
    })))
    const ctx = ctx2d(canvas)
    const W = canvas.width, H = canvas.height
    ctx.fillStyle = '#e9e6e1'; ctx.fillRect(0, 0, W, H)
    const slots = [[0.06, 0.1, 0.46, -0.04], [0.5, 0.06, 0.42, 0.03], [0.28, 0.44, 0.44, -0.015]] as const
    imgs.forEach((img, i) => {
      const [x, y, w, rot] = slots[i]!
      const pw = W * w, ph = pw
      ctx.save(); ctx.translate(W * x + pw / 2, H * y + ph / 2); ctx.rotate(rot)
      ctx.fillStyle = '#fff'; ctx.fillRect(-pw / 2 - 4, -ph / 2 - 4, pw + 8, ph + 8)
      ctx.drawImage(img, -pw / 2, -ph / 2, pw, ph); ctx.restore()
    })
  },
}

/** The tile's renderer, or null for AI tiles (they show shipped pictures). */
export function stillRendererFor(id: StartPickId): StillRenderer | null {
  return RENDERERS[id] ?? null
}

/** Paint `id`'s still. Resolves false (and logs the studio) on any failure. */
export async function paintStill(
  id: StartPickId, canvas: HTMLCanvasElement, t = 0,
  renderers: Partial<Record<StartPickId, StillRenderer>> = RENDERERS,
): Promise<boolean> {
  const r = renderers[id]
  if (!r) return false
  try { await r(canvas, t); return true }
  catch (e) { console.error(`[start] ${id} still failed`, e); return false }
}
