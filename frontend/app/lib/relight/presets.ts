/** The five one-click setups. Values are the mockup's (artifact 7rAD2Mu5a2S5d34kHU42iy). */
import { newLightId, type RelightEffect, type RelightLight } from './settings'

export type RelightSetupName = 'Window' | 'Golden key' | 'Rim' | 'Neon' | 'Under'
type LightSpec = Omit<RelightLight, 'id' | 'on'>

const SETUPS: Record<RelightSetupName, { keep: number; lights: LightSpec[] }> = {
  'Window': { keep: 0.3, lights: [{ x: -0.05, y: 0.25, height: 0.3, color: '#fff1dc', brightness: 1.8, reach: 1.2 }] },
  'Golden key': { keep: 0.12, lights: [{ x: 0.85, y: 0.3, height: 0.4, color: '#ffcf94', brightness: 3.2, reach: 1.4 }] },
  'Rim': { keep: 0.2, lights: [
    { x: 0.95, y: 0.2, height: -0.05, color: '#bcd8ff', brightness: 2.6, reach: 0.8 },
    { x: 0.15, y: 0.4, height: 0.4, color: '#ffe2c0', brightness: 0.6, reach: 1.2 },
  ] },
  'Neon': { keep: 0.15, lights: [
    { x: 0.05, y: 0.5, height: 0.35, color: '#ff3fb4', brightness: 2.2, reach: 0.8 },
    { x: 0.95, y: 0.45, height: 0.35, color: '#29d8ff', brightness: 2.2, reach: 0.8 },
  ] },
  'Under': { keep: 0.2, lights: [{ x: 0.5, y: 1.05, height: 0.25, color: '#ffb36b', brightness: 2.2, reach: 0.9 }] },
}

export const RELIGHT_SETUP_NAMES: readonly RelightSetupName[] = ['Window', 'Golden key', 'Rim', 'Neon', 'Under']

/** Replaces the lights and Original light; the photo controls (Depth, Texture, Shine, Shadows) stay. */
export function applySetup(fx: RelightEffect, name: RelightSetupName): RelightEffect {
  const s = SETUPS[name]
  return { ...fx, keep: s.keep, lights: s.lights.map(l => ({ ...l, id: newLightId(), on: true })) }
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-3

/** The setup these settings still match exactly (ids ignored), or null once anything moved. */
export function setupOf(fx: RelightEffect): RelightSetupName | null {
  for (const name of RELIGHT_SETUP_NAMES) {
    const s = SETUPS[name]
    if (!close(fx.keep, s.keep) || fx.lights.length !== s.lights.length) continue
    const same = s.lights.every((l, i) => {
      const f = fx.lights[i]!
      return f.on && close(f.x, l.x) && close(f.y, l.y) && close(f.height, l.height)
        && f.color === l.color && close(f.brightness, l.brightness) && close(f.reach, l.reach)
    })
    if (same) return name
  }
  return null
}
