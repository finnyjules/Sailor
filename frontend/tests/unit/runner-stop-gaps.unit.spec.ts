/**
 * Step 3, R11.9a: the guard over every named stop-gap (R11.9's table, rows
 * 1–28). With every family on, no row leaves to the engine: each either runs
 * in Sailor, or is refused in plain words before the hold (USER ruling (e)),
 * with a reason code. Rows closed by other tasks are asserted where they are
 * true now; the rows that belong to R9/R10 (and R11.9b/c) are listed as
 * expected exceptions until those tasks land, so the list must shrink then.
 *
 * Also R11.7's and R11.8's named stop-gaps: a made sound past a reader's cap
 * (named with its maker's setting to shorten), a paid video model's sound
 * into a sound effect, several still pictures into Slow motion (AI), a count
 * known only as an upper bound past a per-frame cap, the hosted kept room.
 *
 * No paid calls: the providers are fakes; keys unset.
 */
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { EVERY_KNOWN_FAMILY, MEDIA_TOOL_FAMILIES, MEDIA_EFFECT_TOOL_FAMILIES, LOCAL_MODEL_TOOL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import {
  CARD_EXPORT_ADVICE, CLIP_INTO_PICTURE_WORDS, LETTERS_WORDS, LUT_OUTSIDE_WORDS, NOT_INSTALLED_WORDS, PICTURE_BATCH_ADVICE, RUNNER_NOT_ELIGIBLE,
  TOO_MUCH_WORK_WORDS, VIDEO_FORMAT_ADVICE, captionsTooLongWords, lengthWords, madeSoundTooLongWords, oddTextWords, switchedOffWords, wiredSettingWords, withAdvice,
  type RunnerReasonCode,
} from '#shared/runner/messages'
import { stopGapRefusal, switchedOffNodes } from '#shared/runner/stopGaps'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { needsEngineReasons, nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_WORDS } from '#shared/runner/media'
import { MEDIA_EFFECT_WORDS } from '#shared/runner/mediaEffects'
import {
  FRAME_INTERP_AI_CLASS, LOCAL_MODEL_MAX_FRAMES, LOCAL_MODEL_WORDS, MASK_EXTRACTOR_CLASS, SAM_MASK_WORDS, SLOW_MOTION_AI_MAX_FRAMES, SLOW_MOTION_AI_WORDS,
  UPSCALE_2X_MAX_PIXELS, UPSCALE_2X_TILED_MAX_PIXELS, UPSCALE_2X_WORDS, VOCALS_CLASS, VOCALS_PIECE_SECONDS, WHISPER_CLASS, overCapWords, whisperCeilingSeconds, whisperMaxSeconds,
} from '#shared/runner/localModels'
import { parseMaskPoints, samPointsInput } from '#shared/runner/samInput'
import { isEditorOnlyClass, retiredAdviceOf } from '#shared/runner/retired'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { lipSyncRunEngine } from '#shared/runner/lipSyncEngines'
import { cloneSecondsBound, musicSecondsBound, speechSecondsBound } from '#shared/runner/sourceBounds'
import { CAPTIONS_MAX_CHARS, VIDEO_EFFECTS } from '~~/server/runner/video/table'
import { VIDEO_NOT_MP4 } from '~~/server/runner/media/videoNodes'
import { MEDIA_TOOLS_MISSING } from '~~/server/media/tools'
import { startStopGap } from '~~/server/runner/stopGapWords'
import { localModelStartProblems, slowMotionAiStart } from '~~/server/runner/localModelStart'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import { makeKit } from './__runner__/kit'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'

const EVERY: ReadonlySet<RunnerFamily> = EVERY_KNOWN_FAMILY
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const LONG = { timeout: 120_000 }
const scratch = mkdtempSync(join(tmpdir(), 'runner-stop-gaps-'))
type Link = [string, number]

const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const saveImage = (from: Link) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE_DEFAULTS } })
const previewImage = (from: Link) => ({ class_type: 'PreviewImage', inputs: { images: from } })
const loadImage = (file = 'p.png') => ({ class_type: 'LoadImage', inputs: { image: file, upload: 'image' } })
const loadFrames = (file: string, s: Record<string, unknown> = {}) => ({ class_type: 'LoadVideoFrames', inputs: { file, max_seconds: 10, max_frames: 600, max_size: 720, start_frame: 0, stride: 1, ...s } })
const loadVideo = (file: string) => ({ class_type: 'LoadVideo', inputs: { file } })
const saveVideo = (from: string) => ({ class_type: 'SaveVideo', inputs: { video: [from, 0] as Link, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })
const blur = (from: Link) => ({ class_type: 'Blur', inputs: { image: from, type: 'gaussian', radius: 2, angle: 0, length: 0, strength: 1 } })
const ascii = (characters: string) => ({
  class_type: 'Ascii',
  inputs: { image: ['l', 0] as Link, preset: 'custom', characters, cell_size: 8, gamma: 1, phase: 0, mix: 1, color_mode: 'monochrome', background: true, invert_order: false, pos_x: 0, pos_y: 0, blend_mode: 'normal' },
})
const speech = (chars: number) => ({ class_type: 'GenerateSpeechNode', inputs: { model: 'MiniMax Speech-02 HD', text: 'x'.repeat(chars), voice_id: 'Wise_Woman', emotion: 'auto', speed: 1, volume: 1, pitch: 0, language_boost: 'auto' } })

/** A start the runner refuses plainly: the code, the words, no engine marker, nothing held or sent. */
async function refusedPlainly(k: ReturnType<typeof makeKit>, take: ApiPrompt, code: RunnerReasonCode, words?: string | RegExp): Promise<Error & { data?: Record<string, unknown> }> {
  const err = await k.engine.startRun({ userId: k.userId, takes: [take], ...START }).catch(e => e as Error & { data?: Record<string, unknown> })
  expect(err, 'refused').toBeInstanceOf(Error)
  expect(err.data?.code, err.message).toBe(code)
  expect(err.data?.reason, `${code}: never the engine`).toBeUndefined()
  if (typeof words === 'string') expect(err.message).toBe(words)
  else if (words) expect(err.message).toMatch(words)
  expect(k.ledger.hold).not.toHaveBeenCalled()
  expect(k.fal.submitted()).toEqual([])
  expect(k.replicate.submitted()).toEqual([])
  return err
}

async function writePng(path: string, w = 16, h = 16) {
  writeFileSync(path, await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer())
}

// ── The table ────────────────────────────────────────────────────────────────

/**
 * Rows that still leave to the engine (or are another task's) on purpose, with
 * the task that closes each. When one lands, its row moves out of this list
 * and gets a case below (the test pins the list).
 */
const EXPECTED_EXCEPTIONS: Readonly<Record<number, string>> = {
  1: 'R10.1: apps’ local /prompt with families off ("This app is switched off right now.")',
  9: 'R11.9b: Motion blur (time) on clips over one frame (USER ruling (c))',
  11: 'R11.9c: the Animated Shader effect in a workflow (USER ruling (d))',
  27: 'R10.7: local LoRA training removed',
  28: 'R10.2 / R10.6: stock local-diffusion classes and blueprints ("This needs the local engine" locally)',
}

describe('R11.9: every named stop-gap, one case per row', () => {
  it('the expected exceptions are exactly rows 1, 9, 11, 27 and 28 (R10, R11.9b, R11.9c)', () => {
    expect(Object.keys(EXPECTED_EXCEPTIONS).map(Number)).toEqual([1, 9, 11, 27, 28])
  })

  // Rows 2–8, 10, 12–14 and 26: closed by their own tasks, asserted where true now.
  it('row 2 (R11.5): songs past Karaoke’s cap run in pieces at quiet points', () => {
    expect(VOCALS_PIECE_SECONDS).toBe(600)
  })
  it('row 3 (R11.5): Whisper over one call’s hour runs in pieces, up to its ceiling', () => {
    expect(whisperCeilingSeconds('local')).toBeGreaterThan(whisperMaxSeconds('local'))
    expect(whisperCeilingSeconds('hosted')).toBeGreaterThan(whisperMaxSeconds('hosted'))
  })
  it('row 4 (R11.6): Upscale (2×) past its service’s largest picture runs in tiles', () => {
    expect(UPSCALE_2X_TILED_MAX_PIXELS).toBeGreaterThan(UPSCALE_2X_MAX_PIXELS)
  })
  it('row 5 (R11.7): Slow motion (AI) past 240 frames runs in segments; past the cap refused with the cap in words', () => {
    expect(SLOW_MOTION_AI_MAX_FRAMES.hosted).toBeGreaterThan(240)
    expect(slowMotionAiStart({ multiplier: 2 }, { count: SLOW_MOTION_AI_MAX_FRAMES.hosted + 1, w: 64, h: 64, exact: true }, true))
      .toEqual({ refused: overCapWords(FRAME_INTERP_AI_CLASS, SLOW_MOTION_AI_MAX_FRAMES.hosted) })
  })
  it('row 6 (R11.7): per-frame classes keep measured caps, refused plainly past them', () => {
    expect(LOCAL_MODEL_MAX_FRAMES).toEqual({ hosted: 300, local: 900 })
    expect(overCapWords(FRAME_INTERP_AI_CLASS, 300)).toMatch(/300/)
  })
  it('rows 7–8 (R11.8): every maker bounded (music, speech, a cloned voice), never left', () => {
    expect(musicSecondsBound(8)).toBe(9)
    expect(speechSecondsBound('hello', 1)).toBeGreaterThan(5)
    expect(cloneSecondsBound(20)).toBe(21)
  })
  it('row 10 (R10.0): Face swap runs in Sailor with its family on (its provider is the user’s call, ruling (b))', () => {
    const p: ApiPrompt = { a: loadImage('a.png'), b: loadImage('b.png'), f: { class_type: 'FaceSwap', inputs: { source_face: ['a', 0], target_frames: ['b', 0] } }, s: saveImage(['f', 0]) }
    expect(nodesNeedingEngine(p, { runnerOn: true, families: EVERY, titleOf: id => id })).not.toContain('f')
  })
  it('rows 12–13 (R11.2, R11.3): Fabric and Kling lip-sync engines are known to the runner', () => {
    expect(lipSyncRunEngine({ model_options: JSON.stringify({ engine: 'fabric' }) })).toBe('fabric')
    expect(lipSyncRunEngine({ model_options: JSON.stringify({ face_video: '/view?filename=f.mp4&type=input' }) })).toBe('kling')
  })
  it('row 14 (R11.1): Relight is in the runner (its wired light ported)', () => {
    expect(EVERY.has('nano-extras')).toBe(true)
  })
  it('row 26 (R9.1): the Timeline node in a workflow is refused with advice to use its editor', () => {
    expect(isEditorOnlyClass('Timeline')).toBe(true)
    const r = blockedRunRefusal([{ prompt: { t: { class_type: 'Timeline', inputs: {} } }, titleOf: () => 'Timeline' }], { runnerOn: true, families: EVERY })
    expect(r).toEqual({ title: '“Timeline” can’t run in a workflow', description: retiredAdviceOf('Timeline') })
  })

  // ── Row 15: a clip's frames into a picture reader ──
  it('row 15: Save image and Preview image save each frame of a clip, one file each, as Python saves a batch', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const k = makeKit({ dir, deps: { families: () => EVERY, kept: createFileKeptBytes(join(dir, 'kept')) } })
    copyFileSync(clipPath('g_frames_big.mp4'), join(k.root, 'input', 'g_frames_big.mp4'))
    for (const reader of [saveImage, previewImage]) {
      const p: ApiPrompt = { l: loadFrames('g_frames_big.mp4', { max_size: 64, max_frames: 3 }), s: reader(['l', 0]) }
      expect(runnerTakesWorkflow(p, EVERY)).toBe(true)
      expect(stopGapRefusal(p, EVERY)).toBeNull()
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
      await k.engine.settled(runId)
      const t = (await k.store.get(runId))!.takes[0]!
      for (const id of ['l', 's']) expect(t.nodes[id]!.status, `${id}: ${t.nodes[id]!.error ?? ''}`).toBe('done')
      if (reader === saveImage) {
        const out = t.nodes.s!.outputs
        expect(out.map(f => f.filename)).toEqual(['ComfyUI_00001_.png', 'ComfyUI_00002_.png', 'ComfyUI_00003_.png'])
        expect(out.every(f => f.type === 'output')).toBe(true)
      }
      else {
        // Preview image writes into temp (not the run's assets), one file per frame.
        expect(readdirSync(join(k.root, 'temp')).filter(n => n.startsWith('ComfyUI_temp_') && n.endsWith('.png'))).toHaveLength(3)
      }
    }
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('row 15: any other picture reader (an effect) refuses a clip plainly before the hold', LONG, async () => {
    await requireMediaTools()
    const p: ApiPrompt = { l: loadFrames('g_frames_big.mp4', { max_size: 64, max_frames: 3 }), b: blur(['l', 0]), s: saveImage(['b', 0]) }
    expect(runnerTakesWorkflow(p, EVERY)).toBe(true)
    expect(stopGapRefusal(p, EVERY)).toEqual({ nodeId: 'b', classType: 'Blur', code: 'clip-into-picture', message: CLIP_INTO_PICTURE_WORDS })
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const k = makeKit({ dir, deps: { families: () => EVERY, kept: createFileKeptBytes(join(dir, 'kept')) } })
    copyFileSync(clipPath('g_frames_big.mp4'), join(k.root, 'input', 'g_frames_big.mp4'))
    const err = await refusedPlainly(k, p, 'clip-into-picture', CLIP_INTO_PICTURE_WORDS)
    expect(err.data?.nodeId).toBe('b')
  })

  // ── Row 16: SAM 3's typed points ──
  it('row 16: −1 is dropped and 2/3 sent as a box; what can’t be sent is refused with pointsFail', () => {
    expect(parseMaskPoints('[{"x":0.5,"y":0.5,"label":1},{"x":0.1,"y":0.1,"label":-1}]', 100, 100)).toEqual({ ok: true, points: [{ x: 50, y: 50, label: 1 }], boxes: [] })
    const box = parseMaskPoints('[{"x":0.8,"y":0.7,"label":3},{"x":0.2,"y":0.1,"label":2}]', 100, 100)
    expect(box).toEqual({ ok: true, points: [], boxes: [{ xMin: 20, yMin: 10, xMax: 80, yMax: 70 }] })
    expect(samPointsInput('u', [], (box as { boxes: [] }).boxes).box_prompts).toEqual([{ x_min: 20, y_min: 10, x_max: 80, y_max: 70 }])
    const node = (points: string): ApiPrompt => ({ l: loadImage(), n: { class_type: MASK_EXTRACTOR_CLASS, inputs: { image: ['l', 0], points, feather: 0, invert: false } } })
    expect(runnerTakesNode(node('[{"x":0.5,"y":0.5,"label":2},{"x":0.9,"y":0.9,"label":3}]'), 'n', EVERY)).toBe(true)
    for (const bad of ['[1, 2]', '[{"x":0.5,"y":0.5,"label":7}]', '[{"x":NaN,"y":0}]', '[{"x":0.5,"y":0.5,"label":2}]', '[{"x":0.5,"y":0.5,"label":-1}]']) {
      expect(runnerTakesWorkflow(node(bad), EVERY), bad).toBe(true)
      expect(stopGapRefusal(node(bad), EVERY), bad).toEqual({ nodeId: 'n', classType: MASK_EXTRACTOR_CLASS, code: 'click-points', message: SAM_MASK_WORDS.pointsFail })
    }
  })

  // ── Row 17: a wired setting read as typed ──
  it('row 17: Demucs’ shifts or model, and Whisper’s model size, wired: "Type this setting in; it can’t be wired."', () => {
    const k: ApiPrompt = { k: { class_type: 'PrimitiveInt', inputs: { value: 2 } }, t: { class_type: 'PrimitiveString', inputs: { value: 'htdemucs' } } }
    const vocals = (w: Record<string, unknown>): ApiPrompt => ({
      ...k, s: { class_type: 'LoadAudio', inputs: { audio: 'song.wav' } },
      v: { class_type: VOCALS_CLASS, inputs: { audio: ['s', 0], model: 'htdemucs', shifts: 1, ...w } },
      a: { class_type: 'SaveAudio', inputs: { audio: ['v', 0], filename_prefix: 'audio/ComfyUI' } },
    })
    expect(stopGapRefusal(vocals({ shifts: ['k', 0] }), EVERY)).toEqual({ nodeId: 'v', classType: VOCALS_CLASS, code: 'wired-setting', message: wiredSettingWords('shifts') })
    expect(stopGapRefusal(vocals({ model: ['t', 0] }), EVERY)).toEqual({ nodeId: 'v', classType: VOCALS_CLASS, code: 'wired-setting', message: wiredSettingWords('model') })
    expect(wiredSettingWords('shifts')).toBe('The shifts setting is wired. Type this setting in; it can’t be wired.')
    const whisper: ApiPrompt = {
      ...k, s: { class_type: 'LoadAudio', inputs: { audio: 'talk.wav' } },
      w: { class_type: WHISPER_CLASS, inputs: { audio: ['s', 0], model_size: ['t', 0], language: 'auto', fps: 24 } },
      t2: { class_type: 'Text', inputs: { source: ['w', 2], text: '' } },
    }
    const r = stopGapRefusal(whisper, EVERY)
    expect(runnerTakesWorkflow(whisper, EVERY)).toBe(true)
    expect(r).toEqual({ nodeId: 'w', classType: WHISPER_CLASS, code: 'wired-setting', message: wiredSettingWords('model size') })
    // Typed in, both are taken as they are.
    expect(stopGapRefusal(vocals({}), EVERY)).toBeNull()
  })

  // ── Row 18: odd text ──
  it('row 18: colour text, a painter file’s name: refused plainly, naming the field', () => {
    const gm = (dark: unknown): ApiPrompt => ({ l: loadImage(), g: { class_type: 'GradientMap', inputs: { image: ['l', 0], dark_color: dark, light_color: '#ffffff', midpoint: 0.5, contrast: 1, mix: 1 } } })
    expect(stopGapRefusal(gm('#000000'), EVERY)).toBeNull()
    for (const odd of [5, '#\u0661\u0662\u0663\u0664\u0665\u0666']) {
      expect(runnerTakesWorkflow(gm(odd), EVERY), String(odd)).toBe(true)
      expect(stopGapRefusal(gm(odd), EVERY), String(odd)).toEqual({ nodeId: 'g', classType: 'GradientMap', code: 'odd-text', message: oddTextWords('dark color') })
    }
    const painter: ApiPrompt = { p: { class_type: 'Painter', inputs: { mask: '../x.png', width: 64, height: 64, bg_color: '#000000' } }, s: saveImage(['p', 0]) }
    expect(stopGapRefusal(painter, EVERY)).toEqual({ nodeId: 'p', classType: 'Painter', code: 'odd-text', message: oddTextWords('painter file’s name') })
  })

  // ── Row 19: letters outside the atlas ──
  it('row 19: U+2800 in Ascii’s ramp is refused plainly before the hold', LONG, async () => {
    const p: ApiPrompt = { l: loadImage(), a: ascii('⠀ab') }
    expect(runnerTakesWorkflow(p, EVERY)).toBe(true)
    expect(stopGapRefusal(p, EVERY)).toEqual({ nodeId: 'a', classType: 'Ascii', code: 'letters', message: LETTERS_WORDS })
    expect(stopGapRefusal({ l: loadImage(), a: ascii('#ab') }, EVERY)).toBeNull()
    const k = makeKit({ deps: { families: () => EVERY } })
    await writePng(join(k.root, 'input', 'p.png'))
    await refusedPlainly(k, p, 'letters', LETTERS_WORDS)
    // The refusal names the node by the title the person gave it.
    const titled = await k.engine.startRun({ userId: k.userId, takes: [p], ...START, workflow: { nodes: [{ id: 'a', type: 'Ascii', title: 'Ascii art' }] } }).catch(e => e)
    expect(titled.message).toBe(`“Ascii art”: ${LETTERS_WORDS}`)
    expect(titled.data).toMatchObject({ nodeId: 'a', classType: 'Ascii', code: 'letters' })
  })

  // ── Row 20: video formats; ProRes card export ──
  it('row 20: a file neither the sniffer nor the build reads is refused, saying what to change', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const k = makeKit({ dir, deps: { families: () => EVERY, kept: createFileKeptBytes(join(dir, 'kept')) } })
    writeFileSync(join(k.root, 'input', 'odd.rm'), Buffer.from('.RMF not really RealMedia'.repeat(64)))
    await refusedPlainly(k, { l: loadVideo('odd.rm'), s: saveVideo('l') }, 'video-format', withAdvice(MEDIA_WORDS.unreadable, VIDEO_FORMAT_ADVICE))
  })
  it('row 20: ProRes card export: the bundled build has no ProRes encoder (checked 2026-10-02), so it is refused plainly', () => {
    expect(startStopGap({ message: VIDEO_NOT_MP4 })).toEqual({ code: 'video-format', message: withAdvice(VIDEO_NOT_MP4, CARD_EXPORT_ADVICE) })
  })

  // ── Row 21: LUTs and the waveform's sound ──
  it('row 21: a LUT outside the folders or too large, a sound past 384 kHz: refused plainly', () => {
    expect(startStopGap({ message: MEDIA_EFFECT_WORDS.lutMissing })).toEqual({ code: 'lut', message: LUT_OUTSIDE_WORDS })
    expect(startStopGap({ message: MEDIA_EFFECT_WORDS.lutTooBig })).toEqual({ code: 'lut', message: withAdvice(MEDIA_EFFECT_WORDS.lutTooBig, 'Use a LUT file under 16 MB.') })
  })

  // ── Row 22: typed captions over the cap ──
  it('row 22: captions over 200,000 characters: refused plainly (lifting the cap is parked)', () => {
    const limits = VIDEO_EFFECTS.CaptionTrack!.limits!({ captions: 'x'.repeat(CAPTIONS_MAX_CHARS + 1), font_size: 32, outline_width: 2 }, [], {})
    const over = limits.find(f => f.value > f.limit)!
    expect(over.message).toBe(MEDIA_EFFECT_WORDS.textTooLong)
    expect(startStopGap({ message: over.message, classType: 'CaptionTrack' })).toEqual({ code: 'captions-too-long', message: captionsTooLongWords(CAPTIONS_MAX_CHARS) })
    expect(captionsTooLongWords(CAPTIONS_MAX_CHARS)).toBe('These captions are too long to draw here. Keep them under 200,000 characters.')
  })

  // ── Row 23: hosted work and kept-room caps ──
  it('row 23: past a work, memory or kept-room figure: "too much work for one run here"', async () => {
    for (const words of [MEDIA_EFFECT_WORDS.heldTooMuch, MEDIA_EFFECT_WORDS.tooMuchWork, MEDIA_EFFECT_WORDS.keptTooMuch, MEDIA_EFFECT_WORDS.soundTooLong, MEDIA_EFFECT_WORDS.soundKeptTooMuch, MEDIA_WORDS.tooLong, LOCAL_MODEL_WORDS.overCap]) {
      expect(startStopGap({ message: words }), words).toEqual({ code: 'too-much-work', message: withAdvice(words, TOO_MUCH_WORK_WORDS) })
    }
    expect(TOO_MUCH_WORK_WORDS).toMatch(/too much work for one run here/)
    // In the engine, hosted: Empty audio past R5's sound cap → Fade → Save audio, before any hold.
    const k = makeKit({ hosted: true, deps: { families: () => EVERY } })
    const p: ApiPrompt = {
      e: { class_type: 'EmptyAudio', inputs: { duration: 3000, sample_rate: 48000, channels: 2 } },
      f: { class_type: 'AudioFade', inputs: { audio: ['e', 0], fade_in: 0.5, fade_out: 0.5, curve: 'linear' } },
      s: { class_type: 'SaveAudio', inputs: { audio: ['f', 0], filename_prefix: 'audio/ComfyUI' } },
    }
    expect(runnerTakesWorkflow(p, EVERY)).toBe(true)
    await refusedPlainly(k, p, 'too-much-work', /too much work for one run here/)
  })

  // ── Row 24: what isn't installed ──
  it('row 24: a family switched on whose tools aren’t installed: "This isn’t installed on this server."', LONG, async () => {
    const tools = new Set<RunnerFamily>([...MEDIA_TOOL_FAMILIES, ...MEDIA_EFFECT_TOOL_FAMILIES, ...LOCAL_MODEL_TOOL_FAMILIES])
    const on = new Set<RunnerFamily>([...EVERY].filter(f => !tools.has(f)))
    const k = makeKit({ deps: { families: () => on, uninstalled: () => tools } })
    const p: ApiPrompt = { l: { class_type: 'LoadAudio', inputs: { audio: 'a.wav' } }, s: { class_type: 'SaveAudio', inputs: { audio: ['l', 0], filename_prefix: 'audio/ComfyUI' } } }
    await refusedPlainly(k, p, 'not-installed', NOT_INSTALLED_WORDS)
    expect(startStopGap({ message: MEDIA_TOOLS_MISSING })).toEqual({ code: 'not-installed', message: NOT_INSTALLED_WORDS })
    expect(startStopGap({ message: MEDIA_EFFECT_WORDS.textFontMissing })).toEqual({ code: 'not-installed', message: NOT_INSTALLED_WORDS })
  })

  // ── Row 25: a family that is off ──
  it('row 25: a family off still goes to the engine until R10.0, with a code and "Name is switched off right now."', async () => {
    const off = new Set<RunnerFamily>([...EVERY].filter(f => f !== 'effects-blur'))
    const p: ApiPrompt = { l: loadImage(), b: blur(['l', 0]), s: saveImage(['b', 0]) }
    expect(switchedOffNodes(p, off)).toEqual(['b'])
    expect(needsEngineReasons(p, { runnerOn: true, families: off, titleOf: id => (id === 'b' ? 'Soft blur' : id) })).toEqual([switchedOffWords('Soft blur')])
    const k = makeKit({ deps: { families: () => off } })
    await writePng(join(k.root, 'input', 'p.png'))
    const err = await k.engine.startRun({ userId: k.userId, takes: [p], workflow: { nodes: [{ id: 'b', type: 'Blur', title: 'Soft blur' }] }, canvasId: null, projectUuid: null, projectName: null }).catch(e => e)
    expect(err.message).toBe('“Soft blur” is switched off right now.')
    expect(err.data).toMatchObject({ reason: RUNNER_NOT_ELIGIBLE, code: 'switched-off', nodeId: 'b' })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    // With every family on, it runs.
    expect(isRunnerEligible(p, EVERY)).toBe(true)
  })
})

// ── R11.7's and R11.8's named stop-gaps ──────────────────────────────────────

describe('R11.7 / R11.8 stop-gaps: refused plainly before the hold, never the engine', () => {
  it('a made sound past a reader’s cap names the maker’s setting to shorten, with the figure', LONG, async () => {
    await requireMediaTools()
    const p: ApiPrompt = {
      sp: speech(2500),
      f: { class_type: 'AudioFade', inputs: { audio: ['sp', 0], fade_in: 0.5, fade_out: 0.5, curve: 'linear' } },
      s: { class_type: 'SaveAudio', inputs: { audio: ['f', 0], filename_prefix: 'audio/ComfyUI' } },
    }
    const k = makeKit({ hosted: true, deps: { families: () => EVERY } })
    const err = await refusedPlainly(k, p, 'made-sound-too-long', /^This speech could run past .+, which is the most a sound effect takes here\. Shorten the text to under [\d,]+ characters\.$/)
    expect(err.data?.nodeId).toBe('f')
    expect(madeSoundTooLongWords({ maker: 'speech', limitSeconds: 1800, reader: 'Whisper transcribe', under: 1799 }))
      .toBe('This speech could run past 30 minutes, which is the most Whisper transcribe takes here. Shorten the text to under 1,799 characters.')
    expect(madeSoundTooLongWords({ maker: 'music', limitSeconds: 90, reader: 'Create video', under: 89 })).toBe('This music could run past 1 minute 30 seconds, which is the most Create video takes here. Set its length to under 89 seconds.')
    expect(lengthWords(3600)).toBe('1 hour')
  })

  it('a paid video model’s sound into a sound effect names the model and the limit', LONG, async () => {
    const p: ApiPrompt = {
      v: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'a boat', aspect_ratio: '16:9', duration: '8', seed: 0 } },
      c: { class_type: 'Video', inputs: { source: ['v', 0], file: '', export: false, filename_prefix: 'video' } },
      g: { class_type: 'GetVideoComponents', inputs: { video: ['c', 0] } },
      f: { class_type: 'AudioFade', inputs: { audio: ['g', 1], fade_in: 0.5, fade_out: 0.5, curve: 'linear' } },
      s: { class_type: 'SaveAudio', inputs: { audio: ['f', 0], filename_prefix: 'audio/ComfyUI' } },
    }
    expect(runnerTakesWorkflow(p, EVERY)).toBe(true)
    const k = makeKit({ hosted: true, deps: { families: () => EVERY } })
    await refusedPlainly(k, p, 'paid-video-sound', /^The sound of a video from .+ can’t be measured before the run, and a sound effect here takes at most 30 minutes of sound\. Save the video, then load it with Load video\.$/)
  })

  it('several still pictures into Slow motion (AI) are refused plainly; one is handed on', async () => {
    const p = (batch: number): ApiPrompt => ({
      e: { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: batch, color: 0 } },
      m: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['e', 0], multiplier: 2 } },
      s: saveImage(['m', 0]),
    })
    const got = await localModelStartProblems(p(3), EVERY, { hosted: false, shapes: async () => new Map() })
    expect(got.problem).toMatchObject({ message: SLOW_MOTION_AI_WORDS.pictureBatch, nodeId: 'm' })
    expect(startStopGap(got.problem!)).toEqual({ code: 'picture-batch', message: withAdvice(SLOW_MOTION_AI_WORDS.pictureBatch, PICTURE_BATCH_ADVICE) })
    expect((await localModelStartProblems(p(1), EVERY, { hosted: false, shapes: async () => new Map() })).problem).toBeNull()
    expect(runnerTakesWorkflow(p(3), EVERY)).toBe(true)
    const k = makeKit({ deps: { families: () => EVERY } })
    await refusedPlainly(k, p(3), 'picture-batch')
  })

  it('a count known only as an upper bound past a per-frame cap is held at the cap (R11.8); a sure one past it is refused with the cap in words', () => {
    const cap = SLOW_MOTION_AI_MAX_FRAMES.hosted
    const upper = slowMotionAiStart({ multiplier: 2 }, { count: cap * 3, w: 64, h: 64, exact: false }, true)
    expect('frames' in upper && upper.frames).toBeLessThanOrEqual(cap)
    expect(slowMotionAiStart({ multiplier: 2 }, { count: cap * 3, w: 64, h: 64, exact: false, counted: true }, true)).toEqual({ refused: overCapWords(FRAME_INTERP_AI_CLASS, cap) })
  })

  it('what can’t be counted or sized, and the hosted kept room, are refused plainly in the start’s words', () => {
    expect(startStopGap({ message: LOCAL_MODEL_WORDS.unknownCount }).code).toBe('unknown-length')
    expect(startStopGap({ message: UPSCALE_2X_WORDS.unknownSize }).code).toBe('unknown-length')
    expect(startStopGap({ message: UPSCALE_2X_WORDS.tooLarge }).code).toBe('too-large')
    expect(startStopGap({ message: LOCAL_MODEL_WORDS.overCap })).toEqual({ code: 'too-much-work', message: withAdvice(LOCAL_MODEL_WORDS.overCap, TOO_MUCH_WORK_WORDS) })
  })
})
