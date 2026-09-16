/**
 * Pure fal payload builder for the S7 AI restyle route (server/api/scene3d/restyle.post.ts).
 * No h3 imports: this only shapes the request body so tests/unit/scene3d-restyle-inputs.unit.spec.ts
 * can pin the exact object sent to each fal app WITHOUT spinning up a Nitro event or making a fal
 * call — the CI-mockable seam the paid guardrail rests on. Mirrors server/utils/inpaintFalInputs.ts.
 *
 * The two control modes (RestyleModel.control):
 *  - 'depth' → a depth-structure-preserving control model (fal-ai/flux-control-lora-depth). The
 *    object's rendered DEPTH crop is the `control_lora_image_url` (the exact field name the model
 *    requires — verified against a live 422 at the S7 paid acceptance run; `control_image_url` is
 *    silently ignored and the request fails validation); the `strength` dial drives BOTH the
 *    control scale and a mapped `guidance_scale` (v1 simplification — one dial, per the ratified
 *    Task-0 decision). The normal crop is rendered but held for a union-ControlNet follow-up.
 *  - 'image' → an img2img fallback (fal-ai/flux/dev/image-to-image). The BEAUTY crop is the
 *    `image_url` source; `strength` is fal's denoise strength directly.
 *
 * fal-enum-mismatch-silent-fallover guard: every enum-valued field (`image_size`, `output_format`)
 * is a fixed string pinned in the unit test against the exact value fal expects. There is no
 * control-type enum in either payload.
 */
import type { RestyleModel } from '~~/app/data/scene3d-restyle-models'
// FalCall ({ app, input }) is already defined + auto-imported from inpaintFalInputs.ts — reuse it
// rather than declaring a second global of the same name (which trips the duplicate-import warning).
import type { FalCall } from './inpaintFalInputs'

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)
const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Map the 0..1 `strength` dial to a depth-control model's `guidance_scale`, linearly across fal's
 * usable CFG band (3.5 at strength 0 → 10 at strength 1). Pinned in the unit test so the mapping
 * cannot drift silently.
 */
export function restyleGuidanceScale(strength: number): number {
  return round2(3.5 + clamp01(strength) * 6.5)
}

export function restyleInput(
  m: RestyleModel, prompt: string, beauty: string, depth: string, strength: number, seed: number,
): FalCall {
  const s = clamp01(strength)
  if (m.control === 'depth') {
    return {
      app: m.id,
      input: {
        prompt,
        control_lora_image_url: depth,
        image_size: 'square_hd',
        strength: s,
        guidance_scale: restyleGuidanceScale(s),
        num_images: 1,
        output_format: 'png',
        seed,
      },
    }
  }
  return {
    app: m.id,
    input: {
      prompt,
      image_url: beauty,
      strength: s,
      image_size: 'square_hd',
      num_images: 1,
      output_format: 'png',
      seed,
    },
  }
}
