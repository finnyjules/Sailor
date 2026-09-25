// tests/unit/pen-value-request.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { usePen } from '~/composables/pen/usePen'

const DEV = { a: 34, b: 0, c: 0, d: -34, e: 40, f: 400 }
function mk() {
  const doc = ref<SketchDoc>({ entities: [], constraints: [] })
  return { doc, pen: usePen({ doc, view: ref(DEV) }) }
}

describe('inline value requests', () => {
  it('Repeat… asks for a count and repeats on submit', async () => {
    const { doc, pen } = mk()
    pen.selectTool('circle'); pen.place(0, 0); pen.place(1, 0)
    pen.selectTool('select')
    const circle = doc.value.entities.find(e => e.kind === 'circle')!
    pen.pick(circle.id)
    const done = pen.repeatPrompt()
    expect(pen.valueRequest.value?.label).toMatch(/copies/i)
    pen.submitValue(4)
    await done
    expect(pen.pendingOp.value?.kind).toBe('repeat')
  })
  it('cancel resolves with nothing applied', async () => {
    const { doc, pen } = mk()
    pen.selectTool('line'); pen.place(0, 0); pen.place(3, 0)
    pen.selectTool('select')
    const ids = doc.value.entities.filter(e => e.kind === 'point').map(e => e.id)
    pen.pick(ids[0]!); pen.pick(ids[1]!, true)
    const before = doc.value.constraints.length
    const done = pen.applyWithValue({ kind: 'distance', label: 'Distance…', value: true })
    pen.cancelValue()
    await done
    expect(doc.value.constraints.length).toBe(before)
    expect(pen.valueRequest.value).toBeNull()
  })
  it('never calls window.prompt', () => {
    const src = readFileSync(new URL('../../app/composables/pen/usePen.ts', import.meta.url), 'utf8')
      + readFileSync(new URL('../../app/composables/pen/penCopies.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/window\.prompt|\bprompt\(/)
  })
})
