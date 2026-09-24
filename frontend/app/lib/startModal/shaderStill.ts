// The Shader start tile: the bundled starter picture (the same one
// materializeStart uploads into the Image card that feeds the new Shader node)
// run through the passes a fresh ShaderStudio node starts with, the same way
// ShaderStudioNode.renderFrame builds them.
import { blitCover } from './blit'

export async function renderShaderStill(canvas: HTMLCanvasElement, pictureUrl: string): Promise<void> {
  const [{ fetchShaderFxCatalog, resolveEffectId }, { shaderFx }, { composePasses }, { migrateShaderConfig }, { loadImage }, { hydrateConfig, outputDims }] = await Promise.all([
    import('~/lib/shaderfx/catalog'),
    import('~/lib/shaderfx/renderer'),
    import('~/lib/shaderstudio/passes'),
    import('~/lib/shaderstudio/migrate'),
    import('~/lib/shaderstudio/source'),
    import('~/lib/shaderstudio/types'),
  ])
  const [img, catalog] = await Promise.all([loadImage(pictureUrl), fetchShaderFxCatalog()])
  // What ShaderStudioNode reads for a node with no saved config.
  const cfg = hydrateConfig(migrateShaderConfig(undefined))
  const effectDef = (id: string) => catalog.effects.find(e => e.id === resolveEffectId(id)) ?? null
  const { w, h } = outputDims(img.naturalWidth, img.naturalHeight, Math.max(canvas.width, canvas.height), { upscale: true })
  const out = shaderFx.render(composePasses(cfg, effectDef, 0), img, w, h)
  blitCover(canvas, out, out.width, out.height)
}
