import { describe, it, expect } from 'vitest'
import {
  FLOOR_MODES, floorVisibility, cinematicFloorVisible,
  cinematicFloorRoughness, migrateFloorMode,
} from '~/lib/scene3d/floor'

describe('floorVisibility', () => {
  it('off shows nothing', () => {
    expect(floorVisibility('off')).toEqual({ grid: false, shadow: false, reflector: false })
  })
  it('shadow keeps today’s grid + catcher', () => {
    expect(floorVisibility('shadow')).toEqual({ grid: true, shadow: true, reflector: false })
  })
  it('reflection keeps grounding under the reflector', () => {
    expect(floorVisibility('reflection')).toEqual({ grid: true, shadow: true, reflector: true })
  })
  it('polished is a clean reflective surface (no grid/catcher)', () => {
    expect(floorVisibility('polished')).toEqual({ grid: false, shadow: false, reflector: true })
  })
})

describe('cinematic mapping', () => {
  it('floor hidden only when off', () => {
    expect(cinematicFloorVisible('off')).toBe(false)
    expect(cinematicFloorVisible('shadow')).toBe(true)
    expect(cinematicFloorVisible('reflection')).toBe(true)
  })
  it('shadow is matte; reflection/polished glossier as reflectivity rises', () => {
    expect(cinematicFloorRoughness('shadow', 1)).toBeCloseTo(0.5)
    expect(cinematicFloorRoughness('reflection', 0)).toBeCloseTo(0.5)
    expect(cinematicFloorRoughness('reflection', 1)).toBeCloseTo(0.05)
    expect(cinematicFloorRoughness('polished', 1)).toBeCloseTo(0.05)
  })
  it('clamps reflectivity out of range', () => {
    expect(cinematicFloorRoughness('reflection', 2)).toBeCloseTo(0.05)
    expect(cinematicFloorRoughness('reflection', -1)).toBeCloseTo(0.5)
  })
})

describe('migrateFloorMode', () => {
  it('honours an explicit floorMode', () => {
    expect(migrateFloorMode({ floorMode: 'polished' })).toBe('polished')
  })
  it('legacy showFloor:false → off', () => {
    expect(migrateFloorMode({ showFloor: false })).toBe('off')
  })
  it('legacy showFloor:true or absent → shadow', () => {
    expect(migrateFloorMode({ showFloor: true })).toBe('shadow')
    expect(migrateFloorMode({})).toBe('shadow')
  })
  it('rejects a garbage floorMode, falling back through showFloor', () => {
    expect(migrateFloorMode({ floorMode: 'nope', showFloor: false })).toBe('off')
  })
  it('has four modes', () => {
    expect(FLOOR_MODES.length).toBe(4)
  })
})
