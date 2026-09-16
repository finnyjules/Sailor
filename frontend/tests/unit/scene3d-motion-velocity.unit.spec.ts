import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { defaultDoc, createPrimitive } from '~/lib/scene3d/config'
import { createTreatment } from '~/lib/scene3d/treatments'
import { sceneScreenVelocities, ghostLocalPoses, collectGhostPoses } from '~/lib/scene3d/motion/velocity'

// The velocity/ghost math is pure and headless: a Matrix4 view-projection is injected, so no
// WebGL is needed. An IDENTITY viewProj maps a Vector3 through `applyMatrix4` with w=1 (no
// perspective divide), so a world-space position delta shows up as an equal NDC delta — enough
// to assert "moving ⇒ non-zero, still ⇒ zero" without pinning a real camera.
const IDENTITY = new THREE.Matrix4()

const movingDoc = () => {
  const doc = defaultDoc()
  doc.motion = { duration: 4, fps: 30, loop: true }
  const box = createPrimitive('box', doc.objects)
  box.name = 'Mover'
  box.position = [0, 0.5, 0]
  box.motion = { loop: { kind: 'bob', speed: 1, amount: 2 } } // a vertical bob, changing at t01=0.1
  box.treatments = [createTreatment('velocityBlur')]
  doc.objects.push(box)
  return { doc, box }
}

describe('sceneScreenVelocities', () => {
  it('returns a non-zero NDC vector for a moving object carrying a velocityBlur', () => {
    const { doc, box } = movingDoc()
    const v = sceneScreenVelocities(doc, 0.1, IDENTITY).get(box.id)
    expect(v, 'a bob at t01=0.1 is moving on screen').toBeTruthy()
    expect(Math.hypot(v!.x, v!.y)).toBeGreaterThan(0)
    // A vertical bob moves in Y, not X, under an identity projection.
    expect(Math.abs(v!.y)).toBeGreaterThan(Math.abs(v!.x))
  })

  it('returns no vector for a still object (no motion at all)', () => {
    const doc = defaultDoc()
    doc.motion = { duration: 4, fps: 30, loop: true }
    const box = createPrimitive('box', doc.objects)
    box.treatments = [createTreatment('velocityBlur')]
    doc.objects.push(box) // no box.motion ⇒ evaluateObjectMotion is the identity ⇒ zero velocity
    expect(sceneScreenVelocities(doc, 0.1, IDENTITY).get(box.id)).toBeUndefined()
  })

  it('is empty when no object carries a motion treatment, even if the object moves', () => {
    const doc = defaultDoc()
    doc.motion = { duration: 4, fps: 30, loop: true }
    const box = createPrimitive('box', doc.objects)
    box.motion = { loop: { kind: 'bob', speed: 1, amount: 2 } } // moves, but no velocityBlur/ghostTrails
    doc.objects.push(box)
    expect(sceneScreenVelocities(doc, 0.1, IDENTITY).size).toBe(0)
  })

  it('degrades to zero (no vector) for a parented object — v1 unparented only', () => {
    const { doc, box } = movingDoc()
    const parent = createPrimitive('box', doc.objects)
    doc.objects.push(parent)
    box.parentId = parent.id
    expect(sceneScreenVelocities(doc, 0.1, IDENTITY).get(box.id)).toBeUndefined()
  })
})

describe('ghostLocalPoses', () => {
  it('returns `count` distinct local poses spaced by `spacing` frames for a moving object', () => {
    const { doc, box } = movingDoc()
    const poses = ghostLocalPoses(box, doc, 0.4, 3, 2)
    expect(poses).toHaveLength(3)
    // Every ghost's Y differs from the current pose (the object is bobbing).
    const nowY = box.position[1]
    for (const p of poses) expect(p.position[1]).not.toBe(nowY)
    // Distinct from one another — a real spread, not three copies of one pose.
    const ys = poses.map((p) => p.position[1])
    expect(new Set(ys.map((y) => y.toFixed(6))).size).toBe(3)
  })

  it('returns no poses for a still object (all past poses collapse onto the current pose)', () => {
    const doc = defaultDoc()
    doc.motion = { duration: 4, fps: 30, loop: true }
    const box = createPrimitive('box', doc.objects)
    box.treatments = [createTreatment('ghostTrails')]
    doc.objects.push(box) // no motion ⇒ every sampled pose equals the current one
    expect(ghostLocalPoses(box, doc, 0.4, 3, 2)).toEqual([])
  })
})

describe('collectGhostPoses', () => {
  it('maps a ghostTrails host id to its past poses, using the treatment count/spacing', () => {
    const doc = defaultDoc()
    doc.motion = { duration: 4, fps: 30, loop: true }
    const box = createPrimitive('box', doc.objects)
    box.motion = { loop: { kind: 'bob', speed: 1, amount: 2 } }
    const ghost = createTreatment('ghostTrails') as { count: number; spacing: number }
    ghost.count = 4; ghost.spacing = 1
    box.treatments = [ghost as never]
    doc.objects.push(box)
    const map = collectGhostPoses(doc, 0.4)
    expect(map.get(box.id)).toHaveLength(4)
  })

  it('is empty for a velocityBlur-only host (no ghostTrails)', () => {
    const { doc } = movingDoc() // carries only a velocityBlur
    expect(collectGhostPoses(doc, 0.4).size).toBe(0)
  })
})
