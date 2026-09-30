import { describe, it, expect } from 'vitest'
import { dofShouldRun } from '~/lib/compositor/dofPass'
import {
  defaultPostEffect, isGpuEffect, isChainEffect, chainActive, gpuActive, GPU_TYPES,
} from '~/lib/compositor/postEffects'
import type { DofEffect } from '~/lib/compositor/postEffects'

describe('dof paint routing contract', () => {
  it('a dof effect never reaches the 2D chain filter', () => {
    const fx = [defaultPostEffect('dof'), defaultPostEffect('grain')]
    expect(fx.filter(isChainEffect).map(e => e.type)).toEqual(['grain'])
    expect(fx.filter(isGpuEffect).map(e => e.type)).toEqual(['dof'])
  })

  it('dof alone activates the GPU stage but not the 2D chain', () => {
    const only = [defaultPostEffect('dof')]
    expect(gpuActive(only)).toBe(true)
    expect(chainActive(only)).toBe(false)
  })

  it('a hidden dof effect activates nothing', () => {
    expect(gpuActive([{ type: 'dof', visible: false }])).toBe(false)
  })

  it('is inert until depth exists, so a layer always renders', () => {
    const d = defaultPostEffect('dof') as DofEffect
    expect(dofShouldRun(d, false)).toBe(false)
  })

  it('coexists with the 2D chain — both stages stay active independently', () => {
    const both = [defaultPostEffect('dof'), defaultPostEffect('vignette')]
    expect(gpuActive(both)).toBe(true)
    expect(chainActive(both)).toBe(true)
  })

  it('routes relight to the GPU stage, never the 2D chain', () => {
    expect(GPU_TYPES.has('relight')).toBe(true)
    expect(isChainEffect({ type: 'relight' } as any)).toBe(false)
  })
})
