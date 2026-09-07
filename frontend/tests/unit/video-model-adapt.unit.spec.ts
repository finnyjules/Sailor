import { describe, it, expect } from 'vitest'
import { VIDEO_MODELS, VIDEO_MODELS_BY_ID } from '../../app/data/video-models'
import {
  modelSupportsSeed, allowedDurations, allowedAspectRatios, snapWidgetsToModel,
} from '../../app/lib/videoModelAdapt'

// Audit of comfy_api_nodes/video_models.py: every builder calls _maybe_set_seed
// except _b_kling_v2_5_turbo_pro (Replicate 422s on seed), _b_fabric_1_0 (lip-sync,
// no seed input), and _b_seedance_2_0 (moved to fal 2026-07-02 — fal Seedance has
// no seed input; seedance-2.0-fast stays on Replicate and keeps its seed).
const NO_SEED_IDS = ['kling-v2.5-turbo-pro', 'fabric-1.0', 'seedance-2.0']

describe('video-models supportsSeed flag', () => {
  it('every model declares a boolean supportsSeed', () => {
    for (const m of VIDEO_MODELS) {
      expect(typeof (m as any).supportsSeed, `${m.id} missing supportsSeed`).toBe('boolean')
    }
  })

  it('flags match the Python builder audit', () => {
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

  it('allowedDurations returns the model durations as strings; unknown → null', () => {
    expect(allowedDurations('veo-3.1'))
      .toEqual(VIDEO_MODELS_BY_ID['veo-3.1']!.durations.map(String))
    expect(allowedDurations('kling-v2.5-turbo-pro'))
      .toEqual(VIDEO_MODELS_BY_ID['kling-v2.5-turbo-pro']!.durations.map(String))
    expect(allowedDurations('does-not-exist')).toBeNull()
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
