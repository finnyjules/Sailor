import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { screenRectOfBox, type ScreenRect } from '~/lib/scene3d/passes'

// The screen-bbox → pixel-rect math is pure and headless: a Matrix4 view-projection is injected,
// so no WebGL is needed (the same trick the motion-velocity unit test uses). An IDENTITY viewProj
// applies with w = 1 (no perspective divide), so a world-space Box3 maps straight to NDC and then
// to pixels — enough to pin the projection/clamp/pad math without a real camera or GPU.
const IDENTITY = new THREE.Matrix4()

const box = (min: [number, number, number], max: [number, number, number]) =>
  new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max))

describe('screenRectOfBox', () => {
  it('projects a centred unit cube to the middle of the canvas', () => {
    // Cube spanning [-0.5, 0.5] on x/y → NDC [-0.5, 0.5] under IDENTITY. On a 100×100 canvas:
    //   px = (ndcX * 0.5 + 0.5) * 100 → x ∈ [25, 75]
    //   py = (1 - (ndcY * 0.5 + 0.5)) * 100 → y ∈ [25, 75] (Y flipped for top-left origin)
    const rect = screenRectOfBox(box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]), IDENTITY, 100, 100, 0)
    expect(rect).toEqual<ScreenRect>({ x: 25, y: 25, w: 50, h: 50 })
  })

  it('applies symmetric padding, clamped to the canvas', () => {
    const rect = screenRectOfBox(box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]), IDENTITY, 100, 100, 10)
    // 10px pad on each side: [15, 85] → w/h 70.
    expect(rect).toEqual<ScreenRect>({ x: 15, y: 15, w: 70, h: 70 })
  })

  it('returns null for a box entirely off-screen (to the right)', () => {
    // NDC x ∈ [3, 4] → px ∈ [200, 250], both past the 100px width → clamps to zero area.
    expect(screenRectOfBox(box([3, 3, 0], [4, 4, 0]), IDENTITY, 100, 100, 0)).toBeNull()
  })

  it('returns null for a box entirely off-screen (to the left)', () => {
    expect(screenRectOfBox(box([-4, -4, 0], [-3, -3, 0]), IDENTITY, 100, 100, 0)).toBeNull()
  })

  it('returns null for a degenerate zero-size box', () => {
    expect(screenRectOfBox(box([0, 0, 0], [0, 0, 0]), IDENTITY, 100, 100, 0)).toBeNull()
  })

  it('returns null for an empty (uninitialised) box', () => {
    expect(screenRectOfBox(new THREE.Box3(), IDENTITY, 100, 100, 0)).toBeNull()
  })

  it('returns null when the whole box is behind the camera (w <= 0)', () => {
    // A viewProj whose w-row is -z: every corner at z > 0 gets clipW < 0 → behind → skipped.
    const behind = new THREE.Matrix4().set(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, -1, 0,
    )
    expect(screenRectOfBox(box([-0.5, -0.5, 1], [0.5, 0.5, 2]), behind, 100, 100, 0)).toBeNull()
  })

  it('clips the rect to the canvas when the box straddles an edge', () => {
    // x spans [-1.5, 0.5] → NDC, but the left half is off-canvas; result clamps x to 0.
    const rect = screenRectOfBox(box([-1.5, -0.5, 0], [0.5, 0.5, 0]), IDENTITY, 100, 100, 0)
    expect(rect).not.toBeNull()
    expect(rect!.x).toBe(0)
    expect(rect!.x + rect!.w).toBeLessThanOrEqual(100)
  })
})
