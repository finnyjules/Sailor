import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { pileEffect } from '~/lib/spacetype/effects/pile'
import { defaultsFromControls } from '~/lib/spacetype/effect'
import { PILE_SAMPLES } from '~/lib/spacetype/pile/physics'
import { SPACE_TYPE_EFFECTS, getEffect } from '~/lib/spacetype/effects'
import { separatorEligible } from '~/lib/spacetype/separator'

const env = { width: 960, height: 540, imageTextures: new Map() }
function p(over: Record<string, unknown>) {
  return { ...defaultsFromControls(pileEffect.controls), ...over }
}

describe('pileEffect', () => {
  it('is registered with the raw-word (separator-ineligible) id "pile"', () => {
    expect(pileEffect.id).toBe('pile')
  })

  it('builds one mesh per token and a full-length trajectory', () => {
    const root = pileEffect.buildScene(THREE, p({ text: 'MOVE FAST AND BREAK', textAs: 'words', shapeCount: 3 }), new THREE.Texture(), env)
    const st = (root as any).userData.pileState
    expect(st.meshes).toHaveLength(4 + 3)
    expect(st.trajectory).toHaveLength(PILE_SAMPLES)
  })

  it('update(t01) drives every mesh from the sampled trajectory', () => {
    const params = p({ text: 'HELLO WORLD', textAs: 'words', shapeCount: 0 })
    const root = pileEffect.buildScene(THREE, params, new THREE.Texture(), env)
    const st = (root as any).userData.pileState
    pileEffect.update!(0, params, root)
    const first = st.meshes.map((m: THREE.Object3D) => m.position.clone())
    pileEffect.update!(1, params, root)
    const last = st.meshes.map((m: THREE.Object3D) => m.position.clone())
    // The pile moves between the start of the drop and the settled end.
    const moved = first.some((v: THREE.Vector3, i: number) => v.distanceTo(last[i]) > 1e-3)
    expect(moved).toBe(true)
    // Settled (t=1) matches the final trajectory sample for token 0.
    const end = st.trajectory[PILE_SAMPLES - 1][0]
    expect(st.meshes[0].position.x).toBeCloseTo(end.x, 5)
    expect(st.meshes[0].position.y).toBeCloseTo(end.y, 5)
  })

  it('empty pile builds zero meshes without throwing', () => {
    const root = pileEffect.buildScene(THREE, p({ textAs: 'off', shapeCount: 0 }), new THREE.Texture(), env)
    expect((root as any).userData.pileState.meshes).toHaveLength(0)
  })

  it('every value-select control carries optionLabels', () => {
    for (const c of pileEffect.controls) {
      if (c.kind === 'select') expect(Array.isArray((c as any).optionLabels)).toBe(true)
    }
  })
})

describe('pile registration', () => {
  it('is in the effect registry and resolvable by id', () => {
    expect(SPACE_TYPE_EFFECTS.some(e => e.id === 'pile')).toBe(true)
    expect(getEffect('pile').id).toBe('pile')
  })
  it('is separator-ineligible (raw-word effect)', () => {
    expect(separatorEligible('pile')).toBe(false)
  })
})
