/**
 * The real ad and social formats a Frame can be sized for (Stage 2, spec §6).
 *
 * `FRAME_FORMATS` is the format table, verbatim from the plan. `formatFor` is ruling P5's
 * format-detection rule: a stored preset whose aspect matches the Frame's, else an exact size
 * that no plain size preset shares, never aspect alone.
 *
 * `frameSize.ts` builds `FRAME_SIZE_PRESETS` from this table, so this module must not import
 * from `frameSize.ts` (that would be a cycle) — the six plain preset sizes below are a verbatim
 * copy of `FRAME_SIZE_PRESETS`'s first six entries, kept in sync by hand.
 */

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

/** The six plain size presets' sizes (kept in sync by hand with `FRAME_SIZE_PRESETS`'s first six). */
const PLAIN_PRESET_SIZES: readonly { w: number; h: number }[] = [
  { w: 1024, h: 1024 }, // 1:1
  { w: 1280, h: 720 },  // 16:9
  { w: 720, h: 1280 },  // 9:16
  { w: 1024, h: 1280 }, // 4:5
  { w: 1024, h: 768 },  // 4:3
  { w: 1240, h: 1754 }, // A4
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
  if (exact && !PLAIN_PRESET_SIZES.some(p => p.w === frameW && p.h === frameH)) return exact
  return null
}
