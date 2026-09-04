/**
 * Shape of the gizmo overlay pass in `Scene3DEngine.renderWithPost`.
 *
 * This is a TEXT-SHAPE test on purpose: the overlay pass only exists inside a real
 * `WebGLRenderer` frame, so exercising it needs a GL context that vitest's node
 * environment does not have (and a headless-GL stub would assert against the stub,
 * not against three). The two properties below are structural — a depth clear between
 * the autoClear flip and the render, and a try/finally that always restores the camera
 * layer mask — so reading the source and checking the block's shape catches the exact
 * regressions we care about: helpers vanishing behind the composer's full-screen quad,
 * and a throw parking the camera on the private gizmo layer forever.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(fileURLToPath(new URL('../../app/lib/scene3d/engine.ts', import.meta.url)), 'utf8')

/** The overlay pass: from the saved camera mask that opens it to the end of the
 *  `finally` that puts the helpers back on layer 0. */
function overlayBlock(): string {
  const start = SRC.indexOf('const camMask = camera.layers.mask')
  expect(start, 'renderWithPost no longer saves the camera layer mask').toBeGreaterThan(-1)
  const swap = SRC.indexOf('camera.layers.set(GIZMO_OVERLAY_LAYER)', start)
  expect(swap, 'renderWithPost no longer parks the camera on GIZMO_OVERLAY_LAYER').toBeGreaterThan(start)
  const end = SRC.indexOf('o.layers.set(0)', swap)
  expect(end, 'the overlay pass no longer restores helper layers').toBeGreaterThan(swap)
  return SRC.slice(start, end + 'o.layers.set(0)'.length)
}

describe('gizmo overlay pass', () => {
  it('clears depth between turning autoClear off and rendering the helpers', () => {
    const block = overlayBlock()
    const off = block.indexOf('autoClear = false')
    const clear = block.indexOf('clearDepth()')
    const render = block.indexOf('this.renderer.render(scene, camera)')
    expect(off, 'overlay pass no longer turns autoClear off').toBeGreaterThan(-1)
    expect(render, 'overlay pass no longer renders the scene').toBeGreaterThan(-1)
    // Without this the composer's final quad has already written depth 0 over the whole
    // frame, so every depthTest:true helper (light marker, light widgets, sculpt cursor)
    // fails the test and disappears as soon as a post effect is on.
    expect(clear, 'no clearDepth() in the overlay pass').toBeGreaterThan(off)
    expect(clear, 'clearDepth() must come before the overlay render').toBeLessThan(render)
  })

  it('restores camera layers, autoClear and the background in a finally', () => {
    const block = overlayBlock()
    expect(block, 'the overlay render is not guarded by try/finally').toMatch(/try\s*\{[\s\S]*\}\s*finally\s*\{/)
    const fin = block.slice(block.search(/\}\s*finally\s*\{/))
    // A throw inside the render must not leave the camera on layer 31 — everything
    // afterwards would render an empty scene, permanently.
    expect(fin, 'finally does not restore camera.layers.mask').toContain('camera.layers.mask')
    expect(fin, 'finally does not restore autoClear').toContain('autoClear')
    expect(fin, 'finally does not restore scene.background').toContain('scene.background')
    expect(fin, 'finally does not put the helpers back on layer 0').toContain('o.layers.set(0)')
  })
})
