import { describe, it, expect } from 'vitest'
import { createDefaultShotSheet, type Ref, type ShotSheet } from '../../app/lib/shotdirector/types'
import {
  SEEDANCE_PROFILE,
  KLING_V3_PROFILE,
  VEO_31_PROFILE,
  VEO_31_FAST_PROFILE,
  SHOT_MODEL_CHOICES,
  getProfile,
  clampDuration,
} from '../../app/lib/shotdirector/profiles'
import type { IdentityRefSet } from '../../shared/characters/types'

const img = (slot: number): Ref => ({ kind: 'image', slot, src: `img${slot}`, role: 'identity-lock' })
const vid = (slot: number): Ref => ({ kind: 'video', slot, src: `vid${slot}`, role: 'camera-copy' })
const aud = (slot: number): Ref => ({ kind: 'audio', slot, src: `aud${slot}`, role: 'mood' })

describe('SEEDANCE_PROFILE', () => {
  it('declares the real Replicate capacities and word budget', () => {
    expect(SEEDANCE_PROFILE.maxRefImages).toBe(9)
    expect(SEEDANCE_PROFILE.maxRefVideos).toBe(3)
    expect(SEEDANCE_PROFILE.maxRefAudios).toBe(3)
    expect(SEEDANCE_PROFILE.wordBudgetWarn).toBe(100)
    expect(SEEDANCE_PROFILE.wordBudgetHard).toBe(600)
  })

  it('tags references with @ grammar (fal)', () => {
    expect(SEEDANCE_PROFILE.refTag('image', 1)).toBe('@Image1')
    expect(SEEDANCE_PROFILE.refTag('video', 2)).toBe('@Video2')
    expect(SEEDANCE_PROFILE.refTag('audio', 3)).toBe('@Audio3')
  })

  it('buildInput maps reference-mode arrays sorted by slot and sets format', () => {
    const s = createDefaultShotSheet()
    s.format = { aspectRatio: '9:16', durationS: 10, resolution: '720p', seed: 42 }
    s.references = [img(2), img(1), vid(1), aud(1)]
    const input = SEEDANCE_PROFILE.buildInput(s, 'PROMPT')
    expect(input).toEqual({
      prompt: 'PROMPT',
      duration: 10,
      resolution: '720p',
      aspect_ratio: '9:16',
      image_urls: ['img1', 'img2'],
      video_urls: ['vid1'],
      audio_urls: ['aud1'],
      generate_audio: true,
    })
  })

  it('buildInput maps first/last-frame mode and omits aspect_ratio + refs', () => {
    const s = createDefaultShotSheet()
    s.mode = 'firstLastFrame'
    s.firstFrame = 'FIRST'
    s.lastFrame = 'LAST'
    s.audio.generate = false
    const input = SEEDANCE_PROFILE.buildInput(s, 'PROMPT')
    expect(input).toEqual({
      prompt: 'PROMPT',
      duration: 5,
      resolution: '1080p',
      image_url: 'FIRST',
      end_image_url: 'LAST',
      generate_audio: false,
    })
  })

  it('getProfile falls back to Seedance for unknown ids', () => {
    expect(getProfile('does-not-exist').id).toBe('seedance-2.0')
    expect(getProfile('seedance-2.0')).toBe(SEEDANCE_PROFILE)
  })
})

describe('SEEDANCE_PROFILE fal shape', () => {
  it('tags references with @Image (fal), not [Image]', () => {
    expect(SEEDANCE_PROFILE.refTag('image', 1)).toBe('@Image1')
    expect(SEEDANCE_PROFILE.refTag('video', 2)).toBe('@Video2')
    expect(SEEDANCE_PROFILE.refTag('audio', 3)).toBe('@Audio3')
  })

  it('emits fal image_urls and no seed in reference mode', () => {
    const sheet = {
      mode: 'reference',
      references: [
        { kind: 'image', slot: 1, src: 'https://x/a.png', role: 'identity' },
        { kind: 'image', slot: 2, src: 'https://x/b.png', role: 'identity' },
      ],
      audio: { generate: true, dialogue: [] },
      format: { aspectRatio: '16:9', durationS: 5, resolution: '720p', seed: 42 },
    } as unknown as ShotSheet
    const input = SEEDANCE_PROFILE.buildInput(sheet, 'p')
    expect(input.image_urls).toEqual(['https://x/a.png', 'https://x/b.png'])
    expect(input.reference_images).toBeUndefined()
    expect(input.seed).toBeUndefined()
    expect(input.generate_audio).toBe(true)
  })

  it('emits image_url/end_image_url in firstLastFrame mode', () => {
    const sheet = {
      mode: 'firstLastFrame',
      references: [],
      firstFrame: 'https://x/first.png',
      lastFrame: 'https://x/last.png',
      audio: { generate: false, dialogue: [] },
      format: { aspectRatio: '16:9', durationS: 5, resolution: '720p', seed: 0 },
    } as unknown as ShotSheet
    const input = SEEDANCE_PROFILE.buildInput(sheet, 'p')
    expect(input.image_url).toBe('https://x/first.png')
    expect(input.end_image_url).toBe('https://x/last.png')
    expect(input.image).toBeUndefined()
  })

  it('pickCastRefs prefers portrait over front, then bodyFront, no nulls', () => {
    const full: IdentityRefSet = { name: 'Cal', front: 'F', portrait: 'P', bodyFront: 'BF', bodyBack: 'BB' }
    expect(SEEDANCE_PROFILE.pickCastRefs(full)).toEqual(['P', 'BF'])
    const frontOnly: IdentityRefSet = { name: 'Cal', front: 'F', portrait: null, bodyFront: null, bodyBack: null }
    expect(SEEDANCE_PROFILE.pickCastRefs(frontOnly)).toEqual(['F'])
  })

  it('declares the new cast/frame capability fields', () => {
    expect(SEEDANCE_PROFILE.castMode).toBe('images')
    expect(SEEDANCE_PROFILE.castRefCap).toBe(2)
    expect(SEEDANCE_PROFILE.supportsLastFrame).toBe(true)
    expect(SEEDANCE_PROFILE.requiresFirstFrame).toBe(false)
    expect(SEEDANCE_PROFILE.refsWithFirstFrame).toBe(false)
  })
})

describe('KLING_V3_PROFILE', () => {
  it('declares elements-mode capabilities', () => {
    expect(KLING_V3_PROFILE.id).toBe('kling-v3')
    expect(KLING_V3_PROFILE.label).toBe('Kling 3')
    expect(KLING_V3_PROFILE.castMode).toBe('elements')
    expect(KLING_V3_PROFILE.castRefCap).toBe(4)
    expect(KLING_V3_PROFILE.maxRefImages).toBe(0)
    expect(KLING_V3_PROFILE.maxRefVideos).toBe(0)
    expect(KLING_V3_PROFILE.maxRefAudios).toBe(0)
    expect(KLING_V3_PROFILE.supportsFirstLastFrame).toBe(true)
    expect(KLING_V3_PROFILE.supportsLastFrame).toBe(true)
    expect(KLING_V3_PROFILE.requiresFirstFrame).toBe(true)
    expect(KLING_V3_PROFILE.refsWithFirstFrame).toBe(true)
    expect(KLING_V3_PROFILE.wordBudgetWarn).toBe(400)
    expect(KLING_V3_PROFILE.wordBudgetHard).toBe(2500)
  })

  it('tags elements with @Element grammar', () => {
    expect(KLING_V3_PROFILE.refTag('image', 2)).toBe('@Element2')
  })

  it('buildInput requires a first frame, includes an optional end frame, and wires cast elements in order', () => {
    const s = createDefaultShotSheet()
    s.mode = 'firstLastFrame'
    s.firstFrame = 'START'
    s.lastFrame = 'END'
    s.format = { aspectRatio: '16:9', durationS: 8, resolution: '1080p' }
    s.audio.generate = true
    const cast = [
      { slug: 'cal', front: 'cal-front', refs: ['cal-portrait', 'cal-body-front'] },
      { slug: 'zoe', front: 'zoe-front', refs: ['zoe-portrait'] },
    ]
    const input = KLING_V3_PROFILE.buildInput(s, 'PROMPT', cast)
    expect(input).toEqual({
      prompt: 'PROMPT',
      duration: 8,
      generate_audio: true,
      image_url: 'START',
      end_image_url: 'END',
      elements: [
        { frontal_image_url: 'cal-front', reference_image_urls: ['cal-portrait', 'cal-body-front'] },
        { frontal_image_url: 'zoe-front', reference_image_urls: ['zoe-portrait'] },
      ],
    })
  })

  it('buildInput omits end_image_url and elements when absent', () => {
    const s = createDefaultShotSheet()
    s.mode = 'firstLastFrame'
    s.firstFrame = 'START'
    s.format = { aspectRatio: '16:9', durationS: 5, resolution: '1080p' }
    s.audio.generate = false
    const input = KLING_V3_PROFILE.buildInput(s, 'PROMPT')
    expect(input).toEqual({
      prompt: 'PROMPT',
      duration: 5,
      generate_audio: false,
      image_url: 'START',
    })
  })
})

describe('VEO_31_PROFILE / VEO_31_FAST_PROFILE', () => {
  it('declare images-mode capabilities with no last-frame support', () => {
    for (const profile of [VEO_31_PROFILE, VEO_31_FAST_PROFILE]) {
      expect(profile.castMode).toBe('images')
      expect(profile.castRefCap).toBe(3)
      expect(profile.maxRefImages).toBe(3)
      expect(profile.maxRefVideos).toBe(0)
      expect(profile.maxRefAudios).toBe(0)
      expect(profile.supportsLastFrame).toBe(false)
      expect(profile.requiresFirstFrame).toBe(false)
      expect(profile.refsWithFirstFrame).toBe(false)
      expect(profile.wordBudgetWarn).toBe(150)
      expect(profile.wordBudgetHard).toBe(1000)
    }
    expect(VEO_31_PROFILE.id).toBe('veo-3.1')
    expect(VEO_31_PROFILE.label).toBe('Veo 3.1')
    expect(VEO_31_FAST_PROFILE.id).toBe('veo-3.1-fast')
    expect(VEO_31_FAST_PROFILE.label).toBe('Veo 3.1 Fast')
  })

  it('pickCastRefs orders front, portrait, bodyFront with no nulls', () => {
    const full: IdentityRefSet = { name: 'Cal', front: 'F', portrait: 'P', bodyFront: 'BF', bodyBack: 'BB' }
    expect(VEO_31_PROFILE.pickCastRefs(full)).toEqual(['F', 'P', 'BF'])
    const frontOnly: IdentityRefSet = { name: 'Cal', front: 'F', portrait: null, bodyFront: null, bodyBack: null }
    expect(VEO_31_PROFILE.pickCastRefs(frontOnly)).toEqual(['F'])
  })

  it('tags references as "image N"', () => {
    expect(VEO_31_PROFILE.refTag('image', 3)).toBe('image 3')
  })

  it('buildInput in reference mode emits image_urls in slot order, no last frame key', () => {
    const s = createDefaultShotSheet()
    s.format = { aspectRatio: '9:16', durationS: 8, resolution: '720p' }
    s.references = [img(2), img(1)]
    const input = VEO_31_PROFILE.buildInput(s, 'PROMPT')
    expect(input).toEqual({
      prompt: 'PROMPT',
      aspect_ratio: '9:16',
      image_urls: ['img1', 'img2'],
      resolution: '720p',
      generate_audio: true,
    })
  })

  it('buildInput with a first frame emits image_url, no aspect_ratio or image_urls', () => {
    const s = createDefaultShotSheet()
    s.mode = 'firstLastFrame'
    s.firstFrame = 'FIRST'
    s.format = { aspectRatio: '16:9', durationS: 8, resolution: '1080p' }
    const input = VEO_31_FAST_PROFILE.buildInput(s, 'PROMPT')
    expect(input).toEqual({
      prompt: 'PROMPT',
      image_url: 'FIRST',
      resolution: '1080p',
      generate_audio: true,
    })
  })
})

describe('SHOT_MODEL_CHOICES', () => {
  it('lists the four selectable models in sentence case, leaving out the stub', () => {
    expect(SHOT_MODEL_CHOICES).toEqual([
      { id: 'seedance-2.0', label: 'Seedance 2.0' },
      { id: 'kling-v3', label: 'Kling 3' },
      { id: 'veo-3.1', label: 'Veo 3.1' },
      { id: 'veo-3.1-fast', label: 'Veo 3.1 Fast' },
    ])
  })
})

describe('getProfile', () => {
  it('resolves kling-v3', () => {
    expect(getProfile('kling-v3')).toBe(KLING_V3_PROFILE)
  })
})

describe('durations / clampDuration', () => {
  it('declares each model\'s allowed clip lengths', () => {
    expect(SEEDANCE_PROFILE.durations).toBeNull()
    expect(KLING_V3_PROFILE.durations).toEqual([5, 10, 15])
    expect(VEO_31_PROFILE.durations).toEqual([8])
    expect(VEO_31_FAST_PROFILE.durations).toEqual([8])
  })

  it('passes seconds through unchanged for an unclamped (null) profile', () => {
    expect(clampDuration(SEEDANCE_PROFILE, 7)).toBe(7)
    expect(clampDuration(SEEDANCE_PROFILE, 13)).toBe(13)
  })

  it('maps <= 0 to the dispatch default (5) for an unclamped profile', () => {
    expect(clampDuration(SEEDANCE_PROFILE, -1)).toBe(5)
    expect(clampDuration(SEEDANCE_PROFILE, 0)).toBe(5)
  })

  it('maps <= 0 to the first allowed value for a clamped profile', () => {
    expect(clampDuration(KLING_V3_PROFILE, -1)).toBe(5)
    expect(clampDuration(VEO_31_PROFILE, 0)).toBe(8)
  })

  it('rounds to the nearest allowed value, the larger one on a tie', () => {
    expect(clampDuration(KLING_V3_PROFILE, 7)).toBe(5) // |7-5|=2 < |7-10|=3
    expect(clampDuration(KLING_V3_PROFILE, 8)).toBe(10) // tie (both 2 away) -> larger
    expect(clampDuration(KLING_V3_PROFILE, 20)).toBe(15)
  })

  it('always returns the single allowed value for a one-option profile (Veo)', () => {
    expect(clampDuration(VEO_31_PROFILE, 3)).toBe(8)
    expect(clampDuration(VEO_31_PROFILE, 100)).toBe(8)
  })
})
