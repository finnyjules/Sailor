// LC8 round 2 (F2 money): in hosted, a paid video maker's video into Save video is bounded before the hold
// from its settings (Enhance a video: the measured clip × its upscale and rate). Past the caps Save video
// re-encodes within, or not sizable, it is refused plainly, before anything is held or called.
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { EVERY_KNOWN_FAMILY } from '#shared/runner/families'
import { MEDIA_CAPS } from '#shared/runner/media'
import { paidVideoBound, paidVideoSaveProblem, paidVideoSaveTooLarge, paidVideoSaveUnsized } from '~~/server/runner/video/paidVideoSave'
import type { MeasuredMedia } from '~~/server/runner/types'
import { makeKit } from './__runner__/kit'

const ALL = EVERY_KNOWN_FAMILY
const save = (from: string, over: Record<string, unknown> = {}) => ({ class_type: 'SaveVideo', inputs: { video: [from, 0], filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'h264', ...over } })
const enhance = (target = '4k', fps = '30') => ({ class_type: 'EnhanceVideoNode', inputs: { model: 'Topaz Video Upscale', video_url: 'clip.mp4', target_resolution: target, fps } })
const measuredClip = (seconds: number, w: number, h: number, fps: number): Record<string, MeasuredMedia> =>
  ({ n: { seconds: { video: seconds, videoWidth: w, videoHeight: h, videoFps: fps }, sha: {} } })
const veo = (resolution: string) => ({ class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'a boat', aspect_ratio: '16:9', duration: '8', seed: 0, model_options: JSON.stringify({ resolution }) } })

describe('Enhance a video → Save video, hosted', () => {
  it('the bound is the measured clip × the upscale, at the asked rate', () => {
    const p: ApiPrompt = { n: enhance('4k', '30'), s: save('n') }
    const b = paidVideoBound(p, ['n', 0], measuredClip(60, 1920, 1080, 24))!
    expect(b.count).toBe(60 * 30 + 1)
    expect(b.w * b.h).toBeGreaterThan(1920 * 1080)
  })

  it('a minute upscaled to 4K is past the caps: refused before the hold, naming the maker', () => {
    const p: ApiPrompt = { n: enhance('4k', '30'), s: save('n') }
    expect(paidVideoSaveProblem(p, ALL, { hosted: true, measured: measuredClip(60, 1920, 1080, 24) }))
      .toEqual({ message: paidVideoSaveTooLarge('Enhance a video'), nodeId: 's', classType: 'SaveVideo' })
  })

  it('a short clip within the caps goes on', () => {
    const p: ApiPrompt = { n: enhance('1080p', 'original'), s: save('n') }
    expect(paidVideoSaveProblem(p, ALL, { hosted: true, measured: measuredClip(4, 1280, 720, 24) })).toBeNull()
  })

  it('a clip not measured can\'t be sized: refused', () => {
    const p: ApiPrompt = { n: enhance(), s: save('n') }
    expect(paidVideoSaveProblem(p, ALL, { hosted: true, measured: {} })?.message).toBe(paidVideoSaveUnsized('Enhance a video'))
  })

  it('format and codec on auto: a stream copy, nothing re-encoded, nothing to judge; locally neither', () => {
    const copy: ApiPrompt = { n: enhance('4k', '30'), s: save('n', { codec: 'auto' }) }
    expect(paidVideoSaveProblem(copy, ALL, { hosted: true, measured: measuredClip(60, 1920, 1080, 24) })).toBeNull()
    const p: ApiPrompt = { n: enhance('4k', '30'), s: save('n') }
    expect(paidVideoSaveProblem(p, ALL, { hosted: false, measured: measuredClip(60, 1920, 1080, 24) })).toBeNull()
  })
})

describe('the other paid makers Save video takes, hosted', () => {
  it('Generate a video: its settings bound it (Veo 3.1 at 4K for 8 s is past the caps; at 1080p it is not)', () => {
    expect(paidVideoSaveProblem({ g: veo('4k'), s: save('g') }, ALL, { hosted: true, measured: {} })?.message).toBe(paidVideoSaveTooLarge('Generate a video'))
    expect(paidVideoSaveProblem({ g: veo('1080p'), s: save('g') }, ALL, { hosted: true, measured: {} })).toBeNull()
  })

  it('Film a shot: bounded the same way, from the same settings', () => {
    const shot = { ...veo('4k'), class_type: 'FilmShotNode' }
    const b = paidVideoBound({ f: shot, s: save('f') }, ['f', 0], {})
    expect(b).not.toBeNull()
    expect(b!.count * b!.w * b!.h).toBeGreaterThan(MEDIA_CAPS.hosted.batchPixels)
  })

  it('a lip-synced video no setting bounds: refused unless kept as it is', () => {
    const p: ApiPrompt = { l: { class_type: 'LipSyncNode', inputs: { engine: 'sync-3', model_options: '{}', sync_mode: 'cut_off' } }, s: save('l') }
    expect(paidVideoBound(p, ['l', 0], {})).toBeNull()
    // Judged only where Save video takes it (this minimal node may not be taken): never as within the caps.
    const r = paidVideoSaveProblem(p, ALL, { hosted: true, measured: {} })
    if (r) expect(r.message).toMatch(/^Sailor can’t tell how large “[^”]+”’s video will be before it’s made/)
  })
})

describe('the start, hosted: refused before the hold', () => {
  it('Generate a video at 4K → Save video re-encoding it: refused in plain words, nothing held or called', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL } })
    const p: ApiPrompt = { g: veo('4k'), s: save('g') }
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('too large for Save video to re-encode here') })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
})
