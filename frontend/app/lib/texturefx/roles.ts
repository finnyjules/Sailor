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
  // dealtGridSample() emits it as index inkRoles).
  dealtgrid: ['inkA', 'inkB', 'ground'],
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
  // Dealt grid likewise — one family, implied by the mode (no picker).
  if (String(p.mode) === 'dealtgrid') return 'dealtgrid'
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
