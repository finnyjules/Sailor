/**
 * Recipes — the model composes, our code translates.
 *
 * The objection this whole design answers: *the model does not know how to
 * translate an idea into our gradient machinery.* It doesn't, so nothing here
 * asks it to. A recipe is four things a person could say out loud — which look
 * to start from, which colours in what order, which moods, what to call it — and
 * every one of them is chosen from a menu WE wrote. Turning that into a real
 * config is this file's job, and it is ordinary deterministic code with no model
 * in it.
 *
 * The consequence worth stating: a recipe cannot name a control key, cannot
 * reach a key we did not offer, and cannot produce a config we could not have
 * produced ourselves. The failure modes of the old path — a preset that silently
 * vanished, a colour on the wrong ramp, a direction backwards — are not
 * reachable from here, because none of those decisions is the model's any more.
 */
import type { GradientConfig } from './types'
import { LOOK_NAMES, lookMenu } from './lookDescriptors'
import { buildGradientPreset } from './presets'
import { recolorMeshPoints } from './mesh'
import { oklchToHexInGamut } from '../color/convert'

// ── mood dials ───────────────────────────────────────────────────────────────
//
// OUR table, not the model's vocabulary. The model picks adjectives; this maps
// them onto keys the studio already offers. Each nudge is deliberately small and
// composable — two moods on one recipe should read as both, not as a fight.

/** A nudge is an absolute value for a key the gradient vocabulary offers. */
export interface MoodDial { [key: string]: number | boolean }

export const MOOD_DIALS: Record<string, MoodDial> = {
  dreamy: { 'focus.blur': 52, 'post.grain': true, 'post.grainAmount': 0.28 },
  soft: { 'focus.blur': 34, 'flow.depth': 18 },
  sharp: { 'focus.blur': 0, 'flow.depth': 62 },
  vivid: { 'flow.depth': 74, 'flow.highlights': 78 },
  moody: { 'post.grain': true, 'post.grainAmount': 0.34, 'flow.shadows': 72, 'flow.highlights': 18 },
  calm: { 'flow.speed': 0, 'flow.swirl': 12, 'flow.distortion': 20 },
  turbulent: { 'flow.swirl': 74, 'flow.distortion': 82 },
  glossy: { 'flow.gloss': 68, 'flow.highlights': 72 },
  grainy: { 'post.grain': true, 'post.grainAmount': 0.42 },
  airy: { 'focus.blur': 40, 'flow.depth': 10, 'flow.shadows': 20 },
  // Material texture — the four the original ten could not reach. flow.foldScale
  // was DEAD (no dial touched it) and gloss only went UP, so "frosted glass" had
  // nowhere to land but soft/airy (depth DOWN, no texture). These turn the frost
  // the way the colour dials turn colour. Matte, not wet: gloss stays low (14/8),
  // NOT the authored frosted preset's wet-glass 96.
  //
  // These are LIQUID-SURFACE qualities: foldScale/gloss/depth/shadows are all
  // isLiquid-gated in the schema, so they only render on a liquid-family base
  // (marble/oil/ink/lava/satin/liquid). The recipe prompt steers the model there
  // (buildRecipesPrompt). relief.relief is deliberately NOT set: the renderer
  // gates it on banded layouts (shaders.ts, u_layout < 3.5), and the recipe menu
  // withholds every banded layout (WITHHELD_LAYOUTS), so it renders on no base the
  // menu can offer — the frost's relief on liquid comes from depth+foldScale+shadows.
  frosted: { 'post.grain': true, 'post.grainAmount': 0.32, 'flow.foldScale': 86, 'flow.gloss': 14, 'flow.depth': 45, 'flow.shadows': 42, 'flow.detail': 6 },
  textured: { 'post.grain': true, 'post.grainAmount': 0.38, 'flow.foldScale': 78, 'flow.gloss': 8 },
  deep: { 'flow.depth': 80, 'flow.shadows': 60, 'flow.foldScale': 82 },
  flat: { 'flow.depth': 6, 'flow.foldScale': 28, 'flow.shadows': 16, 'post.grain': false },
}

export const MOOD_NAMES: string[] = Object.keys(MOOD_DIALS)

/** The mood menu, for the prompt. */
export function moodMenu(): string {
  return MOOD_NAMES.join(', ')
}

// ── seed menu ────────────────────────────────────────────────────────────────
//
// The same eye-pick contract as the palette menu the server builds from the
// seed engine (`vibe-recipes.post.ts`): the model names an entry, never a hex.
// This fixed hue-wheel menu is what it picks a SEED from when the request
// carries no brand/taste key colour — 12 hues × 2 lightness levels, each hex
// produced by the same in-gamut OKLCH conversion the rest of the colour system
// uses, so every entry is a real, renderable colour.

export interface SeedMenuEntry { name: string, hex: string }

const SEED_HUES: [string, number][] = [
  ['red', 25], ['orange', 60], ['amber', 90], ['lime', 130], ['green', 150],
  ['teal', 185], ['cyan', 210], ['blue', 260], ['indigo', 290], ['violet', 320], ['magenta', 350], ['rose', 5],
]

/** A fixed 24-entry seed menu: 12 hues × 2 lightness levels. The model picks
 *  one by name (never invents a hex), matching the recipes menu-pick contract. */
export function buildSeedMenu(): SeedMenuEntry[] {
  const out: SeedMenuEntry[] = []
  for (const [name, h] of SEED_HUES) {
    out.push({ name: `deep ${name}`, hex: oklchToHexInGamut(0.45, 0.16, h) })
    out.push({ name: `bright ${name}`, hex: oklchToHexInGamut(0.72, 0.15, h) })
  }
  return out
}

// ── the recipe ───────────────────────────────────────────────────────────────

export interface GradientRecipe {
  /** A look name, or `yours` to build on what the user already has. */
  base: string
  /** 2–5 stops in ramp order, `#rrggbb`. */
  palette: string[]
  mood: string[]
  name: string
}

/** `yours` is a legal base: some of the four should stay near the user's design. */
export const OWN_BASE = 'yours'

const HEX = /^#[0-9a-fA-F]{6}$/
const MAX_PALETTE = 5
const MAX_MOODS = 3

/**
 * Structured-output schema. Same constraints as every other schema we send:
 * strict objects, no count or length keywords (the API rejects them, and only on
 * a live call). Counts live in prose and are enforced by `salvageRecipes`.
 */
export const RECIPES_SCHEMA = {
  type: 'object',
  properties: {
    recipes: {
      type: 'array',
      description: 'Six to eight recipes. Each is a different reading of the request — vary the base look, not just the colours.',
      items: {
        type: 'object',
        properties: {
          base: {
            type: 'string',
            description: 'The name of ONE look from the menu, or "yours" to keep the user\'s current base look.',
          },
          palette: {
            type: 'array',
            description: 'Two to five colours as #rrggbb, IN THE ORDER they should run through the gradient (first = start).',
            items: { type: 'string' },
          },
          mood: {
            type: 'array',
            description: 'Zero to three adjectives, chosen ONLY from the mood list you were given.',
            items: { type: 'string' },
          },
          name: { type: 'string', description: 'A short angle-name for this reading, ≤24 characters.' },
        },
        required: ['base', 'palette', 'mood', 'name'],
        additionalProperties: false,
      },
    },
  },
  required: ['recipes'],
  additionalProperties: false,
}

/** One candidate palette the seed engine assembled — a menu entry the model may
 *  copy verbatim instead of inventing colours. `note` names its origin (a
 *  curated corpus entry vs. a composed one) so the model can tell them apart
 *  when the request calls for one over the other. */
export interface EnginePaletteCandidate { hexes: string[], note: string }

export function buildRecipesPrompt(
  phrase: string,
  yours: { base: string, palette: string[] },
  paletteMenu?: EnginePaletteCandidate[],
): string {
  const engineMenu = paletteMenu && paletteMenu.length
    ? `

A COLOUR ENGINE ALSO OFFERS THESE PALETTES, built from a curated corpus around a seed colour it chose for this request. Prefer COPYING one of these exactly (same colours, same order) for most of your readings — that gives the user a palette a colour system actually vetted, not one invented on the spot. You may still write your own colours for at most one or two readings, when the request names a colour or mood these do not cover.
${paletteMenu.map((p, i) => `${i + 1}. ${p.hexes.join(' → ')} (${p.note})`).join('\n')}`
    : ''

  return `The user asked for: "${phrase}"

Compose 6 to 8 different readings of that request. You are NOT setting parameters — you are choosing from menus.

Each reading is:
- base: one look from the menu below, or "yours" to keep what the user already has
- palette: 2 to 5 colours as #rrggbb, in the order they run through the gradient
- mood: 0 to 3 words from the mood list
- name: a short angle-name, at most 24 characters

THE LOOKS:
${lookMenu()}

THE MOODS: ${moodMenu()}
frosted, textured, deep and flat are LIQUID-SURFACE qualities — pair them with a liquid-family base (marble, oil, ink, lava, satin, liquid), or the texture has no surface to sit on.

WHAT THE USER HAS NOW ("yours"): base ${yours.base}, colours ${yours.palette.join(' → ') || 'unknown'}.
${engineMenu}

Make them genuinely different from each other — vary the BASE look, not only the colours. At least one should keep the user's own base. If the request names colours, honour them; if it names a mood, pick the moods that match. Do not invent look or mood names that are not on the menus.`
}

/**
 * Keep every well-formed recipe, drop the rest.
 *
 * The floor, as everywhere in this feature: a bad entry costs that entry and
 * nothing else. An unknown base, a palette with no usable colour, or a mood word
 * that is not on our menu is dropped — the mood silently, because a recipe whose
 * colours and base are good is still a good recipe with one adjective missing.
 */
export function salvageRecipes(raw: unknown, max = 8): GradientRecipe[] {
  const rows = (raw && typeof raw === 'object' && Array.isArray((raw as any).recipes))
    ? (raw as any).recipes as unknown[]
    : []
  const out: GradientRecipe[] = []
  for (const row of rows) {
    if (out.length >= max) break
    if (!row || typeof row !== 'object') continue
    const { base, palette, mood, name } = row as Record<string, unknown>
    if (typeof base !== 'string') continue
    const baseName = base.trim().toLowerCase()
    if (baseName !== OWN_BASE && !LOOK_NAMES.includes(baseName)) continue
    const stops = (Array.isArray(palette) ? palette : [])
      .filter((c): c is string => typeof c === 'string' && HEX.test(c.trim()))
      .map(c => c.trim().toLowerCase())
      .slice(0, MAX_PALETTE)
    if (stops.length < 2) continue // a "palette" of one is not an ordering
    const moods = (Array.isArray(mood) ? mood : [])
      .filter((m): m is string => typeof m === 'string' && MOOD_NAMES.includes(m.trim().toLowerCase()))
      .map(m => m.trim().toLowerCase())
      .slice(0, MAX_MOODS)
    // Code points, not UTF-16 units — see `truncateLabel` in vibePrompt.ts.
    const label = typeof name === 'string' && name.trim() ? [...name.trim()].slice(0, 24).join('') : baseName
    out.push({ base: baseName, palette: stops, mood: moods, name: label })
  }
  return out
}

// ── materialize ──────────────────────────────────────────────────────────────

/** Read the user's current design back as a recipe base, for the prompt. */
export function summarizeConfig(cfg: GradientConfig): { base: string, palette: string[] } {
  const stops = cfg?.layers?.[0]?.color?.stops ?? []
  return {
    base: String(cfg?.canvas?.layout ?? 'unknown'),
    palette: stops.map(s => String(s.color)).filter(c => HEX.test(c)),
  }
}

/**
 * A recipe becomes a config. Deterministic and total: same recipe in, same
 * config out, and never null for a recipe `salvageRecipes` approved.
 *
 * Order matters and mirrors the macro contract the take path already uses:
 * the BASE decides which keys exist, the palette lands on the stops that base
 * actually has, and the mood nudges go on last. `own` is the user's current
 * config, used when the recipe says `yours`.
 */
export function materializeRecipe(
  recipe: GradientRecipe,
  own: GradientConfig,
  clone: (c: GradientConfig) => GradientConfig,
  seed?: string,
): GradientConfig | null {
  const base = recipe.base === OWN_BASE
    ? clone(own)
    : buildGradientPreset(recipe.base, seed)
  if (!base) return null

  // Palette onto the ramp, in order. A base with FEWER stops than the palette
  // keeps its own count — we recolour what exists rather than growing a ramp the
  // look was not designed around; a base with MORE stops runs the palette across
  // them so the ordering is preserved end to end.
  const layer = base.layers?.[0]
  const stops = layer?.color?.stops
  if (stops?.length && recipe.palette.length) {
    const n = stops.length
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1)
      const idx = Math.min(recipe.palette.length - 1, Math.round(t * (recipe.palette.length - 1)))
      stops[i]!.color = recipe.palette[idx]!
    }
  }

  // The mesh layout renders its colour from layer.mesh.points (renderer.ts →
  // u_meshCol), NOT from color.stops — so recolouring the stops alone left a
  // mesh-base recipe rendering the base's stale default point colours while its
  // palette (and its label) claimed something else: the owner's "Molten Rust"
  // that came out blue/purple. Recolour the points from the SAME palette we just
  // laid on the stops, reusing the studio's own recolour path. Positions and
  // count are preserved; a base with no mesh is untouched (the check is additive).
  if (layer?.mesh?.points?.length && stops?.length) {
    layer.mesh.points = recolorMeshPoints(layer.mesh.points, stops, `${seed ?? ''}#meshcol`)
  }

  // Moods last, so a mood can override what the base chose — that is what the
  // user asked for when they said "dreamy".
  for (const m of recipe.mood) {
    for (const [key, value] of Object.entries(MOOD_DIALS[m] ?? {})) applyKey(base, key, value)
  }
  return base
}

/** Dotted-path write, mirroring `makeConfigParams`'s writer — missing containers
 *  are created, exactly as the studio's own proxy does. */
function applyKey(cfg: GradientConfig, key: string, value: number | boolean): void {
  const parts = key.split('.')
  let cur = cfg as unknown as Record<string, unknown>
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!
    let next = cur[p]
    if (next == null || typeof next !== 'object') { next = {}; cur[p] = next }
    cur = next as Record<string, unknown>
  }
  cur[parts[parts.length - 1]!] = value
}
