// The fixed allowlist of image models the AI restyle treatment (S7) can dispatch. Pure data:
// three-free, Vue-free and importable from BOTH the client (the inspector `select` reads the
// ids + labels) and the server route (its dispatch allowlist reads the same list, so a slug the
// UI can pick is exactly a slug the route can send).
//
// Each id MUST have a `MODEL_COSTS` row (server/utils/priceBook.ts): runFal REFUSES an unpriced
// slug ("unpriced model refused", requestMeter.ts) before any request, and the
// scene3d-restyle-models unit spec ties this list to the price book so they cannot drift apart.
//
// `control` says which crop the route feeds the model: 'depth' models take the object's rendered
// DEPTH crop as a structure-preserving control image; 'image' models take the BEAUTY crop as an
// img2img source. Depth-only is the v1 primary (the normal crop is rendered but held for a
// union-ControlNet follow-up); img2img is the robust fallback.
export interface RestyleModel {
  id: string
  label: string
  control: 'depth' | 'image'
  provider: 'fal'
}

export const RESTYLE_MODELS: RestyleModel[] = [
  { id: 'fal-ai/flux-control-lora-depth', label: 'Depth control (Flux)', control: 'depth', provider: 'fal' },
  { id: 'fal-ai/flux/dev/image-to-image', label: 'Image to image (Flux)', control: 'image', provider: 'fal' },
]
