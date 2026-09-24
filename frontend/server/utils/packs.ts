/**
 * The decided credit ladder (pricing call 2026-08-13 — decision record in
 * docs/superpowers/specs/2026-08-13-pricing-proposal-draft.md). 1 credit =
 * $0.01, always; discounts exist ONLY as bonus credits so the rate is never
 * negotiable. Captions denominate work, not arithmetic (framing rules).
 */
import { MODEL_COSTS } from './priceBook'
import { nodeCredits } from '../../shared/pricing/nodePrice'

export interface CreditPack {
  id: 'starter' | 'creator' | 'studio'
  usd: number
  credits: number
  baseCredits: number
  bonusCredits: number
  label: string
  caption: string
  covers: string
}

// The covers line translates a pack into concrete work, priced from the SAME
// tables the meter charges from — restating "5 cr" here would drift the day
// the book changes. Units: a standard image render (flux-dev tier) and a
// typical video clip: Seedance 2.0, 5 s at 720p, priced by the same shared
// calculation the charge uses (per second, so the unit follows the rate card).
// "Covers ~" hedges deliberately: premium image models and long-form video cost more.
const IMAGE_RENDER_CREDITS = MODEL_COSTS['black-forest-labs/flux-dev']!.credits
export const PACK_VIDEO_CLIP = { model: 'seedance-2.0', duration: '5', model_options: '{"resolution":"720p"}' }
const VIDEO_CLIP_CREDITS = packClipCredits()
/** The pack's video clip in credits. Throws at load if the price refuses it: a covers line must never read "~NaN". */
export function packClipCredits(clip: Record<string, unknown> = PACK_VIDEO_CLIP): number {
  const credits = nodeCredits('GenerateVideoNode', clip)
  if (credits == null || !(credits > 0)) throw new Error(`credit packs: the video clip ${JSON.stringify(clip)} has no price`)
  return credits
}
function coversLine(credits: number): string {
  const images = Math.floor(credits / IMAGE_RENDER_CREDITS / 10) * 10
  const clips = Math.floor(credits / VIDEO_CLIP_CREDITS)
  return `Covers ~${images.toLocaleString('en-US')} image renders, or ~${clips} video clips`
}

export const PACKS: CreditPack[] = [
  { id: 'starter', usd: 10, credits: 1000, baseCredits: 1000, bonusCredits: 0, label: 'Starter', caption: 'About a month of casual use', covers: coversLine(1000) },
  { id: 'creator', usd: 25, credits: 2750, baseCredits: 2500, bonusCredits: 250, label: 'Creator', caption: 'A solid month for a regular user', covers: coversLine(2750) },
  { id: 'studio', usd: 60, credits: 7200, baseCredits: 6000, bonusCredits: 1200, label: 'Studio', caption: 'A full heavy month in one top-up', covers: coversLine(7200) },
]

export function packById(id: string): CreditPack | null {
  return PACKS.find(p => p.id === id) ?? null
}
