/**
 * Video prices live in shared/pricing/videoRates.ts (a per-second or per-clip
 * rate card per model, with its source) and are read through the one price
 * calculation, shared/pricing/nodePrice.ts. The old per-clip VIDEO_MODEL_USD
 * table was retired by the model line-up programme (Task P2): one flat figure
 * per model under-priced every long or high-resolution clip.
 *
 * What stays here is the legacy label remap, pure data with zero imports.
 */

/**
 * Legacy video-model labels GenerateVideoNode still remaps at execute time
 * (_LEGACY_MODEL_REMAP in comfy_api_nodes/nodes_replicate.py). Both the pricer
 * and the badge must price those saved graphs at the model that will actually
 * run — a saved node still holding 'Veo 3' costs veo-3.1 money.
 */
export const LEGACY_VIDEO_MODEL_IDS: Record<string, string> = {
  'Seedance 2.0': 'seedance-2.0',
  'Veo 3': 'veo-3.1',
  'Kling 2.1': 'kling-v2.5-turbo-pro',
}
