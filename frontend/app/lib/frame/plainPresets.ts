/**
 * The six plain size presets ("Square · 1:1", "Wide · 16:9", …) — the ONE place their sizes and
 * labels live. `frameSize.ts` (`FRAME_SIZE_PRESETS`) and `formats.ts` (`formatFor`'s ruling-P5
 * size-exclusion check) both import this module instead of each keeping their own copy, so the
 * two can never drift apart.
 */
export interface PlainSizePreset { id: string; label: string; w: number; h: number }

export const PLAIN_SIZE_PRESETS: readonly PlainSizePreset[] = [
  { id: '1:1', label: 'Square · 1:1', w: 1024, h: 1024 },
  { id: '16:9', label: 'Wide · 16:9', w: 1280, h: 720 },
  { id: '9:16', label: 'Tall · 9:16', w: 720, h: 1280 },
  { id: '4:5', label: 'Portrait · 4:5', w: 1024, h: 1280 },
  { id: '4:3', label: 'Classic · 4:3', w: 1024, h: 768 },
  { id: 'A4', label: 'A4 · print', w: 1240, h: 1754 },
]
