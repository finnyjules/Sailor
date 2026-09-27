import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/NodePort.vue', import.meta.url)), 'utf8')

describe('NodePort hover look', () => {
  it('grows the dot to 16px and fills it on hover', () => {
    expect(SRC).toMatch(/\.node-port:hover \.node-port__dot \{[^}]*width: 16px;[^}]*height: 16px;[^}]*background: var\(--port-color\)/)
  })
  it('slides the dot out from under the node edge', () => {
    expect(SRC).toMatch(/\.node-port--left:hover \.node-port__dot \{[^}]*translate\(calc\(-50% - 5px\), -50%\)/)
    expect(SRC).toMatch(/\.node-port--right:hover \.node-port__dot \{[^}]*translate\(calc\(-50% \+ 5px\), -50%\)/)
  })
  it('names the port at 11px, weight 500', () => {
    expect(SRC).toMatch(/node-port__label[^"]*text-\[11px\]/)
    expect(SRC).toMatch(/node-port__label[^"]*font-medium/)
  })
  it('keeps the full-size hit target above the card', () => {
    expect(SRC).toMatch(/zIndex: 20/)
  })
})
