import type { Params } from '~/lib/spacetype/effect'
import type { Fill } from '~/lib/texturefx/types'

// Ordered roles per family. role 0 = primary ink, 1 = secondary, 2 = ground/gap.
// Procedural motifs: checker, stripes, dots, grid.
// Truchet tile families: arcs, diagonal, weave, multiscale.
export const ROLES_BY_FAMILY: Record<string, string[]> = {
  checker: ['a', 'b'], stripes: ['ink', 'ink2'], dots: ['dot', 'ground'], grid: ['line', 'ground'],
  rings: ['ring', 'ground'], squares: ['ring', 'ground'], diamonds: ['ring', 'ground'],
  waves: ['line', 'ground'], zigzag: ['line', 'ground'], cross: ['cross', 'ground'], graph: ['major', 'minor', 'ground'],
  arcs: ['stroke', 'ground'], diagonal: ['sideA', 'sideB'], weave: ['warp', 'weft', 'gap'], multiscale: ['arc', 'ground'],
  maze: ['line', 'ground'], arcs2: ['stroke', 'ground'], arcdot: ['stroke', 'ground'],
  octagon: ['tile', 'joint'],
  pinwheel: ['a', 'b'],
  chevron: ['a', 'b'],
  basketweave: ['a', 'b'],
  herringbone: ['brickA', 'brickB'],
  fishscale: ['scaleA', 'scaleB', 'grout'],
  pythagorean: ['big', 'small'],
  hex: ['a', 'b', 'c'],
  cairo: ['a', 'b', 'c'],
  cubes: ['top', 'left', 'right'],
  weave3d: ['strandA', 'strandB', 'strandC'],
  tripods: ['armA', 'armB', 'armC'],
  triangles: ['up', 'down'], diamond: ['a', 'b'], shippou: ['overlap', 'circle', 'field'],
  seigaiha: ['ringA', 'ringB', 'ringC'],
  // Chips (terrazzo family): the chips cycle the ink roles, the grout is ground.
  // The ink count must equal CHIP_INK_ROLES in pattern.ts (pinned by a unit test),
  // and the ground role must stay LAST — chipSample() emits it as index inkRoles.
  chips: ['chipA', 'chipB', 'ground'],
  // Dealt grid: each cell hashes to one of two inks; a dropped (density) or
  // inset-gutter cell falls to ground. Same 2-ink + ground shape as chips (the ink
  // count must equal DEALT_INK_ROLES in pattern.ts, and ground stays LAST —
  // dealtGridSample() emits it as index inkRoles). One family PER COLOUR VOCAB
  // (brand/mono/warm/cool) so the grid can recolour without touching the per-cell
  // sampler — every vocab keeps the SAME 2 inks + ground role shape, only the
  // colours differ (see DEALTGRID_VOCABS + legacyColor below). activeFamily() picks
  // the family from p.dgVocab.
  dealtgrid_brand: ['inkA', 'inkB', 'ground'],
  dealtgrid_mono: ['inkA', 'inkB', 'ground'],
  dealtgrid_warm: ['inkA', 'inkB', 'ground'],
  dealtgrid_cool: ['inkA', 'inkB', 'ground'],
}

// Dealt-grid colour vocabularies. Each supplies the same three role slots
// (inkA, inkB, ground); switching vocab only swaps which colours fill those slots,
// never the per-cell layout — so the TS↔GLSL twin stays in parity automatically.
// Referenced by BOTH the GLSL uniform path (legacyColor, below) AND the pure-TS
// sampler (pattern.ts evalPattern's dealtgrid branch), so both agree by construction.
// Characters echo the Frame `deal` vocabularies (lib/compositor/dealVocab.ts):
// brand = paper + brand blue on near-black; mono = greys/paper/ink; warm =
// peach/coral on warm brown; cool = mint/teal on deep navy. `brand` reproduces the
// original fixed dealt-grid palette byte-for-byte (the pre-vocab default).
export type DealtGridVocab = 'brand' | 'mono' | 'warm' | 'cool'
export const DEALTGRID_VOCABS: Record<DealtGridVocab, { inkA: string; inkB: string; ground: string }> = {
  brand: { inkA: '#e8eef5', inkB: '#7aa2f7', ground: '#0e1116' },
  mono:  { inkA: '#ececeb', inkB: '#8a8a86', ground: '#1a1a1a' },
  warm:  { inkA: '#ffb984', inkB: '#ff6259', ground: '#4a1f1c' },
  cool:  { inkA: '#54f4cf', inkB: '#209d80', ground: '#040541' },
}

/** The vocab ids, for the dgVocab control's options / template application. */
export const DEALTGRID_VOCAB_IDS = Object.keys(DEALTGRID_VOCABS) as DealtGridVocab[]

/** Normalise a params bag's dgVocab to a real vocab (unknown / unset ⇒ 'brand'). */
export function dealtGridVocab(p: Params): DealtGridVocab {
  const v = String((p as { dgVocab?: unknown }).dgVocab ?? 'brand')
  return (v in DEALTGRID_VOCABS ? v : 'brand') as DealtGridVocab
}
/** The {inkA, inkB, ground} colours for the params' active dealt-grid vocab. */
export function dealtGridColors(p: Params): { inkA: string; inkB: string; ground: string } {
  return DEALTGRID_VOCABS[dealtGridVocab(p)]
}

const PROCEDURAL_FAMILIES = new Set(['checker', 'stripes', 'dots', 'grid', 'rings', 'squares', 'diamonds', 'waves', 'zigzag', 'cross', 'graph'])
const TRUCHET_FAMILIES = new Set(['arcs', 'diagonal', 'weave', 'multiscale', 'maze', 'arcs2', 'arcdot'])
const SHAPE_FAMILIES = new Set(['octagon', 'pinwheel', 'chevron', 'basketweave', 'herringbone', 'fishscale', 'pythagorean', 'hex', 'cairo', 'cubes', 'weave3d', 'tripods', 'triangles', 'diamond', 'shippou', 'seigaiha'])

// Which family is active given the params (procedural motif, truchet tileFamily, …).
export function activeFamily(p: Params): string {
  if (String(p.mode) === 'truchet') return String(p.tileFamily)
  if (String(p.mode) === 'procedural') return String(p.motif)
  if (String(p.mode) === 'shapes') return String(p.shapeFamily)
  // Chips has a single family — the mode IS the family (no family picker).
  if (String(p.mode) === 'chips') return 'chips'
  // Dealt grid — one family per colour vocab, chosen by p.dgVocab (default brand).
  // The role SHAPE (inkA/inkB/ground) is identical across vocabs; only the family
  // name (hence the colours legacyColor resolves) changes.
  if (String(p.mode) === 'dealtgrid') return `dealtgrid_${dealtGridVocab(p)}`
  return 'checker' // raster mode has no roles; harmless default
}
export function rolesFor(p: Params): string[] {
  const mode = String(p.mode)
  const family = activeFamily(p)
  // Only return roles if the family is valid for the current mode — prevents truchet
  // families from being accidentally resolved in procedural mode and vice-versa.
  if (mode === 'truchet' && !TRUCHET_FAMILIES.has(family)) return ['a', 'b']
  if (mode === 'procedural' && !PROCEDURAL_FAMILIES.has(family)) return ['a', 'b']
  if (mode === 'shapes' && !SHAPE_FAMILIES.has(family)) return ['a', 'b']
  return ROLES_BY_FAMILY[family] ?? ['a', 'b']
}

// Legacy color a role index maps to, so existing tiles look identical pre-customization.
const GROUND_IS_BG = new Set(['dots', 'grid', 'arcs', 'multiscale', 'rings', 'squares', 'diamonds', 'waves', 'zigzag', 'cross', 'maze', 'arcs2', 'arcdot'])
export function legacyColor(p: Params, family: string, roleIndex: number): string {
  // Dealt grid: colours come from the active vocab family, NOT colorA/B/background —
  // role 0 = inkA, 1 = inkB, 2 = ground. (Same colours the TS sampler uses, so the
  // twin stays in parity.) `family` already encodes the vocab (dealtgrid_<vocab>).
  if (family.startsWith('dealtgrid_')) {
    const c = DEALTGRID_VOCABS[dealtGridVocab(p)]
    return [c.inkA, c.inkB, c.ground][roleIndex] ?? c.ground
  }
  // weave3d wants 3 light→dark strand tones over the dark Background recess, so it
  // reads as a 3D isometric weave out of the box (role2 must NOT default to bg).
  if (family === 'weave3d' || family === 'tripods') return ['#d8dee9', '#9aa5b8', '#5b6472'][roleIndex] ?? '#5b6472'
  if (roleIndex === 0) return String(p.colorA ?? '#e8eef5')
  if (roleIndex === 2) return String(p.background ?? '#0e1116')
  // roleIndex 1
  return GROUND_IS_BG.has(family) ? String(p.background ?? '#0e1116') : String(p.colorB ?? '#7aa2f7')
}
export function legacyFill(p: Params, family: string, roleIndex: number): Fill {
  return { type: 'solid', color: legacyColor(p, family, roleIndex) }
}
