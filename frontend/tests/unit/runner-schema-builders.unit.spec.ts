/**
 * Task S1b: the runner's request builders follow the providers' published
 * schemas (tests/unit/fixtures/provider-schemas/), not Python parity.
 *
 *  1. Every value the node's own menus can set (each select option, each
 *     numeric control's ends, each ratio, length and resolution) builds a
 *     request the model's saved schema takes.
 *  2. The settings Python sends under names the schema doesn't have reach
 *     the model under its own names (PixVerse, Wan, LTX, Sora, Flux 2 Dev,
 *     Flux Fast), and fields the schema lacks are not sent.
 */
import { describe, expect, it } from 'vitest'
import { RUNNER_IMAGE_MODELS, RUNNER_REPLICATE_IMAGE_MODELS, imageAppFor } from '~~/server/runner/generators/image'
import { RUNNER_REPLICATE_VIDEO_MODELS, RUNNER_VIDEO_MODELS, falVideoFn } from '~~/server/runner/generators/video'
import { IMAGE_EDIT_MODELS } from '~~/server/runner/generators/refEdits'
import { IMAGE_MODELS_BY_ID } from '~~/app/data/image-models'
import { VIDEO_MODELS_BY_ID } from '~~/app/data/video-models'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'

type Adv = Record<string, unknown>

/** Every value a catalogue control can hold: its default, each option, each end of its range. */
function controlValues(fields: { name: string, type: string, default: unknown, options?: string[], min?: number, max?: number }[]): Adv[] {
  const out: Adv[] = [{}]
  for (const f of fields) {
    const values = new Set<unknown>([f.default, ...(f.options ?? [])])
    if (f.min !== undefined) values.add(f.min)
    if (f.max !== undefined) values.add(f.max)
    if (f.type === 'boolean') { values.add(true); values.add(false) }
    for (const v of values) out.push({ [f.name]: v })
  }
  return out
}

const errorsFor = (provider: 'fal' | 'replicate', endpoint: string, payload: Record<string, unknown>) =>
  checkPayload(loadProviderSchema(provider, endpoint), payload)

describe('every value the node\'s menus can set builds a request the model\'s schema takes', () => {
  it('fal Generate image', () => {
    let n = 0
    for (const d of Object.values(RUNNER_IMAGE_MODELS)) {
      const cat = IMAGE_MODELS_BY_ID[d.id]!
      for (const ar of cat.aspectRatios) {
        for (const adv of controlValues(cat.advanced)) {
          for (const refs of d.refsApp ? [null, ['https://fal.test/a.png']] : [null]) {
            const p = d.build({ prompt: 'a red fox', aspectRatio: ar, seed: 7, adv, refs })
            expect(errorsFor('fal', imageAppFor(d, refs), p), `${d.id} ${ar} ${JSON.stringify(adv)}`).toEqual([])
            n++
          }
        }
      }
    }
    expect(n).toBeGreaterThan(100)
  })

  it('Replicate Generate image', () => {
    let n = 0
    for (const d of Object.values(RUNNER_REPLICATE_IMAGE_MODELS)) {
      const cat = IMAGE_MODELS_BY_ID[d.id]!
      for (const ar of cat.aspectRatios) {
        for (const adv of controlValues(cat.advanced)) {
          for (const seed of [0, 7, 4294967295]) {
            const p = d.build({ prompt: 'a red fox', aspectRatio: ar, seed, adv, refs: null })
            expect(errorsFor('replicate', d.slug, p), `${d.id} ${ar} ${JSON.stringify(adv)} seed ${seed}`).toEqual([])
            n++
          }
        }
      }
    }
    expect(n).toBeGreaterThan(1000)
  })

  it('Generate a video, fal and Replicate', () => {
    let n = 0
    const all = [
      ...Object.values(RUNNER_VIDEO_MODELS).map(d => ({ d, modes: ['t2v', 'i2v'], endpoint: (p: Record<string, unknown>) => { const fn = falVideoFn(p, d.fnByMode); return ['fal', fn ? `${d.app}/${fn}` : d.app] as const } })),
      ...Object.values(RUNNER_REPLICATE_VIDEO_MODELS).map(d => ({ d, modes: [...d.modes], endpoint: () => ['replicate', d.slug] as const })),
    ]
    for (const { d, modes, endpoint } of all) {
      const cat = VIDEO_MODELS_BY_ID[d.id]!
      const options = [
        ...controlValues(cat.advanced),
        ...(cat.resolutions ?? []).map(resolution => ({ resolution })),
      ]
      for (const ar of cat.aspectRatios) {
        for (const duration of cat.durations) {
          for (const adv of options) {
            for (const image of [modes.includes('t2v') ? null : undefined, modes.includes('i2v') ? 'https://fal.test/first.png' : undefined]) {
              if (image === undefined) continue
              const p = d.build({ prompt: 'a wave', aspectRatio: ar, duration, seed: 7, image, adv })
              const [provider, ep] = endpoint(p)
              expect(errorsFor(provider, ep, p), `${d.id} ${ar} ${duration}s ${JSON.stringify(adv)} ${image ? 'i2v' : 't2v'}`).toEqual([])
              n++
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(300)
  })
})

describe('settings reach each model under its own schema\'s names', () => {
  const vid = (id: string, adv: Adv = {}, o: { duration?: number, ar?: string, image?: string | null, seed?: number } = {}) => {
    const d = RUNNER_REPLICATE_VIDEO_MODELS[id] ?? RUNNER_VIDEO_MODELS[id]!
    return d.build({ prompt: 'a wave', aspectRatio: o.ar ?? '16:9', duration: o.duration ?? d.defaultDuration, seed: o.seed ?? 7, image: o.image ?? null, adv })
  }

  it('PixVerse v6: resolution → quality, sound → generate_audio_switch (on by default); no style', () => {
    expect(vid('pixverse-v6')).toEqual({ prompt: 'a wave', aspect_ratio: '16:9', duration: 5, quality: '720p', generate_audio_switch: true, seed: 7 })
    const p = vid('pixverse-v6', { resolution: '1080P', generate_audio: false, style: 'anime' })
    expect(p).toMatchObject({ quality: '1080p', generate_audio_switch: false })
    expect(p).not.toHaveProperty('style')
    expect(p).not.toHaveProperty('resolution')
    expect(p).not.toHaveProperty('generate_audio')
    expect(vid('pixverse-v6', { resolution: '4k' }).quality).toBe('720p')
  })

  it('Wan 2.5 I2V Fast: 720p by default, the length as `duration`, no ratio', () => {
    const p = vid('wan-2.5-i2v-fast', {}, { image: 'https://fal.test/f.png' })
    expect(p).toEqual({ prompt: 'a wave', image: 'https://fal.test/f.png', resolution: '720p', duration: 5, seed: 7 })
    expect(vid('wan-2.5-i2v-fast', { resolution: '480p' }, { image: 'u' }).resolution).toBe('720p')
    expect(vid('wan-2.5-i2v-fast', { resolution: '1080p' }, { image: 'u', duration: 10 })).toMatchObject({ resolution: '1080p', duration: 10 })
  })

  it('Wan 2.7 T2V: the length as `duration` (2–15 s), not num_frames; 480p sent as 720p', () => {
    const p = vid('wan-2.7-t2v', { num_frames: 121, resolution: '480p' }, { duration: 12 })
    expect(p).toMatchObject({ duration: 12, resolution: '720p' })
    expect(p).not.toHaveProperty('num_frames')
    expect(vid('wan-2.7-t2v', {}, { duration: 30 }).duration).toBe(15)
    expect(vid('wan-2.7-t2v', {}, { duration: 1 }).duration).toBe(2)
  })

  it('LTX-Video: guidance → cfg (1–20), steps → steps (1–50)', () => {
    const p = vid('ltx-video', { guidance_scale: 4.5, num_inference_steps: 40 })
    expect(p).toMatchObject({ cfg: 4.5, steps: 40 })
    expect(p).not.toHaveProperty('guidance_scale')
    expect(p).not.toHaveProperty('num_inference_steps')
    expect(vid('ltx-video')).toMatchObject({ cfg: 3, steps: 30 })
    expect(vid('ltx-video', { guidance_scale: 0.2, num_inference_steps: 99 })).toMatchObject({ cfg: 1, steps: 50 })
  })

  it('Sora 2 / 2 Pro: `seconds` 4, 8 or 12 and an orientation; no seed', () => {
    for (const id of ['sora-2', 'sora-2-pro']) {
      expect(vid(id, {}, { duration: 5 })).toEqual({ prompt: 'a wave', aspect_ratio: 'landscape', seconds: 4 })
      expect(vid(id, {}, { duration: 10, ar: '9:16' })).toEqual({ prompt: 'a wave', aspect_ratio: 'portrait', seconds: 8 })
      expect(vid(id, {}, { duration: 12, ar: '1:1' }).seconds).toBe(12)
    }
  })

  it('Seedance 2.0 Fast: 1080p (above its top option) is sent as 720p; no camera_fixed', () => {
    const p = vid('seedance-2.0-fast', { resolution: '1080p', camera_fixed: true })
    expect(p.resolution).toBe('720p')
    expect(p).not.toHaveProperty('camera_fixed')
    expect(vid('seedance-2.0-fast', { resolution: '480p' }).resolution).toBe('480p')
  })

  it('fields a model\'s schema lacks are not sent: Kling 3 cfg_scale and seed, Runway motion, Hailuo 2.3 ratio and seed, Luma seed, FLUX 3 seed', () => {
    const kling = vid('kling-v3', { cfg_scale: 0.8 })
    expect(kling).not.toHaveProperty('cfg_scale')
    expect(kling).not.toHaveProperty('seed')
    expect(vid('runway-gen-4.5', { motion: 9 })).not.toHaveProperty('motion')
    expect(vid('runway-gen-4.5').seed).toBe(7)
    const hailuo = vid('hailuo-2.3', { resolution: '2k' })
    expect(hailuo).not.toHaveProperty('aspect_ratio')
    expect(hailuo).not.toHaveProperty('seed')
    expect(hailuo.resolution).toBe('768p')
    expect(vid('luma-ray-2-720p')).not.toHaveProperty('seed')
    expect(vid('flux-3')).not.toHaveProperty('seed')
    expect(vid('flux-3', {}, { image: 'u' })).not.toHaveProperty('seed')
  })

  it('fal video resolutions: each model\'s own list, lower-cased; H3 Max takes 1080P but not 2K', () => {
    expect(vid('veo-3.1', { resolution: '4K' }).resolution).toBe('4k')
    expect(vid('veo-3.1', { resolution: '8k' }).resolution).toBe('720p')
    expect(vid('flux-3', { resolution: '4k' }).resolution).toBe('720p')
    expect(vid('seedance-2.0', { resolution: '1080P' }).resolution).toBe('1080p')
    expect(vid('hailuo-h3', { resolution: '2k' }).resolution).toBe('2K')
    expect(vid('hailuo-h3-max', { resolution: '1080p' }).resolution).toBe('1080P')
    expect(vid('hailuo-h3-max', { resolution: '2k' }).resolution).toBe('768P')
  })

  const img = (id: string, adv: Adv = {}, o: { ar?: string, seed?: number } = {}) => {
    const d = RUNNER_REPLICATE_IMAGE_MODELS[id] ?? RUNNER_IMAGE_MODELS[id]!
    return d.build({ prompt: 'a red fox', aspectRatio: o.ar ?? '1:1', seed: o.seed ?? 7, adv, refs: null })
  }

  it('fal Flux 1.1 Pro and Schnell: jpg is sent as jpeg; webp (not in the schema) as png', () => {
    for (const id of ['flux-1.1-pro', 'flux-schnell']) {
      expect(img(id, { output_format: 'jpg' }).output_format).toBe('jpeg')
      expect(img(id, { output_format: 'webp' }).output_format).toBe('png')
      expect(img(id).output_format).toBe('png')
      expect(IMAGE_MODELS_BY_ID[id]!.advanced.find(f => f.name === 'output_format')!.options).toEqual(['png', 'jpg'])
    }
    expect(img('flux-schnell', { num_inference_steps: 20 }).num_inference_steps).toBe(12)
  })

  it('Nano Banana Pro text-to-image goes to fal-ai/nano-banana-pro, fal\'s documented app', () => {
    expect(RUNNER_IMAGE_MODELS['nano-banana-pro']!.app).toBe('fal-ai/nano-banana-pro')
    expect(img('nano-banana-pro', { output_format: 'jpg' }).output_format).toBe('jpeg')
    expect(img('nano-banana-pro', { output_format: 'gif' }).output_format).toBe('png')
  })

  it('Flux 2 Dev: the resolution label and ratio as width × height (multiples of 32, ≤ 1440), aspect_ratio "custom"', () => {
    expect(img('flux-2-dev')).toEqual({ prompt: 'a red fox', aspect_ratio: 'custom', width: 1024, height: 1024, output_format: 'webp', output_quality: 90, seed: 7 })
    expect(img('flux-2-dev', { resolution: '1 MP' }, { ar: '16:9' })).toMatchObject({ width: 1376, height: 768 })
    expect(img('flux-2-dev', { resolution: '4 MP' })).toMatchObject({ width: 1440, height: 1440 })
    expect(img('flux-2-dev', { resolution: '4 MP' }, { ar: '4:5' })).toMatchObject({ width: 1152, height: 1440 })
    const p = img('flux-2-dev', { resolution: '2 MP', steps: 50, guidance: 5, safety_tolerance: 3, prompt_upsampling: false })
    for (const k of ['resolution', 'steps', 'guidance', 'safety_tolerance', 'prompt_upsampling']) expect(p, k).not.toHaveProperty(k)
  })

  it('Flux Fast: the menu\'s short speed names are sent as the schema\'s full values', () => {
    expect(img('flux-fast').speed_mode).toBe('Extra Juiced 🔥 (more speed)')
    expect(img('flux-fast', { speed_mode: 'Juiced' }).speed_mode).toBe('Juiced 🔥 (default)')
    expect(img('flux-fast', { speed_mode: 'Blink of an eye 👁️' }).speed_mode).toBe('Blink of an eye 👁️')
    expect(img('flux-fast', { speed_mode: 'Warp' }).speed_mode).toBe('Extra Juiced 🔥 (more speed)')
  })

  it('no seed where the model has none; Ideogram\'s seed wraps under 2^31', () => {
    for (const id of ['imagen-4', 'imagen-3-fast', 'gpt-image-2', 'gpt-image-1.5', 'recraft-v3', 'recraft-v4', 'recraft-v4-pro', 'seedream-4.5', 'minimax-image-01', 'grok-imagine']) {
      expect(img(id), id).not.toHaveProperty('seed')
    }
    expect(img('flux-dev').seed).toBe(7)
    expect(img('ideogram-v2', {}, { seed: 2147483647 }).seed).toBe(2147483647)
    const wrapped = img('ideogram-v2', {}, { seed: 4294967295 }).seed as number
    expect(wrapped).toBeGreaterThan(0)
    expect(wrapped).toBeLessThanOrEqual(2147483647)
  })

  it('Seedream 5 Pro / Lite references: no seed, and a ratio outside their list is left to the model', () => {
    for (const id of ['seedream-5-pro', 'seedream-5-lite']) {
      const d = IMAGE_EDIT_MODELS[id]!
      const p = d.build('the mug', ['u'], 5, { aspect_ratio: '4:3' })
      expect(p).not.toHaveProperty('seed')
      expect(p.aspect_ratio).toBe('4:3')
      expect(d.build('the mug', ['u'], 5, { aspect_ratio: '5:4' })).not.toHaveProperty('aspect_ratio')
    }
  })

  it('a video control is hidden exactly when the builder no longer sends it (fix round 1); its value is kept', () => {
    const all = { ...RUNNER_VIDEO_MODELS, ...RUNNER_REPLICATE_VIDEO_MODELS }
    const hiddenSeen: string[] = []
    for (const [id, d] of Object.entries(all)) {
      const cat = VIDEO_MODELS_BY_ID[id]!
      for (const f of cat.advanced) {
        const other = f.type === 'boolean' ? !f.default
          : f.options ? f.options.find(o => o !== f.default)
            : f.type === 'string' ? 'a different value'
              : (f.max ?? 1) !== f.default ? f.max : f.min
        const image = 'modes' in d && !d.modes.includes('t2v') ? 'https://fal.test/f.png' : null
        const build = (adv: Adv) => JSON.stringify(d.build({ prompt: 'a wave', aspectRatio: '16:9', duration: d.defaultDuration, seed: 7, image, adv }))
        const sent = build({ [f.name]: f.default }) !== build({ [f.name]: other })
        expect(!!f.hidden, `${id} ${f.name}`).toBe(!sent)
        if (f.hidden) hiddenSeen.push(`${id} ${f.name}`)
      }
    }
    expect(hiddenSeen.sort()).toEqual([
      'kling-v2.5-turbo-pro cfg_scale', 'kling-v3 cfg_scale', 'pixverse-v6 style',
      'runway-gen-4.5 motion', 'seedance-2.0-fast camera_fixed', 'wan-2.7-t2v num_frames',
    ])
  })

  it('a video model offers a seed exactly when its schema has one', () => {
    for (const d of Object.values(RUNNER_VIDEO_MODELS)) {
      const f = loadProviderSchema('fal', `${d.app}/${d.fnByMode.t2v}`.replace(/\/$/, ''))
      let input = f.input as Record<string, any>
      while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
      expect(VIDEO_MODELS_BY_ID[d.id]!.supportsSeed, d.id).toBe('seed' in input.properties)
    }
    for (const d of Object.values(RUNNER_REPLICATE_VIDEO_MODELS)) {
      const f = loadProviderSchema('replicate', d.slug)
      const input = f.components.schemas.Input as Record<string, any>
      expect(VIDEO_MODELS_BY_ID[d.id]!.supportsSeed, d.id).toBe('seed' in input.properties)
    }
  })

  it('the Wan 2.5 menu opens at 720p, the default the builder sends', () => {
    expect(VIDEO_MODELS_BY_ID['wan-2.5-i2v-fast']!.defaultResolution).toBe('720p')
  })
})
