/**
 * The real ad and social formats a Frame can be sized for (Stage 2, spec §6).
 *
 * `FRAME_FORMATS` is the format table, verbatim from the plan. `formatFor` is ruling P5's
 * format-detection rule: a stored preset whose aspect matches the Frame's, else an exact size
 * that no plain size preset shares, never aspect alone.
 *
 * `frameSize.ts` builds `FRAME_SIZE_PRESETS` from this table plus `plainPresets.ts`'s six, so
 * this module must not import from `frameSize.ts` (that would be a cycle) — it imports the six
 * plain preset sizes from the shared `plainPresets.ts` instead, which both modules import, so
 * they can never drift apart.
 *
 * Three sizes are shared between two formats: 1200×628 (`link-preview`, `pmax-landscape`),
 * 1200×1200 (`meta-feed-1x1`, `pmax-square`) and 1080×1920 (`meta-story`, `pinterest-9x16`).
 * `formatFor`'s exact-size match picks the first in table order (the order below) when no
 * preset is stored; a stored `sailor_frame.preset` naming either one always wins over table
 * order, as long as its aspect matches the Frame's.
 */
import { PLAIN_SIZE_PRESETS } from './plainPresets'

/** Fractions of the Frame's width (left/right) and height (top/bottom) the platform covers with its own interface. */
export interface KeepClear { top: number; bottom: number; left: number; right: number }

export interface FrameFormat {
  id: string
  label: string
  w: number
  h: number
  /** Width in CSS px people actually see it at — sets the minimum text size. Absent: no floor. */
  view?: number
  keep?: KeepClear
  /** How many levels of text it carries (title → details → date → caption). Absent: all four. */
  carries?: 2 | 3
  /** The platform draws its own button under or on the ad (recorded; used from Stage 3). */
  platformButton?: boolean
  /** Real column count override (very wide banners). */
  nc?: number
}

export const FRAME_FORMATS: readonly FrameFormat[] = [
  { id: 'meta-feed-4x5', label: 'Meta feed · 4:5', w: 1440, h: 1800, view: 390, platformButton: true },
  { id: 'meta-feed-1x1', label: 'Meta feed · 1:1', w: 1200, h: 1200, view: 390, platformButton: true },
  {
    id: 'meta-story', label: 'Meta story / reel · 9:16', w: 1080, h: 1920, view: 390,
    keep: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 }, platformButton: true,
  },
  {
    id: 'meta-story-hd', label: 'Meta story / reel HD · 9:16', w: 1440, h: 2560, view: 390,
    keep: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 }, platformButton: true,
  },
  { id: 'pinterest-2x3', label: 'Pinterest pin · 2:3', w: 1000, h: 1500, view: 236 },
  {
    id: 'pinterest-9x16', label: 'Pinterest idea pin · 9:16', w: 1080, h: 1920, view: 236,
    keep: { top: 270 / 1920, bottom: 440 / 1920, left: 65 / 1080, right: 195 / 1080 },
  },
  { id: 'link-preview', label: 'Link preview · 1.91:1', w: 1200, h: 628, view: 500 },
  { id: 'video-thumb', label: 'Video thumbnail · 16:9', w: 1280, h: 720, view: 170, carries: 2 },
  {
    id: 'pmax-landscape', label: 'Google display · 1.91:1', w: 1200, h: 628, view: 390,
    keep: { top: 0.10, bottom: 0.10, left: 0.10, right: 0.10 }, platformButton: true,
  },
  {
    id: 'pmax-square', label: 'Google display · 1:1', w: 1200, h: 1200, view: 390,
    keep: { top: 0.10, bottom: 0.10, left: 0.10, right: 0.10 }, platformButton: true,
  },
  { id: 'ad-300x250', label: 'Display ad · 300×250', w: 300, h: 250, view: 300 },
  { id: 'ad-160x600', label: 'Display ad · 160×600', w: 160, h: 600, view: 160, carries: 3 },
  { id: 'ad-728x90', label: 'Display ad · 728×90', w: 728, h: 90, view: 728, carries: 3, nc: 24 },
  { id: 'ad-300x600', label: 'Display ad · 300×600', w: 300, h: 600, view: 300, carries: 3 },
  { id: 'ad-320x50', label: 'Display ad · 320×50', w: 320, h: 50, view: 320, carries: 2, nc: 24 },
  { id: 'ad-970x250', label: 'Display ad · 970×250', w: 970, h: 250, view: 970, carries: 3, nc: 24 },
]

/** The format a Frame is sized for (ruling P5), or null. */
export function formatFor(props: Record<string, unknown> | undefined, frameW: number, frameH: number): FrameFormat | null {
  const sf = props?.sailor_frame as { preset?: string } | undefined
  const presetId = sf?.preset
  if (presetId && frameW > 0 && frameH > 0) {
    const fmt = FRAME_FORMATS.find(f => f.id === presetId)
    if (fmt) {
      const aspect = frameW / frameH
      const fAspect = fmt.w / fmt.h
      if (Math.abs(aspect - fAspect) / fAspect <= 0.005) return fmt
    }
  }
  const exact = FRAME_FORMATS.find(f => f.w === frameW && f.h === frameH)
  if (exact && !PLAIN_SIZE_PRESETS.some(p => p.w === frameW && p.h === frameH)) return exact
  return null
}

/** UI grouping for a long Size select: "Social" (Meta, Pinterest, link previews, video
 *  thumbnails) vs. "Display ads" (Google Performance Max, the IAB banner sizes). The six
 *  plain size presets are their own "Sizes" group, added by the caller. */
export type FrameFormatGroup = 'Social' | 'Display ads'
const SOCIAL_FORMAT_IDS = new Set<string>([
  'meta-feed-4x5', 'meta-feed-1x1', 'meta-story', 'meta-story-hd',
  'pinterest-2x3', 'pinterest-9x16', 'link-preview', 'video-thumb',
])
export function frameFormatGroup(id: string): FrameFormatGroup {
  return SOCIAL_FORMAT_IDS.has(id) ? 'Social' : 'Display ads'
}

/** What a format's keep-clear areas are: covered by the platform's own interface (`app`), or an
 *  edge the platform may crop (`crop`, Google Performance Max). Null: the format has none. */
export function keepKind(fmt: Pick<FrameFormat, 'id' | 'keep'> | null | undefined): 'app' | 'crop' | null {
  if (!fmt?.keep) return null
  return fmt.id.startsWith('pmax-') ? 'crop' : 'app'
}

/** The label drawn on a keep-clear area on the stage. */
export function keepLabel(kind: 'app' | 'crop'): string {
  return kind === 'crop' ? 'May be cropped' : 'Covered by the app'
}

/** A side strip narrower than this (fraction of the width) is a safe margin, not the app's own
 *  interface: Meta's stories keep 6% at each side, which the sentence does not call covered;
 *  Pinterest's idea pin covers 18% on the right, which it does. */
const SIDE_COVER_MIN = 0.1

/** The Layout tab's sentence for a format's keep-clear areas, naming the sides it really covers
 *  ("the top, bottom and sides"). Null: the format has none. */
export function keepNote(fmt: Pick<FrameFormat, 'id' | 'keep'> | null | undefined): string | null {
  const kind = keepKind(fmt)
  if (!kind) return null
  if (kind === 'crop') return 'Google may crop the edges; text stays in the middle.'
  const k = fmt!.keep!
  const parts: string[] = []
  if (k.top > 0) parts.push('top')
  if (k.bottom > 0) parts.push('bottom')
  if (Math.max(k.left, k.right) >= SIDE_COVER_MIN) parts.push('sides')
  if (!parts.length) return null
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `The app covers the ${list} of this format; text stays clear of them.`
}
