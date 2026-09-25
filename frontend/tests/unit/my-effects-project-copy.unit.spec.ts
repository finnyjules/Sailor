import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { adoptMyEffects, attachMyEffects, myEffectIdsIn } from '~/lib/myEffects/projectCopy'
import { recordFromTake, withValuesVersion } from '~/lib/myEffects/defs'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const rec = (id: string) => recordFromTake(SPIKE_TAKES.rain![2]!, { id, request: 'rain', from: null, now: 'x' })
const A = 'mine_aaaaaaaaaaaa', B = 'mine_bbbbbbbbbbbb'
const doc = (widgets: unknown[]) => ({ canvases: [{ id: 'c', name: 'Canvas 1', workflow: { nodes: [{ type: 'shader-effect', widgets_values: widgets }] } }], activeCanvasId: 'c' }) as any

describe('projects keep a copy of the My effects they use (spec §7.4)', () => {
  it('finds My effect ids anywhere in the doc, version ids included', () => {
    expect(myEffectIdsIn(doc([A, { fill: { shader: { effectId: `${B}~v2` } } }, 'water_ripple']))).toEqual([A, B])
  })
  it('never picks up a draft take id', () => {
    expect(myEffectIdsIn(doc(['draft_abc123', 'draft_mine']))).toEqual([])
  })
  it('attach writes the used records, and removes the field when none are used', () => {
    const d = doc([A])
    attachMyEffects(d, id => (id === A ? rec(A) : null))
    expect(d.myEffects.map((r: any) => r.id)).toEqual([A])
    const plain = doc(['water_ripple']); plain.myEffects = [rec(A)]
    attachMyEffects(plain, () => null)
    expect(plain.myEffects).toBeUndefined()
  })
  it('an effect removed from the library keeps its existing project copy', () => {
    const d = doc([A]); d.myEffects = [rec(A)]
    attachMyEffects(d, () => null)
    expect(d.myEffects.map((r: any) => r.id)).toEqual([A])
  })
  it('a project copy with more versions than the library copy stands (ruling 17)', () => {
    const lib = rec(A)
    const richer = withValuesVersion(lib, { u_speed: 0.123 }, { request: 'slower', now: 'y' })!
    expect(richer.versions.length).toBeGreaterThan(lib.versions.length)
    const d = doc([A]); d.myEffects = [richer]
    attachMyEffects(d, () => lib)
    expect(d.myEffects[0].versions.length).toBe(richer.versions.length)
    const e = doc([A]); e.myEffects = [lib]
    attachMyEffects(e, () => richer)
    expect(e.myEffects[0]).toBe(richer)
  })
  it('skips the scan entirely when the library is empty and the doc has no copies', () => {
    const d = doc([A]); const lookup = vi.fn(() => null)
    attachMyEffects(d, lookup, { libraryEmpty: true })
    expect(lookup).not.toHaveBeenCalled()
    expect(d.myEffects).toBeUndefined()
  })
  it('adopt hands the copies over (and ignores a doc without any)', () => {
    const adopt = vi.fn()
    adoptMyEffects({ ...doc([A]), myEffects: [rec(A)] }, adopt)
    expect(adopt).toHaveBeenCalledWith([expect.objectContaining({ id: A })])
    adoptMyEffects(doc([]), adopt); adoptMyEffects(null, adopt)
    expect(adopt).toHaveBeenCalledTimes(1)
  })
})

describe('default.vue: every doc from storage adopts its copies (wiring guard, preflight C10)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../app/layouts/default.vue', import.meta.url)), 'utf8')
  it('the one helper adopts, and the six load paths call it', () => {
    expect(src).toMatch(/function loadedDoc\(body: any\): ProjectDoc \{\s*const doc = toProjectDoc\(body\)\s*adoptMyEffects\(doc, myEffectsApi\.adopt\)/)
    expect(src.match(/\bloadedDoc\(/g)!.length - 1).toBe(6)
  })
  it('nothing else turns stored content into a doc behind the helper’s back', () => {
    // Allowed: the helper itself, re-normalising a doc already in savedWorkflows, a blank
    // placeholder, and the durable copy that only enters savedWorkflows through loadedDoc.
    const args = [...src.matchAll(/toProjectDoc\(([^)]*)\)/g)].map(m => m[1])
    const allowed = new Set(['body', 'savedWorkflows[tabId]', 'savedWorkflows[tab.id]', 'makeBlankWorkflow(', 'durableBody'])
    expect(args.filter(a => !allowed.has(a!))).toEqual([])
    expect(src).toMatch(/savedWorkflows\[tab\.id\] = loadedDoc\(durableDoc\)/)
  })
  it('the save snapshot attaches the copies before stamping', () => {
    expect(src).toMatch(/attachMyEffects\(toRaw\(doc\), myEffectRecordById, \{ libraryEmpty: myEffectRecords\.value\.length === 0 \}\)\s*stampDocForSave\(/)
  })
})
