import { describe, it, expect } from 'vitest'
import { VIDEO_MODELS, VIDEO_MODELS_BY_ID } from '../../app/data/video-models'
import {
  modelSupportsSeed, allowedDurations, allowedAspectRatios, snapWidgetsToModel,
} from '../../app/lib/videoModelAdapt'

// Since Task S1b (fix round 1) the flag follows each model's published schema
// (tests/unit/fixtures/provider-schemas/), no longer Python's _maybe_set_seed
// calls. No seed input: Kling 2.5 Turbo and Kling 3, Fabric (lip-sync),
// Seedance 2.0 on fal, FLUX 3, Hailuo 2.3, Luma Ray 2 and Sora 2 / 2 Pro.
// Python still sends a seed to Kling 3, Hailuo 2.3, Luma, FLUX 3 and Sora; the
// runner doesn't, and the node no longer offers one.
const NO_SEED_IDS = [
  'kling-v2.5-turbo-pro', 'fabric-1.0', 'seedance-2.0',
  'kling-v3', 'hailuo-2.3', 'luma-ray-2-720p', 'flux-3', 'sora-2', 'sora-2-pro',
  // Task F4: google/gemini-omni-flash (both endpoints) has no seed field.
  'gemini-omni-flash',
]

describe('video-models supportsSeed flag', () => {
  it('every model declares a boolean supportsSeed', () => {
    for (const m of VIDEO_MODELS) {
      expect(typeof (m as any).supportsSeed, `${m.id} missing supportsSeed`).toBe('boolean')
    }
  })

  it('flags match the models\' published schemas', () => {
    for (const m of VIDEO_MODELS) {
      const expected = !NO_SEED_IDS.includes(m.id)
      expect((m as any).supportsSeed, m.id).toBe(expected)
    }
    for (const id of NO_SEED_IDS) {
      expect(VIDEO_MODELS_BY_ID[id], `${id} missing from registry`).toBeTruthy()
    }
  })
})

describe('videoModelAdapt', () => {
  it('modelSupportsSeed reads the flag; unknown/empty ids are permissive', () => {
    expect(modelSupportsSeed('veo-3.1')).toBe(true)
    expect(modelSupportsSeed('kling-v2.5-turbo-pro')).toBe(false)
    expect(modelSupportsSeed('fabric-1.0')).toBe(false)
    expect(modelSupportsSeed('does-not-exist')).toBe(true)
    expect(modelSupportsSeed('')).toBe(true)
  })

  it('allowedDurations returns the model durations as strings; unknown → every length but the runner-only ones', () => {
    expect(allowedDurations('veo-3.1'))
      .toEqual(VIDEO_MODELS_BY_ID['veo-3.1']!.durations.map(String))
    expect(allowedDurations('kling-v2.5-turbo-pro'))
      .toEqual(VIDEO_MODELS_BY_ID['kling-v2.5-turbo-pro']!.durations.map(String))
    // Unknown, empty or a legacy label: the engine's own lengths (Python's union), not Wan 3.0's 12, 25 and 30 s (F1 fix round 1).
    for (const id of ['does-not-exist', '', 'Veo 3']) {
      expect(allowedDurations(id), id).toEqual(['3', '4', '5', '6', '8', '9', '10', '15', '20', '60'])
    }
    expect(allowedDurations('wan-3.0')).toContain('30')
  })

  it('allowedAspectRatios returns the model ratios; unknown → null', () => {
    expect(allowedAspectRatios('veo-3.1')).toEqual(['16:9', '9:16'])
    expect(allowedAspectRatios('does-not-exist')).toBeNull()
  })

  it('snapWidgetsToModel corrects out-of-range duration and aspect', () => {
    const defs = [{ name: 'model' }, { name: 'duration' }, { name: 'aspect_ratio' }]
    const kling = VIDEO_MODELS_BY_ID['kling-v2.5-turbo-pro']!
    // '8' is Veo's duration (Kling is 5/10); the ratio is deliberately fake so
    // the test doesn't depend on Kling's exact AR list.
    const values = ['kling-v2.5-turbo-pro', '8', 'not-a-ratio']
    const fixes = snapWidgetsToModel(defs, values, 'kling-v2.5-turbo-pro')
    expect(fixes).toContainEqual({ name: 'duration', value: String(kling.defaultDuration) })
    const aspectFix = fixes.find(f => f.name === 'aspect_ratio')
    expect(aspectFix).toBeTruthy()
    expect(kling.aspectRatios).toContain(aspectFix!.value)
  })

  it('never snaps aspect to a placeholder non-ratio (fabric-1.0)', () => {
    const defs = [{ name: 'model' }, { name: 'duration' }, { name: 'aspect_ratio' }]
    // fabric-1.0's aspectRatios is ['matches image'] — not a real W:H ratio the
    // schema combo can display, so the aspect slot must be left alone.
    const fixes = snapWidgetsToModel(defs, ['fabric-1.0', '5', '16:9'], 'fabric-1.0')
    expect(fixes.find(f => f.name === 'aspect_ratio')).toBeUndefined()
  })

  it('snapWidgetsToModel leaves valid values alone and tolerates unknowns', () => {
    const defs = [{ name: 'model' }, { name: 'duration' }, { name: 'aspect_ratio' }]
    expect(snapWidgetsToModel(defs, ['veo-3.1', '8', '16:9'], 'veo-3.1')).toEqual([])
    expect(snapWidgetsToModel(defs, ['x', '8', '16:9'], 'does-not-exist')).toEqual([])
    expect(snapWidgetsToModel([], [], 'veo-3.1')).toEqual([])
  })
})
