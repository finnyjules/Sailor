import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { attachContextWatch } from '~/lib/shaderfx/contextWatch'

describe('attachContextWatch', () => {
  it('prevents the default on loss (or the browser never restores) and reports both events', () => {
    const t = new EventTarget()
    const onLost = vi.fn(), onRestored = vi.fn()
    const detach = attachContextWatch(t, { onLost, onRestored })
    const lost = new Event('webglcontextlost', { cancelable: true })
    t.dispatchEvent(lost)
    expect(lost.defaultPrevented).toBe(true)
    expect(onLost).toHaveBeenCalledTimes(1)
    t.dispatchEvent(new Event('webglcontextrestored'))
    expect(onRestored).toHaveBeenCalledTimes(1)
    detach()
    t.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(onLost).toHaveBeenCalledTimes(1)
  })
})

describe('ShaderFxRenderer wiring (source guard: the renderer needs real WebGL)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../app/lib/shaderfx/renderer.ts', import.meta.url)), 'utf8')
  it('watches its canvas when it creates it, and refuses to render while lost', () => {
    expect(src).toMatch(/attachContextWatch\(this\.canvas/)
    expect(src).toMatch(/throw new ShaderFxContextLostError/)
    expect(src).toMatch(/onContextChange\(/)
  })
  it('dispose() stops watching and drops its context subscribers', () => {
    const body = src.slice(src.indexOf('  dispose(): void {'))
    expect(body.slice(0, body.indexOf('if (!gl) return'))).toMatch(/this\.listeners\.clear\(\)/)
  })
  it('the Shader studio canvas node redraws after a restore, and lets go on unmount', () => {
    const node = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/ShaderStudioNode.vue', import.meta.url)), 'utf8')
    expect(node).toMatch(/const offContextChange = shaderFx\.onContextChange\(\(s\) => \{ if \(s === 'restored'\) renderStill\(\) \}\)/)
    expect(node).toMatch(/onBeforeUnmount\(\(\) => \{[^}]*offContextChange\(\)/)
  })
  it('drops every GL handle on loss so the next render rebuilds them', () => {
    const drop = src.slice(src.indexOf('private dropHandles'), src.indexOf('}', src.indexOf('this.liveTex = new Map')) )
    for (const f of ['programs', 'blit', 'composite', 'mask', 'fboTex', 'fbos', 'holdTex', 'layerSrcTex', 'baseTex', 'extraTexCache', 'liveTex']) expect(drop).toContain(f)
  })
})
