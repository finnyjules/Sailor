import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { SHOWCASE_LAYOUTS, getLayout } from '~/lib/spacetype/layouts/index'
import { projectCard, projectLayout, thumbnailParams, THUMB_CARDS, THUMB_STILL_T } from '~/lib/spacetype/layouts/thumbnail'
import { SPACE_TYPE_EFFECTS } from '~/lib/spacetype/effects'

const HEAD_ON = { rotX: 0, rotY: 0, rotZ: 0 }

describe('layout gallery thumbnails', () => {
  it('a head-on card at the origin projects to a centred, upright square', () => {
    const c = projectCard({ x: 0, y: 0, z: 0, rotY: 0, scale: 2 }, HEAD_ON, 0)!
    const xs = c.corners.map(p => p[0]), ys = c.corners.map(p => p[1])
    expect(Math.max(...xs)).toBeCloseTo(-Math.min(...xs), 9)
    expect(Math.max(...ys)).toBeCloseTo(-Math.min(...ys), 9)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(Math.max(...ys) - Math.min(...ys), 9)
  })

  it('further away is smaller; behind the camera is dropped', () => {
    const w = (z: number) => { const c = projectCard({ x: 0, y: 0, z, rotY: 0, scale: 2 }, HEAD_ON, 0)!; return c.corners[1]![0] - c.corners[0]![0] }
    expect(w(-10)).toBeLessThan(w(0))
    expect(projectCard({ x: 0, y: 0, z: 20, rotY: 0, scale: 2 }, HEAD_ON, 0)).toBeNull()
  })

  it('matches three.js: same card rotation order, same group pose, same camera', () => {
    const tf = { x: 1.5, y: -0.7, z: 2, rotY: 0.6, rotX: -0.4, rotZ: 0.3, scale: 2 }
    const pose = { rotX: -0.5, rotY: 0.2, rotZ: 0.7 }
    const root = new THREE.Group(); root.rotation.set(pose.rotX, pose.rotY, pose.rotZ); root.position.z = -1.2
    const quad = new THREE.Object3D(); quad.rotation.order = 'YXZ'
    quad.position.set(tf.x, tf.y, tf.z); quad.rotation.set(tf.rotX, tf.rotY, tf.rotZ); quad.scale.set(tf.scale, tf.scale, 1)
    root.add(quad); root.updateMatrixWorld(true)
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100); cam.position.set(0, 0, 14); cam.updateMatrixWorld(true); cam.updateProjectionMatrix()
    const ndc = new THREE.Vector3(-0.5, 0.5, 0).applyMatrix4(quad.matrixWorld).project(cam)   // top-left corner
    const mine = projectCard(tf, pose, 0)!.corners[0]!
    expect(mine[0]).toBeCloseTo(ndc.x, 6)   // aspect 1 → NDC x and y are both in half-heights
    expect(mine[1]).toBeCloseTo(ndc.y, 6)
  })

  it('every layout yields a drawable thumbnail, furthest card first', () => {
    for (const l of SHOWCASE_LAYOUTS) for (const t of [THUMB_STILL_T, 0.5]) {
      const cards = projectLayout(l, t)
      expect(cards.length, `${l.id} @ ${t}`).toBeGreaterThan(0)
      expect(cards.length).toBeLessThanOrEqual(THUMB_CARDS)
      for (let k = 1; k < cards.length; k++) expect(cards[k - 1]!.depth).toBeGreaterThanOrEqual(cards[k]!.depth)
      for (const c of cards) for (const [x, y] of c.corners) { expect(Number.isFinite(x)).toBe(true); expect(Number.isFinite(y)).toBe(true) }
      // something lands inside the frame (|y| ≤ 1, |x| ≤ 1.4 at the tile's 7:5 shape)
      expect(cards.some(c => c.corners.some(([x, y]) => Math.abs(x) <= 1.4 && Math.abs(y) <= 1)), `${l.id} in frame`).toBe(true)
    }
  })

  it('the still frame catches the one-at-a-time layouts mid-move, so they do not all look alike', () => {
    for (const id of ['deck', 'slide', 'stage', 'focusshift']) {
      expect(projectLayout(getLayout(id), THUMB_STILL_T).length, id).toBeGreaterThan(1)
    }
  })

  it('thumbnails use each layout\'s declared defaults, including the morphing layout\'s borrowed ones', () => {
    const p = thumbnailParams()
    for (const l of SHOWCASE_LAYOUTS) for (const c of l.controls) expect(p[c.key]).toBe(c.default)
    expect(projectLayout(getLayout('medley'), 0.5).length).toBeGreaterThan(0)
  })

  it('every gallery entry on the Layouts tab has a layout to draw its thumbnail from', () => {
    const entries = SPACE_TYPE_EFFECTS.filter(e => e.gallery === 'layouts')
    expect(entries.length).toBe(SHOWCASE_LAYOUTS.length)
    for (const e of entries) expect(projectLayout(e.showcaseLayout!, THUMB_STILL_T).length, e.id).toBeGreaterThan(0)
  })
})
