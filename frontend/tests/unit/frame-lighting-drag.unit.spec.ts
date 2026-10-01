// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { lightingDragging, setLightingDrag, nudgeLightingDrag } from '~/lib/frame/lighting/drag'

describe('lighting drag flag never sticks', () => {
  afterEach(() => { setLightingDrag(false); vi.useRealTimers() })
  it('turns off on any window pointerup, even one a handler stopped', () => {
    setLightingDrag(true)
    expect(lightingDragging.value).toBe(true)
    const el = document.createElement('div'); document.body.appendChild(el)
    el.addEventListener('pointerup', e => e.stopPropagation())
    el.dispatchEvent(new Event('pointerup', { bubbles: true }))
    expect(lightingDragging.value).toBe(false)
    el.remove()
  })
  it('turns off on pointercancel and on window blur', () => {
    setLightingDrag(true)
    window.dispatchEvent(new Event('pointercancel'))
    expect(lightingDragging.value).toBe(false)
    setLightingDrag(true)
    window.dispatchEvent(new Event('blur'))
    expect(lightingDragging.value).toBe(false)
  })
  it('disarms its listeners once off (a later pointerup does nothing to a wheel nudge)', () => {
    vi.useFakeTimers()
    setLightingDrag(true); setLightingDrag(false)
    nudgeLightingDrag(180)
    expect(lightingDragging.value).toBe(true)
    vi.advanceTimersByTime(100)
    expect(lightingDragging.value).toBe(true)
    vi.advanceTimersByTime(100)
    expect(lightingDragging.value).toBe(false)
  })
})
