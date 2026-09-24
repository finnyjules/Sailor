/** The six requests from the shader spike (AI in Sailor spec §7.1). `base` is a
 *  catalog effect id for transforms, null for "from nothing"; `references` are
 *  the related catalog effects a "from nothing" request is given (spec §7.2.1). */
export interface EvalRequest { key: string; prompt: string; base: string | null; references?: string[] }

export const EVAL_REQUESTS: EvalRequest[] = [
  { key: 'rain', prompt: 'Turn this into rain on a window', base: 'water_ripple' },
  { key: 'popart', prompt: 'Make it a Lichtenstein pop-art panel', base: 'halftone' },
  { key: 'lava', prompt: 'Make it a slow lava lamp', base: 'aurora' },
  { key: 'oil', prompt: 'Make it look like a wet oil slick on asphalt', base: 'holographic' },
  { key: 'haze', prompt: 'Heat haze over a desert road', base: null, references: ['noise_distortion', 'fbm_warp'] },
  { key: 'ink', prompt: 'Ink bleeding into wet paper', base: null, references: ['fbm_warp', 'mist'] },
]
