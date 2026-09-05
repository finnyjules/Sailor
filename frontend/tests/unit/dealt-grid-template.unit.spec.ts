import { describe, expect, it, vi } from 'vitest'
import { applyGridTemplate, DEALTGRID_PRESETS, DEALTGRID_PRESET_IDS, DEALTGRID_TEMPLATE_NONE } from '~/lib/texturefx/templates'
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

// --- preset application -----------------------------------------------------

describe('dealt-grid preset application', () => {
  it('the five presets carry structural names, in picker order (no playgrnd tool names)', () => {
    expect(DEALTGRID_PRESET_IDS).toEqual(['Even', 'Loose', 'Dense', 'Packed', 'Fine'])
    expect(Object.keys(DEALTGRID_PRESETS)).toEqual(DEALTGRID_PRESET_IDS)
    for (const id of DEALTGRID_PRESET_IDS) {
      expect(['modular', 'oddgrid', 'parcel', 'mosh', 'static']).not.toContain(id.toLowerCase())
    }
  })

  it('the preset values are exact', () => {
    expect(DEALTGRID_PRESETS).toEqual({
      Even:   { dgCells: 8,  dgDensity: 1,   dgSizeVar: 0,    vocab: 'brand' },
      Loose:  { dgCells: 10, dgDensity: 1,   dgSizeVar: 0.5,  vocab: 'brand' },
      Dense:  { dgCells: 12, dgDensity: 1,   dgSizeVar: 0.25, vocab: 'warm' },
      Packed: { dgCells: 16, dgDensity: 0.8, dgSizeVar: 0.7,  vocab: 'brand' },
      Fine:   { dgCells: 22, dgDensity: 0.6, dgSizeVar: 0.1,  vocab: 'mono' },
    })
  })

  it('applying each preset writes dgCells / dgDensity / dgSizeVar / dgVocab', () => {
    for (const id of DEALTGRID_PRESET_IDS) {
      const t = DEALTGRID_PRESETS[id]!
      const p = dealt()
      applyGridTemplate(p, id)
      expect(p.dgCells, `${id} cells`).toBe(t.dgCells)
      expect(p.dgDensity, `${id} density`).toBe(t.dgDensity)
      expect(p.dgSizeVar, `${id} sizeVar`).toBe(t.dgSizeVar)
      expect(p.dgVocab, `${id} vocab`).toBe(t.vocab)
      expect(p.dgTemplate, `${id} records the choice`).toBe(id)
    }
  })

  it('reuses the global seed — a preset sets structure + palette, not the shuffle', () => {
    const p = dealt({ seed: 4242 })
    applyGridTemplate(p, 'Loose')
    expect(p.seed).toBe(4242)
  })

  it('mutates in place and returns the same bag (chainable)', () => {
    const p = dealt()
    expect(applyGridTemplate(p, 'Dense')).toBe(p)
  })

  it('the neutral sentinel records the choice but leaves the dials untouched', () => {
    const p = dealt({ dgCells: 13, dgDensity: 0.42, dgSizeVar: 0.9, dgVocab: 'warm' })
    applyGridTemplate(p, DEALTGRID_TEMPLATE_NONE)
    expect(p.dgTemplate).toBe(DEALTGRID_TEMPLATE_NONE)
    expect([p.dgCells, p.dgDensity, p.dgSizeVar, p.dgVocab]).toEqual([13, 0.42, 0.9, 'warm'])
  })

  it('an unknown id (including the retired tool names) is inert on the dials', () => {
    for (const id of ['not-a-preset', 'mosh', 'oddgrid', 'static']) {
      const p = dealt({ dgCells: 5 })
      applyGridTemplate(p, id)
      expect(p.dgCells, id).toBe(5)
      expect(p.dgTemplate, id).toBe(id)
    }
  })

  it('after applying, the dials are still editable (the preset value is not sticky)', () => {
    const p = dealt()
    applyGridTemplate(p, 'Packed')
    expect(p.dgCells).toBe(DEALTGRID_PRESETS.Packed!.dgCells)
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

  it('a preset + its vocab leaves the layout governed only by cells/density/sizeVar', () => {
    // Applying a preset then swapping just the vocab must not move a single cell.
    const p = dealt(); applyGridTemplate(p, 'Dense')
    const withPresetVocab = roleField(p)
    const q = { ...p, dgVocab: 'cool' }
    expect(roleField(q)).toEqual(withPresetVocab)
  })
})
