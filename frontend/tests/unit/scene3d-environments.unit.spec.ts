import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildEnvironmentScene } from '~/lib/scene3d/environments'
import { ENVIRONMENT_KINDS } from '~/lib/scene3d/config'

function meshes(scene: THREE.Scene): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh) })
  return out
}
function maxChannel(c: THREE.Color): number { return Math.max(c.r, c.g, c.b) }

describe('scene3d environments', () => {
  it('builds a disposable scene for every kind', () => {
    for (const kind of ENVIRONMENT_KINDS) {
      const scene = buildEnvironmentScene(kind)
      expect(scene.isScene).toBe(true)
      expect(typeof scene.dispose).toBe('function')
      scene.dispose()
    }
  })

  it('darkStrips is a black void with several HDR-bright thin bars', () => {
    const scene = buildEnvironmentScene('darkStrips')
    expect((scene.background as THREE.Color).getHex()).toBe(0x000000)
    const bars = meshes(scene)
    expect(bars.length).toBeGreaterThanOrEqual(5)
    // Every bar is emissive-bright beyond LDR white so PMREM captures streaks.
    for (const b of bars) {
      const m = b.material as THREE.MeshBasicMaterial
      expect(maxChannel(m.color)).toBeGreaterThan(1)
    }
    scene.dispose()
  })

  it('softbox is a grey void with big soft panels', () => {
    const scene = buildEnvironmentScene('softbox')
    const bg = scene.background as THREE.Color
    expect(bg.r).toBeGreaterThan(0)   // not black
    expect(bg.r).toBeLessThan(0.5)    // not white
    expect(meshes(scene).length).toBeGreaterThanOrEqual(2)
    scene.dispose()
  })

  it('colorGels has opposing magenta-ish and cyan-ish sources on black', () => {
    const scene = buildEnvironmentScene('colorGels')
    expect((scene.background as THREE.Color).getHex()).toBe(0x000000)
    const mats = meshes(scene).map((m) => m.material as THREE.MeshBasicMaterial)
    const magenta = mats.find((m) => m.color.r > m.color.g && m.color.b > m.color.g)
    const cyan = mats.find((m) => m.color.g > m.color.r && m.color.b > m.color.r)
    expect(magenta).toBeTruthy()
    expect(cyan).toBeTruthy()
    scene.dispose()
  })

  it('dispose frees every geometry and material', () => {
    const scene = buildEnvironmentScene('darkStrips')
    const disposed: string[] = []
    for (const m of meshes(scene)) {
      m.geometry.addEventListener('dispose', () => disposed.push('g'))
      ;(m.material as THREE.Material).addEventListener('dispose', () => disposed.push('m'))
    }
    const count = meshes(scene).length
    scene.dispose()
    expect(disposed.filter((d) => d === 'g').length).toBe(count)
    expect(disposed.filter((d) => d === 'm').length).toBe(count)
  })
})
