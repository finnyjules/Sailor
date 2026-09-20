/**
 * Pure placement math for the ring layout: tile i of n → a transform, at loop
 * time t01. The whole ring spins one whole turn per loop (× speed as integer
 * turns handled by the effect's loopRates), so t01=0 and t01=1 coincide — the
 * loop is seamless by construction. No three.js here; the effect applies these
 * numbers to meshes.
 */

export interface RingParams {
  radius: number
  ringTilt: number     // radians, ring-plane tilt about X (applied by the effect to the group)
  cardSize: number
  speed: number        // turns per loop; a fraction closes over several loops (the effect's loopRates reports it)
  direction: 1 | -1
}

export interface TileTransform {
  x: number; y: number; z: number
  rotY: number         // radians; quad normal faces radially outward
  scale: number
  // Optional, so the four original layouts (and ring parity) are untouched. The host
  // applies the three angles in 'YXZ' order — yaw, then pitch, then roll in the card's
  // own plane — which is what "face outward on a sphere" and "fan out like a hand of
  // cards" both need. `opacity` (0…1) multiplies the back fade; layouts that wrap a card
  // from one end of a path to the other use it to hide the jump.
  rotX?: number
  rotZ?: number
  opacity?: number
}

export function ringTransform(i: number, n: number, p: RingParams, t01: number): TileTransform {
  // Negative winding: tiles advance CLOCKWISE so a content sequence (e.g. the
  // letters of a word) reads in order around the ring instead of reversed.
  const base = -(2 * Math.PI * i) / Math.max(1, n)
  const spin = p.direction * 2 * Math.PI * p.speed * t01
  const ang = base + spin
  const x = Math.cos(ang) * p.radius
  const z = Math.sin(ang) * p.radius
  // face radially outward: a quad whose default normal is +Z is turned by -ang
  // (plus a quarter turn so its face, not its edge, points out).
  let rotY = -ang + Math.PI / 2
  // Normalize to [-π, π] for seamless looping: t01=0 and t01=1 produce identical rotY
  rotY = Math.atan2(Math.sin(rotY), Math.cos(rotY))
  return { x, y: 0, z, rotY, scale: p.cardSize }
}

export interface BentOffset { tangent: number; inward: number }

/** Map a card point at tangential offset `s` (from the card centre) onto the ring
 *  arc of radius `R`, at bend factor `bend` (0 flat, 1 fully wrapped). Pure. */
export function bentOffset(s: number, R: number, bend: number): BentOffset {
  if (R <= 0) return { tangent: s, inward: 0 }
  const phi = s / R
  const tangentArc = R * Math.sin(phi)
  const inwardArc = R * (1 - Math.cos(phi))
  return {
    tangent: s + (tangentArc - s) * bend,
    inward: inwardArc * bend,
  }
}
