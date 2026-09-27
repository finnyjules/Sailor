import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CSS = readFileSync(fileURLToPath(new URL('../../app/assets/css/node-surfaces.css', import.meta.url)), 'utf8')
const rule = (sel: string) => {
  const i = CSS.indexOf(`${sel} {`)
  if (i < 0) throw new Error(`rule ${sel} not found`)
  return CSS.slice(i, CSS.indexOf('}', i))
}

describe('node-surfaces.css guards', () => {
  it('shell fill is flat: no gradient inside a shell (a lighter top reads as a dark seam)', () => {
    expect(rule('.node-shell')).not.toMatch(/gradient/)
  })
  it('shell has no inner highlight line (it doubles the top edge)', () => {
    expect(rule('.node-shell')).not.toMatch(/inset\s+0\s+1px/)
  })
  it('borders stay one screen pixel at every zoom', () => {
    expect(rule('.node-shell')).toMatch(/calc\(1px \/ var\(--canvas-zoom, 1\)\)/)
  })
  it('real blur only under the canvas switch AND the node flag', () => {
    expect(CSS).toMatch(/\.canvas-glass--blur \.node-shell\[data-glass-blur\] \{[^}]*backdrop-filter: blur\(18px\) saturate\(1\.4\)/)
    expect(CSS.replace(/\.canvas-glass--blur \.node-shell\[data-glass-blur\] \{[^}]*\}/, '')).not.toMatch(/backdrop-filter: blur\(18px\)/)
  })
  it('never promotes layers', () => {
    expect(CSS).not.toMatch(/will-change|translateZ/)
  })
  it('node text is 500, titles 600', () => {
    expect(rule('.node-shell')).toMatch(/font-weight: 500/)
    expect(rule('.node-shell__title')).toMatch(/font-weight: 600/)
  })
})
