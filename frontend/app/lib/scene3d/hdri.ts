// Curated Poly Haven studio HDRIs for the 3D Studio's cinematic-grade environments.
//
// Poly Haven (polyhaven.com) is CC0, no attribution required. We use its STUDIO category
// because gemstones/products want photo-studio lighting (softboxes, windows, bright specular
// sources) — the "between an Octane render and a macro photo" look. An .hdr is already a
// high-dynamic-range equirect, so unlike the procedural environments it feeds the path tracer
// at full energy (real fire + crisp sparkle) with no 8-bit tone-map.
//
// This module is PURE (no three, no fetch) so it unit-tests cheaply and is safe to import from
// config. The loader (RGBELoader) lives in hdriLoader.ts; the server cache route in
// server/api/scene3d/hdri/[slug].get.ts.

export interface HdriEnvironment {
  /** Poly Haven asset slug — the download key (`<slug>_<res>.hdr`) and our stable id. */
  slug: string
  /** Sentence-case picker label (UI copy rule: no raw identifiers). */
  label: string
  /** One-line note for the picker — what the light is like. */
  note: string
}

// Verified present on Poly Haven's CDN (hdr, 1k–8k). Julien curates the final list once these
// are visible in the studio; keep every entry a real, checked slug.
export const HDRI_ENVIRONMENTS: HdriEnvironment[] = [
  { slug: 'studio_small_08', label: 'Studio soft', note: 'Neutral small studio, soft even key' },
  { slug: 'studio_small_03', label: 'Studio bright', note: 'Brighter neutral studio, crisp highlights' },
  { slug: 'brown_photostudio_02', label: 'Warm studio', note: 'Warm photo studio, directional softbox' },
  { slug: 'brown_photostudio_06', label: 'Amber studio', note: 'Warmer amber cast, moody product light' },
  { slug: 'photo_studio_loft_hall', label: 'Loft window', note: 'Daylight through tall loft windows' },
]

/** The default HDRI when one is turned on without a specific choice. */
export const DEFAULT_HDRI = 'studio_small_08'

const BY_SLUG = new Map(HDRI_ENVIRONMENTS.map((h) => [h.slug, h]))

/** True when `slug` names one of the curated HDRIs (used to validate persisted docs). */
export function isKnownHdri(slug: string | null | undefined): slug is string {
  return typeof slug === 'string' && BY_SLUG.has(slug)
}

/** Picker label for a slug, or the slug itself as a fallback (browsable HDRIs, later). */
export function hdriLabel(slug: string): string {
  return BY_SLUG.get(slug)?.label ?? slug
}
