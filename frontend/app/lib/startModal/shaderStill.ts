// The Shader start tile: the bundled starter picture (the same one
// materializeStart uploads into the Image card that feeds the new Shader node)
// run through starterShaderConfig() — the config that new node is created with —
// the same way ShaderStudioNode.renderFrame builds its passes.
import { hydrateConfig, newLayerId, type ShaderStudioConfig } from '~/lib/shaderstudio/types'
import { migrateShaderConfig } from '~/lib/shaderstudio/migrate'
import { blitCover } from './blit'

/** Catalog id of the starter effect. Crystal Prism: it works ON the picture (not a
 *  generative fill that hides it), its facets + dispersion read clearly on any photo,
 *  and its Shimmer dial (default 0.2) drives u_time, so the node animates on hover. */
export const STARTER_SHADER_EFFECT = 'crystal_prism'

/**
 * The config a Shader node made by the start modal starts with, and the one its
 * tile renders — a fresh node's own default has an EMPTY effect stack, which would
 * show only the plain picture (spec: "a studio whose default renders nothing useful
 * gets a starter preset that the tile AND the new node both use"). Built through the
 * node's own load path (migrate → hydrate), so it is a valid saved
 * `properties.sailor_shaderStudio`. Empty `params` = the catalog's defaults.
 */
export function starterShaderConfig(): ShaderStudioConfig {
  return hydrateConfig(migrateShaderConfig({
    effects: [{ layerId: newLayerId(), id: STARTER_SHADER_EFFECT, params: {}, enabled: true, customChars: '', blend: 'normal', opacity: 1 }],
  }))
}

export async function renderShaderStill(canvas: HTMLCanvasElement, pictureUrl: string): Promise<void> {
  const [{ fetchShaderFxCatalog, resolveEffectId }, { shaderFx }, { composePasses }, { loadImage }, { outputDims }] = await Promise.all([
    import('~/lib/shaderfx/catalog'),
    import('~/lib/shaderfx/renderer'),
    import('~/lib/shaderstudio/passes'),
    import('~/lib/shaderstudio/source'),
    import('~/lib/shaderstudio/types'),
  ])
  const [img, catalog] = await Promise.all([loadImage(pictureUrl), fetchShaderFxCatalog()])
  const cfg = starterShaderConfig()
  const effectDef = (id: string) => catalog.effects.find(e => e.id === resolveEffectId(id)) ?? null
  // composePasses silently skips an unknown effect — that would draw the plain
  // picture and hide the failure, so refuse instead.
  if (!effectDef(STARTER_SHADER_EFFECT)) throw new Error(`shader catalog has no "${STARTER_SHADER_EFFECT}"`)
  const { w, h } = outputDims(img.naturalWidth, img.naturalHeight, Math.max(canvas.width, canvas.height), { upscale: true })
  const out = shaderFx.render(composePasses(cfg, effectDef, 0), img, w, h)
  blitCover(canvas, out, out.width, out.height)
}
