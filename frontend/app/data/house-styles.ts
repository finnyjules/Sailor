/**
 * House style library — Sailor-trained style LoRAs published for all users.
 * Entries are SELF-CONTAINED: no dependency on the local library/loras sidecars
 * (those exist only on the dev machine). Published via /dev/style-publisher,
 * which upserts house-styles.json and writes thumbnails to
 * public/house-styles/<id>/. Publishing = reviewing the git diff + committing.
 */
import rawEntries from './house-styles.json'

export const USE_CASE_TAGS = [
  'illustration', 'poster', 'branding', 'editorial', 'photography',
  'typography', 'anime', '3d', 'texture', 'ecomm', 'fashion', 'architecture',
] as const
export type UseCaseTag = (typeof USE_CASE_TAGS)[number]

export interface HouseStyle {
  id: string                 // kebab-case, e.g. 'rough-cut-revival'
  label: string
  useCases: UseCaseTag[]     // ≥1 — the primary browse dimension
  trigger: string
  tasteProfile: string       // dense conditioning block; REQUIRED
  replicateModel: string     // 'owner/model' (version stripped) — single-LoRA direct-run
  weightsUrl: string         // trained_model.tar — multi-lora stacking
  thumbnails: string[]       // exactly 4, under /house-styles/<id>/
  examplePrompts: string[]
  suggestedScale?: number
}

/** Curated tag groupings for future vertical browsing (phase 2 UI). */
export const VERTICALS: { label: string; tags: UseCaseTag[] }[] = [
  { label: 'Fashion', tags: ['fashion', 'editorial', 'ecomm'] },
  { label: 'Architecture', tags: ['architecture'] },
  { label: 'Graphic', tags: ['poster', 'branding', 'typography'] },
  { label: 'Illustration', tags: ['illustration', 'anime', '3d'] },
]

export const HOUSE_STYLES = rawEntries as HouseStyle[]

export function houseStyleById(id: string): HouseStyle | undefined {
  return HOUSE_STYLES.find(s => s.id === id)
}

export function houseStylesForTag(tag: UseCaseTag): HouseStyle[] {
  return HOUSE_STYLES.filter(s => s.useCases.includes(tag))
}

/**
 * The style-activation block that goes into the node's collapsed `aesthetic`
 * PROPERTY (folded into the prompt at submit by injectLoraStyleIntoPrompt).
 * Same shape LoRALibraryPanel uses for local trained styles.
 */
export function houseStyleStyleBlock(s: Pick<HouseStyle, 'tasteProfile' | 'trigger'>): string {
  return [s.tasteProfile.trim(), s.trigger.trim() ? `${s.trigger.trim()},` : '']
    .filter(Boolean).join(' ').trim()
}

/** Accepted trained-weights artifact shape (multi-lora loader requirement). */
export const WEIGHTS_TAR_RE = /^https:\/\/replicate\.delivery\/[^/]+\/[^/]+\/trained_model\.tar$/

/** TS mirror of comfy_api_nodes/replicate_refs.py::_is_replicate_model_ref. */
export function isReplicateModelRef(value: string): boolean {
  const s = (value || '').trim()
  if (!s || s.includes('://')) return false
  const low = s.toLowerCase()
  if (low.endsWith('.safetensors')) return false
  if (low.includes('huggingface.co') || low.includes('civitai.com') || low.startsWith('hf.co/')) return false
  const parts = s.split('/').filter(Boolean)
  return parts.length === 2 || parts.length === 3
}
