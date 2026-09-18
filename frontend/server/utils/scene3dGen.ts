// Pure fal text-to-3D helpers, shared by the /api/scene3d/gen-* routes and unit
// tested without any network. The routes wrap these with runFal().

const PROMPT_SUFFIX = ', single centered object, plain neutral background, product shot, full object in frame, soft studio lighting'

/** Bias the FLUX prompt toward a clean, single, centred object on a plain
 *  background — image-to-3D models reconstruct those far better than busy scenes. */
export function shapeImagePrompt(prompt: string): string {
  const p = prompt.trim()
  return p ? `${p}${PROMPT_SUFFIX}` : ''
}

/** The opposite shaping to shapeImagePrompt: not one object on a plain ground, but a flat
 *  swatch of SURFACE that can be tiled across a mesh. Straight-on, evenly lit and edge-to-
 *  edge, because anything with perspective, a vignette or a directional highlight bakes a
 *  fake light direction into the material. */
const TEXTURE_PROMPT_SUFFIX =
  ', seamless tileable surface texture, flat straight-on view, even diffuse lighting,'
  + ' no shadows, no vignette, no perspective, no objects, fills the entire frame edge to edge'

export function shapeTexturePrompt(prompt: string): string {
  const p = prompt.trim()
  return p ? `${p}${TEXTURE_PROMPT_SUFFIX}` : ''
}

export interface ThreeDModel {
  app: string
  buildInput(imageUrl: string, opts: { textured?: boolean, seed?: number }): Record<string, unknown>
  glbUrlFrom(result: unknown): string | null
}

// Standard fal output shape for these models is { model_mesh: { url } }.
const meshUrl = (result: unknown): string | null => {
  const u = (result as { model_mesh?: { url?: string } })?.model_mesh?.url
  return typeof u === 'string' && u ? u : null
}

export const THREE_D_MODELS: Record<string, ThreeDModel> = {
  // Confirmed schema: input_image_url + textured_mesh (3x price), output model_mesh.url.
  'hunyuan3d-v2': {
    app: 'fal-ai/hunyuan3d/v2',
    buildInput: (imageUrl, o) => ({ input_image_url: imageUrl, textured_mesh: o.textured ?? false, ...(o.seed != null ? { seed: o.seed } : {}) }),
    glbUrlFrom: meshUrl,
  },
  // The others use `image_url`; exact fields verified against fal's live schema at build.
  'trellis-2': {
    app: 'fal-ai/trellis-2',
    buildInput: (imageUrl) => ({ image_url: imageUrl }),
    glbUrlFrom: meshUrl,
  },
  'tripo-v2.5': {
    app: 'fal-ai/tripo3d/tripo/v2.5/image-to-3d',
    buildInput: (imageUrl, o) => ({ image_url: imageUrl, texture: o.textured ?? true }),
    glbUrlFrom: (r) => meshUrl(r) ?? ((r as { pbr_model?: { url?: string } })?.pbr_model?.url ?? null),
  },
  'triposr': {
    app: 'fal-ai/triposr',
    buildInput: (imageUrl) => ({ image_url: imageUrl }),
    glbUrlFrom: meshUrl,
  },
}

export const DEFAULT_3D_MODEL = 'hunyuan3d-v2'
export const THREE_D_MODEL_IDS = Object.keys(THREE_D_MODELS)

export function resolve3dModel(id: string | undefined): ThreeDModel {
  return THREE_D_MODELS[id ?? ''] ?? THREE_D_MODELS[DEFAULT_3D_MODEL]!
}
