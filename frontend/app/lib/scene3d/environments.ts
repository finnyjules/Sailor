// Procedural environment scenes for Scene3D. Each kind is a tiny THREE.Scene fed
// to PMREMGenerator.fromScene exactly like three's RoomEnvironment — built once
// per kind switch, then disposed. HDR trick: MeshBasicMaterial colours above 1.0
// survive into the float PMREM target, so bars/panels read as light sources.
// Selected by `lighting.environment` (config.ts) — add kinds there first.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { stripAlpha } from '~/lib/color/convert'
import type { EnvironmentKind } from './config'

/** Full parameterisation of the `colorGels` world, passed through from the doc
 *  (`lighting.gel*`). Every field has a default (`DEFAULT_GEL`) so a partial/omitted
 *  bag still builds — unit tests and pre-field docs pass none. Other env kinds ignore it. */
export interface GelEnvOptions {
  colorA: string; brightnessA: number; sizeA: number; azimuthA: number; heightA: number; distanceA: number
  colorB: string; brightnessB: number; sizeB: number; azimuthB: number; heightB: number; distanceB: number
  rim: boolean; rimColor: string; rimBrightness: number
  softness: number; background: string; exposure: number
}

/** The shipped defaults — kept in one place so config.ts's default doc and this module's
 *  fallback agree. The A/B placement (±100° azimuth, waist-height, ~4.6 out) reproduces the
 *  original hand-placed opposing magenta/cyan look now that it's polar. */
export const DEFAULT_GEL: GelEnvOptions = {
  colorA: '#ff0da6', brightnessA: 7, sizeA: 1, azimuthA: -100, heightA: 1.5, distanceA: 4.6,
  colorB: '#0dccff', brightnessB: 7, sizeB: 1, azimuthB: 100, heightB: 1.5, distanceB: 4.6,
  rim: true, rimColor: '#ffffff', rimBrightness: 4,
  softness: 0.04, background: '#000000', exposure: 1,
}

function resolveGel(partial?: Partial<GelEnvOptions>): GelEnvOptions {
  return { ...DEFAULT_GEL, ...(partial ?? {}) }
}

type EnvScene = THREE.Scene & { dispose(): void }

class ProceduralEnv extends THREE.Scene {
  dispose(): void {
    this.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    })
  }
}

/** A box "light bar": w×h×d at `pos`, aimed by `rotZ`/`rotY` (radians), with an
 *  HDR colour (`intensity` multiplies the channels past LDR white). */
function bar(scene: THREE.Scene, w: number, h: number, d: number,
  pos: [number, number, number], rotY: number, rotZ: number,
  color: THREE.Color, intensity: number): void {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshBasicMaterial({ color: color.multiplyScalar(intensity) }),
  )
  m.position.set(...pos)
  m.rotation.set(0, rotY, rotZ)
  scene.add(m)
}

/** Black void + long thin very bright bars at varied angles — studio strip
 *  softboxes. Glass dispersion turns these streaks into rainbow bands. */
function darkStrips(): EnvScene {
  const s = new ProceduralEnv()
  s.background = new THREE.Color(0x000000)
  const white = (warmth: number) => new THREE.Color(1, 1 - warmth * 0.08, 1 - warmth * 0.15)
  bar(s, 8, 0.35, 0.1, [-4, 4, -5], 0.4, 0.5, white(1), 10)
  bar(s, 10, 0.3, 0.1, [5, 3, -4], -0.5, -0.6, white(0), 12)
  bar(s, 7, 0.25, 0.1, [0, -3.5, -5], 0.1, 0.35, white(-1), 8)   // cool from below
  bar(s, 9, 0.3, 0.1, [-5, -1, 4], 2.6, -0.4, white(0.5), 9)
  bar(s, 6, 0.4, 0.1, [4, 5, 3], 2.9, 0.7, white(-0.5), 11)
  bar(s, 8, 0.2, 0.1, [0, 6, 0], 1.2, 1.57, white(0), 7)          // overhead
  return s
}

/** Mid-grey void + two huge soft white panels — the classic product-render
 *  studio: big gradient windows sliding across curved surfaces. */
function softbox(): EnvScene {
  const s = new ProceduralEnv()
  s.background = new THREE.Color(0x2a2a2a)
  bar(s, 6, 4.5, 0.1, [-4, 3, -3], 0.7, 0, new THREE.Color(1, 1, 1), 6)   // key
  bar(s, 4, 3, 0.1, [4.5, 1, 2], -2.2, 0, new THREE.Color(1, 1, 1), 2.5)  // fill
  return s
}

/** One gel panel, placed in polar coordinates around the object: `azimuthDeg` swings it
 *  around Y (0 = front/+Z, + = toward +X), `height` is its Y, `distance` its radius. The
 *  panel is auto-rotated to face the origin (its +Z emissive face aims inward). `size`
 *  scales the 5×4 base; `brightness` is the HDR intensity. */
function placeGel(
  s: THREE.Scene, colorHex: string, brightness: number, size: number,
  azimuthDeg: number, height: number, distance: number,
): void {
  const th = (azimuthDeg * Math.PI) / 180
  const x = Math.sin(th) * distance
  const z = Math.cos(th) * distance
  bar(s, 5 * size, 4 * size, 0.1, [x, height, z], th + Math.PI, 0,
    new THREE.Color(stripAlpha(colorHex)), Math.max(0, brightness))
}

/** Coloured void + two independently-placed gel panels + an optional white rim strip —
 *  the two-tone neon look, now fully parameterised (see GelEnvOptions). `exposure` scales
 *  every source; `stripAlpha` guards StudioColor's 8-digit #rrggbbaa (THREE.Color renders
 *  that as white). */
function colorGels(partial?: Partial<GelEnvOptions>): EnvScene {
  const o = resolveGel(partial)
  const s = new ProceduralEnv()
  s.background = new THREE.Color(stripAlpha(o.background))
  placeGel(s, o.colorA, o.brightnessA * o.exposure, o.sizeA, o.azimuthA, o.heightA, o.distanceA)
  placeGel(s, o.colorB, o.brightnessB * o.exposure, o.sizeB, o.azimuthB, o.heightB, o.distanceB)
  if (o.rim) {
    bar(s, 3, 0.3, 0.1, [0, 5.5, 2], 0, Math.PI / 2,
      new THREE.Color(stripAlpha(o.rimColor)), Math.max(0, o.rimBrightness * o.exposure))
  }
  return s
}

export function buildEnvironmentScene(kind: EnvironmentKind, gel?: Partial<GelEnvOptions>): EnvScene {
  switch (kind) {
    case 'darkStrips': return darkStrips()
    case 'softbox': return softbox()
    case 'colorGels': return colorGels(gel)
    case 'room': default: return new RoomEnvironment() as unknown as EnvScene
  }
}
