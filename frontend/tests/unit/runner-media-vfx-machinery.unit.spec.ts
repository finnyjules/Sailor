/**
 * Task R6.1: the frame-effect machinery every R6 video effect shares, proved
 * with stand-in classes where a real class would hide it:
 *   - the nine R6 families, their requirement chains and the media tools;
 *   - the rows (mediaEffectRows), what their slots carry, and the wires they
 *     take (frame batches only: ruling (k));
 *   - rule 4's hand-off: framesQuantOf;
 *   - the lease (server/media/run.ts mediaLease): one of the person's media
 *     slots for all of a node's processes, and Stop ending every one of them;
 *   - the start pass (server/runner/video/start.ts): what the runner can't
 *     do leaves the whole workflow to the engine before the run;
 *   - letting go of kept batches (ruling (j)) and making them again after a
 *     restart;
 *   - rule 12's invariant: with every R6 family off (and on with the tools
 *     missing), every answer is as before R6.1.
 *
 * The lease is checked against fake tools (small shell scripts, as
 * runner-media-run.unit.spec.ts does). What needs frames on disk uses the
 * real tools (R5 rule 10: requireMediaTools fails, never skips).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MediaTools } from '~~/server/media/tools'

// Fake tools for the lease (null: the real build).
const fake = vi.hoisted(() => ({ tools: null as MediaTools | null }))

// The start pass's sources, standing in for a probe (null: the real one).
const shapeHook = vi.hoisted(() => ({ source: null as null | ((nodeId: string, cls: string) => Promise<{ count: number; w: number; h: number; exact: boolean } | null>) }))
vi.mock('~~/server/runner/video/shapes', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/video/shapes')>()
  return {
    ...real,
    videoSourceShapeOf: (o: Parameters<typeof real.videoSourceShapeOf>[0]) => {
      const own = real.videoSourceShapeOf(o)
      return (id: string, cls: string) => shapeHook.source ? shapeHook.source(id, cls) : own(id, cls)
    },
  }
})

// Every media job, with the lease it ran under (a spy on run.ts, which is the only way a tool starts).
const jobs = vi.hoisted(() => ({ list: [] as { tool: string; lease: unknown; args: string[] }[] }))
vi.mock('~~/server/media/run', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/run')>()
  return {
    ...real,
    runMedia: (job: Parameters<typeof real.runMedia>[0]) => {
      jobs.list.push({ tool: job.tool, lease: job.lease ?? null, args: job.args })
      return real.runMedia(job)
    },
  }
})

// A stand-in two-input class (the lease's case: two decodes and an encode at once), beside the real table.
vi.mock('~~/server/runner/video/table', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/video/table')>()
  const same = (_w: Record<string, unknown>, ins: readonly { count: number; w: number; h: number; exact: boolean }[]) => ({ ...ins[0]! })
  return {
    ...real,
    VIDEO_EFFECTS: {
      ...real.VIDEO_EFFECTS,
      StandInJoin: { family: 'video-time', op: 'time.select', inputs: ['clip_a', 'clip_b'], reads: 'stream', preview: false, shape: same, heldBytes: () => 0, work: () => 0 },
    },
  }
})

// A gate in the worker's video frames: the Nth frame waits until the test lets it go (or Stops the node).
const HOOK = vi.hoisted(() => ({ frames: 0, holdAt: 0, gate: null as Promise<void> | null, ctl: null as AbortController | null, abortedAt: 0 }))
vi.mock('~~/server/runner/compositor/worker', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/compositor/worker')>()
  return {
    ...real,
    pixelsInWorker: ((signal, job, timeout) => real.pixelsInWorker(signal, w => job(new Proxy(w, {
      get(t, k) {
        const v = Reflect.get(t, k)
        if (k !== 'videoFrame') return typeof v === 'function' ? v.bind(t) : v
        return async (...a: Parameters<typeof t.videoFrame>) => {
          if (++HOOK.frames === HOOK.holdAt) {
            if (HOOK.ctl) { HOOK.abortedAt = Date.now(); HOOK.ctl.abort() }
            if (HOOK.gate) await HOOK.gate
          }
          return t.videoFrame(...a)
        }
      },
    })), timeout)) as typeof real.pixelsInWorker,
  }
})

/** Every tool process started, by pid (a spy on the process table's side of spawn). */
const PROCS = vi.hoisted(() => ({ pids: [] as number[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: ((...a: Parameters<typeof real.spawn>) => {
      const c = real.spawn(...a)
      if (c.pid) PROCS.pids.push(c.pid)
      return c
    }) as typeof real.spawn,
  }
})

// Rule 12 with the tools missing: the server's own family answer (config.ts runnerFamilies).
const TOOLS = vi.hoisted(() => ({ ready: null as boolean | null }))
vi.mock('~~/server/media/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/tools')>()
  return {
    ...real,
    mediaTools: async () => fake.tools ?? await real.mediaTools(),
    mediaToolsReady: () => TOOLS.ready ?? real.mediaToolsReady(),
  }
})

const { ALL_RUNNER_FAMILIES, FAMILY_REQUIRES, MEDIA_EFFECT_TOOL_FAMILIES, MEDIA_TOOL_FAMILIES, RUNNER_FAMILIES, familyOn, parseFamilies, requirementOf } = await import('#shared/runner/families')
const {
  FRAMES_OUTPUTS, FRAME_ENCODERS, MEDIA_EFFECT_FAMILIES, MEDIA_EFFECT_FAMILY_OF, MEDIA_EFFECT_OUTPUT_KINDS, MEDIA_EFFECTS_PORTED, mediaEffectRows,
} = await import('#shared/runner/mediaEffects')
const { MEDIA_EFFECT_SCHEMAS } = await import('#shared/runner/mediaEffectSchemas.generated')
const { EFFECT_FAMILY_OF } = await import('#shared/runner/effects')
const {
  LOCAL_RENDER_TYPES, PICTURE_OUTPUTS, RUNNER_NODE_RULES, SWITCHED_CLASSES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed,
} = await import('#shared/runner/eligibility')
const { RUNNER_OUTPUT_CLASSES, pruneInvalidOutputs, runnerTakesWorkflow } = await import('#shared/runner/validate')
const { nodesNeedingEngine } = await import('#shared/runner/needsEngine')
const { MEDIA_CAPS, MEDIA_LEASE_PROCESSES, MEDIA_WORDS } = await import('#shared/runner/media')
const { RUNNER_NOT_ELIGIBLE } = await import('#shared/runner/messages')
const { MediaError, leaseProcesses, mediaLease, mediaLimiter, runMedia } = await import('~~/server/media/run')
const { framesQuantOf } = await import('~~/server/runner/video/plan')
const { mediaEffectStartProblems, keptBatchBound } = await import('~~/server/runner/video/start')
const { VIDEO_EFFECTS } = await import('~~/server/runner/video/table')
const { requireMediaTools, clipPath } = await import('./__runner__/mediaParity')
const { makeKit, until } = await import('./__runner__/kit')
const { createFileKeptBytes, KEPT_GONE, withRunCap } = await import('~~/server/runner/keptBytes')
const { pyFrameBound, pyFrameCount, probeMedia } = await import('~~/server/media/probe')
const { spentKeptMedia } = await import('~~/server/runner/keptRelease')
const { runnerFamilies } = await import('~~/server/runner/config')
const { MEDIA_EFFECT_WORDS } = await import('#shared/runner/mediaEffects')
const { batchBytes, hash16, invariantAnswers, rule12Pin, keptBatch, runVfxNode, sha256, vfxHarness, vfxRunId } = await import('./__runner__/mediaEffectsParity')

import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

const LONG = { timeout: 120_000 }
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const CARDS_VIDEO: RunnerFamily[] = ['cards', 'media-video']
const ON: ReadonlySet<RunnerFamily> = new Set([...CARDS_VIDEO, 'video-time'])
const R6: readonly RunnerFamily[] = ['video-time', 'video-join', 'video-look', 'video-stabilize', 'video-flow', 'video-draw', 'video-text', 'sound-effects', 'sound-denoise']

type Link = [string, number]
const loadVideo = (file: string) => ({ class_type: 'LoadVideo', inputs: { file } })
const getComp = (from: string) => ({ class_type: 'GetVideoComponents', inputs: { video: [from, 0] as Link } })
const createVideo = (images: Link, fps: number | Link = 24) => ({ class_type: 'CreateVideo', inputs: { images, fps } })
const saveVideo = (from: string) => ({ class_type: 'SaveVideo', inputs: { video: [from, 0] as Link, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })
const saveFrames = (frames: Link) => ({ class_type: 'SaveVideoFrames', inputs: { frames, fps: 24, filename_prefix: 'video', audio_file: '(none)', preset: 'veryfast', crf: 20 } })
const reverse = (frames: Link, mode = 'reverse') => ({ class_type: 'VideoReverse', inputs: { frames, mode } })
const trim = (frames: Link, start = 0, end = -1) => ({ class_type: 'VideoTrim', inputs: { frames, start, end } })
const trail = (frames: Link) => ({ class_type: 'FrameTrail', inputs: { frames, decay: 0.85, blend_mode: 'screen', intensity: 1, threshold: 0 } })
const gate = (from: Link) => ({ class_type: 'ComfyGateNode', inputs: { data_in: from, bypass: false } })
const saveImage = (images: Link) => ({
  class_type: 'SaveImage',
  inputs: { images, filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: true, png_compression: 6, scale: 1, max_dimension: 0, embed_metadata: true },
})
const imageCard = () => ({ class_type: 'Image', inputs: { image: 'a.png', export: false, batch_index: -1 } })

/** Load video → Get video components → Reverse → Create video → Save video. */
const reversed = (): ApiPrompt => ({ l: loadVideo('a.mp4'), g: getComp('l'), r: reverse(['g', 0]), c: createVideo(['r', 0]), s: saveVideo('c') })

// ── The families ─────────────────────────────────────────────────────────────

describe('the nine R6 families', () => {
  it('are known, off by default, need the video tools, and are kept out of every set written before R6', () => {
    for (const f of R6) {
      expect(ALL_RUNNER_FAMILIES, f).toContain(f)
      expect(MEDIA_EFFECT_TOOL_FAMILIES, f).toContain(f)
      // Every "every family on" set written before R6 (RUNNER_FAMILIES, R5 rule 8) stays as it was, and R5's own list.
      expect(RUNNER_FAMILIES, f).not.toContain(f)
      expect(MEDIA_TOOL_FAMILIES, f).not.toContain(f)
    }
    expect([...MEDIA_EFFECT_FAMILIES].sort()).toEqual([...R6].sort())
  })

  it('the video families need media-video and the sound families media-sound', () => {
    for (const f of R6) expect(requirementOf(f), f).toBe(f.startsWith('video-') ? 'media-video' : 'media-sound')
    // R2's table (pinned by its specs) is as it was; R5's media families still need cards.
    for (const f of R6) expect(Object.hasOwn(FAMILY_REQUIRES, f), f).toBe(false)
    expect(requirementOf('media-video')).toBe('cards')
  })

  it('parseFamilies drops a family whose chain is broken, until nothing changes', () => {
    expect([...parseFamilies('video-time,media-video')]).toEqual([])
    expect(new Set(parseFamilies('video-time,media-video,cards'))).toEqual(new Set(['video-time', 'media-video', 'cards']))
    // Written in any order: the family is kept only with the whole chain.
    expect(new Set(parseFamilies('cards,video-time'))).toEqual(new Set(['cards']))
    expect(new Set(parseFamilies('sound-denoise,sound-effects,media-sound'))).toEqual(new Set())
    expect(new Set(parseFamilies(['sound-denoise', 'cards', 'media-sound']))).toEqual(new Set(['sound-denoise', 'cards', 'media-sound']))
  })

  it('familyOn follows the chain', () => {
    expect(familyOn('video-time', new Set<RunnerFamily>(['video-time', 'media-video']))).toBe(false)
    expect(familyOn('video-time', new Set<RunnerFamily>(['video-time', 'media-video', 'cards']))).toBe(true)
    expect(familyOn('video-time', new Set<RunnerFamily>(['video-time', 'cards']))).toBe(false)
  })
})

// ── The rows ─────────────────────────────────────────────────────────────────

describe('the rows (rule 1)', () => {
  it('every R6 class has its family; Save audio (Opus) is R5’s and none of them is an R2 effect', () => {
    const classes = Object.keys(MEDIA_EFFECT_SCHEMAS).filter(c => c !== 'SaveAudioOpus')
    expect(classes).toHaveLength(33)
    for (const c of classes) {
      expect(MEDIA_EFFECT_FAMILY_OF[c], c).toBe(MEDIA_EFFECT_SCHEMAS[c]!.family)
      expect(Object.hasOwn(EFFECT_FAMILY_OF, c), c).toBe(false)
    }
    expect(MEDIA_EFFECT_SCHEMAS.SaveAudioOpus!.family).toBe('media-sound')
    expect(Object.hasOwn(MEDIA_EFFECT_FAMILY_OF, 'SaveAudioOpus')).toBe(false)
  })

  it('the ported effects’ rows (R6.1’s pilots, R6.2’s four, R6.3’s two joins, R6.4’s five looks, R6.5’s Stabilize, R6.6’s Slow motion, R6.7’s two made clips, R6.8’s text): a local render reading frame batches only, their widgets as ComfyUI validates them', () => {
    const looks = ['AspectConvert', 'ChromaKey', 'KenBurns', 'LUT', 'ThreeWayCC']
    const madeClips = ['AnimatedNoise', 'AudioWaveform']
    const ported = [...looks, ...madeClips, 'TextClip', 'CaptionTrack', 'Stabilize', 'FrameInterpolate', 'FrameTrail', 'SlitScan', 'SpeedRamp', 'TemporalMotionBlur', 'TimeDisplacement', 'Transition', 'VideoCrossfade', 'VideoReverse', 'VideoTrim'].sort()
    // R6.9's sound effects and Silence cut (family sound-effects): their rows are checked in runner-media-sfx.
    const sounds = ['TrimAudioDuration', 'SplitAudioChannels', 'JoinAudioChannels', 'AudioConcat', 'AudioMerge', 'AudioAdjustVolume', 'EmptyAudio',
      'AudioEqualizer3Band', 'AudioFade', 'AudioNormalize', 'AudioDuck', 'VideoSilenceCut']
    expect([...MEDIA_EFFECTS_PORTED].sort()).toEqual([...ported, ...sounds].sort())
    const rows = mediaEffectRows()
    expect(Object.keys(rows).sort()).toEqual([...ported, ...sounds].sort())
    for (const [cls, row] of Object.entries(rows)) {
      if (sounds.includes(cls)) {
        expect(row, cls).toMatchObject({ family: 'sound-effects', local: 'render' })
        expect(SWITCHED_CLASSES[cls], cls).toBe('sound-effects')
        expect(RUNNER_OUTPUT_CLASSES.has(cls), cls).toBe(false)
        continue
      }
      // R6.7's made clips read no frames: a local render of the video-draw family, an output node (runner-media-vfx-draw).
      if (madeClips.includes(cls)) {
        expect(row, cls).toMatchObject({ family: 'video-draw', local: 'render' })
        expect(row.mustLink, cls).toBeUndefined()
        expect(RUNNER_NODE_RULES[cls], cls).toEqual(row)
        expect(SWITCHED_CLASSES[cls], cls).toBe('video-draw')
        expect(RUNNER_OUTPUT_CLASSES.has(cls), cls).toBe(true)
        continue
      }
      // R6.8's Text clip reads no frames and is not an output node (runner-media-vfx-text).
      if (cls === 'TextClip') {
        expect(row, cls).toMatchObject({ family: 'video-text', local: 'render' })
        expect(row.mustLink, cls).toBeUndefined()
        expect(RUNNER_NODE_RULES[cls], cls).toEqual(row)
        expect(SWITCHED_CLASSES[cls], cls).toBe('video-text')
        expect(RUNNER_OUTPUT_CLASSES.has(cls), cls).toBe(false)
        continue
      }
      const joins = cls === 'VideoCrossfade' || cls === 'Transition'
      const family = joins ? 'video-join' : looks.includes(cls) ? 'video-look' : cls === 'Stabilize' ? 'video-stabilize' : cls === 'FrameInterpolate' ? 'video-flow' : cls === 'CaptionTrack' ? 'video-text' : 'video-time'
      // 3-way color reads its frames on `image` (its Python name).
      const ins = joins ? ['clip_a', 'clip_b'] : cls === 'ThreeWayCC' ? ['image'] : ['frames']
      expect(row, cls).toMatchObject({ family, local: 'render', mustLink: ins, required: ins, valueInputs: Object.fromEntries(ins.map(i => [i, ['frames']])) })
      for (const i of ins) expect(row.linkSources![i], `${cls} ${i}`).toEqual(expect.arrayContaining(FRAMES_OUTPUTS.map(x => [...x])))
      expect(RUNNER_NODE_RULES[cls], cls).toEqual(row)
      expect(SWITCHED_CLASSES[cls], cls).toBe(family)
      expect(LOCAL_RENDER_TYPES.has(cls), cls).toBe(true)
      // Every video effect but Slow motion, Silence cut and Text clip is an output node (define_schema).
      expect(RUNNER_OUTPUT_CLASSES.has(cls), cls).toBe(cls !== 'FrameInterpolate')
    }
    expect(rows.VideoTrim!.widgets).toEqual({ start: { type: 'INT', required: true, min: 0, max: 10000 }, end: { type: 'INT', required: true, min: -1, max: 10000 } })
    expect(rows.VideoReverse!.widgets).toEqual({ mode: { type: 'COMBO', required: true, options: ['reverse', 'ping_pong'] } })
  })

  it('FRAMES_OUTPUTS: Get video components, Load video frames and each ported effect; FRAME_ENCODERS: Create video, Save video frames', () => {
    expect(FRAMES_OUTPUTS.map(x => [...x])).toEqual([
      ['GetVideoComponents', 0], ['LoadVideoFrames', 0], ['FrameTrail', 0], ['VideoReverse', 0], ['VideoTrim', 0],
      ['TemporalMotionBlur', 0], ['SlitScan', 0], ['TimeDisplacement', 0], ['SpeedRamp', 0], ['VideoCrossfade', 0], ['Transition', 0],
      ['KenBurns', 0], ['AspectConvert', 0], ['ChromaKey', 0], ['LUT', 0], ['ThreeWayCC', 0], ['Stabilize', 0], ['FrameInterpolate', 0],
      ['AnimatedNoise', 0], ['AudioWaveform', 0], ['TextClip', 0], ['CaptionTrack', 0], ['VideoSilenceCut', 0],
    ])
    expect([...FRAME_ENCODERS]).toEqual(['CreateVideo', 'SaveVideoFrames'])
    expect(MEDIA_EFFECT_OUTPUT_KINDS).toEqual({
      FrameTrail: { 0: 'frames' }, VideoReverse: { 0: 'frames' }, VideoTrim: { 0: 'frames' },
      TemporalMotionBlur: { 0: 'frames' }, SlitScan: { 0: 'frames' }, TimeDisplacement: { 0: 'frames' }, SpeedRamp: { 0: 'frames' },
      VideoCrossfade: { 0: 'frames' }, Transition: { 0: 'frames' },
      KenBurns: { 0: 'frames' }, AspectConvert: { 0: 'frames' }, ChromaKey: { 0: 'frames' }, LUT: { 0: 'frames' }, ThreeWayCC: { 0: 'frames' },
      Stabilize: { 0: 'frames' }, FrameInterpolate: { 0: 'frames' }, AnimatedNoise: { 0: 'frames' }, AudioWaveform: { 0: 'frames' },
      TextClip: { 0: 'frames' }, CaptionTrack: { 0: 'frames' }, VideoSilenceCut: { 0: 'frames' },
    })
    for (const [cls, input] of [['CreateVideo', 'images'], ['SaveVideoFrames', 'frames']] as const) {
      expect(RUNNER_NODE_RULES[cls]!.linkSources![input], cls).toEqual(expect.arrayContaining(FRAMES_OUTPUTS.map(x => [...x])))
    }
    expect(VIDEO_EFFECTS.VideoTrim!.reads).toBe('stream')
    expect(VIDEO_EFFECTS.VideoReverse!.reads).toBe('held')
    expect(VIDEO_EFFECTS.FrameTrail!.reads).toBe('stream')
    expect(VIDEO_EFFECTS.SlitScan!.reads).toBe('held')
    expect(VIDEO_EFFECTS.TimeDisplacement!.reads).toBe('held')
    expect(VIDEO_EFFECTS.SpeedRamp!.reads).toBe('window')
    expect(VIDEO_EFFECTS.VideoCrossfade!.reads).toBe('join')
    expect(VIDEO_EFFECTS.Transition!.reads).toBe('join')
    for (const cls of ['KenBurns', 'AspectConvert', 'ChromaKey', 'LUT', 'ThreeWayCC']) expect(VIDEO_EFFECTS[cls]!.reads, cls).toBe('stream')
    expect(VIDEO_EFFECTS.Stabilize!.reads).toBe('two-pass')
    expect(VIDEO_EFFECTS.FrameInterpolate!.reads).toBe('tool')
    expect(VIDEO_EFFECTS.AnimatedNoise!.reads).toBe('generator')
    expect(VIDEO_EFFECTS.AudioWaveform!.reads).toBe('generator')
    expect(VIDEO_EFFECTS.TextClip!.reads).toBe('generator')
    expect(VIDEO_EFFECTS.CaptionTrack!.reads).toBe('stream')
  })

  it('an effect’s slot carries frames only while its family is on', () => {
    expect(outputKindsFor(ON).VideoReverse).toEqual({ 0: 'frames' })
    expect(outputKindsFor(new Set(CARDS_VIDEO)).VideoReverse).toBeUndefined()
    expect(outputKindsFor(new Set([...CARDS_VIDEO, 'video-look'] as RunnerFamily[])).VideoReverse).toBeUndefined()
    // Video effects are never pictures.
    expect(Object.hasOwn(PICTURE_OUTPUTS, 'VideoReverse')).toBe(false)
  })

  it('takes Load video → Get video components → Reverse → Create video → Save video with video-time on; names Reverse with it off', () => {
    const p = reversed()
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    expect(runnerTakesWorkflow(p, new Set(CARDS_VIDEO))).toBe(false)
    // Reverse, and Create video, whose frames then come from a node the runner doesn't know.
    expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(CARDS_VIDEO), titleOf: id => id })).toEqual(['r', 'c'])
    // Chains, a Gate between, and Save video frames too.
    const chain: ApiPrompt = { l: loadVideo('a.mp4'), g: getComp('l'), t: trim(['g', 0], 1, 5), x: gate(['t', 0]), r: reverse(['x', 0], 'ping_pong'), f: trail(['r', 0]), s: saveFrames(['f', 0]) }
    expect(runnerTakesWorkflow(chain, ON)).toBe(true)
  })

  it('ruling (k): a picture wired into a video effect, and a video effect wired into Save image, leave the workflow to the engine', () => {
    const picture: ApiPrompt = { i: imageCard(), r: reverse(['i', 0]), c: createVideo(['r', 0]), s: saveVideo('c') }
    expect(runnerTakesNode(picture, 'r', ON)).toBe(false)
    expect(runnerTakesWorkflow(picture, ON)).toBe(false)
    const intoPicture: ApiPrompt = { l: loadVideo('a.mp4'), g: getComp('l'), r: reverse(['g', 0]), s: saveImage(['r', 0]) }
    expect(runnerTakesNode(intoPicture, 's', ON)).toBe(false)
    expect(runnerTakesWorkflow(intoPicture, ON)).toBe(false)
  })
})

describe('rule 4: framesQuantOf', () => {
  const base = { l: loadVideo('a.mp4'), g: getComp('l'), r: reverse(['g', 0]) }
  it('is trunc only when every reader of the slot only encodes it', () => {
    expect(framesQuantOf({ ...base, c: createVideo(['r', 0]), s: saveVideo('c') }, 'r', 0, ON)).toBe('trunc')
    expect(framesQuantOf({ ...base, s: saveFrames(['r', 0]) }, 'r', 0, ON)).toBe('trunc')
    expect(framesQuantOf({ ...base, s: saveFrames(['r', 0]), c: createVideo(['r', 0]), v: saveVideo('c') }, 'r', 0, ON)).toBe('trunc')
    // Through a Gate.
    expect(framesQuantOf({ ...base, x: gate(['r', 0]), s: saveFrames(['x', 0]) }, 'r', 0, ON)).toBe('trunc')
  })
  it('is round when any reader reads the frames on (another effect, or a made video taken apart again), or none reads them', () => {
    expect(framesQuantOf({ ...base, t: trim(['r', 0]), s: saveFrames(['r', 0]) }, 'r', 0, ON)).toBe('round')
    expect(framesQuantOf({ ...base, c: createVideo(['r', 0]), g2: getComp('c'), t: trail(['g2', 0]) }, 'r', 0, ON)).toBe('round')
    expect(framesQuantOf(base, 'r', 0, ON)).toBe('round')
    expect(framesQuantOf({ ...base, x: gate(['r', 0]), t: trim(['x', 0]) }, 'r', 0, ON)).toBe('round')
  })
})

describe('the caps (ruling (i))', () => {
  it('hosted: 512 MiB of frames held, ten minutes of stereo 48 kHz sound, and a work budget; locally R5’s own caps only', () => {
    expect(MEDIA_CAPS.hosted.heldFrameBytes).toBe(512 * 1024 * 1024)
    expect(MEDIA_CAPS.hosted.effectSoundSamples).toBe(2 * 48000 * 600)
    expect(MEDIA_CAPS.hosted.effectWork).toBeGreaterThan(0)
    expect(Number.isFinite(MEDIA_CAPS.hosted.effectWork)).toBe(true)
    expect(MEDIA_CAPS.local.heldFrameBytes).toBe(Number.POSITIVE_INFINITY)
    expect(MEDIA_CAPS.local.effectSoundSamples).toBe(Number.POSITIVE_INFINITY)
    expect(MEDIA_CAPS.local.effectWork).toBe(Number.POSITIVE_INFINITY)
    expect(MEDIA_LEASE_PROCESSES).toBe(3)
  })
})

// ── The lease (ruling (n)) ───────────────────────────────────────────────────

const HOSTED_KEY = 'NUXT_CLERK_SECRET_KEY'
const scratch = mkdtempSync(join(tmpdir(), 'media-vfx-machinery-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let runs = 0

/** Runs `fn` as hosted (the media module reads the deployment from the environment). */
async function asHosted<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env[HOSTED_KEY]
  process.env[HOSTED_KEY] = 'sk_test_machinery'
  try { return await fn() }
  finally {
    if (saved === undefined) delete process.env[HOSTED_KEY]
    else process.env[HOSTED_KEY] = saved
  }
}

describe('mediaLease: one of the person’s slots for all of a node’s processes', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(scratch, 'fake-')) })
  afterEach(() => { fake.tools = null })

  /** A fake ffmpeg that runs until it is killed. */
  function sleepingTools(): MediaTools {
    const f = join(dir, 'ffmpeg')
    writeFileSync(f, '#!/bin/sh\nexec /bin/sleep 30\n')
    chmodSync(f, 0o755)
    const t: MediaTools = {
      ffmpeg: f, ffprobe: f,
      version: 'ffmpeg version 8.0.3-sailor1', buildconf: [], encoders: new Set(), protocols: { input: ['file', 'pipe'], output: ['file', 'pipe'] },
    }
    fake.tools = t
    return t
  }
  const job = (lease: InstanceType<typeof Object> | undefined, userId: string | null) =>
    runMedia({ tool: 'ffmpeg', args: ['-i', 'pipe:0', 'pipe:1'], userId, ...(lease ? { lease: lease as never } : {}) })

  it('runs up to three processes in one slot, refuses a fourth, and makes a second node of the same person wait', LONG, async () => {
    sleepingTools()
    await asHosted(async () => {
      let end!: () => void
      const held = new Promise<void>((r) => { end = r })
      let first: Parameters<Parameters<typeof mediaLease>[1]>[0] | null = null
      const children: Promise<unknown>[] = []
      const a = mediaLease({ userId: 'user_9' }, async (lease) => {
        first = lease
        for (let i = 0; i < 3; i++) children.push(job(lease, 'user_9').catch(e => e))
        await until(() => leaseProcesses(lease) === 3)
        await expect(job(lease, 'user_9')).rejects.toThrow(MEDIA_WORDS.failed)
        // Another person's job can't run under this lease.
        await expect(job(lease, 'user_8')).rejects.toThrow(MEDIA_WORDS.failed)
        await held
      })
      await until(() => first !== null && leaseProcesses(first) === 3)
      let secondRan = false
      const b = mediaLease({ userId: 'user_9' }, async () => { secondRan = true })
      await sleep(150)
      // One running, one waiting: the lease is one slot, and hosted gives a person one.
      expect(secondRan).toBe(false)
      expect(mediaLimiter().pending('user_9')).toBe(2)
      const t0 = Date.now()
      end()
      await a
      // Ending the lease killed all three, each within the second.
      expect(Date.now() - t0).toBeLessThan(1000)
      for (const c of await Promise.all(children)) expect((c as Error).message).toBe(MEDIA_WORDS.stopped)
      expect(leaseProcesses(first!)).toBe(0)
      expect(first!.live).toBe(false)
      await b
      expect(secondRan).toBe(true)
      // A job can't start under a lease that has ended.
      await expect(job(first!, 'user_9')).rejects.toThrow(MEDIA_WORDS.stopped)
    })
  })

  it('Stop ends the lease: every process killed within a second, and the slot given back', LONG, async () => {
    sleepingTools()
    await asHosted(async () => {
      const ctl = new AbortController()
      const before = PROCS.pids.length
      const children: Promise<unknown>[] = []
      const stopped = new Promise<void>((_, reject) => ctl.signal.addEventListener('abort', () => reject(new MediaError('stopped')), { once: true }))
      stopped.catch(() => {})
      const a = mediaLease({ userId: 'user_7', signal: ctl.signal }, async (lease) => {
        for (let i = 0; i < 3; i++) children.push(job(lease, 'user_7').catch(e => e))
        // The node's own work ends when Stop reaches it.
        await stopped
      })
      await until(() => PROCS.pids.length - before >= 3)
      const t0 = Date.now()
      ctl.abort()
      await expect(a).rejects.toThrow(MEDIA_WORDS.stopped)
      expect(Date.now() - t0).toBeLessThan(1000)
      for (const pid of PROCS.pids.slice(before)) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
      expect(mediaLimiter().pending('user_7')).toBe(0)
    })
  })
})

// ── A node's plan under its lease (a stand-in class with two inputs) ─────────

/** A stand-in node straight through planVideoEffect (the dispatch knows only ported classes). */
async function runStandIn(h: ReturnType<typeof vfxHarness>, prompt: ApiPrompt, id: string, values: Record<string, Record<number, RunnerValue>>, o: { runId: string; signal?: AbortSignal }) {
  const { planVideoEffect } = await import('~~/server/runner/video/plan')
  const { vfxIo } = await import('./__runner__/mediaEffectsParity')
  const plan = planVideoEffect({ prompt, nodeId: id, families: ON, gateOpen: false, filesFrom: () => [], valueFrom: l => values[l[0]]?.[l[1]], toUrl: async () => '' })
  if (plan.kind !== 'derive') throw new Error('not a derive plan')
  return plan.derive(vfxIo(h, id, o.runId, o.signal ?? new AbortController().signal))
}

describe('a video effect’s plan', () => {
  const W = 320
  const H = 240
  const big = (n: number, seed: number) => ({ frames: Array.from({ length: n }, (_, i) => new Uint8Array(W * H * 3).fill((seed + i * 7) & 255)), w: W, h: H })
  const joinPrompt = (): ApiPrompt => ({ l: loadVideo('a.mp4'), g: getComp('l'), g2: getComp('l'), j: { class_type: 'StandInJoin', inputs: { clip_a: ['g', 0], clip_b: ['g2', 0] } }, t: trim(['j', 0]) })

  it('a two-input stand-in runs its decodes and its encode under one lease, while a second node of the same hosted person waits', LONG, async () => {
    await requireMediaTools()
    await asHosted(async () => {
      const h = vfxHarness(scratch, { hosted: true })
      const runId = vfxRunId(++runs)
      const a = await keptBatch(h, runId, big(12, 1))
      const b = await keptBatch(h, runId, big(12, 100))
      const c = await keptBatch(h, runId, big(4, 50))
      let letGo!: () => void
      HOOK.frames = 0
      HOOK.holdAt = 1
      HOOK.gate = new Promise<void>((r) => { letGo = r })
      const from = jobs.list.length
      try {
        const first = runStandIn(h, joinPrompt(), 'j', { g: { 0: a }, g2: { 0: b } }, { runId })
        first.catch(() => {})
        await until(() => HOOK.frames >= 1, 20_000)
        const mine = jobs.list.slice(from)
        // Two decodes and the encode, all ffmpeg, all under the same lease.
        expect(mine.map(j => j.tool)).toEqual(['ffmpeg', 'ffmpeg', 'ffmpeg'])
        expect(new Set(mine.map(j => j.lease)).size).toBe(1)
        expect(mine[0]!.lease).not.toBeNull()
        expect(leaseProcesses(mine[0]!.lease as never)).toBe(3)
        // A second node of the same person waits for the slot: none of its processes starts.
        const second = runVfxNode(h, { l: loadVideo('a.mp4'), g: getComp('l'), r: trim(['g', 0], 1) }, 'r', { g: { 0: c } }, { runId, families: ON })
        second.catch(() => {})
        await sleep(300)
        expect(jobs.list.length - from).toBe(3)
        expect(mediaLimiter().pending('user_1')).toBe(2)
        letGo()
        const made = await first
        const out = await second
        const theirs = jobs.list.slice(from + 3)
        expect(theirs.length).toBeGreaterThanOrEqual(2)
        expect(new Set(theirs.map(j => j.lease)).size).toBe(1)
        expect(theirs[0]!.lease).not.toBe(mine[0]!.lease)
        // The stand-in's frames are clip A's, one for one (its op hands the first input's frame on).
        const got = await batchBytes(h, runId, made.values[0] as never)
        expect(sha256(got)).toBe(sha256(await batchBytes(h, runId, a)))
        expect((out.values[0] as { count: number }).count).toBe(3)
      }
      finally { HOOK.holdAt = 0; HOOK.gate = null }
    })
  })

  it('Stop mid-batch kills all three processes within a second and leaves no kept file', LONG, async () => {
    await requireMediaTools()
    await asHosted(async () => {
      const h = vfxHarness(scratch, { hosted: true })
      const runId = vfxRunId(++runs)
      const a = await keptBatch(h, runId, big(24, 3))
      const b = await keptBatch(h, runId, big(24, 90))
      const ctl = new AbortController()
      const before = PROCS.pids.length
      HOOK.frames = 0
      HOOK.holdAt = 3
      HOOK.ctl = ctl
      try {
        await expect(runStandIn(h, joinPrompt(), 'j', { g: { 0: a }, g2: { 0: b } }, { runId, signal: ctl.signal })).rejects.toThrow(MEDIA_WORDS.stopped)
        expect(Date.now() - HOOK.abortedAt).toBeLessThan(1000)
      }
      finally { HOOK.holdAt = 0; HOOK.ctl = null }
      const pids = PROCS.pids.slice(before)
      expect(pids).toHaveLength(3)
      for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
      // Only the two inputs are kept: no partial batch, no work folder.
      expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual([a.file.filename, b.file.filename].sort())
    })
  })

  it('a held batch past the node’s limit is refused before any decode', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const a = await keptBatch(h, runId, big(3, 5))
    const { heldFrames } = await import('~~/server/media/values')
    const from = jobs.list.length
    await expect(mediaLease({ userId: null }, lease => heldFrames(a, { access: h.access, kept: h.kept, runId, userId: null, hosted: false }, lease, 3 * W * H * 3 - 1)))
      .rejects.toThrow(MEDIA_WORDS.tooManyFrames)
    expect(jobs.list.length).toBe(from)
  })
})

// ── The start pass (rule 3) ──────────────────────────────────────────────────

describe('the start pass: what the runner can’t do leaves the whole workflow to the engine before the run', () => {
  const HD = { w: 1920, h: 1080 }
  const shapes = (entries: [string, { count: number; w: number; h: number }][]) => new Map(entries.map(([k, s]) => [k, { ...s, exact: false }]))

  it('a held effect over heldFrameBytes (hosted), a batch over R5’s caps, an unknown source, too much work', async () => {
    const p = reversed()
    // 100 frames of 1080p held: 622 MB, over 512 MiB in hosted; nothing locally.
    const s100 = shapes([['g:0', { count: 100, ...HD }]])
    expect(await mediaEffectStartProblems(p, ON, { hosted: true, shapes: s100 })).toEqual({ message: MEDIA_EFFECT_WORDS.heldTooMuch, nodeId: 'r', classType: 'VideoReverse', engine: true })
    expect(await mediaEffectStartProblems(p, ON, { hosted: false, shapes: s100 })).toBeNull()
    // Ping-pong of 400 small frames makes 798: over the hosted batch's 600.
    const pp: ApiPrompt = { ...p, r: reverse(['g', 0], 'ping_pong') }
    expect(await mediaEffectStartProblems(pp, ON, { hosted: true, shapes: shapes([['g:0', { count: 400, w: 64, h: 48 }]]) }))
      .toEqual({ message: MEDIA_WORDS.tooManyFrames, nodeId: 'r', classType: 'VideoReverse', engine: true })
    // A source the build can't read (no shape known).
    expect(await mediaEffectStartProblems(p, ON, { hosted: false, shapes: new Map() }))
      .toEqual({ message: MEDIA_EFFECT_WORDS.unknownLength, nodeId: 'r', classType: 'VideoReverse', engine: true })
    // Work past the budget: Frame trail over 600 frames of 1080p is 5 × 10⁹ pixel·steps, within the hosted
    // budget; with the budget below it, the same workflow is left to the engine.
    const trailed: ApiPrompt = { l: loadVideo('a.mp4'), g: getComp('l'), f: trail(['g', 0]), s: saveFrames(['f', 0]) }
    const s600 = shapes([['g:0', { count: 600, ...HD }]])
    expect(VIDEO_EFFECTS.FrameTrail!.work({}, [{ count: 600, ...HD, exact: true }], { count: 600, ...HD, exact: true })).toBeLessThan(MEDIA_CAPS.hosted.effectWork)
    expect(await mediaEffectStartProblems(trailed, ON, { hosted: true, shapes: s600 })).toBeNull()
    const caps = MEDIA_CAPS.hosted as { effectWork: number }
    const budget = caps.effectWork
    caps.effectWork = 1e9
    try {
      expect(await mediaEffectStartProblems(trailed, ON, { hosted: true, shapes: s600 })).toEqual({ message: MEDIA_EFFECT_WORDS.tooMuchWork, nodeId: 'f', classType: 'FrameTrail', engine: true })
    }
    finally { caps.effectWork = budget }
    // With the family off there's nothing to check.
    expect(await mediaEffectStartProblems(p, new Set(CARDS_VIDEO), { hosted: true, shapes: s100 })).toBeNull()
  })

  it('the run’s kept total, each batch let go after its last reader (ruling (j)), against the hosted run’s room', async () => {
    const chain = (n: number): ApiPrompt => {
      const p: ApiPrompt = { l: loadVideo('a.mp4'), g: getComp('l') }
      let from = 'g'
      for (let i = 1; i <= n; i++) { p[`t${i}`] = trim([from, 0], 1); from = `t${i}` }
      p.s = saveFrames([from, 0])
      return p
    }
    const shapesOf = (p: ApiPrompt, count: number) => {
      const m = shapes([['g:0', { count, ...HD }]])
      let c = count
      for (const id of Object.keys(p).filter(k => k.startsWith('t'))) { c -= 1; m.set(`${id}:0`, { count: c, ...HD, exact: false }) }
      return m
    }
    // 320 frames of 1080p: a batch's bound is 2.24 GB, two at once pass 4 GiB.
    expect(keptBatchBound({ count: 320, ...HD, exact: true }) * 2).toBeGreaterThan(4 * 1024 ** 3)
    const two = chain(1)
    expect(await mediaEffectStartProblems(two, ON, { hosted: true, shapes: shapesOf(two, 320) }))
      .toEqual({ message: MEDIA_EFFECT_WORDS.keptTooMuch, nodeId: 't1', classType: 'VideoTrim', engine: true })
    // 250 frames through three trims: never more than two batches at once (3.5 GB); all four together would be 7 GB.
    const four = chain(3)
    expect(keptBatchBound({ count: 250, ...HD, exact: true }) * 4).toBeGreaterThan(4 * 1024 ** 3)
    expect(await mediaEffectStartProblems(four, ON, { hosted: true, shapes: shapesOf(four, 250) })).toBeNull()
    // Locally the room is the machine's own.
    expect(await mediaEffectStartProblems(two, ON, { hosted: false, shapes: shapesOf(two, 320) })).toBeNull()
  })

  it('in the engine: each leaves the workflow to the engine before the run, with no tool process started', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const k = makeKit({ hosted: true, dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    copyFileSync(clipPath('v_stereo_aac.mp4'), join(k.root, 'input', 'v_stereo_aac.mp4'))
    const held: ApiPrompt = { ...reversed(), l: loadVideo('v_stereo_aac.mp4') }
    const kept: ApiPrompt = { l: loadVideo('v_stereo_aac.mp4'), g: getComp('l'), t: trim(['g', 0], 1), s: saveFrames(['t', 0]) }
    try {
      for (const [p, count, words] of [[held, 100, MEDIA_EFFECT_WORDS.heldTooMuch], [kept, 320, MEDIA_EFFECT_WORDS.keptTooMuch]] as const) {
        shapeHook.source = async (_id, cls) => (cls === 'GetVideoComponents' ? { count, ...HD, exact: false } : null)
        const from = jobs.list.length
        await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toMatchObject({ statusCode: 400, message: words, data: { reason: RUNNER_NOT_ELIGIBLE } })
        // The start checks read the file's header (ffprobe); no decode or encode started.
        expect(jobs.list.slice(from).filter(j => j.tool === 'ffmpeg')).toEqual([])
      }
    }
    finally { shapeHook.source = null }
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })
})

// ── Letting go (ruling (j)) ──────────────────────────────────────────────────

describe('kept batches let go once their readers have finished, and made again after a restart', () => {
  const clip = 'v_stereo_aac.mp4'
  function kit(dir: string, families: ReadonlySet<RunnerFamily>) {
    const k = makeKit({ dir, root: join(dir, 'root'), deps: { families: () => families, kept: createFileKeptBytes(join(dir, 'kept')) } })
    copyFileSync(clipPath(clip), join(k.root, 'input', clip))
    return k
  }
  const flow = (): ApiPrompt => ({ l: loadVideo(clip), g: getComp('l'), t: trim(['g', 0], 1), r: reverse(['t', 0]), s: saveFrames(['r', 0]) })
  const keptNames = (dir: string, runId: string) => (existsSync(join(dir, 'kept', runId)) ? readdirSync(join(dir, 'kept', runId)).filter(n => /\.(?:mkv|wav)$/.test(n)).sort() : [])

  it('lets go of every batch and sound as soon as nothing reads it any more, and marks each on its holders', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'release-'))
    const k = kit(dir, ON)
    const { runId } = await k.engine.startRun({ userId: null, takes: [flow()], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 'g', 't', 'r', 's']) expect(t.nodes[id]!.status, `${id}: ${t.nodes[id]!.error ?? ''}`).toBe('done')
    const batch = (id: string) => (t.nodes[id]!.values![0] as { file: OutputFile }).file.filename
    expect(t.nodes.g!.released).toEqual(expect.arrayContaining([batch('g')]))
    expect(t.nodes.t!.released).toEqual([batch('t')])
    expect(t.nodes.r!.released).toEqual([batch('r')])
    // Nothing is kept once the run is over: every batch (and Get video components' sound) was let go.
    expect(keptNames(dir, runId)).toEqual([])
  })

  it('with the R6 families off, a run keeps what it made until it ends, as before', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'release-off-'))
    const k = kit(dir, new Set(CARDS_VIDEO))
    const { runId } = await k.engine.startRun({ userId: null, takes: [{ l: loadVideo(clip), g: getComp('l'), s: saveFrames(['g', 0]) }], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    expect(t.nodes.s!.status).toBe('done')
    expect(t.nodes.g!.released).toBeUndefined()
    expect(keptNames(dir, runId)).toContain((t.nodes.g!.values![0] as { file: OutputFile }).file.filename)
  })

  it('a released value is made again after a restart, bit for bit', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'revive-'))
    const k1 = kit(dir, ON)
    const { runId } = await k1.engine.startRun({ userId: null, takes: [flow()], ...START })
    await k1.engine.settled(runId)
    const run = (await k1.store.get(runId))!
    const t = run.takes[0]!
    const trimmed = t.nodes.t!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    const got = (id: string) => (t.nodes[id]!.values![0] as { file: OutputFile }).file
    expect(keptNames(dir, runId)).toEqual([])
    await expect(k1.deps.kept!.verifiedPath(trimmed.file)).rejects.toThrow(KEPT_GONE)
    // As if the server stopped while Reverse was running: its turn (and Save video frames') to come again.
    t.nodes.r!.status = 'running'
    t.nodes.s!.status = 'waiting'
    run.status = 'running'
    run.legs.at(-1)!.status = 'running'
    for (const c of run.charges) c.finished = false
    await k1.store.save(run)
    const k2 = kit(dir, ON)
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    const again = (await k2.store.get(runId))!.takes[0]!
    for (const id of ['g', 't', 'r', 's']) expect(again.nodes[id]!.status, `${id}: ${again.nodes[id]!.error ?? ''}`).toBe('done')
    // Trim and Get video components ran again (their values were let go): the same bytes, so the same names.
    expect((again.nodes.t!.values![0] as { file: OutputFile }).file).toEqual(got('t'))
    expect((again.nodes.g!.values![0] as { file: OutputFile }).file).toEqual(got('g'))
    expect((again.nodes.r!.values![0] as { file: OutputFile }).file).toEqual(got('r'))
    expect(again.nodes.s!.outputs).toHaveLength(1)
  })
})

// ── Rule 12 ──────────────────────────────────────────────────────────────────

describe('rule 12: with every R6 family off (or on with the tools missing), every answer is as before R6.1', () => {
  it('the server answers the R6 families as off while the tools are missing', () => {
    const env = { ...process.env }
    process.env.NUXT_RUNNER_ENABLED = 'true'
    process.env.NUXT_RUNNER_FAMILIES = 'cards,media-video,media-sound,video-time,sound-effects'
    try {
      TOOLS.ready = false
      expect([...runnerFamilies()]).toEqual(['cards'])
      TOOLS.ready = true
      expect([...runnerFamilies()].sort()).toEqual(['cards', 'media-sound', 'media-video', 'sound-effects', 'video-time'])
    }
    finally {
      TOOLS.ready = null
      process.env = env
    }
  })

  it('PICTURE_OUTPUTS is the pinned one, and the teeth: with video-time on, the answers differ', () => {
    const pin = rule12Pin()
    expect(PICTURE_OUTPUTS).toEqual(pin.pictureOutputs)
    const g = pin.graphs['hand-made reversed']!
    expect(hash16(invariantAnswers(g.prompt, ON))).not.toBe(g.answers.cards)
  })

  const PROJECTS = fileURLToPath(new URL('../../../user/sailor/projects/', import.meta.url))
  const projectsIt = existsSync(PROJECTS) ? it : it.skip
  projectsIt('over every saved project graph (made into prompts as the app makes them): the answers pinned from before R6.1', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(fileURLToPath(new URL('../../server/native/objectInfo.baseline.json.gz', import.meta.url)))).toString('utf8'))
    const pin = rule12Pin()
    let graphs = 0
    let matched = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        graphs++
        // A project edited since the pin was made has another prompt: it can't be compared.
        const want = pin.saved[hash16(p)]
        if (!want) continue
        matched++
        for (const [set, fam] of Object.entries(pin.sets)) {
          expect(hash16(invariantAnswers(p, new Set(fam as RunnerFamily[]))), `${uuid}, ${set}`).toBe(want[set])
        }
      }
    }
    expect(matched).toBeGreaterThanOrEqual(800)
    console.info(`[media-vfx] rule 12 held over ${matched} of ${graphs} saved graphs, against the answers pinned at ${pin.commit}`)
  }, 300_000)
})

// ── Fix round 1 ──────────────────────────────────────────────────────────────

describe('fix round 1 (I1): the start pass bounds a source’s frames, never estimates them', () => {
  const clip = 'g_video_ps.mpg'

  it('an MPEG-PS clip: Python’s estimate is under its decoded frames; the bound counts its packets (its rate varies)', LONG, async () => {
    await requireMediaTools()
    const path = clipPath(clip)
    const p = await probeMedia(path, { userId: null, roots: [join(path, '..')] })
    expect(await pyFrameCount(p, p.path, { userId: null })).toBe(6)
    expect(await pyFrameBound(p, { userId: null })).toEqual({ frames: 8, counted: true })
    // A constant-rate file: ceil(length × rate) + 2, from its header, without counting.
    const cfr = clipPath('v_stereo_aac.mp4')
    const q = await probeMedia(cfr, { userId: null, roots: [join(cfr, '..')] })
    expect(await pyFrameBound(q, { userId: null })).toEqual({ frames: 26, counted: false })
    expect(await pyFrameBound(q, { userId: null, count: true })).toEqual({ frames: 24, counted: true })
  })

  function hostedKit() {
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const k = makeKit({ hosted: true, dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    for (const c of [clip, 'v_stereo_aac.mp4']) copyFileSync(clipPath(c), join(k.root, 'input', c))
    return k
  }
  const reversedFrom = (file: string): ApiPrompt => ({ l: loadVideo(file), g: getComp('l'), r: reverse(['g', 0]), s: saveFrames(['r', 0]) })
  /** Reverse's held figure for `count` frames of `w` × `h` (table.ts effectHeldBytes: the frames held, in hand and on the worker). */
  const reverseHeld = (count: number, w: number, h: number) => VIDEO_EFFECTS.VideoReverse!.heldBytes({ mode: 'reverse' }, [{ count, w, h, exact: false }])

  it('a variable-rate clip whose estimate is under the held limit and whose real count is over it leaves the workflow to the engine; the node’s own check is the backstop', LONG, async () => {
    await requireMediaTools()
    const k = hostedKit()
    const caps = MEDIA_CAPS.hosted as { heldFrameBytes: number }
    const saved = caps.heldFrameBytes
    // 32 × 24: 6 frames (the estimate) fit, 8 (its frames) don't.
    caps.heldFrameBytes = reverseHeld(7, 32, 24)
    expect(reverseHeld(6, 32, 24)).toBeLessThanOrEqual(caps.heldFrameBytes)
    expect(reverseHeld(8, 32, 24)).toBeGreaterThan(caps.heldFrameBytes)
    try {
      await expect(k.engine.startRun({ userId: k.userId, takes: [reversedFrom(clip)], ...START }))
        .rejects.toMatchObject({ statusCode: 400, message: MEDIA_EFFECT_WORDS.heldTooMuch, data: { reason: RUNNER_NOT_ELIGIBLE } })
      expect(k.ledger.hold).not.toHaveBeenCalled()
      // Had it run, Reverse would have failed at its turn, plainly (the backstop).
      await asHosted(async () => {
        const h = vfxHarness(scratch, { hosted: true })
        const runId = vfxRunId(++runs)
        const eight = await keptBatch(h, runId, { frames: Array.from({ length: 8 }, (_, i) => new Uint8Array(32 * 24 * 3).fill(i)), w: 32, h: 24 })
        await expect(runVfxNode(h, reversedFrom(clip), 'r', { g: { 0: eight } }, { runId, families: ON })).rejects.toThrow(MEDIA_EFFECT_WORDS.heldTooMuch)
      })
    }
    finally { caps.heldFrameBytes = saved }
  })

  it('a bound within 10% of a hosted limit is measured again with the packets counted, before the hold', LONG, async () => {
    await requireMediaTools()
    const k = hostedKit()
    const caps = MEDIA_CAPS.hosted as { heldFrameBytes: number }
    const saved = caps.heldFrameBytes
    // The header bound (26 frames) lands within 10% of the limit; its 24 frames, counted, fit.
    caps.heldFrameBytes = reverseHeld(26, 32, 24) + 1
    try {
      const from = jobs.list.length
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [reversedFrom('v_stereo_aac.mp4')], ...START })
      const counted = jobs.list.slice(from).filter(j => j.tool === 'ffprobe' && j.args.includes('-count_packets'))
      expect(counted.length).toBeGreaterThanOrEqual(1)
      await k.engine.settled(runId)
      expect((await k.store.get(runId))!.takes[0]!.nodes.s!.status).toBe('done')
    }
    finally { caps.heldFrameBytes = saved }
  })
})

describe('fix round 1 (I2): the kept total is pessimistic about branches running side by side', () => {
  const HD = { w: 1920, h: 1080 }
  it('300 frames of 1080p into four Frame trails, each saved, leaves the workflow to the engine in hosted', async () => {
    const p: ApiPrompt = { l: loadVideo('a.mp4'), g: getComp('l') }
    const shapes = new Map([['g:0', { count: 300, ...HD, exact: false }]])
    for (let i = 1; i <= 4; i++) {
      p[`f${i}`] = trail(['g', 0])
      p[`s${i}`] = saveFrames([`f${i}`, 0])
      shapes.set(`f${i}:0`, { count: 300, ...HD, exact: false })
    }
    expect(await mediaEffectStartProblems(p, ON, { hosted: true, shapes }))
      .toMatchObject({ message: MEDIA_EFFECT_WORDS.keptTooMuch, engine: true })
    // One trail alone fits: Get video components' batch and its own.
    const one: ApiPrompt = { l: p.l!, g: p.g!, f1: p.f1!, s1: p.s1! }
    expect(await mediaEffectStartProblems(one, ON, { hosted: true, shapes })).toBeNull()
  })

  it('counts Get video components’ kept sound (never let go), and nothing is let go between takes', async () => {
    const { keptPeak } = await import('~~/server/runner/video/start')
    const p: ApiPrompt = { l: loadVideo('a.mp4'), g: getComp('l'), t: trim(['g', 0], 1), s: saveFrames(['t', 0]) }
    const plain = new Map([['g:0', { count: 10, w: 64, h: 48, exact: false }], ['t:0', { count: 9, w: 64, h: 48, exact: false }]])
    const withSound = new Map([['g:0', { count: 10, w: 64, h: 48, exact: false, soundBytes: 5_000_000 }], ['t:0', { count: 9, w: 64, h: 48, exact: false }]])
    const a = keptPeak(p, ON, plain, { release: true })!
    const b = keptPeak(p, ON, withSound, { release: true })!
    expect(b.bytes - a.bytes).toBe(5_000_000)
    // A chain lets its source go once the next node has read it; with several takes nothing is let go.
    const chain: ApiPrompt = { ...p, t2: trim(['t', 0], 1), s: saveFrames(['t2', 0]) }
    const shapes3 = new Map([...plain, ['t2:0', { count: 8, w: 64, h: 48, exact: false }]])
    expect(keptPeak(chain, ON, shapes3, { release: false })!.bytes).toBeGreaterThan(keptPeak(chain, ON, shapes3, { release: true })!.bytes)
  })
})

describe('fix round 1 (I3): a lease job’s time is the tool’s own, with no whole-node limit locally', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(scratch, 'clock-')) })
  afterEach(async () => {
    fake.tools = null
    const { __setMediaClockForTests } = await import('~~/server/media/run')
    __setMediaClockForTests(null)
  })
  function tool(body: string): void {
    const f = join(dir, 'ffmpeg')
    writeFileSync(f, `#!/bin/sh\n${body}\n`)
    chmodSync(f, 0o755)
    fake.tools = { ffmpeg: f, ffprobe: f, version: 'ffmpeg version 8.0.3-sailor1', buildconf: [], encoders: new Set(), protocols: { input: ['file', 'pipe'], output: ['file', 'pipe'] } }
  }
  /** A thousand stubbed milliseconds for every real one: a real second is almost 17 minutes. */
  async function stubClock(): Promise<void> {
    const { __setMediaClockForTests } = await import('~~/server/media/run')
    const t0 = Date.now()
    __setMediaClockForTests({ now: () => t0 + (Date.now() - t0) * 1000, tickMs: 20 })
  }
  const leased = (o: { onStdout?: (c: Uint8Array) => Promise<void> } = {}) => mediaLease({ userId: null }, lease =>
    runMedia({ tool: 'ffmpeg', args: ['-i', 'pipe:0', 'pipe:1'], userId: null, lease, ...(o.onStdout ? { onStdout: o.onStdout } : {}) }))
  // A tool that works for 1.5 s (25 stubbed minutes), printing as it goes.
  const busy = 'i=0; while [ $i -lt 30 ]; do printf x; /bin/sleep 0.05; i=$((i+1)); done'

  it('locally a tool that keeps working runs past the old 30-minute limit', LONG, async () => {
    tool(busy)
    await stubClock()
    const r = await leased()
    expect(Buffer.from(r.stdout!).toString()).toBe('x'.repeat(30))
  })

  it('in hosted the tool’s own time is held to the job limit (10 minutes)', LONG, async () => {
    tool(busy)
    await stubClock()
    await asHosted(async () => {
      await expect(leased()).rejects.toThrow(MEDIA_WORDS.timedOut)
    })
  })

  it('a tool that makes no progress for five minutes is killed (the stall watchdog)', LONG, async () => {
    tool('exec /bin/sleep 30')
    await stubClock()
    const t0 = Date.now()
    await expect(leased()).rejects.toThrow(MEDIA_WORDS.timedOut)
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  it('time the node holds the tool up (its frame on the worker, a slot) isn’t counted', LONG, async () => {
    tool('printf a; /bin/sleep 0.05; printf b; /bin/sleep 0.05; printf c')
    await stubClock()
    let chunks = 0
    // Each chunk held for 0.5 s (over eight stubbed minutes), past the stall limit: none of it is the tool's.
    await leased({ onStdout: async () => { chunks++; await sleep(500) } })
    expect(chunks).toBeGreaterThanOrEqual(1)
  })
})

describe('fix round 1 (M1): a release never removes a batch made again since it was decided', () => {
  const rec = (status: string, values?: Record<number, RunnerValue>) => ({ status, classType: 'VideoTrim', leg: 0, endpoint: null, payload: null, fingerprint: null, request: null, outputs: [], reused: false, credits: 0, startedAt: null, endedAt: null, error: null, ...(values ? { values } : {}) })

  it('another take making the same bytes after the snapshot keeps the file', async () => {
    const dir = mkdtempSync(join(scratch, 'race-'))
    const kept = withRunCap(createFileKeptBytes(dir), () => Number.POSITIVE_INFINITY)
    const runId = vfxRunId(++runs)
    const bytes = Buffer.from('the same batch')
    const write = async () => {
      const work = await kept.workDir(runId)
      writeFileSync(join(work, 'frames.mkv'), bytes)
      return kept.putPath(runId, join(work, 'frames.mkv'), 'mkv')
    }
    const file = await write()
    const value: RunnerValue = { kind: 'frames', file, count: 1, w: 1, h: 1 }
    const prompt: ApiPrompt = { a: trim(['x', 0]), r: saveFrames(['a', 0]) }
    // Take 0 made it and read it; take 1's maker hasn't started.
    const run = {
      id: runId,
      takes: [
        { index: 0, prompt, nodes: { a: rec('done', { 0: value }), r: rec('done') }, openGates: [], droppedGates: [] },
        { index: 1, prompt, nodes: { a: rec('waiting'), r: rec('waiting') }, openGates: [], droppedGates: [] },
      ],
    } as never as Parameters<typeof spentKeptMedia>[0]
    const spent = spentKeptMedia(run)
    expect(spent.map(s => s.file)).toEqual([file])
    // Take 1's maker starts after the snapshot and puts the same bytes; the release, queued behind it, asks again.
    run.takes[1]!.nodes.a!.status = 'running'
    const again = write()
    const still = () => spentKeptMedia(run).some(x => x.file.filename === file.filename)
    const released = kept.release(runId, file, { still })
    expect(await again).toEqual(file)
    expect(await released).toBe(false)
    expect(await kept.exists(file)).toBe(true)
    // With nothing made again, the same release lets it go.
    run.takes[1]!.nodes.a!.status = 'waiting'
    expect(await kept.release(runId, file, { still })).toBe(true)
    expect(await kept.exists(file)).toBe(false)
  })
})

describe('fix round 1 (M3): the held figure counts the worker’s float tensors', () => {
  it('one cost model: frames held and in hand, the worker’s 8-bit frames and its float32 tensors and state', async () => {
    const { effectHeldBytes } = await import('~~/server/runner/video/table')
    const s = { count: 10, w: 4096, h: 4096, exact: true }
    const f8 = 4096 * 4096 * 3
    // Frame trail: in hand 2 + worker 3 frames at 8 bits; input, output and trail as float32.
    expect(VIDEO_EFFECTS.FrameTrail!.heldBytes({}, [s])).toBe(5 * f8 + 3 * 4 * f8)
    expect(VIDEO_EFFECTS.FrameTrail!.heldBytes({}, [s])).toBe(effectHeldBytes(s, { reads: 1, state32: 1 }))
    expect(VIDEO_EFFECTS.VideoTrim!.heldBytes({}, [s])).toBe(5 * f8 + 2 * 4 * f8)
    expect(VIDEO_EFFECTS.VideoReverse!.heldBytes({ mode: 'reverse' }, [s])).toBe((10 + 5) * f8 + 2 * 4 * f8)
    // At a hosted 4096² frame Frame trail holds about 850 MB: over 512 MiB, so it goes to the engine.
    expect(VIDEO_EFFECTS.FrameTrail!.heldBytes({}, [s])).toBeGreaterThan(MEDIA_CAPS.hosted.heldFrameBytes)
  })
})
