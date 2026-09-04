import { describe, expect, it, vi } from 'vitest'
import { applyGridTemplate, DEALTGRID_TEMPLATE_NONE } from '~/lib/texturefx/templates'
import { GRID_TEMPLATES, gridTemplate } from '~/lib/frame/gridTemplates'
import { textureDefaults } from '~/lib/texturefx/controls'
import { DEALTGRID_VOCABS, dealtGridColors, dealtGridVocab, rolesFor } from '~/lib/texturefx/roles'
import { dealtGridSample } from '~/lib/texturefx/pattern'

// controls.ts pulls in the shared post stack (which some sibling specs mock ofetch
// for). Nothing here calls a tuner, but keep the harmless mock for import-graph parity.
vi.mock('ofetch', () => ({ $fetch: vi.fn() }))

const dealt = (over: Record<string, unknown> = {}) => ({
  ...textureDefaults(), mode: 'dealtgrid', seed: 7, ...over,
}) as any

/** The role field over an N×N sample grid — pure per-cell layout, no colour. */
function roleField(p: any, n = 32): number[] {
  const cells = Number(p.dgCells), seed = Number(p.seed)
  const density = Number.isFinite(Number(p.dgDensity)) ? Number(p.dgDensity) : 1
  const sizeVar = Number.isFinite(Number(p.dgSizeVar)) ? Number(p.dgSizeVar) : 0
  const out: number[] = []
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      out.push(dealtGridSample((x + 0.5) / n, (y + 0.5) / n, cells, seed, density, sizeVar).role)
  return out
}

// --- template application ---------------------------------------------------

describe('dealt-grid template application', () => {
  it('the five shared templates are the ones we wire (Modular / Oddgrid / Parcel / Mosh / Static)', () => {
    expect(GRID_TEMPLATES.map(t => t.id)).toEqual(['modular', 'oddgrid', 'parcel', 'mosh', 'static'])
  })

  it('applying each template writes dgCells / dgDensity / dgSizeVar / dgVocab from its .pattern', () => {
    for (const t of GRID_TEMPLATES) {
      const p = dealt()
      applyGridTemplate(p, t.id)
      expect(p.dgCells, `${t.id} cells`).toBe(t.pattern.dgCells)
      expect(p.dgDensity, `${t.id} density`).toBe(t.pattern.dgDensity)
      expect(p.dgSizeVar, `${t.id} sizeVar`).toBe(t.pattern.dgSizeVar)
      expect(p.dgVocab, `${t.id} vocab`).toBe(t.pattern.vocab)
      expect(p.dgTemplate, `${t.id} records the choice`).toBe(t.id)
    }
  })

  it('reuses the global seed — a template sets structure + palette, not the shuffle', () => {
    const p = dealt({ seed: 4242 })
    applyGridTemplate(p, 'oddgrid')
    expect(p.seed).toBe(4242)
  })

  it('mutates in place and returns the same bag (chainable)', () => {
    const p = dealt()
    expect(applyGridTemplate(p, 'parcel')).toBe(p)
  })

  it('the neutral sentinel records the choice but leaves the dials untouched', () => {
    const p = dealt({ dgCells: 13, dgDensity: 0.42, dgSizeVar: 0.9, dgVocab: 'warm' })
    applyGridTemplate(p, DEALTGRID_TEMPLATE_NONE)
    expect(p.dgTemplate).toBe(DEALTGRID_TEMPLATE_NONE)
    expect([p.dgCells, p.dgDensity, p.dgSizeVar, p.dgVocab]).toEqual([13, 0.42, 0.9, 'warm'])
  })

  it('an unknown id is inert on the dials (records the choice only)', () => {
    const p = dealt({ dgCells: 5 })
    applyGridTemplate(p, 'not-a-template')
    expect(p.dgCells).toBe(5)
    expect(p.dgTemplate).toBe('not-a-template')
  })

  it('after applying, the dials are still editable (the template value is not sticky)', () => {
    const p = dealt()
    applyGridTemplate(p, 'mosh')
    expect(p.dgCells).toBe(gridTemplate('mosh')!.pattern.dgCells)
    p.dgCells = 3   // a plain edit, as the panel would write
    expect(p.dgCells).toBe(3)
  })
})

// --- vocab families ---------------------------------------------------------

describe('dealt-grid colour vocabularies', () => {
  it('the four families each supply the required role slots (2 inks + ground) as valid colours', () => {
    for (const v of ['brand', 'mono', 'warm', 'cool'] as const) {
      const fam = DEALTGRID_VOCABS[v]
      for (const slot of ['inkA', 'inkB', 'ground'] as const) {
        expect(/^#[0-9a-f]{6}$/.test(fam[slot]), `${v}.${slot}=${fam[slot]}`).toBe(true)
      }
      // The role SHAPE is identical across vocabs — 2 inks + ground, in that order.
      expect(rolesFor(dealt({ dgVocab: v }))).toEqual(['inkA', 'inkB', 'ground'])
    }
  })

  it('dealtGridVocab / dealtGridColors read dgVocab and default to brand', () => {
    expect(dealtGridVocab(dealt())).toBe('brand')                    // unset ⇒ brand
    expect(dealtGridVocab(dealt({ dgVocab: 'cool' }))).toBe('cool')
    expect(dealtGridVocab(dealt({ dgVocab: 'bogus' }))).toBe('brand') // unknown ⇒ brand
    expect(dealtGridColors(dealt({ dgVocab: 'warm' }))).toEqual(DEALTGRID_VOCABS.warm)
  })

  it('switching vocab changes the resolved colours (mono ≠ brand, and every pair differs)', () => {
    const vs = ['brand', 'mono', 'warm', 'cool'] as const
    for (let i = 0; i < vs.length; i++)
      for (let j = i + 1; j < vs.length; j++)
        expect(DEALTGRID_VOCABS[vs[i]!], `${vs[i]} vs ${vs[j]}`).not.toEqual(DEALTGRID_VOCABS[vs[j]!])
    // mono reads grey (inkA ≈ inkB ≈ ground in hue) while brand carries the blue ink.
    expect(dealtGridColors(dealt({ dgVocab: 'mono' }))).not.toEqual(dealtGridColors(dealt({ dgVocab: 'brand' })))
  })
})

// --- parity: vocab is colour-only, never geometry ---------------------------

describe('dealt-grid vocab does not perturb the sampler (twin-safe)', () => {
  it('the per-cell role field is byte-identical across all four vocabs', () => {
    // Determinism/parity guard: the dealt-grid sampler takes no colour input, so the
    // kept cells + layout must be the SAME for every vocab — only the colours the
    // render paints differ. If this drifts, the TS↔GLSL twin would too.
    const base = roleField(dealt({ dgVocab: 'brand', dgSizeVar: 0.5, dgDensity: 0.6, dgCells: 10 }))
    for (const v of ['mono', 'warm', 'cool'] as const) {
      const f = roleField(dealt({ dgVocab: v, dgSizeVar: 0.5, dgDensity: 0.6, dgCells: 10 }))
      expect(f, `layout for ${v}`).toEqual(base)
    }
  })

  it('a template + its vocab leaves the layout governed only by cells/density/sizeVar', () => {
    // Applying a template then swapping just the vocab must not move a single cell.
    const p = dealt(); applyGridTemplate(p, 'parcel')
    const withTemplateVocab = roleField(p)
    const q = { ...p, dgVocab: 'cool' }
    expect(roleField(q)).toEqual(withTemplateVocab)
  })
})
