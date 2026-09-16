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
  control: 'depth' | 'image' | 'depth+style'
  provider: 'fal'
  /** Shown on the inspector's Model dropdown. The depth+style model is route-internal (the route
   *  swaps to it when a Style with refs is attached), never a user pick — so `false`. Absent ⇒ true. */
  selectable?: boolean
}

export const RESTYLE_MODELS: RestyleModel[] = [
  { id: 'fal-ai/flux-control-lora-depth', label: 'Depth control (Flux)', control: 'depth', provider: 'fal' },
  { id: 'fal-ai/flux/dev/image-to-image', label: 'Image to image (Flux)', control: 'image', provider: 'fal' },
  // Route-internal: chosen by pickRestyleModel when a moodboard with reference images is attached.
  // Accepts a depth ControlNet + IP-adapter refs in one call (spec 2026-09-16, Approach A).
  { id: 'fal-ai/flux-general', label: 'Depth + Style (Flux)', control: 'depth+style', provider: 'fal', selectable: false },
]

/** Which model the route dispatches. A Style with reference images ⇒ the depth+style model; otherwise
 *  the requested selectable model (default the first). The internal depth+style model can never be
 *  chosen by `requestedId` — it is `selectable: false` and only reachable via `hasStyleRefs`. */
export function pickRestyleModel(requestedId: string | undefined, hasStyleRefs: boolean): RestyleModel {
  if (hasStyleRefs) {
    const styled = RESTYLE_MODELS.find((m) => m.control === 'depth+style')
    if (styled) return styled
  }
  return RESTYLE_MODELS.find((m) => m.id === requestedId && m.selectable !== false) ?? RESTYLE_MODELS[0]!
}
