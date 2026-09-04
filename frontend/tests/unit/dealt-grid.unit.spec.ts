import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEALT_INK_ROLES, CHIP_SALT_DENSITY,
  chipHash, chipKeepCell, dealtGridSample, patternColor, type RGBA,
} from '~/lib/texturefx/pattern'
import { TEXTURE_CONTROLS, textureDefaults } from '~/lib/texturefx/controls'
import { TEXTURE_SECTIONS } from '~/lib/texturefx/sections'
import { rolesFor } from '~/lib/texturefx/roles'
import { MODES } from '~/lib/texturefx/types'
import { TEXTURE_FS } from '~/lib/texturefx/renderer'

// controls.ts pulls in the post stack, which is fine here; nothing calls a tuner.
// (Chips' spec mocks ofetch for studioTune — this file imports none of that, but the
// mock is harmless and keeps parity with the sibling spec if the import graph shifts.)
vi.mock('ofetch', () => ({ $fetch: vi.fn() }))

const dealtParams = (over: Record<string, unknown> = {}) => ({
  ...textureDefaults(), mode: 'dealtgrid', seed: 7, ...over,
}) as any

/** The role field on an N×N sample grid (pixel centres, so no seam sampling). */
function roleField(p: any, n = 32): number[] {
  const cells = Number(p.dgCells), seed = Number(p.seed)
  const density = Number.isFinite(Number(p.dgDensity)) ? Number(p.dgDensity) : 1
  const sizeVar = Number.isFinite(Number(p.dgSizeVar)) ? Number(p.dgSizeVar) : 0
  const out: number[] = []
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      out.push(dealtGridSample((x + 0.5) / n, (y + 0.5) / n, cells, seed, density, sizeVar).role)
    }
  }
  return out
}

function groundShare(p: any, n = 48): number {
  const f = roleField(p, n)
  return f.filter(r => r === DEALT_INK_ROLES).length / f.length
}

/** Fraction of GRID CELLS that fill (drawn at their centre), computed directly from
 *  the sampler by probing each cell's centre — where any inset < 0.5 still draws. */
function filledCellFraction(cells: number, seed: number, density: number, sizeVar = 0): number {
  let filled = 0
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const u = (cx + 0.5) / cells, v = (cy + 0.5) / cells
      if (dealtGridSample(u, v, cells, seed, density, sizeVar).role < DEALT_INK_ROLES) filled++
    }
  }
  return filled / (cells * cells)
}

const eqRGBA = (a: RGBA, b: RGBA) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-9)
const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// --- mode registration -----------------------------------------------------

describe('dealt grid mode registration', () => {
  it('appends dealtgrid to MODES without moving the existing indices', () => {
    // renderer.ts dispatches on MODES.indexOf(mode) — appending keeps saved scenes valid.
    expect(MODES.indexOf('procedural' as any)).toBe(0)
    expect(MODES.indexOf('truchet' as any)).toBe(1)
    expect(MODES.indexOf('raster' as any)).toBe(2)
    expect(MODES.indexOf('shapes' as any)).toBe(3)
    expect(MODES.indexOf('chips' as any)).toBe(4)
    expect(MODES.indexOf('dealtgrid' as any)).toBe(5)
  })

  it('rolesFor: dealtgrid resolves to the two inks + ground', () => {
    const roles = rolesFor({ mode: 'dealtgrid' } as any)
    expect(roles).toEqual(['inkA', 'inkB', 'ground'])
    // The ground role index the CPU math emits must be the LAST role in the list.
    expect(roles.length).toBe(DEALT_INK_ROLES + 1)
  })
})

// --- controls --------------------------------------------------------------

describe('dealt grid controls', () => {
  const find = (k: string) => TEXTURE_CONTROLS.find(c => c.key === k)!

  it('declares dgCells / dgDensity / dgSizeVar with the spec ranges', () => {
    expect(find('dgCells')).toMatchObject({ kind: 'slider', label: 'Cells across', min: 2, max: 24, step: 1, default: 8, group: 'Dealt grid' })
    expect(find('dgDensity')).toMatchObject({ kind: 'slider', label: 'Density', min: 0.15, max: 1, step: 0.01, default: 1, group: 'Dealt grid' })
    expect(find('dgSizeVar')).toMatchObject({ kind: 'slider', label: 'Size variance', min: 0, max: 1, step: 0.01, default: 0, group: 'Dealt grid' })
  })

  it('defaults pick up the dealt-grid keys', () => {
    const d = textureDefaults()
    expect(d.dgCells).toBe(8)
    expect(d.dgDensity).toBe(1)
    expect(d.dgSizeVar).toBe(0)
  })

  it('the Dealt grid group is in the section allow-list', () => {
    expect(new Set<string>(TEXTURE_SECTIONS).has('Dealt grid')).toBe(true)
  })

  it('draws the panel in list order: cells / density / size variance', () => {
    const group = TEXTURE_CONTROLS.filter(c => c.group === 'Dealt grid').map(c => c.key)
    expect(group).toEqual(['dgCells', 'dgDensity', 'dgSizeVar'])
  })

  it('reveals the Dealt grid group only in dealtgrid mode', () => {
    const proc = textureDefaults()
    const dealt = dealtParams()
    for (const k of ['dgCells', 'dgDensity', 'dgSizeVar']) {
      expect(find(k).when!(proc), `${k} in procedural`).toBe(false)
      expect(find(k).when!(dealt), `${k} in dealtgrid`).toBe(true)
    }
  })

  it('hides the lattice controls in dealtgrid mode (it owns its own grid)', () => {
    expect(find('cells').when!(dealtParams())).toBe(false)
    expect(find('lattice').when!(dealtParams())).toBe(false)
    expect(find('cells').when!(textureDefaults())).toBe(true)
  })
})

// --- determinism -----------------------------------------------------------

describe('dealt grid determinism', () => {
  it('same seed → identical role field; different seed → a different one', () => {
    const a = roleField(dealtParams({ seed: 11, dgDensity: 0.6 }))
    const b = roleField(dealtParams({ seed: 11, dgDensity: 0.6 }))
    expect(a).toEqual(b)
    const c = roleField(dealtParams({ seed: 12, dgDensity: 0.6 }))
    expect(c).not.toEqual(a)
  })

  it('the same params render the same colours twice (no hidden state)', () => {
    const p = dealtParams({ dgSizeVar: 0.7, dgDensity: 0.7 })
    for (const [u, v] of [[0.13, 0.71], [0.5, 0.5], [0.92, 0.04]]) {
      expect(eqRGBA(patternColor(p, u!, v!), patternColor(p, u!, v!))).toBe(true)
    }
  })
})

// --- tileability -----------------------------------------------------------

describe('dealt grid tileability', () => {
  const RING = Array.from({ length: 41 }, (_, i) => i / 40)

  it('the role field wraps at u∈{0,1} and v∈{0,1}', () => {
    for (const cells of [2, 5, 8, 24]) {
      for (const t of RING) {
        const l = dealtGridSample(0, t, cells, 5, 0.7, 0.5)
        const r = dealtGridSample(1, t, cells, 5, 0.7, 0.5)
        expect(l.role, `x-wrap role @ v=${t} cells=${cells}`).toBe(r.role)
        expect(`${l.cellX},${l.cellY}`, `x-wrap owner @ v=${t} cells=${cells}`).toBe(`${r.cellX},${r.cellY}`)
        const b = dealtGridSample(t, 0, cells, 5, 0.7, 0.5)
        const u = dealtGridSample(t, 1, cells, 5, 0.7, 0.5)
        expect(b.role, `y-wrap role @ u=${t} cells=${cells}`).toBe(u.role)
        expect(`${b.cellX},${b.cellY}`, `y-wrap owner @ u=${t} cells=${cells}`).toBe(`${u.cellX},${u.cellY}`)
      }
    }
  })

  it('the rendered colour wraps too, including at low density', () => {
    for (const over of [{ dgCells: 9 }, { dgCells: 9, dgDensity: 0.35, dgSizeVar: 0.6 }]) {
      const p = dealtParams(over)
      for (const t of RING) {
        expect(eqRGBA(patternColor(p, 0, t), patternColor(p, 1, t)), `x @ v=${t} ${JSON.stringify(over)}`).toBe(true)
        expect(eqRGBA(patternColor(p, t, 0), patternColor(p, t, 1)), `y @ u=${t} ${JSON.stringify(over)}`).toBe(true)
      }
    }
  })
})

// --- size variance ---------------------------------------------------------

describe('dealt grid size variance', () => {
  it('sizeVar 0 at full density → every pixel is ink, no ground at all (flush grid)', () => {
    // A rigid grid: no drops (density 1) and no inset (sizeVar 0) means no ground.
    for (const cells of [4, 8, 12]) {
      const g = groundShare(dealtParams({ dgCells: cells, dgDensity: 1, dgSizeVar: 0 }), 48)
      expect(g, `cells=${cells}`).toBe(0)
    }
  })

  it('sizeVar > 0 opens ground gutters between cells (more inset → more ground)', () => {
    const shares = [0, 0.25, 0.5, 0.9].map(sv => groundShare(dealtParams({ dgCells: 8, dgDensity: 1, dgSizeVar: sv }), 64))
    expect(shares[0]).toBe(0)                       // flush → no gutter
    for (let i = 1; i < shares.length; i++) {
      expect(shares[i]!, `sizeVar step ${i}: ${shares[i - 1]} → ${shares[i]}`).toBeGreaterThan(shares[i - 1]!)
    }
    expect(shares[shares.length - 1]!).toBeLessThan(1)   // ...but never all ground
  })

  it('only the declared role indices appear, and both inks show up', () => {
    const seen = new Set(roleField(dealtParams({ dgSizeVar: 0.4 }), 64))
    expect([...seen].every(r => r >= 0 && r <= DEALT_INK_ROLES)).toBe(true)
    expect(seen.has(0) && seen.has(1)).toBe(true)   // both inks present
  })
})

// --- density ---------------------------------------------------------------

describe('dealt grid density', () => {
  it('lower density → strictly more ground on a fixed grid', () => {
    const shares = [1, 0.8, 0.6, 0.4, 0.2].map(d => groundShare(dealtParams({ dgCells: 12, dgDensity: d, dgSizeVar: 0 })))
    expect(shares[0]).toBe(0)   // density 1, sizeVar 0 → fully packed
    for (let i = 1; i < shares.length; i++) {
      expect(shares[i]!, `density step ${i}: ${shares[i - 1]} → ${shares[i]}`).toBeGreaterThan(shares[i - 1]!)
    }
    expect(shares[shares.length - 1]!).toBeLessThan(1)   // chips still left at 0.2
  })

  it('the filled fraction tracks the density dial (± the one forced cell)', () => {
    // Each non-kept cell fills iff its density lane hashes below `density`, a ~uniform
    // 0..1 draw, so over a big grid the filled fraction ≈ density. Tolerant: it is a
    // finite sample, and the force-kept cell adds at most one.
    const cells = 16
    for (const d of [1, 0.75, 0.5, 0.25]) {
      const frac = filledCellFraction(cells, 7, d, 0)
      expect(Math.abs(frac - d), `density ${d}: filled ${frac.toFixed(3)}`).toBeLessThan(0.12)
    }
  })

  it('deterministic: the same density renders the same field twice', () => {
    const p = dealtParams({ dgDensity: 0.4 })
    expect(roleField(p)).toEqual(roleField(p))
    expect(roleField(dealtParams({ dgDensity: 0.41 }))).not.toEqual(roleField(p))
  })
})

// --- never blank -----------------------------------------------------------

describe('dealt grid never renders a blank tile', () => {
  it('the force-kept cell always draws ink at its centre — every density, every sizeVar', () => {
    // The blank-tile guard: chipKeepCell()'s min-hash cell is never density-dropped,
    // and its CENTRE is inside any inset (< 0.5 strictly), so it always draws ink.
    // Swept over the density floor / 0 and the full sizeVar range, on the small grids
    // that are the worst case (fewest cells to survive).
    for (const cells of [2, 4, 6, 12]) {
      for (const seed of [1, 7, 20, 47, 407, 999983]) {
        const keep = chipKeepCell(cells, seed)
        const u = (keep.cx + 0.5) / cells, v = (keep.cy + 0.5) / cells
        for (const density of [0, 0.15, 0.5]) {
          for (const sizeVar of [0, 0.5, 1]) {
            const s = dealtGridSample(u, v, cells, seed, density, sizeVar)
            expect(s.role, `kept cell blank @ cells=${cells} seed=${seed} d=${density} sv=${sizeVar}`).toBeLessThan(DEALT_INK_ROLES)
            expect([s.cellX, s.cellY], 'the drawn cell must be the kept one').toEqual([keep.cx, keep.cy])
          }
        }
      }
    }
  })

  it('a flush sweep at the density floor / 0 never blanks a whole tile', () => {
    // sizeVar 0 isolates DENSITY as the blank axis (the concern the force-keep fixes):
    // even 0.85^16 ≈ 7% of small-grid seeds would come up empty without it.
    const inked = (over: Record<string, unknown>, n = 40) => {
      const p = dealtParams(over)
      const cells = Number(p.dgCells), seed = Number(p.seed), d = Number(p.dgDensity), sv = Number(p.dgSizeVar)
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (dealtGridSample((x + 0.5) / n, (y + 0.5) / n, cells, seed, d, sv).role < DEALT_INK_ROLES) return true
        }
      }
      return false
    }
    const blank: string[] = []
    for (const density of [0.15, 0]) {
      for (const cells of [2, 4, 6]) {
        for (let seed = 1; seed <= 200; seed++) {
          if (!inked({ dgCells: cells, seed, dgDensity: density, dgSizeVar: 0 })) blank.push(`cells${cells}/dens${density}/seed${seed}`)
        }
      }
    }
    expect(blank, `blank tiles: ${blank.slice(0, 10).join(' ')}`).toEqual([])
  }, 20000)
})

// --- colour ----------------------------------------------------------------

describe('dealt grid colour', () => {
  it('renders exactly the three role colours — inkA, inkB, ground, nothing off-palette', () => {
    const p = dealtParams({ dgSizeVar: 0.5, dgDensity: 0.7, colorA: '#c94f3d', colorB: '#3d6bc9', background: '#f2ede4' })
    const palette: RGBA[] = [[...hex('#c94f3d'), 1] as RGBA, [...hex('#3d6bc9'), 1] as RGBA, [...hex('#f2ede4'), 1] as RGBA]
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const c = patternColor(p, (x + 0.5) / 32, (y + 0.5) / 32)
        expect(palette.some(q => eqRGBA(c, q)), `pixel ${x},${y} = ${c.join(',')}`).toBe(true)
      }
    }
  })
})

// --- the GPU twin (source assertions) --------------------------------------
// The shader can't run here (WebGL needs a browser), so these pin the one fragment
// shader render() compiles — the house style (see texturefx-chips.unit.spec.ts).
// Pixel-level agreement is checked with a tolerance on /dev/pattern-gallery's
// Dealt grid row.

describe('dealt grid shader branch', () => {
  /** Just the dealt-grid branch: from its gate to the chips gate that follows it. */
  const branch = (() => {
    const start = TEXTURE_FS.indexOf('if (u_mode > 4.5)')
    const end = TEXTURE_FS.indexOf('if (u_mode > 3.5)')
    return TEXTURE_FS.slice(start, end)
  })()

  it('gates on the dealtgrid MODE INDEX, and gates BEFORE the chips branch', () => {
    // The chips gate is a bare `u_mode > 3.5`, which catches index 5 too — so dealt
    // grid must return FIRST or picking it would render chips.
    expect(MODES.indexOf('dealtgrid' as any)).toBe(5)
    const dealtGate = TEXTURE_FS.indexOf('if (u_mode > 4.5)')
    const chipsGate = TEXTURE_FS.indexOf('if (u_mode > 3.5)')
    expect(dealtGate, 'dealt-grid branch missing from the shader').toBeGreaterThan(0)
    expect(dealtGate, 'dealt grid must be gated BEFORE chips').toBeLessThan(chipsGate)
    // 4.5 is the midpoint between chips (4) and dealtgrid (5).
    expect(MODES.indexOf('dealtgrid' as any) - 0.5).toBe(4.5)
  })

  it('interpolates DEALT_INK_ROLES instead of retyping it', () => {
    expect(branch).toContain(`evalFill(${DEALT_INK_ROLES}, fc, v_uv)`)                                   // empty / gutter = ground
    expect(branch).toContain(`floor(chipHash(cx, cy, u_chipSalt[3]) * float(${DEALT_INK_ROLES}))`)       // role pick
  })

  it('mirrors the CPU dropout + force-keep + inset rules on the wrapped cell', () => {
    // Wrapped id vs un-wrapped position is what makes the tile seamless.
    expect(branch).toContain('float cx = posmod(ix, C), cy = posmod(iy, C);')
    // Density: >= is the exact negation of the CPU's `hash < density`.
    expect(branch).toContain('float dens = clamp(u_dgDensity, 0.0, 1.0);')
    expect(branch).toContain('bool isKeep = (cx == u_chipKeep.x && cy == u_chipKeep.y);')
    expect(branch).toContain('bool dropped = !isKeep && chipHash(cx, cy, u_chipSalt[5]) >= dens;')
    // lone survivor drawn flush (inset skipped) — mirrors chipSample's lone exemption.
    expect(branch).toContain('bool lone = isKeep && u_chipKeep.z >= dens;')
    expect(branch).toContain('float inset = lone ? 0.0 : sv * chipHash(cx, cy, u_chipSalt[2]) * 0.5;')
    expect(branch).toContain('if (dropped || !inInset) {')
  })

  it('uses the ASYMMETRIC chip hash, not the symmetric cellHash', () => {
    expect(branch).toContain('chipHash(')
    expect(branch, 'dealt grid must not fall back to the symmetric cellHash').not.toContain('cellHash(')
  })

  it('reads the salt lanes at the indices chipSaltLanes() wrote (R=2, ROLE=3, DENSITY=5)', () => {
    expect(branch, 'lane 2 is the size-variance inset').toContain('chipHash(cx, cy, u_chipSalt[2])')
    expect(branch, 'lane 3 is the ROLE pick').toContain('chipHash(cx, cy, u_chipSalt[3])')
    expect(branch, 'lane 5 is the DENSITY dropout').toContain('chipHash(cx, cy, u_chipSalt[5])')
  })

  it('declares its uniforms and render() uploads every one of them', () => {
    const src = readFileSync(resolve(__dirname, '../../app/lib/texturefx/renderer.ts'), 'utf8')
    for (const name of ['u_dgCells', 'u_dgDensity', 'u_dgSizeVar']) {
      expect(TEXTURE_FS, `${name} not declared`).toContain(name)
      expect(src, `${name} declared but never set`).toContain(`u('${name}')`)
    }
    // The force-keep uniform is shared with chips, so dealtgrid must re-key it on dgCells.
    expect(src).toContain('const dgKeep = chipKeepCell(dgCells, chipSeed)')
    expect(src).toContain('gl.uniform3f(u(\'u_chipKeep\'), dgKeep.cx, dgKeep.cy, dgKeep.second)')
    expect(src).toContain('const dgCells = Math.max(2, Math.round(Number(p.dgCells) || 8))')
  })
})

// --- independent brute force -----------------------------------------------

describe('dealt grid: independent brute force of the role field', () => {
  it('agrees with a from-scratch reimplementation of the cell math', () => {
    // A deliberately separate implementation (not the sampler): if the wrap, the
    // force-keep, the density test, or the inset ever drift, the two disagree.
    const posmod = (a: number, n: number) => ((a % n) + n) % n
    const brute = (u: number, v: number, C: number, seed: number, density: number, sizeVar: number) => {
      const gx = u * C, gy = v * C
      const cx = posmod(Math.floor(gx), C), cy = posmod(Math.floor(gy), C)
      const fx = gx - Math.floor(gx), fy = gy - Math.floor(gy)
      const keep = chipKeepCell(C, seed)
      const isKeep = cx === keep.cx && cy === keep.cy
      const dropped = !isKeep && chipHash(cx, cy, seed + CHIP_SALT_DENSITY) >= density
      const lone = isKeep && keep.second >= density
      const inset = lone ? 0 : sizeVar * chipHash(cx, cy, seed + 2.719 /* CHIP_SALT_R */) * 0.5
      const inInset = fx >= inset && fx <= 1 - inset && fy >= inset && fy <= 1 - inset
      if (dropped || !inInset) return DEALT_INK_ROLES
      return Math.min(DEALT_INK_ROLES - 1, Math.floor(chipHash(cx, cy, seed + 3.911 /* CHIP_SALT_ROLE */) * DEALT_INK_ROLES))
    }
    for (const [C, density, sizeVar] of [[4, 1, 0], [8, 1, 0.6], [6, 0.5, 0.4], [12, 0.3, 0.9]] as [number, number, number][]) {
      for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 24; x++) {
          const u = (x + 0.37) / 24, v = (y + 0.61) / 24
          const s = dealtGridSample(u, v, C, 3, density, sizeVar)
          expect(s.role, `role @ ${u},${v} C=${C} d=${density} sv=${sizeVar}`).toBe(brute(u, v, C, 3, density, sizeVar))
        }
      }
    }
  })
})
