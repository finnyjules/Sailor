// frontend/app/lib/scene3d/lighting.ts
// Simple lighting: a data-driven Look library + a PURE resolver that turns a Look
// and three dials (softness/warmth/brightness) into the SceneLighting fields the
// engine already consumes, plus sunColor + shadowSoftness. No WebGL, no three, no Vue.
import type { EnvironmentKind, LightingPreset } from '~/lib/scene3d/config'

export interface LookRecipe {
  id: string
  group: 'portrait' | 'product' | 'cinematic' | 'natural'
  label: string
  featured?: boolean
  additive?: boolean
  azimuth: number      // key direction, 0..360
  elevation: number    // 5..90
  softness: number     // default dial 0..1
  warmth: number       // default dial 0..1
  environment: EnvironmentKind
  preset: LightingPreset   // reuse existing env-intensity + shadow bucket
  sunIntensity: number     // baseline exposure
  ambient: number
}

// The Look library — data, drawn from the design spec's Look tables. ★ = featured.
export const LOOK_LIBRARY: LookRecipe[] = [
  // Product & commercial (featured heavy)
  { id: 'softbox-beauty',  group: 'product',   label: 'Softbox beauty',     featured: true, azimuth: 35,  elevation: 40, softness: 0.85, warmth: 0.5,  environment: 'softbox',    preset: 'soft',     sunIntensity: 1.2, ambient: 0.7 },
  { id: 'ecommerce-flat',  group: 'product',   label: 'E-commerce flat',    featured: true, azimuth: 45,  elevation: 45, softness: 0.9,  warmth: 0.5,  environment: 'softbox',    preset: 'flat',     sunIntensity: 1.0, ambient: 0.9 },
  { id: 'rim-on-dark',     group: 'product',   label: 'Rim on dark',        featured: true, azimuth: 160, elevation: 35, softness: 0.3,  warmth: 0.5,  environment: 'darkStrips', preset: 'dramatic', sunIntensity: 1.6, ambient: 0.15 },
  { id: 'hard-single-key', group: 'product',   label: 'Hard single key',    featured: true, azimuth: 40,  elevation: 35, softness: 0.15, warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.8, ambient: 0.25 },
  { id: 'two-tone-gels',   group: 'product',   label: 'Two-tone gels',      featured: true, azimuth: 60,  elevation: 30, softness: 0.5,  warmth: 0.5,  environment: 'colorGels',  preset: 'studio',   sunIntensity: 0.8, ambient: 0.3 },
  { id: 'three-point',     group: 'product',   label: 'Three-point',                        azimuth: 45,  elevation: 40, softness: 0.6,  warmth: 0.5,  environment: 'room',       preset: 'studio',   sunIntensity: 1.4, ambient: 0.5 },
  { id: 'light-tent',      group: 'product',   label: 'Light tent / high-key',              azimuth: 40,  elevation: 50, softness: 0.95, warmth: 0.5,  environment: 'softbox',    preset: 'flat',     sunIntensity: 1.0, ambient: 1.0 },
  { id: 'backlit',         group: 'product',   label: 'Backlit / contre-jour',              azimuth: 175, elevation: 30, softness: 0.5,  warmth: 0.5,  environment: 'room',       preset: 'soft',     sunIntensity: 1.7, ambient: 0.4 },
  // Portrait & beauty
  { id: 'rembrandt',       group: 'portrait',  label: 'Rembrandt',          featured: true, azimuth: 45,  elevation: 45, softness: 0.35, warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.6, ambient: 0.3 },
  { id: 'loop',            group: 'portrait',  label: 'Loop',                               azimuth: 35,  elevation: 40, softness: 0.6,  warmth: 0.5,  environment: 'room',       preset: 'studio',   sunIntensity: 1.4, ambient: 0.5 },
  { id: 'butterfly',       group: 'portrait',  label: 'Butterfly (Paramount)',              azimuth: 0,   elevation: 60, softness: 0.8,  warmth: 0.5,  environment: 'softbox',    preset: 'soft',     sunIntensity: 1.3, ambient: 0.6 },
  { id: 'clamshell',       group: 'portrait',  label: 'Clamshell',                          azimuth: 0,   elevation: 55, softness: 0.9,  warmth: 0.5,  environment: 'softbox',    preset: 'soft',     sunIntensity: 1.2, ambient: 0.8 },
  { id: 'split',           group: 'portrait',  label: 'Split',                              azimuth: 90,  elevation: 30, softness: 0.3,  warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.6, ambient: 0.2 },
  { id: 'broad-short',     group: 'portrait',  label: 'Broad / Short',                      azimuth: 55,  elevation: 40, softness: 0.55, warmth: 0.5,  environment: 'room',       preset: 'studio',   sunIntensity: 1.4, ambient: 0.5 },
  { id: 'rim-hair',        group: 'portrait',  label: 'Rim / hair',       additive: true,   azimuth: 180, elevation: 55, softness: 0.4,  warmth: 0.5,  environment: 'room',       preset: 'studio',   sunIntensity: 1.6, ambient: 0.5 },
  // Cinematic & mood
  { id: 'motivated',       group: 'cinematic', label: 'Motivated single source',            azimuth: 60,  elevation: 40, softness: 0.5,  warmth: 0.55, environment: 'room',       preset: 'dramatic', sunIntensity: 1.5, ambient: 0.35 },
  { id: 'low-key-noir',    group: 'cinematic', label: 'Low-key / noir',                     azimuth: 70,  elevation: 35, softness: 0.15, warmth: 0.45, environment: 'room',       preset: 'dramatic', sunIntensity: 1.8, ambient: 0.1 },
  { id: 'high-key',        group: 'cinematic', label: 'High-key',                           azimuth: 40,  elevation: 50, softness: 0.95, warmth: 0.5,  environment: 'softbox',    preset: 'flat',     sunIntensity: 1.0, ambient: 1.0 },
  { id: 'chiaroscuro',     group: 'cinematic', label: 'Chiaroscuro',                        azimuth: 65,  elevation: 40, softness: 0.25, warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.7, ambient: 0.15 },
  { id: 'silhouette',      group: 'cinematic', label: 'Silhouette',                         azimuth: 180, elevation: 30, softness: 0.5,  warmth: 0.5,  environment: 'room',       preset: 'soft',     sunIntensity: 2.0, ambient: 0.2 },
  { id: 'top-light',       group: 'cinematic', label: 'Top light',                          azimuth: 0,   elevation: 88, softness: 0.2,  warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.6, ambient: 0.2 },
  { id: 'underlight',      group: 'cinematic', label: 'Underlight',                         azimuth: 0,   elevation: 5,  softness: 0.3,  warmth: 0.5,  environment: 'room',       preset: 'dramatic', sunIntensity: 1.5, ambient: 0.2 },
  { id: 'edge-on-black',   group: 'cinematic', label: 'Edge-only on black',                 azimuth: 165, elevation: 40, softness: 0.3,  warmth: 0.5,  environment: 'darkStrips', preset: 'dramatic', sunIntensity: 1.7, ambient: 0.05 },
  // Natural & time-of-day
  { id: 'golden-hour',     group: 'natural',   label: 'Golden hour',        featured: true, azimuth: 110, elevation: 15, softness: 0.6,  warmth: 0.85, environment: 'room',       preset: 'soft',     sunIntensity: 1.5, ambient: 0.45 },
  { id: 'overcast',        group: 'natural',   label: 'Overcast / open shade', featured: true, azimuth: 40, elevation: 70, softness: 1.0, warmth: 0.4, environment: 'room',        preset: 'flat',     sunIntensity: 0.9, ambient: 1.0 },
  { id: 'blue-hour',       group: 'natural',   label: 'Blue hour / twilight',               azimuth: 130, elevation: 20, softness: 0.8,  warmth: 0.2,  environment: 'room',       preset: 'soft',     sunIntensity: 0.8, ambient: 0.6 },
  { id: 'hard-noon',       group: 'natural',   label: 'Hard noon',                          azimuth: 30,  elevation: 80, softness: 0.1,  warmth: 0.45, environment: 'room',       preset: 'studio',   sunIntensity: 1.8, ambient: 0.4 },
  { id: 'window-light',    group: 'natural',   label: 'Window light',                       azimuth: 80,  elevation: 35, softness: 0.7,  warmth: 0.5,  environment: 'room',       preset: 'soft',     sunIntensity: 1.4, ambient: 0.5 },
  { id: 'sunset-backlight',group: 'natural',   label: 'Sunset backlight',                   azimuth: 170, elevation: 18, softness: 0.6,  warmth: 0.8,  environment: 'room',       preset: 'soft',     sunIntensity: 1.7, ambient: 0.45 },
  { id: 'moonlight',       group: 'natural',   label: 'Moonlight',                          azimuth: 120, elevation: 40, softness: 0.5,  warmth: 0.15, environment: 'room',       preset: 'dramatic', sunIntensity: 1.2, ambient: 0.25 },
  { id: 'firelight',       group: 'natural',   label: 'Firelight / candlelight',            azimuth: 55,  elevation: 25, softness: 0.6,  warmth: 0.95, environment: 'room',       preset: 'dramatic', sunIntensity: 1.3, ambient: 0.3 },
]

export function getLook(id: string): LookRecipe {
  return LOOK_LIBRARY.find(l => l.id === id) ?? LOOK_LIBRARY[0]!
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v * 255))).toString(16).padStart(2, '0')).join('')

/** 0 = cool (bluish), 0.5 = neutral white, 1 = warm (amber). Lerp cool→white→warm. */
export function warmthToColor(w: number): string {
  const t = clamp01(w)
  const cool = [0.80, 0.88, 1.0]
  const neutral = [1, 1, 1]
  const warm = [1.0, 0.80, 0.58]
  const lerp = (a: number[], b: number[], k: number) => a.map((av, i) => av + (b[i]! - av) * k)
  const c = t <= 0.5 ? lerp(cool, neutral, t / 0.5) : lerp(neutral, warm, (t - 0.5) / 0.5)
  return toHex(c[0]!, c[1]!, c[2]!)
}

/** 0 = hard (small penumbra), 1 = soft (large). Maps to THREE sun.shadow.radius. */
export function softnessToRadius(s: number): number {
  return 1 + clamp01(s) * 11   // 1..12
}

export interface LightingDials { softness: number; warmth: number; brightness: number }

/** Full recipe application — used when the Look itself changes. */
export function resolveLook(recipe: LookRecipe) {
  return {
    sunAzimuth: recipe.azimuth,
    sunElevation: recipe.elevation,
    environment: recipe.environment,
    preset: recipe.preset,
    softness: recipe.softness,
    warmth: recipe.warmth,
  }
}

/** Dial-only recompute — used when a dial moves; leaves direction/env/preset alone. */
export function resolveDials(recipe: LookRecipe, dials: LightingDials) {
  return {
    sunIntensity: recipe.sunIntensity * Math.max(0.25, dials.brightness),
    ambient: recipe.ambient,
    sunColor: warmthToColor(dials.warmth),
    shadowSoftness: softnessToRadius(dials.softness),
  }
}
