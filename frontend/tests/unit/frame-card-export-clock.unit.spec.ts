import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The Frame card's video download bakes frame i by calling `renderCompositeAtTime(i / fps)`.
 *  That must reach the painter as its clock — the same `t` the live preview passes — or every
 *  shader fill is painted at t = 0 and freezes in the exported video while the preview animates.
 *  (It shipped that way: the export called the painter with `undefined` in the clock slot.) */
const src = readFileSync(resolve(__dirname, '../../app/components/vue-canvas/ArtifactFrameNode.vue'), 'utf8')

/** Body of `function name(...) { ... }`, by brace matching from the signature. */
function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
  }
  throw new Error(`unbalanced body for ${name}`)
}

/** Top-level arguments of the first `callee(...)` call in `code`. */
function callArgs(code: string, callee: string): string[] {
  const at = code.indexOf(`${callee}(`)
  expect(at, `${callee}( not found`).toBeGreaterThan(-1)
  const args: string[] = []
  let depth = 0, cur = ''
  for (let i = at + callee.length; i < code.length; i++) {
    const c = code[i]
    if ('([{'.includes(c)) { if (depth++ === 0) continue }
    else if (')]}'.includes(c)) { if (--depth === 0) { args.push(cur.trim()); return args } }
    else if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  throw new Error(`unbalanced call to ${callee}`)
}

const CLOCK_ARG = 6 // paintLayerStack(ctx, W, H, items, localLayers, skip, t, ...)

describe('Frame card video export uses the frame clock', () => {
  it('the live preview paints at t (the reference behaviour)', () => {
    const preview = callArgs(src.slice(src.indexOf('withWiredContent(wiredContentForSlot')), 'paintLayerStack')
    expect(preview[CLOCK_ARG]).toBe('t')
  })

  it('renderCompositeAtTime hands its time to the export painter', () => {
    const args = callArgs(fnBody('renderCompositeAtTime'), 'exportCompositeCanvas')
    expect(args).toEqual(['t'])
  })

  it('exportCompositeCanvas paints at the time it was given, not undefined', () => {
    const param = /function exportCompositeCanvas\((\w+)\??:\s*number/.exec(src)?.[1]
    expect(param, 'exportCompositeCanvas takes no time parameter').toBeTruthy()
    const args = callArgs(fnBody('exportCompositeCanvas'), 'paintLayerStack')
    expect(args[CLOCK_ARG]).toBe(param)
  })
})
