/**
 * The five one-click setups. Values are the mockup's (artifact 7rAD2Mu5a2S5d34kHU42iy).
 *
 * Since Frame light layers stage 2 a setup is a light arrangement around the photo — specs in
 * fractions of the photo's BOX (as the old Relight lights were), plus the Original light it
 * sets. `setupToLightLayers` (lib/frame/lighting/convertRelight) turns a setup into the
 * Frame's light layers through the photo's transform.
 */
import type { RelightLight } from './settings'

export type RelightSetupName = 'Window' | 'Golden key' | 'Rim' | 'Neon' | 'Under'
/** One light of a setup: x, y in fractions of the photo's box; height < 0 = behind (becomes 0
 *  as a Frame light); colour, brightness and reach as the old Relight light had them. */
export type RelightSetupLightSpec = Omit<RelightLight, 'id' | 'on'>
export interface RelightSetup { keep: number; lights: readonly RelightSetupLightSpec[] }

const SETUPS: Record<RelightSetupName, RelightSetup> = {
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

/** A setup's box-fraction light specs and Original light (a copy — callers may not mutate the table). */
export function relightSetup(name: RelightSetupName): RelightSetup {
  const s = SETUPS[name]
  return { keep: s.keep, lights: s.lights.map(l => ({ ...l })) }
}

export const isRelightSetupName = (v: unknown): v is RelightSetupName =>
  typeof v === 'string' && (RELIGHT_SETUP_NAMES as readonly string[]).includes(v)
