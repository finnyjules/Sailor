// Pure model lists for the image-edit pickers. Sentence-case labels; the value is
// the engine id the compositor switches on. Kontext / FLUX Fill are the defaults.
export interface EditModel { value: string; label: string }
export const WHOLE_IMAGE_MODELS: readonly EditModel[] = [
  { value: 'kontext', label: 'Kontext' },
  { value: 'nano', label: 'Nano Banana' },
]
// Region edit is FLUX Fill only for now — Nano region inpaint isn't wired, so it's not
// offered here (a picker that silently ran a different model would be a dead control).
export const REGION_MODELS: readonly EditModel[] = [
  { value: 'flux', label: 'FLUX Fill' },
]
