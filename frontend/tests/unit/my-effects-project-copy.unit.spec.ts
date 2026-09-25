import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { adoptMyEffects, attachMyEffects, myEffectIdsIn } from '~/lib/myEffects/projectCopy'
import { expandMyEffect, recordFromTake, withCodeVersion, withValuesVersion } from '~/lib/myEffects/defs'
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
  it('a project pinned to v1 keeps a copy that still renders v1 after v2 is added elsewhere (Ruling #2)', () => {
    const v1 = rec(A)
    const pinned = expandMyEffect(v1)[0]!.id // what a pick or a Keep wrote
    expect(pinned).toBe(`${A}~v1`)
    const v2 = withCodeVersion(v1, SPIKE_TAKES.rain![0]!, { request: 'heavier', now: 'y' })
    const d = doc([pinned]); d.myEffects = [v1]
    attachMyEffects(d, () => v2)
    const copy = d.myEffects[0]
    expect(copy.versions[0].body).toBe(SPIKE_TAKES.rain![2]!.body)
    expect(expandMyEffect(copy).find(x => x.id === pinned)!.source).toContain(SPIKE_TAKES.rain![2]!.body.slice(0, 40))
  })
  it('the copy kept holds every code version the doc uses', () => {
    const v1 = rec(A)
    const v2 = withCodeVersion(v1, SPIKE_TAKES.rain![0]!, { request: 'heavier', now: 'y' })
    // As many versions, but its v2 only moved dials: it has no code version 2 for `~v2` to render.
    const dials = withValuesVersion(v1, { u_speed: 0.123 }, { request: 'slower', now: 'y' })!
    expect(dials.versions.length).toBe(v2.versions.length)
    const d = doc([`${A}~v2`]); d.myEffects = [v2]
    attachMyEffects(d, () => dials)
    expect(d.myEffects[0]).toBe(v2)
    // Used only at v1, both hold it: ruling 17 (the library's, at as many versions) as before.
    const e = doc([`${A}~v1`]); e.myEffects = [v2]
    attachMyEffects(e, () => dials)
    expect(e.myEffects[0]).toBe(dials)
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

/** Every way a doc can enter tab state in default.vue, and whether it went through loadedDoc.
 *  STRUCTURAL: it looks at every write into `savedWorkflows` (and the one bulk load), not at
 *  argument names — so a new load path fails however its variable is called. */
function unadoptedDocWrites(src: string): string[] {
  const bad: string[] = []
  // Any write: `savedWorkflows[k] = …`, `??=`, `||=`; plus bulk writes by other means.
  for (const m of src.matchAll(/savedWorkflows\[[^\]]*\]\s*(\?\?=|\|\|=|=(?!=))\s*([^\n]*)/g)) {
    const rhs = m[2]!.trim()
    const at = m.index!
    if (m[1] !== '=') { bad.push(m[0]); continue }
    if (/^loadedDoc\(/.test(rhs)) continue
    const id = /^([A-Za-z_$][\w$]*)\s*$/.exec(rhs)?.[1]
    if (!id) { bad.push(m[0]); continue }
    // A bare name must be bound, in the nearest preceding `const <id> =`, to a doc that is either
    // adopted (loadedDoc), already in savedWorkflows (re-normalised), or the blank placeholder.
    const decls = [...src.slice(0, at).matchAll(new RegExp(`const ${id}\\s*=\\s*([^\\n]*)`, 'g'))]
    const init = decls.at(-1)?.[1]?.trim() ?? ''
    if (/^loadedDoc\(/.test(init) || /^toProjectDoc\(savedWorkflows\[[^\]]*\]\)$/.test(init) || init === 'toProjectDoc(makeBlankWorkflow())') continue
    bad.push(m[0])
  }
  for (const m of src.matchAll(/Object\.assign\(savedWorkflows|Reflect\.set\(savedWorkflows|(?<!const )\bsavedWorkflows\s*=(?!=)/g)) bad.push(m[0])
  // The bulk session restore: its per-key write must adopt, and savedWorkflows must be born from it.
  for (const m of src.matchAll(/parsed\[key\]\s*=\s*([^\n]*)/g)) if (!/^loadedDoc\(/.test(m[1]!.trim())) bad.push(m[0])
  if (!/reactive<Record<string, any>>\(loadPersistedWorkflows\(\)\)/.test(src)) bad.push('savedWorkflows is not born from loadPersistedWorkflows')
  return bad
}

describe('default.vue: every doc from storage adopts its copies (wiring guard, preflight C10)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../app/layouts/default.vue', import.meta.url)), 'utf8')
  it('the one helper adopts', () => {
    expect(src).toMatch(/function loadedDoc\(body: any\): ProjectDoc \{\s*const doc = toProjectDoc\(body\)\s*adoptMyEffects\(doc, myEffectsApi\.adopt\)/)
  })
  it('every write of a doc into tab state goes through it (or keeps a doc already there)', () => {
    expect(unadoptedDocWrites(src)).toEqual([])
    expect(src.match(/\bloadedDoc\(/g)!.length - 1).toBe(6)
  })
  it('the guard catches a seventh path, whatever it is called (the review’s examples)', () => {
    const sabotage = [
      'function seventhPath(body: any) { savedWorkflows[x] = toProjectDoc(body) }',
      'function eighth(d: any) { savedWorkflows[y] = d }',
      'function ninth(w: any) { const doc = toProjectDoc(w); savedWorkflows[z] = doc }',
      'function tenth(w: any) { savedWorkflows[z] ??= w }',
      'function eleventh(w: any) { Object.assign(savedWorkflows, w) }',
      'function twelfth(w: any) { savedWorkflows = w }',
    ]
    for (const s of sabotage) expect(unadoptedDocWrites(`${src}\n${s}\n`).length, s).toBeGreaterThan(0)
  })
  it('the save snapshot attaches the copies before stamping, skipping only a library known to be empty', () => {
    expect(src).toMatch(/attachMyEffects\(toRaw\(doc\), myEffectRecordById, \{ libraryEmpty: myEffectLibraryKnownEmpty\(\) \}\)\s*stampDocForSave\(/)
  })
})

describe('a save before the library loads still scans (review #4)', () => {
  it('the library is "known empty" only once it has loaded', async () => {
    const lib = await import('~/lib/myEffects/library')
    lib.myEffectRecords.value = []
    lib.myEffectsLoaded.value = false
    expect(lib.myEffectLibraryKnownEmpty()).toBe(false)
    const d = doc([A]); const lookup = vi.fn(() => null)
    attachMyEffects(d, lookup, { libraryEmpty: lib.myEffectLibraryKnownEmpty() })
    expect(lookup).toHaveBeenCalledWith(A)
    lib.myEffectsLoaded.value = true
    expect(lib.myEffectLibraryKnownEmpty()).toBe(true)
    lib.myEffectRecords.value = [rec(A)]
    expect(lib.myEffectLibraryKnownEmpty()).toBe(false)
    lib.myEffectsLoaded.value = false; lib.myEffectRecords.value = []
  })
})
