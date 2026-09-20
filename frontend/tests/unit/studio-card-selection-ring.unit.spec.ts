import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The canvas draws a studio card's selection ring with ONE rule:
 *  `.vue-flow__node.selected .studio-node`. A card whose root lacks the class still
 *  selects on click but shows nothing — which is how five of them shipped ringless. */
const dir = resolve(__dirname, '../../app/components/vue-canvas')
const STUDIO_CARDS = [
  'GradientStudioNode', 'ShaderStudioNode', 'TextureStudioNode', 'ShapeStudioNode',
  'Scene3DStudioNode', 'LipSyncStudioNode', 'ShotDirectorNode', 'SpaceTypeNode', 'VectorTypeNode',
]

describe('studio cards show a selection ring', () => {
  it('the canvas still styles the shared class', () => {
    expect(readFileSync(resolve(dir, 'VueNodeCanvas.vue'), 'utf8')).toContain('.vue-flow__node.selected .studio-node')
  })

  it.each(STUDIO_CARDS)('%s carries the class on its root element', (name) => {
    const src = readFileSync(resolve(dir, `${name}.vue`), 'utf8')
    const template = src.slice(src.indexOf('<template>'))
    const root = /<div\b[^>]*>/.exec(template)?.[0] ?? ''
    expect(root).toMatch(/class="[^"]*\bstudio-node\b/)
  })
})
