// Pure model lists for the image-edit pickers. Sentence-case labels; the value is
// the engine id the compositor switches on. Kontext / FLUX Fill are the defaults.
export interface EditModel { value: string; label: string }
export const WHOLE_IMAGE_MODELS: readonly EditModel[] = [
  { value: 'kontext', label: 'Kontext' },
  { value: 'nano', label: 'Nano Banana' },
]
export const REGION_MODELS: readonly EditModel[] = [
  { value: 'flux', label: 'FLUX Fill' },
  { value: 'nano', label: 'Nano Banana' },
]
