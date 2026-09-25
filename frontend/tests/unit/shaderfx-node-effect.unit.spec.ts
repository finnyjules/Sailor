// frontend/tests/unit/shaderfx-node-effect.unit.spec.ts
// A canvas Shader effect node's own effect, named through the live catalog (stage 5 final fix #6).
import { describe, it, expect } from 'vitest'
import { nodeEffectDef, nodeEffectId } from '~/lib/shaderfx/nodeEffect'
import type { EffectDef } from '~/lib/shaderfx/types'

const d = (id: string, name: string): EffectDef => ({ id, name, category: 'distortion', animated: false, passes: 1, centerParam: null, textures: [], params: [], source: '' })
const effects = [d('water_ripple', 'Water ripple'), d('mine_aaaaaaaaaaaa', 'Rain on glass')]
const data = (effect: unknown) => ({ widgetDefs: [{ name: 'params' }, { name: 'effect' }], widgetsValues: ['{}', effect] })

describe('nodeEffectDef', () => {
  it('reads the node’s effect widget and names it through the catalog', () => {
    expect(nodeEffectId(data('water_ripple'))).toBe('water_ripple')
    expect(nodeEffectDef(data('water_ripple'), effects)?.name).toBe('Water ripple')
    expect(nodeEffectDef(data('mine_aaaaaaaaaaaa'), effects)?.name).toBe('Rain on glass')
  })
  it('none picked, an unknown id, or no catalog yet: no effect', () => {
    expect(nodeEffectId(data(null))).toBe('')
    expect(nodeEffectDef(data(null), effects)).toBeNull()
    expect(nodeEffectDef(data('nope'), effects)).toBeNull()
    expect(nodeEffectDef(data('water_ripple'), null)).toBeNull()
    expect(nodeEffectDef({}, effects)).toBeNull()
  })
})
