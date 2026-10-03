/**
 * Task R5.3: the sound nodes in the runner, family `media-sound`
 * (server/runner/media/soundNodes.ts): LoadAudio, RecordAudio, the Audio card
 * beyond its sync-3 and audio-gen rows, SaveAudio, SaveAudioMP3 and
 * PreviewAudio, with Opus export resampled as torchaudio does it.
 *
 * Parity is against scripts/runner_media_fixtures.py --group sound: each
 * class's own execute over the standard sound clips, as the real Python
 * (PyAV 17) runs it. A saved sound is compared as Python's own reader
 * (nodes_audio.load) reads it back: FLAC and MP3 exactly (the same FLAC
 * encoder and LAME), Opus within rule 3's 60 dB (libopus is a float encoder).
 * Names, subfolders, counters and ui equal Python's; the temp previews' five
 * letters are random in both, so only their shape is compared. Tags are
 * JSON-value-equal.
 *
 * The parity parts need the real tools (R5.1a): they fail, never skip, when
 * the tools are missing.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { makeKit } from './__runner__/kit'
import {
  clipPath, deinterleave, mediaFixture, requireMediaTools, sha256Hex, soundBytes, unzF32, type DecodeCase, type PySound,
} from './__runner__/mediaParity'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GATE_CLASS, type ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, FAMILY_REQUIRES, MEDIA_TOOL_FAMILIES, NO_FAMILIES, RUNNER_FAMILIES, parseFamilies, type RunnerFamily } from '#shared/runner/families'
import {
  AUDIO_CARD_AUDIO_GEN_RULE, AUDIO_CARD_MEDIA_RULE, LOCAL_RENDER_TYPES, RUNNER_NODE_RULES, SOUND_OUTPUTS, SWITCHED_CLASSES,
  isRunnerEligible, outputKindsFor, runnerRuleFor, runnerTakesNode, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { RUNNER_OUTPUT_CLASSES, pruneInvalidOutputs, runnerTakesWorkflow } from '#shared/runner/validate'
import { stopGapRefusal } from '#shared/runner/stopGaps'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { AUDIO_GEN_CLASSES } from '#shared/runner/audioGen'
import { MEDIA_WORDS } from '#shared/runner/media'
import { SOUND_EFFECT_OUTPUTS } from '#shared/runner/mediaEffects'
import { planNode, type DeriveIO, type Derived, type NodePlan } from '~~/server/runner/executors'
import { createEngineResultStore, type ResultStore } from '~~/server/runner/results'
import { createFileKeptBytes, type KeptBytes } from '~~/server/runner/keptBytes'
import { createFileAccess, type FileAccess } from '~~/server/runner/fileAccess'
import { collectInputFiles } from '~~/server/runner/inputs'
import { filesOf } from '~~/server/runner/values'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { decodeAudio, type DecodedSound } from '~~/server/media/decode'
import { opusRate, resampleLikeTorchaudio } from '~~/server/media/resample'
import { runMedia } from '~~/server/media/run'
import { readSound } from '~~/server/media/values'
import {
  AUDIO_PREVIEW_LETTERS, OPUS_BIT_RATE_REFUSED, SOUND_FILE_MISSING, SOUND_SAVE_BAD_NAME, SOUND_SAVE_FAILED, SOUND_SAVE_NO_ROOM,
  loadAudioStartProblems, saveAudioFiles, soundSaveWords,
} from '~~/server/runner/media/soundNodes'
import { SAVE_NOT_A_FILE, SAVE_OUTSIDE } from '~~/server/runner/results'
import { createFakeReplicate } from './__runner__/kit'
import { cardCaseKey, cardCases, cardPrompt } from './__runner__/soundCardCases'
import { createHash } from 'node:crypto'
import { runnerFamilies } from '~~/server/runner/config'

/** The tools' remembered answer, as the server's eligibility reads it; null: the real one. */
const TOOLS = vi.hoisted(() => ({ ready: null as boolean | null }))
vi.mock('~~/server/media/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/tools')>()
  return { ...real, mediaToolsReady: () => TOOLS.ready ?? real.mediaToolsReady() }
})

// ── The fixture ──────────────────────────────────────────────────────────────

interface PyEntry { filename: string; subfolder: string; type: string }
interface PyUi { audio: PyEntry[] }
interface PySaved { decoded: PySound; tags: Record<string, string>; stream: { codec: string; rate: number; channels: number; bitRate: number } }
interface SoundCases {
  prompt: ApiPrompt
  extraPnginfo: { workflow: unknown }
  clips: {
    clip: string; load: PySound
    ui: { card: PyUi; preview: PyUi; save: PyUi; mp3: PyUi }
    flac: PySaved; saveTags: Record<string, string>; mp3: PySaved
    written: { output: string[]; temp: string[] }
  }[]
  cardSource: { file: string; source: string; value: PySound; ui: PyUi; flac: PySaved }
  cardSilence: { export: boolean; value: PySound; ui: PyUi; written: { output: string[]; temp: string[] } }[]
  cardExport: {
    clip: string
    cases: ({ format: 'flac' | 'mp3' | 'opus'; quality: string } & ({ ui: PyUi; saved: PySaved } | { error: string; written: string[] }))[]
    written: { output: string[]; temp: string[] }
  }
  batch: { clip: string; scales: number[]; runs: { prefix: string; ui: PyUi; decoded: PySound[] }[]; written: string[] }
  resample: {
    rate: number; input: string; encoderRate: number; filename: string; saved: PySaved
    resample: { orig: number; new: number; samples: number; output: string } | null
  }[]
  answers: { clip: string; value: PySound; ui: PyUi; flac: PySaved }[]
  validate: { missing: string; present: boolean }
}

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const FIX = JSON.parse(readFileSync(join(FIXTURES, 'runner-media-sound.json'), 'utf8')) as { cases: SoundCases; clips: Record<string, string> }
const C = FIX.cases
const LONG = { timeout: 120_000 }
const BIG = Number.MAX_SAFE_INTEGER

/**
 * Rule 3's audio bound for Opus (a float encoder: not bit-stable across
 * builds; R5.1c measured 62–64 dB against Python's decoded file).
 */
const OPUS_SNR_DB = 60

/**
 * The Opus clip's `load`, kept whole by the decode group (R5.1b's named case:
 * some samples a last bit apart, at most 2⁻²⁴).
 */
const OPUS_LOAD_ULP: Record<string, PySound> = Object.fromEntries(
  mediaFixture<DecodeCase>('decode').cases.filter(c => c.clip === 'a_opus.webm' && !('error' in c.load)).map(c => [c.clip, c.load as PySound]),
)

/**
 * Opus export at libopus's own default rate (the card's `V0`: save_audio sets
 * no bit rate, so 64 kb/s for one channel). The resampler's last-bit
 * differences from torch (≤ 1e-6) cross a few s16 rounding steps, and at this
 * rate the encoder's choices then part: measured 52.5 dB against Python's
 * decoded file (fed torchaudio's own samples, ffmpeg's libopus is at 104 dB
 * from PyAV's). Named for the controller; judged as ruling (c) judges two
 * encoders: no further from the source than Python's file (within 0.5 dB).
 */
const OPUS_SOURCE_RULE = new Set(['opus V0', 'opus 128k'])

/** The media families on, as a local server runs them. */
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-sound'])
const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const scratch = mkdtempSync(join(tmpdir(), 'media-sound-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const rid = (n: number) => `run_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let runs = 0

/** A temp preview's name with its five random letters masked (Python's are random too). */
const masked = (name: string) => name.replace(/^ComfyUI_temp_[a-z]{5}_/, 'ComfyUI_temp_?????_')

function snr(want: Float32Array[], got: Float32Array[]): number {
  let sig = 0
  let noise = 0
  for (let c = 0; c < want.length; c++) {
    for (let i = 0; i < want[c]!.length; i++) {
      sig += want[c]![i]! ** 2
      noise += (want[c]![i]! - (got[c]?.[i] ?? 0)) ** 2
    }
  }
  return noise === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10(sig / noise)
}

function channelsOf(f32z: string, rows: number): Float32Array[] {
  const all = unzF32(f32z)
  const n = all.length / rows
  return Array.from({ length: rows }, (_, c) => all.slice(c * n, (c + 1) * n))
}

// ── A node run with the real stores ──────────────────────────────────────────

interface Harness { root: string; results: ResultStore; kept: KeptBytes; access: FileAccess; hosted: boolean; userId: string | null }

function harness(o: { hosted?: boolean; clips?: string[] } = {}): Harness {
  const root = mkdtempSync(join(scratch, 'h-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
  for (const c of o.clips ?? []) copyFileSync(clipPath(c), join(root, 'input', c))
  const hosted = !!o.hosted
  const results = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => hosted })
  const kept = createFileKeptBytes(join(root, 'kept'))
  return { root, results, kept, access: createFileAccess(results, kept), hosted, userId: hosted ? 'user_1' : null }
}

function ioFor(h: Harness, nodeId: string, runId: string, assets: OutputFile[]): DeriveIO {
  const signal = new AbortController().signal
  const opts = (a: { prefix: string; ext: string; subfolder?: string; folder?: 'output' | 'temp' | 'input'; counter?: { prefix: string; offset: number } }) => ({
    userId: h.userId, prefix: a.prefix, ext: a.ext,
    ...(a.subfolder !== undefined ? { subfolder: a.subfolder } : {}),
    ...(a.folder ? { folder: a.folder } : {}),
    ...(a.counter ? { counter: a.counter } : {}),
  })
  return {
    read: f => h.access.read(f),
    keep: (b, ext) => h.kept.put(runId, b, ext),
    saveAsset: async (bytes, a) => {
      const f = await h.results.save(bytes, opts(a))
      if ((a.folder ?? 'output') === 'output') assets.push(f)
      return f
    },
    saveAssetFromPath: async (path, a) => {
      const f = await h.results.saveFromPath!(path, opts(a))
      if ((a.folder ?? 'output') === 'output') assets.push(f)
      return f
    },
    savePreview: async () => { throw new Error('no live previews') },
    savePreviewAs: (bytes, a) => h.results.savePreviewAs(bytes, { filename: a.filename, userId: h.userId }),
    hosted: h.hosted, signal, nodeId,
    runWorkflow: C.extraPnginfo.workflow, runPrompt: C.prompt,
    media: { access: h.access, kept: h.kept, runId, userId: h.userId, hosted: h.hosted, signal },
  }
}

/** Plans and runs node `id` of `prompt`; `values`: what each upstream node handed on (slot 0). */
async function runNode(h: Harness, prompt: ApiPrompt, id: string, values: Record<string, RunnerValue> = {}, families = ON): Promise<Derived & { assets: OutputFile[] }> {
  const plan: NodePlan = await planNode({
    prompt, nodeId: id, families, gateOpen: false,
    filesFrom: l => filesOf(values[l[0]]),
    valueFrom: l => values[l[0]],
    toUrl: async () => '',
  })
  expect(plan.kind, `${prompt[id]!.class_type} plans a derive`).toBe('derive')
  const assets: OutputFile[] = []
  const made = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive(ioFor(h, id, rid(++runs), assets))
  return { ...made, assets }
}

const inputFile = (name: string): OutputFile => ({ filename: name, subfolder: '', type: 'input' })

/** What Python's reader makes of a saved file (nodes_audio.load). */
async function decodedSaved(h: Harness, e: { filename: string; subfolder: string; type: string }): Promise<DecodedSound> {
  const path = h.results.pathOf!(e as OutputFile)
  return decodeAudio(path, { decoder: 'load', userId: null, maxSamples: BIG, roots: [h.results.rootOf!(e as OutputFile)] })
}

async function tagsOf(path: string): Promise<Record<string, string>> {
  const { stdout } = await runMedia({
    tool: 'ffprobe',
    args: ['-protocol_whitelist', 'file,pipe', '-i', `file:${path}`, '-of', 'json', '-show_format', '-show_streams'],
    userId: null,
  })
  const j = JSON.parse(Buffer.from(stdout!).toString('utf8')) as { format?: { tags?: Record<string, string> }; streams?: { tags?: Record<string, string> }[] }
  const tags: Record<string, string> = { ...(j.format?.tags ?? {}) }
  for (const s of j.streams ?? []) for (const [k, v] of Object.entries(s.tags ?? {})) tags[`stream:${k}`] = v
  return tags
}

/** The prompt and workflow tags as JSON values (rule 3: JSON-value-equal). */
function jsonTags(t: Record<string, string>): { prompt: unknown; workflow: unknown } {
  const pick = (k: string) => t[k] ?? t[`stream:${k}`] ?? t[k.toUpperCase()] ?? t[`stream:${k.toUpperCase()}`]
  return { prompt: JSON.parse(pick('prompt')!), workflow: JSON.parse(pick('workflow')!) }
}

/** Every file under a folder, relative, sorted. */
function written(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else out.push(relative(dir, join(d, e.name)))
    }
  }
  walk(dir)
  return out.sort()
}

/** A decoded sound against Python's record: sha-equal, or (a named not-exact case) within `bound` dB when kept whole. */
function expectSound(got: DecodedSound, want: PySound, label: string, o: { snrDb?: number } = {}): number | 'exact' {
  expect(got.rate, label).toBe(want.rate)
  expect(got.channels.length, label).toBe(want.rows)
  expect(got.channels[0]!.length, label).toBe(want.samples)
  if (sha256Hex(soundBytes(got.channels)) === want.sha256) return 'exact'
  if (o.snrDb === undefined || !want.f32z) {
    expect(sha256Hex(soundBytes(got.channels)), `${label}: decodes exactly`).toBe(want.sha256)
    return 'exact'
  }
  const s = snr(channelsOf(want.f32z, want.rows), got.channels)
  expect(s, `${label}: within ${o.snrDb} dB`).toBeGreaterThanOrEqual(o.snrDb)
  return Math.round(s * 10) / 10
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const loadAudio = (audio: string) => ({ class_type: 'LoadAudio', inputs: { audio } })
const recordAudio = (audio: string) => ({ class_type: 'RecordAudio', inputs: { audio } })
const card = (o: { audio?: string; source?: [string, number]; export?: boolean; format?: string; quality?: string; prefix?: string } = {}) => ({
  class_type: 'Audio',
  inputs: {
    audio: o.audio ?? '', export: o.export ?? false, filename_prefix: o.prefix ?? 'audio/ComfyUI',
    format: o.format ?? 'flac', quality: o.quality ?? 'V0', ...(o.source ? { source: o.source } : {}),
  },
})
const saveAudio = (from: string, prefix = 'audio/ComfyUI') => ({ class_type: 'SaveAudio', inputs: { audio: [from, 0] as [string, number], filename_prefix: prefix } })
const saveMp3 = (from: string, quality = 'V0') => ({ class_type: 'SaveAudioMP3', inputs: { audio: [from, 0] as [string, number], filename_prefix: 'audio/ComfyUI', quality } })
const previewAudio = (from: string) => ({ class_type: 'PreviewAudio', inputs: { audio: [from, 0] as [string, number] } })
const music = () => ({ class_type: 'GenerateMusicNode', inputs: { model: 'MusicGen', prompt: 'calm piano', duration: 8, model_version: 'stereo-large', temperature: 1, top_p: 0, seed: 0 } })

// ── Parity: each class over every sound clip ─────────────────────────────────

describe('each class over the sound clips equals Python’s execute', () => {
  const measured: Record<string, number | 'exact'> = {}
  afterAll(() => { console.info('[media-sound] clips: saved sounds against Python (dB, or exact)', JSON.stringify(measured)) })

  for (const c of C.clips) {
    it(`${c.clip}: LoadAudio, RecordAudio, the card, PreviewAudio, SaveAudio and SaveAudioMP3 V0`, LONG, async () => {
      await requireMediaTools()
      const h = harness({ clips: [c.clip] })
      // LoadAudio and RecordAudio hand the file on as it is, read by Python's `load`.
      for (const node of [loadAudio(c.clip), recordAudio(c.clip)]) {
        const made = await runNode(h, { l: node }, 'l')
        expect(made.values[0], node.class_type).toEqual({ kind: 'files', files: [inputFile(c.clip)], sound: { decode: 'load' } })
        expect(made.ui, node.class_type).toBeNull()
        const s = await readSound(made.values[0]!, node.class_type, { access: h.access, userId: null, hosted: false })
        if (c.clip in OPUS_LOAD_ULP) {
          // R5.1b's named case: FFmpeg's float Opus decoder puts some samples a last bit from PyAV's.
          const want = OPUS_LOAD_ULP[c.clip]!
          expect(want.sha256).toBe(c.load.sha256)
          const ref = channelsOf(want.f32z!, want.rows)
          let worst = 0
          for (let ch = 0; ch < ref.length; ch++) for (let i = 0; i < ref[ch]!.length; i++) worst = Math.max(worst, Math.abs(ref[ch]![i]! - s.channels[ch]![i]!))
          expect(worst, `${c.clip}: a last bit at most`).toBeLessThanOrEqual(2 ** -24)
        }
        else expectSound(s, c.load, `${c.clip} ${node.class_type}`)
      }
      const value: RunnerValue = { kind: 'files', files: [inputFile(c.clip)], sound: { decode: 'load' } }
      const whole = c.clip === 'a_opus.webm' ? { snrDb: OPUS_SNR_DB } : {}
      // The card (no export): its file, and a FLAC preview in temp.
      const shown = await runNode(h, { c: card({ audio: c.clip }) }, 'c')
      expect(shown.values[0]).toEqual(value)
      const cardUi = shown.ui as unknown as PyUi
      expect(cardUi.audio.map(e => [masked(e.filename), e.subfolder, e.type])).toEqual(c.ui.card.audio.map(e => [masked(e.filename), e.subfolder, e.type]))
      measured[`${c.clip} card`] = expectSound(await decodedSaved(h, cardUi.audio[0]!), c.flac.decoded, `${c.clip} card preview`, whole)
      // PreviewAudio.
      const preview = await runNode(h, { l: loadAudio(c.clip), p: previewAudio('l') }, 'p', { l: value })
      const previewUi = preview.ui as unknown as PyUi
      expect(previewUi.audio.map(e => [masked(e.filename), e.subfolder, e.type])).toEqual(c.ui.preview.audio.map(e => [masked(e.filename), e.subfolder, e.type]))
      expectSound(await decodedSaved(h, previewUi.audio[0]!), c.flac.decoded, `${c.clip} PreviewAudio`, whole)
      expect(preview.assets).toEqual([])
      // SaveAudio: FLAC into output, Python's name, counter and tags.
      const saved = await runNode(h, { l: loadAudio(c.clip), s: saveAudio('l') }, 's', { l: value })
      expect(saved.ui).toEqual(c.ui.save)
      expect(saved.assets).toEqual(c.ui.save.audio)
      expectSound(await decodedSaved(h, c.ui.save.audio[0]!), c.flac.decoded, `${c.clip} SaveAudio`, whole)
      expect(jsonTags(await tagsOf(h.results.pathOf!(saved.assets[0]!)))).toEqual(jsonTags(c.saveTags))
      // SaveAudioMP3 V0: the counter moves on over the FLAC.
      const mp3 = await runNode(h, { l: loadAudio(c.clip), m: saveMp3('l') }, 'm', { l: value })
      expect(mp3.ui).toEqual(c.ui.mp3)
      measured[`${c.clip} mp3`] = expectSound(await decodedSaved(h, c.ui.mp3.audio[0]!), c.mp3.decoded, `${c.clip} SaveAudioMP3`, c.clip === 'a_opus.webm' ? { snrDb: 60 } : {})
      expect(jsonTags(await tagsOf(h.results.pathOf!(mp3.assets[0]!)))).toEqual(jsonTags(c.mp3.tags))
      // Exactly the files Python wrote (temp names masked).
      expect(written(join(h.root, 'output'))).toEqual(c.written.output)
      expect(written(join(h.root, 'temp')).map(masked)).toEqual(c.written.temp.map(masked))
    })
  }
})

describe('the Audio card', () => {
  it('a wired source wins over its file; the card hands the source on as it came in', LONG, async () => {
    await requireMediaTools()
    const h = harness({ clips: [C.cardSource.file, C.cardSource.source] })
    const src: RunnerValue = { kind: 'files', files: [inputFile(C.cardSource.source)], sound: { decode: 'load' } }
    const made = await runNode(h, { l: loadAudio(C.cardSource.source), c: card({ audio: C.cardSource.file, source: ['l', 0] }) }, 'c', { l: src })
    expect(made.values[0]).toEqual(src)
    const ui = made.ui as unknown as PyUi
    expect(ui.audio.map(e => [masked(e.filename), e.subfolder, e.type])).toEqual(C.cardSource.ui.audio.map(e => [masked(e.filename), e.subfolder, e.type]))
    expectSound(await decodedSaved(h, ui.audio[0]!), C.cardSource.flac.decoded, 'card source')
    const s = await readSound(made.values[0]!, 'Audio', { access: h.access, userId: null, hosted: false })
    expectSound(s, C.cardSource.value, 'card source value')
  })

  for (const c of C.cardSilence) {
    it(`with nothing to play (export ${c.export ? 'on' : 'off'}) hands on Python’s 1 s of silence at 44.1 kHz, kept exactly, and shows nothing`, LONG, async () => {
      await requireMediaTools()
      const h = harness()
      const made = await runNode(h, { c: card({ export: c.export, format: 'mp3' }) }, 'c')
      expect(made.ui).toEqual(c.ui)
      const v = made.values[0]!
      expect(v).toMatchObject({ kind: 'files', sound: { decode: 'exact' } })
      expect(filesOf(v)[0]!.type).toBe('kept')
      expectSound(await readSound(v, 'Audio', { access: h.access, userId: null, hosted: false }), c.value, 'silence')
      expect(written(join(h.root, 'output'))).toEqual(c.written.output)
      expect(written(join(h.root, 'temp'))).toEqual(c.written.temp)
    })
  }

  it('exports in every format and quality as Python does: names, counter, samples; Opus 320k mono fails as PyAV does', LONG, async () => {
    await requireMediaTools()
    const h = harness({ clips: [C.cardExport.clip] })
    const measured: Record<string, number | 'exact'> = {}
    for (const c of C.cardExport.cases) {
      const label = `${c.format} ${c.quality}`
      const node = { c: card({ audio: C.cardExport.clip, export: true, format: c.format, quality: c.quality }) }
      if ('error' in c) {
        // PyAV refuses libopus above its rate for the channels; the runner refuses before any work, in plain words.
        await expect(runNode(h, node, 'c'), label).rejects.toThrow(OPUS_BIT_RATE_REFUSED)
        expect(written(join(h.root, 'output')), label).toEqual(c.written)
        continue
      }
      const made = await runNode(h, node, 'c')
      expect(made.ui, label).toEqual(c.ui)
      expect(made.assets, label).toEqual(c.ui.audio)
      const ours = await decodedSaved(h, c.ui.audio[0]!)
      if (OPUS_SOURCE_RULE.has(label)) {
        // The named case: each file against the source (the clip at 48 kHz, as save_audio resamples it).
        const clip = await decodeAudio(clipPath(C.cardExport.clip), { decoder: 'load', userId: null, maxSamples: BIG, roots: [join(FIXTURES, 'media')] })
        const source = resampleLikeTorchaudio(clip.channels, clip.rate, 48000)
        const python = channelsOf(c.saved.decoded.f32z!, c.saved.decoded.rows)
        expect(ours.channels[0]!.length, label).toBe(python[0]!.length)
        const [pySnr, ourSnr] = [snr(source, python), snr(source, ours.channels)]
        measured[label] = Math.round(snr(python, ours.channels) * 10) / 10
        measured[`${label} from the source (Python, Sailor)`] = `${Math.round(pySnr * 10) / 10}, ${Math.round(ourSnr * 10) / 10}` as unknown as number
        expect(ourSnr, `${label}: no further from the source than Python's`).toBeGreaterThanOrEqual(pySnr - 0.5)
      }
      else measured[label] = expectSound(ours, c.saved.decoded, label, c.format === 'opus' ? { snrDb: OPUS_SNR_DB } : {})
      if (c.format !== 'opus') expect(measured[label], `${label}: FLAC and LAME decode exactly`).toBe('exact')
      expect(jsonTags(await tagsOf(h.results.pathOf!(made.assets[0]!))), label).toEqual(jsonTags(c.saved.tags))
    }
    console.info('[media-sound] card export against Python (dB, or exact)', JSON.stringify(measured))
    expect(written(join(h.root, 'output'))).toEqual(C.cardExport.written.output)
    // With export on, the card shows the saved copy: no preview is written to temp.
    expect(written(join(h.root, 'temp'))).toEqual([])
  })

  it('shows a Generate music answer as Python’s FLAC of the download decode (mono exactly; stereo read as two channels, ruling k)', LONG, async () => {
    await requireMediaTools()
    for (const a of C.answers) {
      const h = harness({ clips: [a.clip] })
      // The answer as audio-gen saved it: a file in output, no sound note (an R3.8-era value).
      copyFileSync(clipPath(a.clip), join(h.root, 'output', a.clip))
      const answer: RunnerValue = { kind: 'files', files: [{ filename: a.clip, subfolder: '', type: 'output' }] }
      const made = await runNode(h, { g: music(), c: card({ source: ['g', 0] }) }, 'c', { g: answer })
      // Handed on with the note its maker implies, so a reader after the card decodes it as Python does.
      expect(made.values[0]).toEqual({ ...answer, sound: { decode: 'download' } })
      const ui = made.ui as unknown as PyUi
      expect(ui.audio.map(e => [masked(e.filename), e.subfolder, e.type])).toEqual(a.ui.audio.map(e => [masked(e.filename), e.subfolder, e.type]))
      const got = await decodedSaved(h, ui.audio[0]!)
      if (a.flac.decoded.rows === 1 && got.channels.length === 2) {
        // Ruling (k): Python reads a stereo WAV answer as one interleaved row; Sailor reads its two channels.
        // The same samples: interleaved, ours are Python's row exactly.
        const row = new Float32Array(got.channels[0]!.length * 2)
        for (let i = 0; i < got.channels[0]!.length; i++) { row[2 * i] = got.channels[0]![i]!; row[2 * i + 1] = got.channels[1]![i]! }
        expect(sha256Hex(new Uint8Array(row.buffer)), `${a.clip}: the same samples, read as two channels`).toBe(a.flac.decoded.sha256)
        expect(deinterleave(row, 2).length).toBe(2)
      }
      else expectSound(got, a.flac.decoded, a.clip)
    }
  })
})

describe('SaveAudio’s names and counters', () => {
  it('a two-item batch: %batch_num% per item, the counter moved on per item, and run again', LONG, async () => {
    await requireMediaTools()
    const h = harness({ clips: [C.batch.clip] })
    const one = await decodeAudio(clipPath(C.batch.clip), { decoder: 'load', userId: null, maxSamples: BIG, roots: [join(FIXTURES, 'media')] })
    const sounds = C.batch.scales.map(k => ({ rate: one.rate, channels: one.channels.map(ch => ch.map(x => Math.fround(x * k))) }))
    for (const r of C.batch.runs) {
      const io = ioFor(h, 's', rid(++runs), [])
      const files = await saveAudioFiles(io, sounds, { prefix: r.prefix, format: 'flac', quality: '128k', folder: 'output' })
      expect(files.map(f => ({ filename: f.filename, subfolder: f.subfolder, type: f.type })), r.prefix).toEqual(r.ui.audio)
      for (const [i, f] of files.entries()) expectSound(await decodedSaved(h, f), r.decoded[i]!, `${r.prefix} #${i}`)
    }
    expect(written(join(h.root, 'output'))).toEqual(C.batch.written)
  })
})

describe('Opus export’s resample (ruling j)', () => {
  it('converts 44.1, 22.05 and 96 kHz as torchaudio does (within a millionth), leaves 8 kHz, and encodes within 60 dB', LONG, async () => {
    await requireMediaTools()
    const h = harness()
    let worst = 0
    for (const r of C.resample) {
      const input = channelsOf(r.input, 2)
      expect(opusRate(r.rate), `${r.rate}`).toBe(r.encoderRate)
      if (r.resample) {
        const got = resampleLikeTorchaudio(input, r.resample.orig, r.resample.new)
        const want = channelsOf(r.resample.output, 2)
        for (let c = 0; c < 2; c++) {
          expect(got[c]!.length, `${r.rate}`).toBe(r.resample.samples)
          for (let i = 0; i < got[c]!.length; i++) worst = Math.max(worst, Math.abs(got[c]![i]! - want[c]![i]!))
        }
      }
      else expect(r.rate, 'only an Opus rate goes unconverted').toBe(r.encoderRate)
      const io = ioFor(h, 's', rid(++runs), [])
      const [f] = await saveAudioFiles(io, [{ rate: r.rate, channels: input }], { prefix: `r${r.rate}`, format: 'opus', quality: '128k', folder: 'output' })
      expect(f!.filename).toBe(r.filename)
      expectSound(await decodedSaved(h, f!), r.saved.decoded, `opus from ${r.rate}`, { snrDb: OPUS_SNR_DB })
    }
    console.info(`[media-sound] resample worst difference ${worst}`)
    // A library kernel (R2 rule 10): ε measured against torchaudio 2.10 and written here.
    expect(worst).toBeLessThanOrEqual(1e-6)
  })
})

// ── Eligibility ──────────────────────────────────────────────────────────────

describe('the family', () => {
  it('is known, needs `cards`, and is dropped without it', () => {
    // Known, but kept out of RUNNER_FAMILIES so every pre-R5 "every family" set is unchanged (rule 8).
    expect(ALL_RUNNER_FAMILIES).toContain('media-sound')
    // R5.4's media-video joined it, and R3.10's sound-in (its WAV is made with the tools).
    expect(MEDIA_TOOL_FAMILIES).toEqual(['media-sound', 'media-video', 'sound-in'])
    expect(RUNNER_FAMILIES).not.toContain('media-sound')
    expect(FAMILY_REQUIRES['media-sound']).toBe('cards')
    expect([...parseFamilies('media-sound')]).toEqual([])
    expect([...parseFamilies('cards,media-sound')].sort()).toEqual(['cards', 'media-sound'])
  })

  it('answers as off on the server while the video tools are missing or refused', () => {
    const env = { ...process.env }
    process.env.NUXT_RUNNER_ENABLED = 'true'
    process.env.NUXT_RUNNER_FAMILIES = 'cards,media-sound'
    try {
      TOOLS.ready = false
      expect([...runnerFamilies()]).toEqual(['cards'])
      TOOLS.ready = true
      expect([...runnerFamilies()].sort()).toEqual(['cards', 'media-sound'])
    }
    finally {
      TOOLS.ready = null
      process.env = env
    }
  })

  it('SOUND_OUTPUTS lists every sound maker, each taken only while its own family is on', () => {
    expect(SOUND_OUTPUTS).toEqual([
      ['LoadAudio', 0], ['RecordAudio', 0], ['Audio', 0], ['GetVideoComponents', 1],
      ...AUDIO_GEN_CLASSES.map(c => [c, 0]), ['CloneSingingVoiceNode', 0],
      // R6.9: every sound effect's sound slots (taken only while `sound-effects` is on: runner-media-sfx).
      ...SOUND_EFFECT_OUTPUTS,
      // R7.8: Vocal separator's two stems (taken only while `vocal-split` is on: runner-local-vocals).
      ['VocalSeparator', 0], ['VocalSeparator', 1],
    ])
    for (const cls of ['SaveAudio', 'SaveAudioMP3', 'PreviewAudio']) expect(RUNNER_NODE_RULES[cls]!.linkSources, cls).toEqual({ audio: SOUND_OUTPUTS })
    expect(AUDIO_CARD_MEDIA_RULE.linkSources).toEqual({ source: SOUND_OUTPUTS })
  })

  it('the rows: loaders are sources, the card, savers and PreviewAudio render and are output nodes', () => {
    for (const cls of ['LoadAudio', 'RecordAudio']) expect(RUNNER_NODE_RULES[cls]).toMatchObject({ family: 'media-sound', local: 'source' })
    for (const cls of ['SaveAudio', 'SaveAudioMP3', 'PreviewAudio']) {
      expect(RUNNER_NODE_RULES[cls]).toMatchObject({ family: 'media-sound', local: 'render' })
      expect(LOCAL_RENDER_TYPES.has(cls), cls).toBe(true)
      expect(RUNNER_OUTPUT_CLASSES.has(cls), cls).toBe(true)
    }
    for (const cls of ['LoadAudio', 'RecordAudio', 'SaveAudio', 'SaveAudioMP3', 'PreviewAudio']) expect(SWITCHED_CLASSES[cls], cls).toBe('media-sound')
    expect(AUDIO_CARD_MEDIA_RULE).toMatchObject({ family: 'media-sound', local: 'render' })
    expect(AUDIO_CARD_MEDIA_RULE.widgets).toMatchObject({
      format: { type: 'COMBO', options: ['flac', 'mp3', 'opus'] },
      quality: { type: 'COMBO', options: ['V0', '128k', '192k', '320k'] },
    })
    expect(RUNNER_NODE_RULES.SaveAudioMP3!.widgets!.quality).toMatchObject({ type: 'COMBO', options: ['V0', '128k', '320k'] })
  })

  it('the card’s row: audio-gen’s while media-sound is off, the media row while on, else sync-3’s', () => {
    const wired = { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: ['g', 0] }
    const own = { ...wired, audio: 'a.wav', source: undefined }
    expect(runnerRuleFor('Audio', wired, new Set(['cards', 'audio-gen']))).toBe(AUDIO_CARD_AUDIO_GEN_RULE)
    expect(runnerRuleFor('Audio', wired, new Set(['cards', 'audio-gen', 'media-sound']))).toBe(AUDIO_CARD_MEDIA_RULE)
    expect(runnerRuleFor('Audio', own, new Set(['cards', 'media-sound', 'sync-3']))).toBe(AUDIO_CARD_MEDIA_RULE)
    expect(runnerRuleFor('Audio', own, new Set(['cards', 'sync-3']))).toBe(RUNNER_NODE_RULES.Audio)
    expect(runnerRuleFor('Audio', wired, new Set(['cards', 'sync-3']))).toBe(RUNNER_NODE_RULES.Audio)
  })

  it('takes the sound workflows with media-sound and `cards` on, and leaves them to the engine otherwise', () => {
    const graphs: Record<string, ApiPrompt> = {
      'load → save': { l: loadAudio('a.wav'), s: saveAudio('l') },
      'record → mp3': { r: recordAudio('rec.webm'), m: saveMp3('r') },
      'load → card → preview': { l: loadAudio('a.wav'), c: card({ source: ['l', 0] }), p: previewAudio('c') },
      'a card alone': { c: card({ audio: 'a.wav' }) },
      'a card exporting': { c: card({ audio: 'a.wav', export: true, format: 'opus', quality: '128k' }) },
      'a silent card': { c: card() },
    }
    for (const [name, p] of Object.entries(graphs)) {
      expect(runnerTakesWorkflow(p, ON), name).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: ON, titleOf: id => id }), name).toEqual([])
      for (const off of [NO_FAMILIES, CARDS, new Set<RunnerFamily>(['media-sound'])]) {
        expect(runnerTakesWorkflow(p, off), `${name} with ${[...off].join(',') || 'none'}`).toBe(false)
      }
    }
  })

  it('leaves a sound from anything else, a wired setting or an unknown quality to the engine', () => {
    const refused: Record<string, ApiPrompt> = {
      'a sound through a Gate': { l: loadAudio('a.wav'), g: { class_type: GATE_CLASS, inputs: { data_in: ['l', 0], bypass: true } }, s: saveAudio('g') },
      'a wired file name': { t: { class_type: 'PrimitiveString', inputs: { value: 'x' } }, l: { class_type: 'LoadAudio', inputs: { audio: ['t', 0] } }, s: saveAudio('l') },
      'a card with an unknown format': { c: { ...card({ audio: 'a.wav' }), inputs: { ...card({ audio: 'a.wav' }).inputs, format: 'wav' } } },
      'Save audio (Opus), not ported': { l: loadAudio('a.wav'), o: { class_type: 'SaveAudioOpus', inputs: { audio: ['l', 0], filename_prefix: 'audio/ComfyUI', quality: '128k' } } },
    }
    // R11.9a (row 17): a wired setting is sent to the runner, to be refused plainly before the hold.
    for (const [name, p] of Object.entries(refused)) {
      if (name === 'a wired file name') expect(stopGapRefusal(p, ON)?.code, name).toBe('wired-setting')
      else expect(runnerTakesWorkflow(p, ON), name).toBe(false)
    }
    // An MP3 quality ComfyUI's validation refuses: the runner refuses the prompt with ComfyUI's own error, as ComfyUI would.
    const badQuality: ApiPrompt = { l: loadAudio('a.wav'), m: saveMp3('l', '192k') }
    expect(runnerTakesWorkflow(badQuality, ON)).toBe(true)
    expect(pruneInvalidOutputs(badQuality, ON)).toMatchObject({ failed: true, dropped: ['m'], nodeErrors: { m: { errors: [{ type: 'value_not_in_list' }] } } })
  })

  it('a Generate music sound may be saved directly while media-sound is on (and only the card reads it while off)', () => {
    const direct: ApiPrompt = { g: music(), s: saveAudio('g') }
    expect(runnerTakesNode(direct, 'g', new Set(['cards', 'audio-gen', 'media-sound']))).toBe(true)
    expect(runnerTakesNode(direct, 'g', new Set(['cards', 'audio-gen']))).toBe(false)
    const shown: ApiPrompt = { g: music(), c: card({ source: ['g', 0] }), s: saveAudio('c') }
    expect(runnerTakesWorkflow(shown, new Set(['cards', 'audio-gen', 'media-sound']))).toBe(true)
  })

  it('pruning knows the classes only while the family is on', () => {
    const p: ApiPrompt = { l: loadAudio('a.wav'), s: saveAudio('l'), x: loadAudio('b.wav') }
    expect(pruneInvalidOutputs(p, ON).unread).toEqual(['x'])
    expect(pruneInvalidOutputs(p, CARDS).prompt).toBe(p)
  })

  it('collects LoadAudio’s and RecordAudio’s files as the workflow’s own (hosted: must be the user’s)', () => {
    expect(collectInputFiles({ l: loadAudio('sub/a.wav'), r: recordAudio('rec.webm [temp]'), w: { class_type: 'LoadAudio', inputs: { audio: ['x', 0] } } }))
      .toEqual([{ filename: 'a.wav', subfolder: 'sub', type: 'input' }, { filename: 'rec.webm', subfolder: '', type: 'temp' }])
  })
})

// ── Rule 8: with media-sound off, nothing changes ────────────────────────────

/** The rows R5.3 added, taken away: the tables as they were before it. */
function beforeR53<T>(fn: () => T): T {
  const rules = RUNNER_NODE_RULES as Record<string, unknown>
  const switched = SWITCHED_CLASSES as Record<string, unknown>
  const renders = LOCAL_RENDER_TYPES as Set<string>
  const added = ['LoadAudio', 'RecordAudio', 'SaveAudio', 'SaveAudioMP3', 'PreviewAudio']
  const saved = added.map(c => [c, rules[c], switched[c], renders.has(c)] as const)
  const gen = AUDIO_GEN_CLASSES.map(c => [c, (rules[c] as { feedsAlso?: unknown }).feedsAlso] as const)
  for (const c of added) { delete rules[c]; delete switched[c]; renders.delete(c) }
  for (const [c] of gen) delete (rules[c] as { feedsAlso?: unknown }).feedsAlso
  try { return fn() }
  finally {
    for (const [c, r, s, isRender] of saved) { rules[c] = r; switched[c] = s; if (isRender) renders.add(c) }
    for (const [c, f] of gen) if (f !== undefined) (rules[c] as { feedsAlso?: unknown }).feedsAlso = f
  }
}

function answers(p: ApiPrompt, families: ReadonlySet<RunnerFamily>) {
  const kinds = outputKindsFor(families)
  return {
    needs: nodesNeedingEngine(p, { runnerOn: true, families, titleOf: id => id }),
    workflow: runnerTakesWorkflow(p, families),
    eligible: isRunnerEligible(p, families),
    pruned: pruneInvalidOutputs(p, families),
    // The Audio card's row too (the one class R5.3 gives a row by families).
    nodes: Object.keys(p).map(id => [
      runnerTakesNode(p, id, families), valueWiresAllowed(p, id, kinds, families),
      p[id]!.class_type === 'Audio' ? runnerRuleFor('Audio', p[id]!.inputs ?? {}, families) : null,
    ]),
    kinds,
  }
}

/** Every family but media-sound (and the sets R3.8 and F22 run under). */
const OFF_SETS: [string, RunnerFamily[]][] = [
  ['none', []],
  ['cards', ['cards']],
  ['sync-3', ['cards', 'sync-3']],
  ['audio-gen', ['cards', 'audio-gen']],
  ['audio-gen and sync-3', ['cards', 'audio-gen', 'sync-3']],
  ['every family but media-sound', ALL_RUNNER_FAMILIES.filter(f => f !== 'media-sound')],
]

const SOUND_GRAPHS: Record<string, ApiPrompt> = {
  'sound saved three ways': { l: loadAudio('a.wav'), s: saveAudio('l'), m: saveMp3('l'), p: previewAudio('l') },
  'a card feeding a lip-sync': {
    c: card({ audio: 'a.wav' }),
    ls: { class_type: 'LipSyncNode', inputs: { engine: 'sync-3', model_options: '{"engine":"sync-3","face_video":"face.mp4"}', sync_mode: 'cut_off', audio: ['c', 0] } },
  },
  'a music card feeding a lip-sync': {
    g: music(), c: card({ source: ['g', 0] }),
    ls: { class_type: 'LipSyncNode', inputs: { engine: 'sync-3', model_options: '{"engine":"sync-3","face_video":"face.mp4"}', sync_mode: 'cut_off', audio: ['c', 0] } },
  },
  'a music card alone': { g: music(), c: card({ source: ['g', 0] }) },
  'music saved directly': { g: music(), s: saveAudio('g') },
  'a card exporting': { c: card({ audio: 'a.wav', export: true }) },
  'recorded into a card': { r: recordAudio('rec.webm'), c: card({ source: ['r', 0] }) },
}

describe('rule 8: with media-sound off, every answer is as before R5.3', () => {
  it('over the checked-in sound graphs, under every other family set', () => {
    let n = 0
    for (const [name, p] of Object.entries(SOUND_GRAPHS)) {
      for (const [set, fam] of OFF_SETS) {
        const families = new Set(fam)
        expect(answers(p, families), `${name}, ${set}`).toEqual(beforeR53(() => answers(p, families)))
        n++
      }
    }
    expect(n).toBe(Object.keys(SOUND_GRAPHS).length * OFF_SETS.length)
    // Teeth: with media-sound on the answers differ.
    expect(answers(SOUND_GRAPHS['sound saved three ways']!, ON)).not.toEqual(beforeR53(() => answers(SOUND_GRAPHS['sound saved three ways']!, ON)))
  })

  const PROJECTS = fileURLToPath(new URL('../../../user/sailor/projects/', import.meta.url))
  // The saved projects are this machine's own data: with the folder missing the check is skipped, visibly.
  const projectsIt = existsSync(PROJECTS) ? it : it.skip
  projectsIt('over every saved project graph (made into prompts as the app makes them)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(fileURLToPath(new URL('../../server/assets/nodeCatalog.json.gz', import.meta.url)))).toString('utf8'))
    let graphs = 0
    let sound = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        if (Object.values(p).some(n => ['LoadAudio', 'RecordAudio', 'SaveAudio', 'SaveAudioMP3', 'PreviewAudio', 'Audio'].includes(n.class_type))) sound++
        for (const [name, fam] of OFF_SETS) {
          const families = new Set(fam)
          expect(answers(p, families), `${uuid}, ${name}`).toEqual(beforeR53(() => answers(p, families)))
        }
        graphs++
      }
    }
    // A lower bound, not an exact count: the folder is live data (R5.2 counted 940).
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`[media-sound] rule 8 held over ${graphs} saved graphs (${sound} with a sound node)`)
  }, 300_000)
})

// ── The engine, end to end ───────────────────────────────────────────────────

describe('the engine', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function soundKit(o: { hosted?: boolean; owns?: boolean } = {}) {
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const kept = createFileKeptBytes(join(dir, 'runner-kept'))
    const k = makeKit({
      hosted: o.hosted, dir,
      deps: {
        families: () => ON, kept,
        ...(o.owns === false ? { ownership: { ownsInput: async () => false, ownsOutput: async () => false } } : {}),
      },
    })
    copyFileSync(clipPath('a_min.wav'), join(k.root, 'input', 'a_min.wav'))
    return k
  }

  it('runs LoadAudio → SaveAudio: the file saved under Python’s name, free of any provider', LONG, async () => {
    await requireMediaTools()
    const k = soundKit()
    const { runId } = await k.engine.startRun({ userId: null, takes: [{ l: loadAudio('a_min.wav'), s: saveAudio('l') }], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    expect(t.nodes.s!.status, t.nodes.s!.error ?? '').toBe('done')
    expect(t.nodes.s!.outputs).toEqual([{ filename: 'ComfyUI_00001_.flac', subfolder: 'audio', type: 'output' }])
    expect(existsSync(join(k.root, 'output', 'audio', 'ComfyUI_00001_.flac'))).toBe(true)
  })

  it('refuses a LoadAudio file that isn’t there before the run, in plain words (Python: “Invalid audio file”)', async () => {
    expect(C.validate).toEqual({ missing: 'Invalid audio file: no_such_sound.wav', present: true })
    const k = soundKit()
    await expect(k.engine.startRun({ userId: null, takes: [{ l: loadAudio('no_such_sound.wav'), s: saveAudio('l') }], ...START })).rejects.toThrow(SOUND_FILE_MISSING)
    expect(await loadAudioStartProblems({ l: loadAudio('a_min.wav'), s: saveAudio('l') }, async () => true)).toBeNull()
  })

  it('hosted: an audio file that isn’t the user’s is refused before the hold', async () => {
    const k = soundKit({ hosted: true, owns: false })
    await expect(k.engine.startRun({ userId: k.userId, takes: [{ l: loadAudio('a_min.wav'), s: saveAudio('l') }], ...START })).rejects.toThrow('isn’t one of yours')
    await expect(k.engine.startRun({ userId: k.userId, takes: [{ c: card({ audio: 'a_min.wav', export: true }) }], ...START })).rejects.toThrow('isn’t one of yours')
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('hosted: a saved sound is in the user’s own folder and counted as the run’s output; a preview is not', LONG, async () => {
    await requireMediaTools()
    const k = soundKit({ hosted: true })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ l: loadAudio('a_min.wav'), s: saveAudio('l'), p: previewAudio('l') }], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    expect(t.nodes.s!.status, t.nodes.s!.error ?? '').toBe('done')
    expect(t.nodes.p!.status, t.nodes.p!.error ?? '').toBe('done')
    const out = t.nodes.s!.outputs[0]!
    expect(out.subfolder).toMatch(/^u_[0-9a-f]+\/audio$/)
    expect(existsSync(join(k.root, 'output', out.subfolder, out.filename))).toBe(true)
    const recorded = k.graphRuns.appendOutput.mock.calls.map(c => String(c[1]))
    expect(recorded.some(r => r.includes(out.filename))).toBe(true)
    expect(recorded.some(r => r.includes('ComfyUI_temp_'))).toBe(false)
    expect(t.nodes.p!.outputs).toEqual([])
  })

  it('LipSync on sync-3 still reads the card’s own file as it is, with media-sound on', async () => {
    const p: ApiPrompt = SOUND_GRAPHS['a card feeding a lip-sync']!
    const fam = new Set<RunnerFamily>(['cards', 'media-sound', 'sync-3'])
    expect(runnerTakesNode(p, 'c', fam)).toBe(true)
    const h = harness({ clips: ['a_min.wav'] })
    const c = { ...p, c: card({ audio: 'a_min.wav' }) }
    const made = await runNode(h, c, 'c', {}, fam)
    // The value the lip-sync's link reads: the card's own file, untouched.
    expect(filesOf(made.values[0])).toEqual([inputFile('a_min.wav')])
  })
})

describe('guards', () => {
  it('AUDIO_PREVIEW_LETTERS are PreviewAudio’s 26 letters (not PreviewImage’s)', () => {
    expect(AUDIO_PREVIEW_LETTERS).toBe('abcdefghijklmnopqrstuvwxyz')
  })

  it('a node with no media IO (a live preview) fails plainly', async () => {
    const plan = await planNode({ prompt: { c: card({ audio: 'a.wav' }) }, nodeId: 'c', families: ON, gateOpen: false, filesFrom: () => [], toUrl: async () => '' })
    const io = { ...ioFor(harness(), 'c', rid(++runs), []), media: undefined }
    await expect((plan as Extract<NodePlan, { kind: 'derive' }>).derive(io)).rejects.toThrow()
  })

  it('a 3-channel sound fails plainly where PyAV raises', LONG, async () => {
    await requireMediaTools()
    const h = harness()
    const three: DecodedSound = { rate: 44100, channels: [new Float32Array(10), new Float32Array(10), new Float32Array(10)] }
    await expect(saveAudioFiles(ioFor(h, 's', rid(++runs), []), [three], { prefix: 'x', format: 'flac', quality: '128k', folder: 'output' })).rejects.toThrow(MEDIA_WORDS.failed)
    expect(written(join(h.root, 'output'))).toEqual([])
  })
})

// ── Fix round 1 ──────────────────────────────────────────────────────────────

const videoCard = (from: string) => ({ class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: [from, 0] as [string, number] } })
const lipSync = (from: string) => ({ class_type: 'LipSyncNode', inputs: { engine: 'sync-3', model_options: '{"engine":"sync-3","face_video":"face.mp4"}', sync_mode: 'cut_off', audio: [from, 0] as [string, number] } })

describe('fix round 1 (A): a loaded or recorded sound through the card into a Lip-sync stays with the engine', () => {
  it('with media-sound on the workflow goes to the engine, as before R5.3, and is never refused', () => {
    const fam = new Set<RunnerFamily>(['cards', 'sync-3', 'audio-gen', 'media-sound'])
    const before = new Set<RunnerFamily>(['cards', 'sync-3', 'audio-gen'])
    for (const src of [loadAudio('b.wav'), recordAudio('rec.webm'), card({ audio: 'b.wav' })]) {
      // The Video card after the lip-sync shows its result (a lip-sync nothing reads is not run, by ComfyUI either).
      const p: ApiPrompt = { s: src, c: card({ source: ['s', 0] }), ls: lipSync('c'), v: videoCard('ls') }
      expect(runnerTakesWorkflow(p, fam), src.class_type).toBe(false)
      expect(runnerTakesNode(p, 'c', fam), src.class_type).toBe(false)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }), src.class_type).toContain('c')
      expect(runnerTakesWorkflow(p, before), `${src.class_type}, before`).toBe(false)
    }
    // The card's own file, and a music node's sound, still reach sync-3 in the runner.
    expect(runnerTakesNode({ c: card({ audio: 'a.wav' }), ls: lipSync('c'), v: videoCard('ls') }, 'c', fam)).toBe(true)
    expect(runnerTakesNode({ g: music(), c: card({ source: ['g', 0] }), ls: lipSync('c'), v: videoCard('ls') }, 'c', fam)).toBe(true)
    // Read by anything else, a loaded sound through the card is the runner's.
    expect(runnerTakesWorkflow({ s: loadAudio('b.wav'), c: card({ source: ['s', 0] }), p: previewAudio('c') }, fam)).toBe(true)
  })
})

describe('fix round 1 (B): a loader’s file with no sound fails at that node before the run', () => {
  const NO_SOUND = 'v_h264_601.mp4'
  it('LoadAudio and RecordAudio are refused before anything is held, in Python’s plain words', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const k = makeKit({ dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    copyFileSync(clipPath(NO_SOUND), join(k.root, 'input', NO_SOUND))
    for (const node of [loadAudio(NO_SOUND), recordAudio(NO_SOUND)]) {
      const err = await k.engine.startRun({ userId: null, takes: [{ l: node, s: saveAudio('l') }], ...START }).then(() => null, e => e as Error & { data?: Record<string, unknown> })
      expect(err?.message, node.class_type).toContain(MEDIA_WORDS.noSound)
    }
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('the node itself fails at its turn too (the backstop), and a sound file passes', LONG, async () => {
    await requireMediaTools()
    const h = harness({ clips: [NO_SOUND, 'a_min.wav'] })
    await expect(runNode(h, { l: recordAudio(NO_SOUND) }, 'l')).rejects.toThrow(MEDIA_WORDS.noSound)
    await expect(runNode(h, { l: loadAudio('a_min.wav') }, 'l')).resolves.toBeTruthy()
    const exists = (f: OutputFile) => h.access.exists(f)
    const probe = async (f: OutputFile) => (await import('~~/server/runner/media/soundNodes')).soundStreamProblem(h.access, f, null)
    expect(await loadAudioStartProblems({ l: loadAudio(NO_SOUND) }, exists, probe)).toMatchObject({ nodeId: 'l', classType: 'LoadAudio', message: MEDIA_WORDS.noSound })
    expect(await loadAudioStartProblems({ l: recordAudio('missing.webm') }, exists, probe)).toBeNull()
    expect(await loadAudioStartProblems({ l: loadAudio('a_min.wav') }, exists, probe)).toBeNull()
  })
})

describe('fix round 1 (Important 1): the stage’s history lists each file once', () => {
  for (const exporting of [false, true]) {
    it(`Generate music → Audio card (export ${exporting ? 'on' : 'off'}): the music once${exporting ? ', and the export once' : ''}`, LONG, async () => {
      await requireMediaTools()
      const bytes = readFileSync(clipPath('a_min.wav'))
      const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: 'https://r.test/music/out.wav' }) })
      const dir = mkdtempSync(join(scratch, 'runs-'))
      const k = makeKit({
        dir, replicate,
        deps: { families: () => new Set<RunnerFamily>(['cards', 'audio-gen', 'media-sound']), kept: createFileKeptBytes(join(dir, 'kept')), download: async () => ({ bytes: new Uint8Array(bytes), contentType: 'audio/wav' }) },
      })
      const { runId } = await k.engine.startRun({ userId: null, takes: [{ g: music(), c: card({ source: ['g', 0], export: exporting }) }], ...START })
      await k.engine.settled(runId)
      const nodes = (await k.store.get(runId))!.takes[0]!.nodes
      expect(nodes.c!.status, nodes.c!.error ?? '').toBe('done')
      const made = nodes.g!.outputs[0]!
      const written = k.records.write.mock.calls.flatMap(c => (c[0] as { outputs: OutputFile[] }).outputs)
      const keys = written.map(f => `${f.type}:${f.subfolder}:${f.filename}`)
      expect(new Set(keys).size, keys.join(', ')).toBe(keys.length)
      expect(keys.filter(x => x === `output:${made.subfolder}:${made.filename}`)).toHaveLength(1)
      expect(written.length).toBe(exporting ? 2 : 1)
    })
  }
})

describe('fix round 1 (Minor 3): the card’s rows with media-sound off equal the code before R5.3', () => {
  const PIN = JSON.parse(readFileSync(join(FIXTURES, 'runner-media-sound-card-rows.json'), 'utf8')) as {
    commit: string; rows: Record<string, { prompt: string; rule: string; card: boolean; workflow: boolean; needs: string[] }>
  }
  it('every configuration and family set answers as b56ff8551 pinned it', () => {
    const cases = cardCases()
    expect(Object.keys(PIN.rows)).toHaveLength(cases.length)
    const tally: Record<string, number> = {}
    for (const k of cases) {
      const key = cardCaseKey(k)
      const want = PIN.rows[key]!
      const p = cardPrompt(k)
      const fam = new Set(k.families) as ReadonlySet<RunnerFamily>
      expect(createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16), `${key}: the same prompt`).toBe(want.prompt)
      const rule = runnerRuleFor('Audio', p.c!.inputs ?? {}, fam)
      const got = {
        prompt: want.prompt,
        rule: rule === AUDIO_CARD_AUDIO_GEN_RULE ? 'audio-gen' : rule === RUNNER_NODE_RULES.Audio ? 'sync-3' : rule ? 'other' : 'none',
        card: runnerTakesNode(p, 'c', fam),
        workflow: runnerTakesWorkflow(p, fam),
        needs: nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }),
      }
      expect(got, key).toEqual(want)
      tally[`${got.rule} ${got.card}`] = (tally[`${got.rule} ${got.card}`] ?? 0) + 1
      // With media-sound on (and cards), the media row, whatever else is on.
      if (k.families.includes('cards')) expect(runnerRuleFor('Audio', p.c!.inputs ?? {}, new Set([...fam, 'media-sound'])), key).toBe(AUDIO_CARD_MEDIA_RULE)
    }
    // Teeth: the pinned answers take the card under both of its old rows.
    expect(tally['sync-3 true']).toBeGreaterThan(0)
    expect(tally['audio-gen true']).toBeGreaterThan(0)
  })
})

describe('fix round 1 (Minor 4): save failures in plain words by cause', () => {
  const coded = (code: string) => Object.assign(new Error(`${code}: /srv/secret/output/x`), { code })
  it('only a name problem asks for another name; the server’s folders are never named', () => {
    expect(soundSaveWords(coded('ENAMETOOLONG'))).toBe(SOUND_SAVE_BAD_NAME)
    expect(soundSaveWords(coded('EINVAL'))).toBe(SOUND_SAVE_BAD_NAME)
    expect(soundSaveWords(coded('ENOSPC'))).toBe(SOUND_SAVE_NO_ROOM)
    expect(soundSaveWords(new Error(SAVE_NOT_A_FILE))).toBe(SAVE_NOT_A_FILE)
    expect(soundSaveWords(new Error(SAVE_OUTSIDE))).toBe(SAVE_OUTSIDE)
    expect(soundSaveWords(coded('EACCES'))).toBe(SOUND_SAVE_FAILED)
    expect(soundSaveWords(new Error('The file store is not available'))).toBe(SOUND_SAVE_FAILED)
  })

  it('a full disk while saving is reported as such, not as a bad name', LONG, async () => {
    await requireMediaTools()
    const h = harness()
    const io = { ...ioFor(h, 's', rid(++runs), []), saveAssetFromPath: async () => { throw coded('ENOSPC') } }
    await expect(saveAudioFiles(io, [{ rate: 8000, channels: [new Float32Array(80)] }], { prefix: 'x', format: 'flac', quality: '128k', folder: 'output' })).rejects.toThrow(SOUND_SAVE_NO_ROOM)
  })
})
