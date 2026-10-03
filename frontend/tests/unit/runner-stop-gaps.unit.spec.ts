/**
 * Step 3, R11.9a: the guard over every named stop-gap (R11.9's table, rows
 * 1–28). With every family on, no row leaves to the engine: each either runs
 * in Sailor, or is refused in plain words before the hold (USER ruling (e)),
 * with a reason code. Rows closed by other tasks are asserted where they are
 * true now; the rows that belong to R9/R10 are listed as
 * expected exceptions until those tasks land, so the list must shrink then.
 * R10.2 closed the canvas's silent fallback: a decline (`switched-off`,
 * `not-taken`) and every Shader effect engine case end in a plain refusal,
 * unless every refused node is local-only (tests/unit/runner-no-silent-engine.unit.spec.ts).
 *
 * R10.6 closed row 28: hosted offers no local-only class or blueprint, and the
 * blueprints list natively with ComfyUI off (native-global-subgraphs.unit.spec.ts).
 *
 * Also R11.7's and R11.8's named stop-gaps: a made sound past a reader's cap
 * (named with its maker's setting to shorten), a paid video model's sound
 * into a sound effect, several still pictures into Slow motion (AI), a count
 * known only as an upper bound past a per-frame cap, the hosted kept room.
 *
 * No paid calls: the providers are fakes; keys unset.
 */
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { EVERY_KNOWN_FAMILY, MEDIA_TOOL_FAMILIES, MEDIA_EFFECT_TOOL_FAMILIES, LOCAL_MODEL_TOOL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import {
  CARD_EXPORT_ADVICE, CLIP_INTO_PICTURE_WORDS, LETTERS_WORDS, LUT_OUTSIDE_WORDS, NOT_INSTALLED_WORDS, PICTURE_BATCH_ADVICE, RUNNER_NOT_ELIGIBLE, SOUND_RATE_ADVICE,
  TOO_MUCH_WORK_WORDS, VIDEO_FORMAT_ADVICE, captionsTooLongWords, lengthWords, madeSoundTooLongWords, oddSettingWords, oddTextWords, paidVideoSettingsAdvice, switchedOffWords,
  wiredSettingWords, wiredValueOutOfRangeWords, withAdvice, type RunnerReasonCode,
} from '#shared/runner/messages'
import { FRAME_WIDGET_NAMES, shownLabel, stopGapRefusal, switchedOffNodes, wiredDearestBound, withStaticWiredSettings } from '#shared/runner/stopGaps'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { isRunnerEligible, runnerRuleFor, runnerTakesNode } from '#shared/runner/eligibility'
import { blockedRunRefusal, engineRoute, localOnlyHostedWords, needsEngineReasons, nodesNeedingEngine } from '#shared/runner/needsEngine'
import { hostedOffersClass } from '#shared/runner/hostedOffer'
import { MEDIA_EFFECT_WORDS } from '#shared/runner/mediaEffects'
import {
  BG_REMOVE_CLASS, FRAME_INTERP_AI_CLASS, LOCAL_MODEL_MAX_FRAMES, LOCAL_MODEL_WORDS, MASK_EXTRACTOR_CLASS, SAM_MASK_WORDS, SLOW_MOTION_AI_MAX_FRAMES, SLOW_MOTION_AI_WORDS,
  UPSCALE_2X_CLASS, UPSCALE_2X_WORDS, VOCALS_CLASS, WHISPER_CLASS, overCapWords,
} from '#shared/runner/localModels'
import { CHAT_LLM_MODELS } from '#shared/runner/llm'
import { parseMaskPoints, samPointsInput } from '#shared/runner/samInput'
import { isEditorOnlyClass, retiredAdviceOf } from '#shared/runner/retired'
import { CAPTIONS_MAX_CHARS } from '~~/server/runner/video/table'
import { WAVE_SOUND_OUTSIDE_WORDS } from '~~/server/runner/video/start'
import { VIDEO_NOT_MP4 } from '~~/server/runner/media/videoNodes'
import { MEDIA_TOOLS_MISSING } from '~~/server/media/tools'
import { paidVideoAdvice, paidVideoMakerOfFrames, startStopGap, wiredValueOutOfRange } from '~~/server/runner/stopGapWords'
import { localModelStartProblems, slowMotionAiStart } from '~~/server/runner/localModelStart'
import { saveFramesKeptBytes, saveFramesStartProblem, savedFrameBytesBound, savedFrameTextBytes } from '~~/server/runner/cards/saveImage'
import { clipAtCaps, paidVideoClipBound } from '~~/server/runner/video/shapes'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { SHADER_CATALOG_VERSION, SHADER_ENGINE_WORDS, SHADER_NEEDS_PICTURE_FIRST, shaderBakeKeySync, shaderBakedText, shaderEngineReason } from '#shared/runner/shaderBakeKey'
import { makeKit } from './__runner__/kit'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'

const EVERY: ReadonlySet<RunnerFamily> = EVERY_KNOWN_FAMILY
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const LONG = { timeout: 120_000 }
const scratch = mkdtempSync(join(tmpdir(), 'runner-stop-gaps-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
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
  // The node is named first, by its title or its display name (fix round 1, m5), then the words.
  expect(err.message, 'names the node').toMatch(/^“[^”]+”: /)
  const said = err.message.replace(/^“[^”]+”: /, '')
  if (typeof words === 'string') expect(said).toBe(words)
  else if (words) expect(said).toMatch(words)
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
  27: 'R10.7: local LoRA training removed',
}

/**
 * R11.9c fix round 1 (M1, I3) named the Shader effects the runner left to the engine; R10.2 closed every one:
 * each is a plain refusal with its words, locally with the engine up as in hosted, and a bake this browser or
 * machine can't make stops the run in plain words everywhere (layouts/default.vue; the guard is in
 * runner-no-silent-engine.unit.spec.ts). The list of cases silently left to the engine is empty. R10.2 fix
 * round 1 (c): one of your own effects goes to the local engine again, locally with it up, but named (the
 * local-engine toast), never silently; elsewhere it gets its words. Fix round 2: so does one whose picture is
 * made in the same run (NEEDS_LOCAL_ENGINE_SHADER_CASES; runner-no-silent-engine.unit.spec.ts).
 */
const SHADER_ENGINE_CASES: Readonly<Record<string, { closedBy: string; words: string }>> = {}
const SHADER_CLOSED_CASES: Readonly<Record<string, string>> = {
  'a My effect or a draft': SHADER_ENGINE_WORDS.myEffect,
  'an effect the runner doesn’t know': SHADER_ENGINE_WORDS.unknownEffect,
  'params only Python reads': SHADER_ENGINE_WORDS.oddParams,
  'a wired setting': SHADER_ENGINE_WORDS.wired,
  'a bake that no longer agrees with its settings': SHADER_ENGINE_WORDS.keyMismatch,
  'its picture made in the run': SHADER_NEEDS_PICTURE_FIRST,
}

describe('R10.2: the Shader effects once left to the engine are refused plainly, with their words', () => {
  it('none is left to the engine', () => {
    expect(Object.keys(SHADER_ENGINE_CASES)).toHaveLength(0)
    for (const [name, words] of Object.entries(SHADER_CLOSED_CASES)) expect(words, name).toMatch(/^[A-Z].*\.$/)
  })
  it('each graph case is refused, locally with the engine up, naming the node and its cause', () => {
    const SH: ReadonlySet<RunnerFamily> = new Set(['cards', 'shader-bake'])
    const shader = (over: Record<string, unknown>, image?: Link): ApiPrompt => ({
      ...(image ? {} : { 0: { class_type: 'Image', inputs: { image: 'src.png', export: false, filename_prefix: 'ComfyUI', batch_index: -1 } } }),
      fx: { class_type: 'ShaderEffect', inputs: { image: image ?? ['0', 0], effect: 'halftone', params: '{}', time: 0, duration: 0, fps: 24, seed: 42, resolution: 768, aspect: '1:1', ...over } },
      s: saveImage(['fx', 0]),
    })
    const stale = shader({})
    stale.fx!.inputs.sailor_baked = shaderBakedText([`shader_bake_${'0'.repeat(32)}.png`], 'f'.repeat(64))
    const cases: [string, ApiPrompt][] = [
      ['a My effect or a draft', shader({ effect: 'mine_abc~v1' })],
      ['an effect the runner doesn’t know', shader({ effect: 'no_such_effect' })],
      ['params only Python reads', shader({ params: '{"u_amount":"0.5"}' })],
      ['a bake that no longer agrees with its settings', stale],
    ]
    const titleOf = (id: string) => (id === 'fx' ? 'Halftone' : id)
    for (const [name, p] of cases) {
      expect(runnerTakesNode(p, 'fx', SH), name).toBe(false)
      expect(needsEngineReasons(p, { runnerOn: true, families: SH }), name).toEqual([SHADER_CLOSED_CASES[name]])
      const local = engineRoute([{ prompt: p, titleOf }], { runnerOn: true, families: SH, hosted: false, engineUp: true })
      if (name === 'a My effect or a draft') {
        expect(local, name).toEqual({ to: 'engine', notice: { title: 'This workflow needs the local engine', description: 'Only the engine can run “Halftone”.' } })
        expect(engineRoute([{ prompt: p, titleOf }], { runnerOn: true, families: SH, hosted: true, engineUp: true }), name)
          .toEqual({ to: 'refused', title: 'This workflow can’t run here', description: `“Halftone”: ${SHADER_CLOSED_CASES[name]}` })
      }
      else expect(local, name).toEqual({ to: 'refused', title: '“Halftone” can’t run', description: `“Halftone”: ${SHADER_CLOSED_CASES[name]}` })
    }
    expect(shaderEngineReason(shader({ seed: ['9', 0] }), 'fx', SH)).toBe(SHADER_CLOSED_CASES['a wired setting'])
  })
})

describe('R11.9: every named stop-gap, one case per row', () => {
  it('the expected exceptions are exactly row 27 (R10)', () => {
    expect(Object.keys(EXPECTED_EXCEPTIONS).map(Number)).toEqual([27])
  })

  // Row 28 (decision 4): R10.2 closed the canvas route (local-only classes go to the engine only locally, with it
  // up, named); R10.6 closed the rest. Hosted offers no local-only class in node search and no blueprint (its
  // list is empty, never ComfyUI's); locally the blueprints list natively with ComfyUI off, and a blueprint is
  // judged class by class like any graph. The cases live in their own specs, which must keep them.
  it('row 28 (R10.2, R10.6): local-only classes and blueprints: hosted offers neither; locally the blueprints list without ComfyUI', () => {
    expect(hostedOffersClass('KSampler')).toBe(false)
    expect(hostedOffersClass('GenerateImageNode')).toBe(true)
    expect(engineRoute([{ prompt: { k: { class_type: 'KSampler', inputs: {} } }, titleOf: () => 'Sampler' }], { runnerOn: true, families: EVERY, hosted: true, engineUp: true }))
      .toEqual({ to: 'refused', title: 'This workflow can’t run here', description: localOnlyHostedWords(['Sampler']) })
    const proven: [string, string][] = [
      ['native-global-subgraphs.unit.spec.ts', 'equals ComfyUI’s own list and entries for the repo’s blueprints'],
      ['native-global-subgraphs.unit.spec.ts', 'each blueprint: on Sailor when the runner takes it; else the local engine locally (engine up), and plain words in hosted'],
      ['native-global-subgraphs.unit.spec.ts', 'hosted lists only the classes the runner takes, plus the cards'],
      ['native-global-subgraphs.unit.spec.ts', 'the sidebar fetches no blueprint and shows no blueprint tab or section in hosted'],
      ['engine-path-alias.unit.spec.ts', 'R10.6: the blueprint list is empty in every spelling, and one blueprint is refused, never proxied'],
      ['runner-no-silent-engine.unit.spec.ts', 'R10.2'],
    ]
    for (const [file, name] of proven) expect(readFileSync(join(__dirname, file), 'utf8').includes(name), `${file} — “${name}”`).toBe(true)
  })

  // Row 1 (R10.1): the mini apps have no engine way out. With their families off they say "This app is switched
  // off right now." in both places; nothing in them calls /prompt or /history.
  it('row 1 (R10.1): the mini apps never call the engine; a decline says they are switched off, in both places', () => {
    const appRoot = join(__dirname, '..', '..', 'app')
    const files = [
      ...readdirSync(join(appRoot, 'components', 'apps')).map(n => join(appRoot, 'components', 'apps', n)),
      ...['karaokeApp.ts', 'autoSubtitleApp.ts', 'productShotApp.ts', 'faceSwapApp.ts'].map(n => join(appRoot, 'lib', 'runner', n)),
    ]
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/['"`]\/(prompt|history)\b/)
      expect(text, f).not.toMatch(/runOnEngine|engineStopGap/)
    }
    const proven: [string, string][] = [
      ['app-karaoke-run.unit.spec.ts', 'R10.1: a decline at the start says "switched off" in both places, never the engine'],
      ['app-auto-subtitle-run.unit.spec.ts', 'R10.1: a decline at the start says "switched off" in both places, never the engine'],
      ['app-product-shot-run.unit.spec.ts', 'R10.1: a decline at the start says the app is switched off in both places, never the engine'],
    ]
    for (const [file, name] of proven) expect(readFileSync(join(__dirname, file), 'utf8').includes(name), `${file} — “${name}”`).toBe(true)
  })

  // Rows 2–9 and 11–14: closed by their own tasks. Each is probed where a probe is cheap (its graph is the runner's
  // with every family on: it fails if the row went back to the engine), and its own spec is named and must keep
  // the case that proves it.
  const LA = { class_type: 'LoadAudio', inputs: { audio: 'a.wav' } }
  const saveAudio = (from: string) => ({ class_type: 'SaveAudio', inputs: { audio: [from, 0] as Link, filename_prefix: 'audio/ComfyUI' } })
  const getComp = (from: string) => ({ class_type: 'GetVideoComponents', inputs: { video: [from, 0] as Link } })
  const createVideo = (from: string) => ({ class_type: 'CreateVideo', inputs: { images: [from, 0] as Link, fps: 24 } })
  /** Row 11: a generative Shader effect moving over two seconds at 12 fps (24 frames), baked as the browser bakes it. */
  const shaderAnimated = (): ApiPrompt => {
    const inputs: Record<string, unknown> = { effect: 'aurora', params: '{}', time: 0, duration: 2, fps: 12, seed: 42, resolution: 256, aspect: '16:9' }
    const files = Array.from({ length: 24 }, (_, i) => `shader_bake_${i.toString(16).padStart(32, '0')}.png`)
    inputs.sailor_baked = shaderBakedText(files, shaderBakeKeySync(inputs, [], SHADER_CATALOG_VERSION, files))
    return { fx: { class_type: 'ShaderEffect', inputs }, c: createVideo('fx'), s: saveVideo('c') }
  }
  const PROBES: Record<number, ApiPrompt> = {
    2: { s: LA, v: { class_type: VOCALS_CLASS, inputs: { audio: ['s', 0], model: 'htdemucs', shifts: 1 } }, a: saveAudio('v') },
    3: { s: LA, w: { class_type: WHISPER_CLASS, inputs: { audio: ['s', 0], model_size: 'base', language: 'auto', fps: 24 } }, t: { class_type: 'Text', inputs: { source: ['w', 2], text: '' } } },
    4: { l: loadImage(), u: { class_type: UPSCALE_2X_CLASS, inputs: { frames: ['l', 0], tile_size: 512 } }, s: saveImage(['u', 0]) },
    5: { l: loadVideo('a.mp4'), g: getComp('l'), n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: 2 } }, c: createVideo('n'), s: saveVideo('c') },
    6: { l: loadVideo('a.mp4'), g: getComp('l'), b: { class_type: BG_REMOVE_CLASS, inputs: { frames: ['g', 0], output: 'transparent', edge_softness: 0 } }, s: saveImage(['b', 0]) },
    7: { m: { class_type: 'GenerateMusicNode', inputs: { model: 'MusicGen', prompt: 'calm piano', duration: 8, model_version: 'stereo-large', temperature: 1, top_p: 0, seed: 0 } }, f: { class_type: 'AudioFade', inputs: { audio: ['m', 0], fade_in: 0.5, fade_out: 0.5, curve: 'linear' } }, a: saveAudio('f') },
    8: { sp: speech(40), w: { class_type: WHISPER_CLASS, inputs: { audio: ['sp', 0], model_size: 'base', language: 'auto', fps: 24 } }, t: { class_type: 'Text', inputs: { source: ['w', 2], text: '' } } },
    9: { l: loadVideo('a.mp4'), g: getComp('l'), m: { class_type: 'TemporalMotionBlur', inputs: { frames: ['g', 0], radius: 2, falloff: 'gaussian' } }, c: createVideo('m'), s: saveVideo('c') },
    // R11.9c (USER ruling (d)): an animated Shader effect, baked frame by frame in the browser, into Create video.
    11: shaderAnimated(),
  }
  /** Each row's own spec and the case in it that proves the row (fails if the case is removed or renamed). */
  const PROVEN_IN: Record<number, [string, string]> = {
    2: ['runner-long-sound.unit.spec.ts', 'Karaoke\\\'s chain, hosted, a 10-minute-20 song: two Demucs calls'],
    3: ['runner-long-sound.unit.spec.ts', 'Whisper, hosted, a 30-minute-and-2-second sound: two Wizper calls'],
    4: ['runner-upscale-tiles.unit.spec.ts', 'a 4K picture: six tiles of 1366 × 1144'],
    5: ['runner-clip-caps.unit.spec.ts', '300 frames at ×2: two calls (479 and 121 frames out)'],
    6: ['runner-clip-caps.unit.spec.ts', 'the per-frame classes keep 300 hosted and 900 locally'],
    7: ['runner-source-bounds.unit.spec.ts', 'music: the duration asked, plus a second'],
    8: ['runner-source-bounds.unit.spec.ts', 'speech: every character at four a second'],
    9: ['runner-media-vfx-time.unit.spec.ts', 'Load video → Get video components → Motion blur → Create video → Save video runs in the engine: the same frame count and rate, blurred'],
    11: ['runner-shader-bake.unit.spec.ts', 'a time-animated generative shader: its frames kept as one batch, each frame its bake\\\'s RGB, nothing held or charged (hosted)'],
    12: ['runner-lipsync-engines.unit.spec.ts', 'with sound-in on; with it off (any other families) the engine keeps Fabric and Kling'],
    13: ['runner-replicate-video.unit.spec.ts', 'takes fabric-1.0 only with a linked picture and a linked runner sound'],
    14: ['runner-relight-wired.unit.spec.ts', 'takes a wired light and wired instructions as text'],
  }
  for (const [row, p] of Object.entries(PROBES)) {
    it(`row ${row}: its graph runs in Sailor with every family on (proven in ${PROVEN_IN[Number(row)]![0]})`, () => {
      expect(runnerTakesWorkflow(p, EVERY)).toBe(true)
      expect(stopGapRefusal(p, EVERY)).toBeNull()
      expect(nodesNeedingEngine(p, { runnerOn: true, families: EVERY, titleOf: id => id })).toEqual([])
    })
  }
  it('rows 2–9, 11–14: each row’s own spec still holds the case that proves it', () => {
    for (const [row, [file, name]] of Object.entries(PROVEN_IN)) {
      const text = readFileSync(join(__dirname, file), 'utf8')
      expect(text.includes(name), `row ${row}: ${file} — “${name}”`).toBe(true)
    }
  })
  it('row 12 (R11.3): Fabric and Kling lip-sync on uploads run in Sailor', () => {
    const lip = (opts: Record<string, unknown>): ApiPrompt => ({ n: { class_type: 'LipSyncNode', inputs: { engine: 'auto', resolution: '720p', sync_mode: 'cut_off', model_options: JSON.stringify(opts) } }, v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['n', 0] } } })
    expect(runnerTakesWorkflow(lip({ engine: 'fabric', face_image: '/view?filename=f.png&type=input', audio: '/view?filename=a.wav&type=input' }), EVERY)).toBe(true)
    expect(runnerTakesWorkflow(lip({ engine: 'sync', face_video: '/view?filename=f.mp4&type=input', audio: '/view?filename=a.wav&type=input' }), EVERY)).toBe(true)
  })

  it('row 10 (R10.0): Face swap runs in Sailor with its family on (its provider is the user’s call, ruling (b))', () => {
    const p: ApiPrompt = { a: loadImage('a.png'), b: loadImage('b.png'), f: { class_type: 'FaceSwap', inputs: { source_face: ['a', 0], target_frames: ['b', 0] } }, s: saveImage(['f', 0]) }
    expect(nodesNeedingEngine(p, { runnerOn: true, families: EVERY, titleOf: id => id })).not.toContain('f')
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
  it('row 16: −1 is dropped and 2/3 sent as a box; a label SAM 3 can’t be sent has its own words, anything else pointsFail', () => {
    expect(parseMaskPoints('[{"x":0.5,"y":0.5,"label":1},{"x":0.1,"y":0.1,"label":-1}]', 100, 100)).toEqual({ ok: true, points: [{ x: 50, y: 50, label: 1 }], boxes: [] })
    const box = parseMaskPoints('[{"x":0.8,"y":0.7,"label":3},{"x":0.2,"y":0.1,"label":2}]', 100, 100)
    expect(box).toEqual({ ok: true, points: [], boxes: [{ xMin: 20, yMin: 10, xMax: 80, yMax: 70 }] })
    expect(samPointsInput('u', [], (box as { boxes: [] }).boxes).box_prompts).toEqual([{ x_min: 20, y_min: 10, x_max: 80, y_max: 70 }])
    const node = (points: string): ApiPrompt => ({ l: loadImage(), n: { class_type: MASK_EXTRACTOR_CLASS, inputs: { image: ['l', 0], points, feather: 0, invert: false } } })
    expect(runnerTakesNode(node('[{"x":0.5,"y":0.5,"label":2},{"x":0.9,"y":0.9,"label":3}]'), 'n', EVERY)).toBe(true)
    for (const [bad, words] of [
      ['[1, 2]', SAM_MASK_WORDS.pointsFail], ['[{"x":NaN,"y":0}]', SAM_MASK_WORDS.pointsFail],
      ['[{"x":0.5,"y":0.5,"label":7}]', SAM_MASK_WORDS.pointsLabel], ['[{"x":0.5,"y":0.5,"label":2}]', SAM_MASK_WORDS.pointsLabel], ['[{"x":0.5,"y":0.5,"label":-1}]', SAM_MASK_WORDS.pointsLabel],
    ] as const) {
      expect(runnerTakesWorkflow(node(bad), EVERY), bad).toBe(true)
      expect(stopGapRefusal(node(bad), EVERY), bad).toEqual({ nodeId: 'n', classType: MASK_EXTRACTOR_CLASS, code: 'click-points', message: words })
    }
    expect(SAM_MASK_WORDS.pointsLabel).toMatch(/box’s two corners/)
  })

  // ── Row 17 (as ruled in fix round 1, M1) ──
  const k: ApiPrompt = { k: { class_type: 'PrimitiveInt', inputs: { value: 2 } }, t: { class_type: 'PrimitiveString', inputs: { value: 'htdemucs' } }, b: { class_type: 'PrimitiveString', inputs: { value: 'base' } } }
  const llm = { class_type: 'ChatLLMNode', inputs: { model: CHAT_LLM_MODELS[0], prompt: 'x', system_prompt: '', temperature: 1, max_tokens: 100 } }
  const vocals = (w: Record<string, unknown>): ApiPrompt => ({
    ...k, q: llm, s: { class_type: 'LoadAudio', inputs: { audio: 'song.wav' } },
    v: { class_type: VOCALS_CLASS, inputs: { audio: ['s', 0], model: 'htdemucs', shifts: 1, ...w } },
    a: { class_type: 'SaveAudio', inputs: { audio: ['v', 0], filename_prefix: 'audio/ComfyUI' } },
  })
  const whisper = (modelSize: unknown): ApiPrompt => ({
    ...k, q: llm, s: { class_type: 'LoadAudio', inputs: { audio: 'talk.wav' } },
    w: { class_type: WHISPER_CLASS, inputs: { audio: ['s', 0], model_size: modelSize, language: 'auto', fps: 24 } },
    t2: { class_type: 'Text', inputs: { source: ['w', 2], text: '' } },
  })
  const grain = (seed: unknown, extra: ApiPrompt = {}): ApiPrompt => ({ ...extra, l: loadImage(), f: { class_type: 'FilmGrain', inputs: { image: ['l', 0], amount: 0.2, size: 1, seed } }, s: saveImage(['f', 0]) })

  it('row 17: a card’s own value wired into a setting is put in as if typed and runs (Primitive int → Film grain seed)', LONG, async () => {
    const p = grain(['k', 0], { k: k.k! })
    expect(withStaticWiredSettings(p, EVERY).f!.inputs!.seed).toBe(2)
    expect(stopGapRefusal(withStaticWiredSettings(p, EVERY), EVERY)).toBeNull()
    const kit = makeKit({ deps: { families: () => EVERY } })
    await writePng(join(kit.root, 'input', 'p.png'))
    const { runId } = await kit.engine.startRun({ userId: kit.userId, takes: [p], ...START })
    await kit.engine.settled(runId)
    const t = (await kit.store.get(runId))!.takes[0]!
    for (const id of ['l', 'f', 's']) expect(t.nodes[id]!.status, `${id}: ${t.nodes[id]!.error ?? ''}`).toBe('done')
    // The named settings from a card run as typed too; an invalid card value stays wired and is refused.
    expect(stopGapRefusal(withStaticWiredSettings(vocals({ shifts: ['k', 0], model: ['t', 0] }), EVERY), EVERY)).toBeNull()
    expect(stopGapRefusal(withStaticWiredSettings(whisper(['b', 0]), EVERY), EVERY)).toBeNull()
  })

  it('row 17: a value the run makes with a dearest bound is taken (priced at its dearest, put in at the node’s turn)', () => {
    const p = grain(['z', 0], { z: { class_type: 'GetImageSize', inputs: { image: ['l', 0] } } })
    expect(runnerTakesWorkflow(p, EVERY)).toBe(true)
    expect(stopGapRefusal(withStaticWiredSettings(p, EVERY), EVERY)).toBeNull()
  })

  // Fix round 2 (N1): the dearest bound is a true bound on what is sent.
  const music = (duration: unknown, extra: ApiPrompt = {}): ApiPrompt => ({
    ...extra,
    m: { class_type: 'GenerateMusicNode', inputs: { model: 'MusicGen', prompt: 'calm piano', duration, model_version: 'stereo-melody-large', temperature: 1, top_p: 0, seed: 0 } },
    s: { class_type: 'SaveAudio', inputs: { audio: ['m', 0], filename_prefix: 'audio/ComfyUI' } },
  })
  const sized = { l: loadImage('p.png'), z: { class_type: 'GetImageSize', inputs: { image: ['l', 0] } } } satisfies ApiPrompt

  it('row 17 (N1): Get image size 64 → Generate music duration: taken at its dearest, then failed at its turn before any call, charged nothing', LONG, async () => {
    const p = music(['z', 0], sized)
    expect(runnerTakesWorkflow(p, EVERY)).toBe(true)
    expect(stopGapRefusal(withStaticWiredSettings(p, EVERY), EVERY)).toBeNull()
    // The label the canvas shows (its rule adds “(frames)” to every `duration`, Generate music's too).
    const words = wiredValueOutOfRangeWords(shownLabel('GenerateMusicNode', 'duration'), 64, { type: 'INT', min: 1, max: 30 })
    expect(words).toBe('“Duration (frames)” got 64 from another node; it takes from 1 to 30.')
    // The turn's check on its own: in range runs, out of range (either end) fails.
    const at = (value: number) => () => ({ kind: 'number' as const, value, int: true })
    expect(wiredValueOutOfRange(p, 'm', at(20), EVERY)).toBeNull()
    expect(wiredValueOutOfRange(p, 'm', at(64), EVERY)).toBe(words)
    expect(wiredValueOutOfRange(p, 'm', at(0), EVERY)).toBe(wiredValueOutOfRangeWords('Duration (frames)', 0, { type: 'INT', min: 1, max: 30 }))
    // Through the engine, hosted: held at the dearest, the node fails at its turn, nothing sent, nothing charged.
    const k = makeKit({ hosted: true, deps: { families: () => EVERY } })
    await writePng(join(k.root, 'input', 'p.png'), 64, 48)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    expect(t.nodes.z!.status).toBe('done')
    expect(t.nodes.m!.status).toBe('error')
    expect(t.nodes.m!.error).toBe(words)
    expect(k.ledger.hold).toHaveBeenCalled()
    expect(k.fal.submitted()).toEqual([])
    expect(k.replicate.submitted()).toEqual([])
    expect(k.ledger.settle.mock.calls.every(c => c[1] === 0)).toBe(true)
  })

  it('row 17 (N1): a Primitive 64 wired into Generate music duration is refused before the hold, never sent', LONG, async () => {
    const p = music(['k', 0], { k: { class_type: 'PrimitiveInt', inputs: { value: 64 } } })
    const words = wiredValueOutOfRangeWords('Duration (frames)', 64, { type: 'INT', min: 1, max: 30 })
    expect(stopGapRefusal(withStaticWiredSettings(p, EVERY), EVERY)).toEqual({ nodeId: 'm', classType: 'GenerateMusicNode', code: 'wired-setting', message: words })
    // In range, it is put in as typed.
    expect(withStaticWiredSettings(music(['k', 0], { k: { class_type: 'PrimitiveInt', inputs: { value: 12 } } }), EVERY).m!.inputs!.duration).toBe(12)
    const k = makeKit({ hosted: true, deps: { families: () => EVERY } })
    await refusedPlainly(k, p, 'wired-setting', words)
  })

  it('row 17 (N1): the dearest bound needs a least and a most, and R7’s local-model nodes have none', () => {
    const rule = runnerRuleFor('GenerateMusicNode', music(5).m!.inputs!, EVERY)!
    expect(wiredDearestBound('GenerateMusicNode', rule, { type: 'INT', min: 1, max: 30 })).toBe(true)
    expect(wiredDearestBound('GenerateMusicNode', rule, { type: 'INT', max: 30 })).toBe(false)
    expect(wiredDearestBound('GenerateMusicNode', rule, { type: 'FLOAT', min: 0.5 })).toBe(false)
    const fi = { image: ['l', 0], multiplier: 2 }
    const fiRule = runnerRuleFor(FRAME_INTERP_AI_CLASS, fi, EVERY)
    expect(fiRule).toBeTruthy()
    expect(wiredDearestBound(FRAME_INTERP_AI_CLASS, fiRule!, fiRule!.widgets?.multiplier)).toBe(false)
  })

  it('row 17: a value the run makes for a model choice (no bound), or for a setting the brief names, is refused: "Type this setting in; it can’t be wired."', async () => {
    const edit: ApiPrompt = { q: llm, l: loadImage(), e: { class_type: 'EditImageNode', inputs: { model: ['q', 0], input_image: ['l', 0], prompt: 'x' } }, s: saveImage(['e', 0]) }
    expect(runnerTakesWorkflow(edit, EVERY)).toBe(true)
    expect(stopGapRefusal(edit, EVERY)).toEqual({ nodeId: 'e', classType: 'EditImageNode', code: 'wired-setting', message: wiredSettingWords('Model') })
    expect(wiredSettingWords('Model')).toBe('“Model” gets its value from another node during the run. Type this setting in; it can’t be wired.')
    expect(stopGapRefusal(vocals({ shifts: ['q', 0] }), EVERY)).toMatchObject({ nodeId: 'v', code: 'wired-setting', message: wiredSettingWords('Shifts') })
    expect(stopGapRefusal(whisper(['q', 0]), EVERY)).toMatchObject({ nodeId: 'w', code: 'wired-setting', message: wiredSettingWords('Model size') })
    // Through the engine: refused before the hold, the node named.
    const kit = makeKit({ deps: { families: () => EVERY } })
    await writePng(join(kit.root, 'input', 'p.png'))
    await refusedPlainly(kit, edit, 'wired-setting', wiredSettingWords('Model'))
  })

  it('row 17 (m1, m2): labels are the node’s own (the canvas’s rule); an object where a value belongs isn’t called wired', () => {
    expect(shownLabel(WHISPER_CLASS, 'model_size')).toBe('Model size')
    expect(shownLabel('TextClip', 'duration')).toBe('Duration (frames)')
    expect(shownLabel('RestyleWithLoRANode', 'style_strength')).toBe('Transformation')
    // The canvas's own rule, read from its source so the two can't drift.
    const canvas = readFileSync(join(__dirname, '../../app/components/vue-canvas/ComfyNodeWidget.vue'), 'utf8')
    expect(canvas).toContain("RestyleWithLoRANode: { style_strength: 'Transformation' }")
    for (const name of FRAME_WIDGET_NAMES) expect(canvas).toContain(`'${name}'`)
    const obj = vocals({ shifts: { __value__: 2 } })
    expect(stopGapRefusal(obj, EVERY)).toMatchObject({ code: 'odd-text', message: oddSettingWords('Shifts') })
  })

  // ── Row 18: odd text ──
  it('row 18: colour text, a painter file’s name, a Moodboard reading, a bake card’s settings: refused plainly, naming the field', async () => {
    const gm = (dark: unknown): ApiPrompt => ({ l: loadImage(), g: { class_type: 'GradientMap', inputs: { image: ['l', 0], dark_color: dark, light_color: '#ffffff', midpoint: 0.5, contrast: 1, mix: 1 } } })
    expect(stopGapRefusal(gm('#000000'), EVERY)).toBeNull()
    for (const odd of [5, '#\u0661\u0662\u0663\u0664\u0665\u0666']) {
      expect(runnerTakesWorkflow(gm(odd), EVERY), String(odd)).toBe(true)
      expect(stopGapRefusal(gm(odd), EVERY), String(odd)).toEqual({ nodeId: 'g', classType: 'GradientMap', code: 'odd-text', message: oddSettingWords('Dark color') })
    }
    const painter: ApiPrompt = { p: { class_type: 'Painter', inputs: { mask: '../x.png', width: 64, height: 64, bg_color: '#000000' } }, s: saveImage(['p', 0]) }
    expect(stopGapRefusal(painter, EVERY)).toEqual({ nodeId: 'p', classType: 'Painter', code: 'odd-text', message: oddTextWords('painter file’s name') })
    const mood: ApiPrompt = {
      m: { class_type: 'Moodboard', inputs: { reading_json: '{"summary": 5}', moodboard_id: 'mb_1' } }, c: loadImage('c.png'),
      r: { class_type: 'RestyleFromImageNode', inputs: { model: 'Nano Banana 2', content_image: ['c', 0], style_in: ['m', 0], prompt: 'x' } }, s: saveImage(['r', 0]),
    }
    expect(runnerTakesWorkflow(mood, EVERY)).toBe(true)
    expect(stopGapRefusal(mood, EVERY)).toEqual({ nodeId: 'm', classType: 'Moodboard', code: 'odd-text', message: oddTextWords('moodboard’s reading') })
    const bake: ApiPrompt = { t: { class_type: 'TextOnPath', inputs: { params: '{"rendered": NaN}' } }, s: saveImage(['t', 0]) }
    expect(runnerTakesWorkflow(bake, EVERY)).toBe(true)
    expect(stopGapRefusal(bake, EVERY)).toMatchObject({ nodeId: 't', code: 'odd-text', message: 'This node’s saved settings can’t be read here. Set them again on the node.' })
    // Through the engine: refused before the hold (no file is read for these).
    const kit = makeKit({ deps: { families: () => EVERY } })
    await refusedPlainly(kit, bake, 'odd-text', /saved settings can’t be read here/)
    await refusedPlainly(kit, mood, 'odd-text', oddTextWords('moodboard’s reading'))
  })

  // ── Row 19: letters outside the atlas ──
  it('row 19: U+2800 in Ascii’s ramp is refused plainly before the hold', LONG, async () => {
    const p: ApiPrompt = { l: loadImage(), a: ascii('\u2800ab') }
    expect(runnerTakesWorkflow(p, EVERY)).toBe(true)
    expect(stopGapRefusal(p, EVERY)).toEqual({ nodeId: 'a', classType: 'Ascii', code: 'letters', message: LETTERS_WORDS })
    expect(stopGapRefusal({ l: loadImage(), a: ascii('#ab') }, EVERY)).toBeNull()
    const kit = makeKit({ deps: { families: () => EVERY } })
    await writePng(join(kit.root, 'input', 'p.png'))
    await refusedPlainly(kit, p, 'letters', LETTERS_WORDS)
    // The node is named by the title the person gave it.
    const titled = await kit.engine.startRun({ userId: kit.userId, takes: [p], ...START, workflow: { nodes: [{ id: 'a', type: 'Ascii', title: 'Ascii art' }] } }).catch(e => e)
    expect(titled.message).toBe(`“Ascii art”: ${LETTERS_WORDS}`)
    expect(titled.data).toMatchObject({ nodeId: 'a', classType: 'Ascii', code: 'letters' })
  })

  // ── Rows 20–22 and the waveform, through the engine kit ──
  const mediaKit = () => {
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const kit = makeKit({ dir, deps: { families: () => EVERY, kept: createFileKeptBytes(join(dir, 'kept')) } })
    for (const c of ['v_stereo_aac.mp4', 'v_prores.mov']) copyFileSync(clipPath(c), join(kit.root, 'input', c))
    return kit
  }
  const clipThrough = (effect: Record<string, unknown> & { class_type: string }): ApiPrompt => ({ l: loadVideo('v_stereo_aac.mp4'), g: getComp('l'), e: effect, c: createVideo('e'), s: saveVideo('c') })
  const waveform = (file: string): ApiPrompt => ({
    e: { class_type: 'AudioWaveform', inputs: { audio_file: file, width: 64, height: 64, fps: 24, frame_count: 4, style: 'bars', bar_count: 8, color: '#ffffff', bg_color: '#000000', sensitivity: 1, smoothing: 0.5 } },
    c: createVideo('e'), s: saveVideo('c'),
  })

  it('row 20: a file neither the sniffer nor the build reads, and a ProRes card export (no ProRes encoder in the build, checked 2026-10-02)', LONG, async () => {
    await requireMediaTools()
    const kit = mediaKit()
    writeFileSync(join(kit.root, 'input', 'odd.rm'), Buffer.from('.RMF not really RealMedia'.repeat(64)))
    await refusedPlainly(kit, { l: loadVideo('odd.rm'), s: saveVideo('l') }, 'video-format', withAdvice(MEDIA_WORDS.unreadable, VIDEO_FORMAT_ADVICE))
    await refusedPlainly(kit, { c: { class_type: 'Video', inputs: { file: 'v_prores.mov', export: true, filename_prefix: 'video' } } }, 'video-format', withAdvice(VIDEO_NOT_MP4, CARD_EXPORT_ADVICE))
  })

  it('row 21: a LUT outside the folders; a waveform’s sound outside the folders or past 384 kHz', LONG, async () => {
    await requireMediaTools()
    const kit = mediaKit()
    await refusedPlainly(kit, clipThrough({ class_type: 'LUT', inputs: { frames: ['g', 0], lut_file: '../grade.cube', strength: 1 } }), 'lut', LUT_OUTSIDE_WORDS)
    await refusedPlainly(kit, waveform('../x.wav'), 'sound-rate', WAVE_SOUND_OUTSIDE_WORDS)
    const rate = 400_000
    const data = Buffer.alloc(4 * 64)
    const fmt = Buffer.alloc(16)
    fmt.writeUInt16LE(3, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(rate, 4); fmt.writeUInt32LE(rate * 4, 8); fmt.writeUInt16LE(4, 12); fmt.writeUInt16LE(32, 14)
    writeFileSync(join(kit.root, 'input', 'fast.wav'), Buffer.concat([Buffer.from('RIFF'), Buffer.from(Uint32Array.of(4 + 24 + 8 + data.length).buffer), Buffer.from('WAVEfmt '), Buffer.from(Uint32Array.of(16).buffer), fmt, Buffer.from('data'), Buffer.from(Uint32Array.of(data.length).buffer), data]))
    await refusedPlainly(kit, waveform('fast.wav'), 'sound-rate', withAdvice(MEDIA_EFFECT_WORDS.waveSoundTooBig, SOUND_RATE_ADVICE))
  })

  it('row 22: captions over 200,000 characters (lifting the cap is parked)', LONG, async () => {
    await requireMediaTools()
    const kit = mediaKit()
    const captions = (n: number) => clipThrough({ class_type: 'CaptionTrack', inputs: { frames: ['g', 0], captions: 'x'.repeat(n), font_size: 32, color: '#ffffff', outline_color: '#000000', outline_width: 2, position: 'bottom', y_inset: 0.05 } })
    await refusedPlainly(kit, captions(CAPTIONS_MAX_CHARS + 1), 'captions-too-long', captionsTooLongWords(CAPTIONS_MAX_CHARS))
    expect(captionsTooLongWords(CAPTIONS_MAX_CHARS)).toBe('These captions are too long to draw here. Keep them under 200,000 characters.')
  })

  it('no start pass sends a workflow to the engine: RUNNER_NOT_ELIGIBLE is set only at eligibility’s three declines', () => {
    const files = readdirSync(join(__dirname, '../../server/runner'), { recursive: true }).map(String).filter(f => f.endsWith('.ts'))
    const uses: string[] = []
    for (const f of files) {
      const text = readFileSync(join(__dirname, '../../server/runner', f), 'utf8')
      for (const line of text.split('\n')) if (/reason: RUNNER_NOT_ELIGIBLE/.test(line)) uses.push(`${f}: ${line.trim()}`)
    }
    expect(uses, uses.join('\n')).toHaveLength(3)
    expect(uses.every(u => u.startsWith('engine.ts: '))).toBe(true)
    expect(uses.filter(u => u.includes("'not-taken'"))).toHaveLength(2)
    expect(uses.filter(u => u.includes("'switched-off'"))).toHaveLength(1)
  })

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
  it('row 25: a family off is declined with a code and "Name is switched off right now.", which the canvas refuses (R10.2)', async () => {
    const off = new Set<RunnerFamily>([...EVERY].filter(f => f !== 'effects-blur'))
    const p: ApiPrompt = { l: loadImage(), b: blur(['l', 0]), s: saveImage(['b', 0]) }
    expect(switchedOffNodes(p, off)).toEqual(['b'])
    expect(needsEngineReasons(p, { runnerOn: true, families: off, titleOf: id => (id === 'b' ? 'Soft blur' : id) })).toEqual([switchedOffWords('Soft blur')])
    // R10.2: never the engine, even locally with it up.
    expect(engineRoute([{ prompt: p, titleOf: id => (id === 'b' ? 'Soft blur' : id) }], { runnerOn: true, families: off, hosted: false, engineUp: true }))
      .toEqual({ to: 'refused', title: '“Soft blur” can’t run', description: switchedOffWords('Soft blur') })
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
      sp: speech(10000),
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

  it('fix round 1 (I1): a paid video’s clip is bounded by its own settings: an 8 s Veo clip into a video effect starts hosted; one whose settings truly pass the caps is refused with advice on those settings', async () => {
    const veo = (options: Record<string, unknown> = {}): ApiPrompt => ({
      v: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'a boat', aspect_ratio: '16:9', duration: '8', seed: 0, model_options: JSON.stringify(options) } },
      c: { class_type: 'Video', inputs: { source: ['v', 0], file: '', export: false, filename_prefix: 'video' } },
      g: { class_type: 'GetVideoComponents', inputs: { video: ['c', 0] } },
      t: { class_type: 'VideoTrim', inputs: { frames: ['g', 0], start: 0, end: -1 } },
      cv: { class_type: 'CreateVideo', inputs: { images: ['t', 0], fps: 24 } },
      s: saveVideo('cv'),
    })
    expect(runnerTakesWorkflow(veo(), EVERY)).toBe(true)
    const kit = makeKit({ hosted: true, deps: { families: () => EVERY } })
    const quote = await kit.engine.quoteRun({ userId: kit.userId, takes: [veo()], ...START }).catch(e => e)
    expect(quote instanceof Error ? quote.message : null).toBeNull()
    const err = await kit.engine.quoteRun({ userId: kit.userId, takes: [veo({ resolution: '4k' })], ...START }).catch(e => e)
    expect(err.data).toMatchObject({ code: 'too-much-work', nodeId: 't' })
    expect(err.data.reason).toBeUndefined()
    expect(err.message.endsWith(paidVideoSettingsAdvice('Generate a video'))).toBe(true)
    expect(kit.ledger.hold).not.toHaveBeenCalled()
  })

  it('fix round 1 (I2): Save image saving every frame is counted against hosted’s kept room before the hold', () => {
    const p = (scale: number, reader: 'SaveImage' | 'PreviewImage' = 'SaveImage'): ApiPrompt => ({
      l: { class_type: 'LoadVideoFrames', inputs: { file: 'a.mp4', max_seconds: 10, max_frames: 600, max_size: 1080, start_frame: 0, stride: 1 } },
      s: reader === 'SaveImage' ? { ...saveImage(['l', 0]), inputs: { ...saveImage(['l', 0]).inputs, scale } } : previewImage(['l', 0]),
    })
    const shapes = new Map([['l:0', { count: 600, w: 1920, h: 1080, exact: false }]])
    const opts = (hosted: boolean) => ({ hosted, clipAtCaps: () => clipAtCaps(hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local) })
    // 600 frames of 1080p ≈ 3.8 GB at most: within 4 GiB; at scale 4, 16× that: refused.
    expect(600 * savedFrameBytesBound(1920, 1080)).toBeLessThan(MEDIA_CAPS.hosted.keptBytesPerRun)
    expect(saveFramesStartProblem(p(1), EVERY, shapes, opts(true))).toBeNull()
    expect(saveFramesStartProblem(p(4), EVERY, shapes, opts(true))).toMatchObject({ nodeId: 's', classType: 'SaveImage' })
    expect(startStopGap(saveFramesStartProblem(p(4), EVERY, shapes, opts(true))!).code).toBe('too-much-work')
    // Locally the machine is the person's own; Preview image saves at scale 1.
    expect(saveFramesStartProblem(p(4), EVERY, shapes, opts(false))).toBeNull()
    expect(saveFramesStartProblem(p(4, 'PreviewImage'), EVERY, shapes, opts(true))).toBeNull()
  })

  // ── Fix round 2 ──
  const paidClip = (model: string, inputs: Record<string, unknown> = {}, title?: string): ApiPrompt => ({
    v: { class_type: 'GenerateVideoNode', inputs: { model, prompt: 'a boat', aspect_ratio: '16:9', duration: '5', seed: 0, ...inputs }, ...(title ? { _meta: { title } } : {}) } as ApiPrompt[string],
    c: { class_type: 'Video', inputs: { source: ['v', 0], file: '', export: false, filename_prefix: 'video' } },
    g: { class_type: 'GetVideoComponents', inputs: { video: ['c', 0] } },
    t: { class_type: 'VideoTrim', inputs: { frames: ['g', 0], start: 0, end: -1 } },
    cv: { class_type: 'CreateVideo', inputs: { images: ['t', 0], fps: 24 } },
    s: saveVideo('cv'),
  })

  it('fix round 2 (I1 gap): Runway Gen-4.5, Kling 2.5 Turbo Pro and LTX-Video are bounded by their own largest frame: a 5 s clip starts hosted; advice names only settings the model has', async () => {
    const kit = makeKit({ hosted: true, deps: { families: () => EVERY } })
    for (const model of ['runway-gen-4.5', 'kling-v2.5-turbo-pro', 'ltx-video']) {
      const q = await kit.engine.quoteRun({ userId: kit.userId, takes: [paidClip(model)], ...START }).catch(e => e)
      expect(q instanceof Error ? q.message : null, model).toBeNull()
    }
    // Runway at 10 s: past the hosted frames held at once at the 60 fps ceiling; it has a length and no resolution.
    const err = await kit.engine.quoteRun({ userId: kit.userId, takes: [paidClip('runway-gen-4.5', { duration: '10' })], ...START }).catch(e => e)
    expect(err.data).toMatchObject({ code: 'too-much-work', nodeId: 't' })
    expect(err.message.endsWith('Pick a shorter duration on “Generate a video”.'), err.message).toBe(true)
    expect(paidVideoSettingsAdvice('X', { duration: false, resolution: false })).toBe('Save the video from “X”, then load it with Load video.')
    expect(paidVideoSettingsAdvice('X', { duration: false, resolution: true })).toBe('Pick a lower resolution on “X”.')
    expect(kit.ledger.hold).not.toHaveBeenCalled()
  })

  it('fix round 2 (I1 gap, m6): a wired duration is to be typed in; the Generate a video named is the one the frames come from', async () => {
    // A wired duration (bounded at the model's longest): type it in. (Taken only where the runner reads the wire.)
    const wired = paidClip('veo-3.1', { duration: ['d', 0], model_options: JSON.stringify({ resolution: '4k' }) })
    expect(paidVideoAdvice(wired, 'v', 'Boat shot')).toBe('Type a shorter duration in on “Boat shot” instead of wiring it, or pick a lower resolution.')
    expect(paidVideoAdvice(paidClip('runway-gen-4.5', { duration: ['d', 0] }), 'v', 'Boat shot')).toBe('Type a shorter duration in on “Boat shot” instead of wiring it.')
    // The node is named by its own title through the engine.
    const kit = makeKit({ hosted: true, deps: { families: () => EVERY } })
    const titled = paidClip('veo-3.1', { duration: '8', model_options: JSON.stringify({ resolution: '4k' }) }, 'Boat shot')
    const err = await kit.engine.quoteRun({ userId: kit.userId, takes: [titled], ...START }).catch(e => e)
    expect(err.data, err.message).toMatchObject({ code: 'too-much-work' })
    expect(err.message.endsWith('Pick a shorter duration or lower resolution on “Boat shot”.'), err.message).toBe(true)
    // Only the frames' own chain: a paid video's sound into Create video beside frames from Load video names nothing.
    const mixed: ApiPrompt = {
      ...paidClip('veo-3.1'),
      lv: loadVideo('a.mp4'), lg: { class_type: 'GetVideoComponents', inputs: { video: ['lv', 0] } },
      cv: { class_type: 'CreateVideo', inputs: { images: ['lg', 0], audio: ['g', 1], fps: 24 } },
    }
    expect(paidVideoMakerOfFrames(mixed, 'cv', EVERY)).toBeNull()
    expect(paidVideoMakerOfFrames(mixed, 't', EVERY)).toBe('v')
  })

  it('fix round 2 (N3): the saved frames’ embedded prompt and workflow count, and every take’s frames add up with the run’s other kept bytes', async () => {
    const { v, c, g } = paidClip('veo-3.1', { duration: '8' })
    const take: ApiPrompt = { v: v!, c: c!, g: g!, si: saveImage(['g', 0]) }
    const bound = paidVideoClipBound(take, ['c', 0])!
    const shapes = new Map([['g:0', bound]])
    const clip = () => clipAtCaps(MEDIA_CAPS.hosted)
    const plain = saveFramesKeptBytes(take, EVERY, shapes, { clipAtCaps: clip })
    expect(plain.first).toEqual({ nodeId: 'si', classType: 'SaveImage' })
    expect(plain.bytes).toBe(bound.count * (savedFrameBytesBound(bound.w, bound.h) + savedFrameTextBytes(take, null)))
    const workflow = { nodes: 'x'.repeat(1_000_000) }
    const withWorkflow = saveFramesKeptBytes(take, EVERY, shapes, { clipAtCaps: clip, workflow })
    expect(withWorkflow.bytes - plain.bytes).toBe(bound.count * savedFrameTextBytes(null, workflow) - bound.count * savedFrameTextBytes(null, null))
    expect(saveFramesKeptBytes({ ...take, si: { ...take.si!, inputs: { ...take.si!.inputs, embed_metadata: false } } }, EVERY, shapes, { clipAtCaps: clip, workflow }).bytes)
      .toBe(bound.count * savedFrameBytesBound(bound.w, bound.h))
    // Through the engine, hosted, with the room set between one take and two: one starts, two are refused.
    const was = MEDIA_CAPS.hosted.keptBytesPerRun
    try {
      ;(MEDIA_CAPS.hosted as { keptBytesPerRun: number }).keptBytesPerRun = Math.floor(plain.bytes * 1.5)
      const kit = makeKit({ hosted: true, deps: { families: () => EVERY } })
      const one = await kit.engine.quoteRun({ userId: kit.userId, takes: [take], ...START }).catch(e => e)
      expect(one instanceof Error ? one.message : null).toBeNull()
      const two = await kit.engine.quoteRun({ userId: kit.userId, takes: [take, take], ...START }).catch(e => e)
      expect(two.data, two.message).toMatchObject({ code: 'too-much-work', nodeId: 'si' })
      // One take with a 1 MB workflow embedded in each of its 193 frames: past the room too.
      ;(MEDIA_CAPS.hosted as { keptBytesPerRun: number }).keptBytesPerRun = Math.floor(plain.bytes + bound.count * 500_000)
      const big = await kit.engine.quoteRun({ userId: kit.userId, takes: [take], ...START, workflow }).catch(e => e)
      expect(big.data, big.message).toMatchObject({ code: 'too-much-work', nodeId: 'si' })
      expect(kit.ledger.hold).not.toHaveBeenCalled()
    }
    finally {
      ;(MEDIA_CAPS.hosted as { keptBytesPerRun: number }).keptBytesPerRun = was
    }
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
