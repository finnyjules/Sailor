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
import { MOODBOARD_MAX_REFS } from '~~/shared/taste/moodboard'

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)
const round2 = (n: number): number => Math.round(n * 100) / 100

// ── fal-ai/flux-general depth+style repos. fal loads the controlnet with diffusers'
// FluxControlNetModel.from_pretrained(path) and the IP-adapter with pipe.load_ip_adapter(path,
// weight_name, image_encoder_path), so BOTH must be diffusers-loadable HF repos (fal's schema names
// the fields but pins no repo).
//  · Depth controlnet: MUST be diffusers-format (a repo with config.json + diffusion_pytorch_model
//    .safetensors). A raw XLabs checkpoint (XLabs-AI/flux-controlnet-depth-v3) is NOT — fal 422s
//    "Failed to load controlnet … config_url=None" (caught live 2026-09-16, Julien's moodboard run).
//    jasperai/Flux.1-dev-Controlnet-Depth IS diffusers-format (its own example loads it via
//    from_pretrained + controlnet_conditioning_scale=0.6, matching ours). Verified HF 2026-09-16.
//  · IP-adapter: XLabs-AI/flux-ip-adapter is the repo diffusers' FLUX load_ip_adapter example uses;
//    its sole weight is 'ip_adapter.safetensors', encoder 'openai/clip-vit-large-patch14'.
// The Task-5 paid run remains the end-to-end validator (a wrong repo passes at submit, fails at result).
export const FLUX_DEPTH_CONTROLNET_PATH = 'jasperai/Flux.1-dev-Controlnet-Depth'
export const FLUX_IP_ADAPTER_PATH = 'XLabs-AI/flux-ip-adapter'
export const FLUX_IP_ADAPTER_ENCODER = 'openai/clip-vit-large-patch14'
export const FLUX_IP_ADAPTER_WEIGHT = 'ip_adapter.safetensors'
// Tuned defaults (no user dial — spec YAGNI). Depth control holds STRUCTURE; the IP-adapter only
// NUDGES the look. Balance validated live 2026-09-16 against a real moodboard (blue ballpoint on
// white paper): ip scale 0.7 FLOODED the output with the refs' flat white/cream field, erasing both
// the depth structure and the prompt (a blank cream disc — Julien's "solid stays the same"). Depth
// conditioning 0.85 + guidance 3.5 + ip 0.4 restores a structured, clearly-styled result; ip 0.25 is
// crisper still. Keep depth dominant and the ip-adapter a nudge.
export const RESTYLE_DEPTH_CONDITIONING_SCALE = 0.85
export const RESTYLE_IP_ADAPTER_SCALE = 0.4
// flux-general defaults guidance to 3.5; we pin it so the prompt stays legible under the controlnet.
export const RESTYLE_DEPTH_STYLE_GUIDANCE = 3.5

/**
 * Map the 0..1 `strength` dial to a depth-control model's `guidance_scale`, linearly across fal's
 * usable CFG band (3.5 at strength 0 → 10 at strength 1). Pinned in the unit test so the mapping
 * cannot drift silently.
 */
export function restyleGuidanceScale(strength: number): number {
  return round2(3.5 + clamp01(strength) * 6.5)
}

/** Fold the moodboard's palette+prose block into the prompt. Empty/whitespace styleText ⇒ the prompt
 *  is returned verbatim, so the no-Style payload is byte-identical to today. */
function foldStylePrompt(prompt: string, styleText: string): string {
  const s = styleText.trim()
  return s ? `${prompt}. ${s}` : prompt
}

export function restyleInput(
  m: RestyleModel, prompt: string, beauty: string, depth: string, strength: number, seed: number,
  styleRefs: string[] = [], styleText = '',
): FalCall {
  const s = clamp01(strength)
  const finalPrompt = foldStylePrompt(prompt, styleText)
  if (m.control === 'depth+style') {
    return {
      app: m.id,
      input: {
        prompt: finalPrompt,
        // Our depth crop is ALREADY a depth map → passed directly as the control image (no fal preprocess).
        controlnets: [{
          path: FLUX_DEPTH_CONTROLNET_PATH,
          control_image_url: depth,
          conditioning_scale: RESTYLE_DEPTH_CONDITIONING_SCALE,
        }],
        ip_adapters: styleRefs.slice(0, MOODBOARD_MAX_REFS).map((url) => ({
          path: FLUX_IP_ADAPTER_PATH,
          image_url: url,
          scale: RESTYLE_IP_ADAPTER_SCALE,
          image_encoder_path: FLUX_IP_ADAPTER_ENCODER,
          weight_name: FLUX_IP_ADAPTER_WEIGHT,
        })),
        guidance_scale: RESTYLE_DEPTH_STYLE_GUIDANCE,
        image_size: 'square_hd',
        num_inference_steps: 28,
        num_images: 1,
        output_format: 'png',
        seed,
      },
    }
  }
  if (m.control === 'depth') {
    return {
      app: m.id,
      input: {
        prompt: finalPrompt,
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
      prompt: finalPrompt,
      image_url: beauty,
      strength: s,
      image_size: 'square_hd',
      num_images: 1,
      output_format: 'png',
      seed,
    },
  }
}
