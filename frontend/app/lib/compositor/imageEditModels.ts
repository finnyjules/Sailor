// Pure model lists for the image-edit pickers. The value is the engine id the
// compositor switches on; the label is what the picker shows; the hint is the
// one-line "when to use" under the label in the dropdown.
export interface EditModel { value: string; label: string; hint: string }

// Whole-image ("Edit image") instruction editors, all mask-free. 'kontext' routes
// through the /api/inpaint/kontext route to FLUX.2 [pro] Edit (route name kept);
// 'nano' is Nano Banana Pro (Gemini 3 Pro Image), 'nano2' is Nano Banana 2 (Gemini
// 3.1 Flash — faster/cheaper) — both via /api/inpaint/nano-gen with a `variant`.
export const WHOLE_IMAGE_MODELS: readonly EditModel[] = [
  { value: 'kontext', label: 'FLUX.2', hint: 'Best all-round; keeps the layout' },
  { value: 'nano', label: 'Nano Banana Pro', hint: 'Great with text and scenes' },
  { value: 'nano2', label: 'Nano Banana 2', hint: 'Newer, sharper Nano Banana' },
  { value: 'seedream', label: 'Seedream 5', hint: 'Fast, photoreal, budget-friendly' },
  { value: 'gptimage', label: 'GPT Image', hint: 'Follows complex instructions' },
]

// Area ("Edit an area") masked-inpaint models — all mask-native (image + mask +
// prompt). 'flux' = FLUX.1 [pro] Fill (default), 'flux-general' = FLUX general
// inpainting, 'qwen' = Qwen Image Edit inpaint. runRegionFill routes each to its
// fal endpoint via the /api/inpaint/flux-fill route.
export const REGION_MODELS: readonly EditModel[] = [
  { value: 'flux', label: 'FLUX Fill', hint: 'Clean, seamless fills' },
  { value: 'flux-general', label: 'FLUX General', hint: 'Flexible fallback fill' },
  { value: 'qwen', label: 'Qwen Edit', hint: 'Best for text in the area' },
  { value: 'gptimage', label: 'GPT Image', hint: 'Understands what belongs there' },
]
