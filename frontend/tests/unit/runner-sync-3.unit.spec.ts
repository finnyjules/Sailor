/**
 * Task F22 (model line-up): sync-3 (sync.so) lip-sync on fal, the "sync-3"
 * engine of Lip-sync a character, runner-only, family `sync-3`
 * (server/runner/generators/sync3.ts, server/runner/sync3Media.ts). No backup.
 *
 * The family contract:
 *  - the saved schema: the endpoint id and fal's pricing text;
 *  - every payload over the settings grid fits the schema, and carries the
 *    sync mode the price reads;
 *  - hand-written expected payloads: plain (the schema's own example files),
 *    every option set, and the sound from a linked Audio card;
 *  - eligibility with the family on and off (only sync-3; the linked sound
 *    is taken only from an Audio card);
 *  - blockedModelUses refuses sync-3 when the family is off or the run goes
 *    to the engine, wherever the node sets it;
 *  - the studio and the node's menu hide sync-3 while the family is off;
 *  - the price is verified and non-zero, badge = charge, hold ≥ charge;
 *  - the media hand-off: the files are read and measured before the hold
 *    and again before the call; what sync-3 can't take is refused plainly;
 *    the charge is the clip measured;
 *  - the engine, end to end: the family's own endpoint, the hold and charge.
 */
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BufferTarget, EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { PROVIDER_TYPES, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { blockedModelUses, blockedModelsResponse } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { __resetModelMenusForTests, applyModelOverlay, comboMenu, menuDefault, menuHiddenValues, modelMenu } from '#shared/runner/modelMenus'
import {
  SYNC_3_MODE_LINKED, SYNC_3_MODE_REFUSED, SYNC_3_SILENCE_REFUSED, SYNC_3_SYNC_MODES, isSync3LipSync, lipSyncEngine, lipSyncSyncMode,
  mentionsSync3, sync3OutputSeconds,
} from '#shared/runner/lipSync'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { CLIP_RATES, clipRate } from '#shared/pricing/clipRates'
import { LIPSYNC_MAX_SECONDS, SYNC_3_ENDPOINT, VIEW_REF_REFUSED, remoteVideoCalls, sync3PriceHint } from '#shared/pricing/clipSettings'
import { creditsForUsd } from '#shared/pricing/markup'
import { priceNode } from '#shared/pricing/nodePrice'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { compileLipSync, engineLabel, resolveEngine } from '~/lib/lipsync/compile'
import { hydrateLipSyncSheet } from '~/lib/lipsync/hydrate'
import { EDIT_MODEL_MENUS } from '~~/app/data/edit-model-options'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import {
  SYNC_3_APP, SYNC_3_NEEDS_SOUND, SYNC_3_NEEDS_VIDEO, SYNC_3_SOUND_NOT_A_FILE, SYNC_3_VIDEO_NOT_A_FILE, sync3Lipsync, sync3Sources,
} from '~~/server/runner/generators/sync3'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import {
  SYNC_3_FILE_MISSING, SYNC_3_MAX_SOUND_BYTES, SYNC_3_MAX_VIDEO_BYTES, SYNC_3_SOUND_RULE, SYNC_3_TOO_LONG, SYNC_3_VIDEO_RULE, sync3MediaCheck,
} from '~~/server/runner/sync3Media'
import { mediaFacts, mediaFormat, mediaRuleProblem } from '~~/server/runner/mediaInputs'
import { requestProblem, requestProblems } from '~~/server/runner/requestRules'
import { collectInputFiles } from '~~/server/runner/inputs'
import { createHandoff, mimeFor, sha256Hex } from '~~/server/runner/handoff'
import { stageEstimate } from '~~/server/runner/metering'
import { pruneInvalidOutputs } from '#shared/runner/validate'
import { SYNC_3_CHANGED } from '~~/server/runner/sync3Media'
import { QWEN_2511_ANGLES_APP } from '~~/server/runner/generators/qwen2511Angles'
import sharp from 'sharp'
import { createEngineResultStore } from '~~/server/runner/results'
import { nodeCredits } from '~~/server/runner/metering'
import { PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { createFakeFal, createFakeLedger, makeKit, ofType, until } from './__runner__/kit'

const FAMILY: RunnerFamily = 'sync-3'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SCHEMA = loadProviderSchema('fal', SYNC_3_APP)
const VIDEO_VIEW = '/view?filename=face.mp4&type=input'
const SOUND_VIEW = '/view?filename=voice.wav&type=input'

/** A 16-bit mono PCM WAV of `seconds`. */
function wav(seconds: number, rate = 8000): Buffer {
  const n = Math.round(seconds * rate)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  return b
}

/** A picture-only MP4 whose video track lasts `seconds` (10 fps), `width` × `height`, muxed without an encoder. */
async function mp4(seconds: number, width = 320, height = 240): Promise<Buffer> {
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const src = new EncodedVideoPacketSource('avc')
  out.addVideoTrack(src, { frameRate: 10 })
  await out.start()
  const description = new Uint8Array([1, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0, 0x0A, 0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x02, 0x80, 0xBF, 0xE5, 0x84, 1, 0, 4, 0x68, 0xCE, 0x3C, 0x80])
  const frames = Math.round(seconds * 10)
  for (let i = 0; i < frames; i++) {
    await src.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65]), i === 0 ? 'key' : 'delta', i / 10, 0.1),
      i === 0 ? { decoderConfig: { codec: 'avc1.42c01e', codedWidth: width, codedHeight: height, description } } : undefined)
  }
  await out.finalize()
  return Buffer.from((out.target as BufferTarget).buffer!)
}

/** A LipSyncNode as the studio fills it (VueNodeCanvas handleLipSyncGenerate), on sync-3 unless told. */
function lip(o: { engine?: unknown, mode?: unknown, opts?: Record<string, unknown>, inputs?: Record<string, unknown>, options?: unknown } = {}) {
  const engine = o.engine ?? 'sync-3'
  const mode = o.mode ?? 'cut_off'
  const opts = { engine, resolution: '720p', audio: SOUND_VIEW, face_video: VIDEO_VIEW, sync_mode: mode, ...o.opts }
  return {
    class_type: 'LipSyncNode',
    inputs: { engine, resolution: '720p', sync_mode: mode, model_options: o.options ?? JSON.stringify(opts), ...o.inputs },
  }
}
const card = (file = 'voice.wav', extra: Record<string, unknown> = {}) =>
  ({ class_type: 'Audio', inputs: { audio: file, export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', ...extra } })
const videoCard = (from = '1') => ({ class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: [from, 0] } })

afterEach(() => __resetModelMenusForTests())

// ── 1. The saved schema ─────────────────────────────────────────────────────

describe('the saved schema', () => {
  it('is fal-ai/sync-lipsync/v3 (its x-fal-metadata id), read 2026-09-25, with fal\'s pricing text', () => {
    expect(SYNC_3_APP).toBe('fal-ai/sync-lipsync/v3')
    expect(SYNC_3_APP).toBe(SYNC_3_ENDPOINT)
    expect(SCHEMA.endpoint).toBe(SYNC_3_APP)
    expect(SCHEMA.fetchedAt).toBe('2026-09-25')
    expect(SCHEMA.pricingText).toContain('$8 per minutes')
    const input = SCHEMA.components.schemas.SyncLipsyncV3Input as { required: string[], properties: Record<string, { enum?: string[] }> }
    expect(input.required.sort()).toEqual(['audio_url', 'video_url'])
    expect(input.properties.sync_mode!.enum).toEqual(['cut_off', 'loop', 'bounce', 'silence', 'remap'])
    // The modes sync-3 is run with are the schema's, less "silence".
    expect([...SYNC_3_SYNC_MODES].sort()).toEqual(input.properties.sync_mode!.enum!.filter(m => m !== 'silence').sort())
  })

  it('the route: fal first, no backup, and why', () => {
    expect(RUNNER_ROUTES['LipSyncNode:sync-3']!.first).toBe('fal')
    expect(RUNNER_ROUTES['LipSyncNode:sync-3']!.backup).toBeNull()
    expect(RUNNER_ROUTES['LipSyncNode:sync-3']!.why).toContain('Replicate has no sync-3')
  })
})

// ── 2. The builder ──────────────────────────────────────────────────────────

async function plan(prompt: ApiPrompt, nodeId = '1', filesFrom: (l: [string, number]) => OutputFile[] = () => []): Promise<Extract<NodePlan, { kind: 'provider' }>> {
  const p = await planNode({ prompt, nodeId, gateOpen: false, filesFrom, toUrl: async f => `https://fal.storage/${f.subfolder ? `${f.subfolder}/` : ''}${f.filename}`, families: ON })
  if (p.kind !== 'provider') throw new Error('no call')
  return p
}

describe('the request', () => {
  it('every sync mode it runs, from the widget or the options, fits the schema and sends that mode', async () => {
    let n = 0
    for (const mode of SYNC_3_SYNC_MODES) {
      for (const where of ['widget', 'options'] as const) {
        const node = where === 'widget'
          ? lip({ mode, opts: { sync_mode: undefined } })
          : lip({ mode: 'loop', opts: { sync_mode: mode } })
        if (where === 'widget') node.inputs.model_options = JSON.stringify({ engine: 'sync-3', audio: SOUND_VIEW, face_video: VIDEO_VIEW })
        const p = await plan({ 1: node })
        expect(p.endpoint).toBe(SYNC_3_APP)
        expect(p.provider).toBe('fal')
        expect(p.media).toBe('video')
        expect(p.backup).toBeUndefined()
        expect(checkPayload(SCHEMA, p.payload), `${mode} ${where}`).toEqual([])
        expect(p.payload.sync_mode).toBe(mode)
        // The price reads the same mode.
        expect(lipSyncSyncMode(node.inputs)).toBe(mode)
        n++
      }
    }
    expect(n).toBe(8)
  })

  it('plain, with the schema\'s own example files: exactly the three fields', () => {
    const input = SCHEMA.components.schemas.SyncLipsyncV3Input as { properties: Record<string, { examples?: string[] }> }
    const video = input.properties.video_url!.examples![0]!
    const audio = input.properties.audio_url!.examples![0]!
    const call = sync3Lipsync({ videoUrl: video, audioUrl: audio, syncMode: 'cut_off' })
    expect(call).toEqual({ provider: 'fal', endpoint: SYNC_3_APP, payload: { video_url: video, audio_url: audio, sync_mode: 'cut_off' } })
    expect(checkPayload(SCHEMA, call.payload)).toEqual([])
  })

  it('every option set (loop, the studio\'s resolution and face picture ignored): the hand-off links and the mode', async () => {
    const p = await plan({ 1: lip({ mode: 'loop', opts: { resolution: '1080p', face_image: '/view?filename=still.png&type=input' } }) })
    expect(p.payload).toEqual({ video_url: 'https://fal.storage/face.mp4', audio_url: 'https://fal.storage/voice.wav', sync_mode: 'loop' })
    expect(checkPayload(SCHEMA, p.payload)).toEqual([])
    expect(p.prefix).toBe('lip_sync')
    expect(p.uiFor([{ filename: 'x.mp4', subfolder: '', type: 'output' }])).toBeNull()
  })

  it('the sound from a linked Audio card: the file the card handed on', async () => {
    const node = lip({ inputs: { audio: ['2', 0] } })
    const prompt: ApiPrompt = { 1: node, 2: card('voice.wav') }
    const p = await plan(prompt, '1', () => [{ filename: 'song.mp3', subfolder: 'clips', type: 'input' }])
    expect(p.payload).toEqual({ video_url: 'https://fal.storage/face.mp4', audio_url: 'https://fal.storage/clips/song.mp3', sync_mode: 'cut_off' })
    expect(checkPayload(SCHEMA, p.payload)).toEqual([])
    // The card itself hands its own file on, with nothing to show and no call.
    const cardPlan = await planNode({ prompt, nodeId: '2', gateOpen: false, filesFrom: () => [], toUrl: async () => 'x' })
    expect(cardPlan).toEqual({ kind: 'pass', files: [{ filename: 'voice.wav', subfolder: '', type: 'input' }], ui: null })
  })

  it('"silence" is never sent: refused at planning and by the request check', async () => {
    await expect(plan({ 1: lip({ mode: 'silence' }) })).rejects.toThrow(SYNC_3_SILENCE_REFUSED)
    expect(requestProblem('fal', SYNC_3_APP, { video_url: 'a', audio_url: 'b', sync_mode: 'silence' })).toBe(SYNC_3_SILENCE_REFUSED)
    expect(requestProblem('fal', SYNC_3_APP, { video_url: 'a', audio_url: 'b', sync_mode: 'loop' })).toBeNull()
    expect(requestProblem('fal', SYNC_3_APP, { video_url: 'a', audio_url: 'b' })).toBe(SYNC_3_MODE_REFUSED)
  })

  it('the other engines never plan here', async () => {
    for (const engine of ['auto', 'fabric', 'sync']) {
      await expect(planNode({ prompt: { 1: lip({ engine }) }, nodeId: '1', gateOpen: false, filesFrom: () => [], toUrl: async () => 'x' }))
        .rejects.toThrow('sync-3 only')
    }
  })
})

// ── 3. Reading the node ─────────────────────────────────────────────────────

describe('reading the engine and the sync mode (as LipSyncNode.execute does)', () => {
  it('the options win over the widgets; unreadable options fall back to the widgets', () => {
    expect(lipSyncEngine({ engine: 'auto', model_options: '{"engine":"sync-3"}' })).toBe('sync-3')
    expect(lipSyncEngine({ engine: 'sync-3', model_options: '{"engine":"fabric"}' })).toBe('fabric')
    expect(lipSyncEngine({ engine: 'sync-3', model_options: '{}' })).toBe('sync-3')
    expect(lipSyncEngine({ engine: 'sync-3', model_options: '[1]' })).toBe('sync-3')
    expect(lipSyncEngine({ engine: 'sync', model_options: 'not json' })).toBe('sync')
    expect(lipSyncSyncMode({ sync_mode: 'loop', model_options: '{"sync_mode":"remap"}' })).toBe('remap')
    expect(lipSyncSyncMode({ model_options: '{}' })).toBe('cut_off')
  })

  it('the runner reads sync-3 only from options it can read; the refusal counts any mention', () => {
    expect(isSync3LipSync(lip().inputs)).toBe(true)
    expect(isSync3LipSync({ engine: 'sync-3', model_options: 'NaN{' })).toBe(false)
    expect(isSync3LipSync({ engine: 'sync-3', model_options: ['9', 0] })).toBe(false)
    expect(mentionsSync3({ engine: 'sync-3', model_options: ['9', 0] })).toBe(true)
    expect(mentionsSync3({ engine: 'auto', model_options: '{"engine": "sync-3", "x": NaN}' })).toBe(true)
    expect(mentionsSync3({ engine: 'auto', model_options: '{"engine": "sync-3"}' })).toBe(true)
    expect(mentionsSync3({ engine: 'sync', model_options: '{"engine": "fabric"}' })).toBe(false)
  })

  it('the clip made: the sound\'s length, or the shorter of the two for cut off; "silence" none', () => {
    expect(sync3OutputSeconds('loop', 4, 30)).toBe(4)
    expect(sync3OutputSeconds('bounce', 40, 3)).toBe(40)
    expect(sync3OutputSeconds('remap', 12, 3)).toBe(12)
    expect(sync3OutputSeconds('cut_off', 12, 3)).toBe(3)
    expect(sync3OutputSeconds('cut_off', 2, 30)).toBe(2)
    expect(sync3OutputSeconds('silence', 2, 30)).toBeNull()
  })
})

// ── 4. Eligibility ──────────────────────────────────────────────────────────

describe('eligibility', () => {
  const alone = (node = lip()): ApiPrompt => ({ 1: node, 2: videoCard() })

  it('on: taken; off (no families, or every other one): not', () => {
    expect(isRunnerEligible(alone(), ON)).toBe(true)
    expect(isRunnerEligible(alone(), ALL)).toBe(true)
    expect(isRunnerEligible(alone(), NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(alone(), ALL_BUT)).toBe(false)
    expect(runnerTakesWorkflow(alone(), ON)).toBe(true)
    expect(PROVIDER_TYPES.has('LipSyncNode')).toBe(true)
    expect(PROVIDER_TYPES.has('Audio')).toBe(false)
  })

  it('only sync-3: Fabric, Kling (sync) and auto stay on the engine, whatever is on', () => {
    for (const engine of ['auto', 'fabric', 'sync']) expect(isRunnerEligible(alone(lip({ engine })), ALL), engine).toBe(false)
    // sync-3 in the options alone (the widget says auto) counts, as the node reads it.
    const viaOptions = lip()
    viaOptions.inputs.engine = 'auto'
    expect(isRunnerEligible(alone(viaOptions), ON)).toBe(true)
    // sync-3 on the widget but Fabric in the options: Fabric.
    expect(isRunnerEligible(alone(lip({ opts: { engine: 'fabric' } })), ALL)).toBe(false)
    // Options the runner can't read: not taken.
    expect(isRunnerEligible(alone(lip({ options: '{"engine": "sync-3", "x": NaN}' })), ALL)).toBe(false)
  })

  it('what it reads before the run must not be wired; a linked picture is not taken', () => {
    for (const name of ['model_options', 'engine', 'sync_mode', 'image']) {
      expect(isRunnerEligible({ ...alone(lip({ inputs: { [name]: ['5', 0] } })), 5: { class_type: 'Image', inputs: { image: 'a.png' } } }, ALL), name).toBe(false)
    }
  })

  it('the linked sound (lifted for sync-3 only): taken from an Audio card playing its own file, from nothing else', () => {
    const withCard = (c: Record<string, unknown>): ApiPrompt => ({ 1: lip({ inputs: { audio: ['3', 0] } }), 2: videoCard(), 3: c as any })
    expect(isRunnerEligible(withCard(card()), ON)).toBe(true)
    expect(runnerTakesNode(withCard(card()), '3', ON)).toBe(true)
    expect(isRunnerEligible(withCard(card()), NO_FAMILIES)).toBe(false)
    // A card fed from upstream, a LoadAudio or speech: left to the engine.
    expect(isRunnerEligible({ ...withCard(card('voice.wav', { source: ['4', 0] })), 4: { class_type: 'LoadAudio', inputs: { audio: 'v.wav' } } }, ALL)).toBe(false)
    expect(isRunnerEligible(withCard({ class_type: 'LoadAudio', inputs: { audio: 'v.wav' } }), ALL)).toBe(false)
    expect(isRunnerEligible(withCard({ class_type: 'GenerateSpeechNode', inputs: { text: 'hi' } }), ALL)).toBe(false)
    // A card feeding anything but lip-sync nodes: not taken.
    const feedsVideo: ApiPrompt = { ...withCard(card()), 5: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'x', audio: ['3', 0] } } }
    expect(runnerTakesNode(feedsVideo, '3', ALL)).toBe(false)
    // Kling's lip-sync with a linked sound: still the engine's.
    expect(isRunnerEligible({ 1: lip({ engine: 'sync', inputs: { audio: ['3', 0] } }), 2: videoCard(), 3: card() }, ALL)).toBe(false)
    // Generate a video still refuses a linked sound.
    expect(runnerTakesNode({ 1: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'x', audio: ['3', 0] } }, 3: card() }, '1', ALL)).toBe(false)
  })
})

// ── 5. The engine path refuses it ───────────────────────────────────────────

describe('blockedModelUses: sync-3 runs only in Sailor', () => {
  const use = { nodeId: '1', classType: 'LipSyncNode', value: 'sync-3', reason: 'runner-only', input: 'engine' }

  it('to ComfyUI: refused, on or off; to the runner: fine while on', () => {
    const p: ApiPrompt = { 1: lip() }
    expect(blockedModelUses(p, { families: ON })).toEqual([use])
    expect(blockedModelUses(p, { families: NO_FAMILIES })).toEqual([use])
    expect(blockedModelUses(p, { families: ON, runnerTakes: true })).toEqual([])
    expect(blockedModelUses(p, { families: ALL_BUT, runnerTakes: true })).toEqual([use])
  })

  it('wherever it is set: the widget, the options, options the runner can\'t read', () => {
    const viaOptions = lip()
    viaOptions.inputs.engine = 'auto'
    expect(blockedModelUses({ 1: viaOptions }, { families: ON })).toEqual([use])
    // Options the runner can't read: the runner doesn't take the node, and the engine path refuses it.
    expect(blockedModelUses({ 1: lip({ options: '{"engine": "sync-3", "x": NaN}' }) }, { families: ON })).toEqual([use])
    expect(blockedModelUses({ 1: lip({ engine: 'fabric' }) }, { families: NO_FAMILIES })).toEqual([])
    expect(blockedModelUses({ 1: lip({ engine: 'sync' }) }, { families: NO_FAMILIES })).toEqual([])
  })

  it('the refusal names the node and the model in plain words, on the engine widget', () => {
    const body = blockedModelsResponse({ 1: lip() }, [use as any], { families: NO_FAMILIES })
    expect(body.error.message).toBe('“Lip-sync a character” uses sync-3, which only runs in Sailor. Its switch is off.')
    expect((body.node_errors['1'] as any).errors[0].extra_info).toEqual({ input_name: 'engine', input_value: 'sync-3' })
    const r = blockedRunRefusal([{ prompt: { 1: lip() }, titleOf: () => 'Say hello' }], { runnerOn: true, families: NO_FAMILIES })
    expect(r).toEqual({ title: '“Say hello” uses sync-3, which only runs in Sailor', description: 'Its switch is off.' })
    // The server's /prompt gate (local proxy and hosted meter) refuses it too.
    expect(blockedPromptRefusal({ 1: lip() }, ON)).toBeTruthy()
  })
})

// ── 6. Menus ────────────────────────────────────────────────────────────────

describe('the menus hide sync-3 while its switch is off', () => {
  it('the node\'s engine menu: every value valid, sync-3 hidden while off, default auto', () => {
    const menu = modelMenu('LipSyncNode', 'engine')!
    expect(menu.entries.map(e => e.value)).toEqual(['auto', 'fabric', 'sync', 'sync-3'])
    expect(menuHiddenValues(menu, NO_FAMILIES)).toEqual(['sync-3'])
    expect(menuHiddenValues(menu, ALL_BUT)).toEqual(['sync-3'])
    expect(menuHiddenValues(menu, ON)).toEqual([])
    expect(menuDefault(menu, ON)).toBe('auto')
    expect(EDIT_MODEL_MENUS['LipSyncNode.engine']!.options.find(o => o.value === 'sync-3')).toEqual({ value: 'sync-3', label: 'sync-3', runnerOnly: true, family: 'sync-3' })
    const info = { LipSyncNode: { input: { required: { engine: [['auto', 'fabric', 'sync'], { default: 'auto' }] } } } }
    const off = applyModelOverlay(info, NO_FAMILIES) as any
    expect(off.LipSyncNode.input.required.engine).toEqual([['auto', 'fabric', 'sync', 'sync-3'], { default: 'auto', hidden_options: ['sync-3'] }])
    const on = applyModelOverlay(info, ON) as any
    expect(on.LipSyncNode.input.required.engine[1].hidden_options).toEqual([])
    // A node already on sync-3 keeps showing it, tagged.
    expect(comboMenu(['auto', 'fabric', 'sync', 'sync-3'], ['sync-3'], 'sync-3', engineLabel)).toEqual({
      options: ['auto', 'fabric', 'sync', 'sync-3'], labels: ['Auto', 'Fabric', 'Sync', 'sync-3 (hidden)'],
    })
  })

  it('the studio: sync-3 compiles to the node\'s options; a picture face, a web link or "silence" is an error', () => {
    const sheet = hydrateLipSyncSheet({ face: { kind: 'video', src: VIDEO_VIEW }, voice: { kind: 'audio', src: SOUND_VIEW }, engine: 'sync-3', syncMode: 'loop' })
    expect(resolveEngine(sheet)).toBe('sync-3')
    expect(engineLabel('sync-3')).toBe('sync-3')
    const c = compileLipSync(sheet)
    expect(c.issues).toEqual([])
    expect(c.engine).toBe('sync-3')
    expect(c.modelOptions).toEqual({ engine: 'sync-3', resolution: '720p', audio: SOUND_VIEW, face_video: VIDEO_VIEW, sync_mode: 'loop' })
    const codes = (s: object) => compileLipSync(hydrateLipSyncSheet({ ...sheet, ...s })).issues.map(i => i.code)
    expect(codes({ face: { kind: 'image', src: '/view?filename=a.png&type=input' } })).toEqual(['sync-3-needs-video'])
    expect(codes({ face: { kind: 'video', src: 'https://example.com/a.mp4' } })).toEqual(['sync-3-video-link'])
    expect(codes({ voice: { kind: 'audio', src: 'https://example.com/a.wav' } })).toEqual(['sync-3-sound-link'])
    expect(codes({ syncMode: 'silence' })).toEqual(['sync-3-silence'])
    // A typed line (text to speech) resolves to an uploaded file at Generate.
    expect(codes({ voice: { kind: 'tts', text: 'Hello', voiceId: 'Wise_Woman' } })).toEqual([])
  })
})

// ── 7. The price ────────────────────────────────────────────────────────────

describe('the price', () => {
  const at = (inputs: Record<string, unknown>, measured: { audio?: number, video?: number } = {}) => priceNode('LipSyncNode', inputs, { inputSeconds: measured })

  it('the card: $8 a minute of video made on fal, verified, non-zero; the book carries it (lineup-f22, now lineup-g1)', () => {
    const rate = clipRate(SYNC_3_ENDPOINT)!
    expect(rate).toEqual({
      unit: 'per_second', service: 'fal', source: 'https://fal.ai/models/fal-ai/sync-lipsync/v3/llms.txt', read: '2026-09-25', confidence: 'verified',
      byResolution: { '*': 8 / 60 },
    })
    expect(CLIP_RATES[SYNC_3_ENDPOINT]).toBe(rate)
    expect(PRICE_BOOK_VERSION).toBe('r3-turntable')
  })

  // Final fix F8: the Lip-Sync Studio's hint reads the card, in credits in hosted mode (what 30 s is charged).
  it('the studio\'s price hint: from the card, dollars locally, the charge in credits in hosted mode', () => {
    expect(sync3PriceHint()).toEqual({ text: '~$4 / 30s', title: 'sync-3 bills $8 per minute of video it makes' })
    const per30 = (at(lip({ mode: 'loop' }).inputs, { audio: 30, video: 30 }) as { credits: number }).credits
    const per60 = (at(lip({ mode: 'loop' }).inputs, { audio: 60, video: 60 }) as { credits: number }).credits
    expect(sync3PriceHint({ hosted: true })).toEqual({ text: `~${per30} credits / 30s`, title: `sync-3 costs ${per60} credits per minute of video it makes` })
    expect(per30).toBeGreaterThan(0)
  })

  it('the clip it makes, whole seconds rounded up: the sound (loop, bounce, remap), the shorter (cut off)', () => {
    expect(at(lip({ mode: 'loop' }).inputs, { audio: 4.2, video: 30 })).toEqual({ usd: 0.666667, credits: creditsForUsd(0.666667) })
    // $0.666667 (the rate × 5, to the millionth, rounded up) is 101 credits: a credit above 5 s at $8 a minute
    // exactly, on the safe side (videoRates.ts perSecondUsd rounds to 1e-6).
    expect(at(lip({ mode: 'bounce' }).inputs, { audio: 5, video: 1 })).toEqual({ usd: 0.666667, credits: 101 })
    expect(at(lip({ mode: 'remap' }).inputs, { audio: 5, video: 1 })).toEqual({ usd: 0.666667, credits: 101 })
    expect(at(lip({ mode: 'cut_off' }).inputs, { audio: 12, video: 2.5 })).toEqual({ usd: 0.4, credits: 60 })
    expect(at(lip({ mode: 'cut_off' }).inputs, { audio: 1, video: 30 })).toEqual({ usd: 0.133333, credits: 20 })
    // Unmeasured: the 60 s cap ($8), the hold's figure.
    expect(at(lip().inputs)).toEqual({ usd: 8, credits: 1200 })
    expect(at(lip({ mode: 'cut_off' }).inputs, { audio: 7 })).toEqual({ usd: 0.933333, credits: 140 })
    expect(at(lip({ mode: 'loop' }).inputs, { video: 7 })).toEqual({ usd: 8, credits: 1200 })
    expect(LIPSYNC_MAX_SECONDS).toBe(60)
  })

  it('a sync mode it isn\'t run with: refused, not priced', () => {
    expect(at(lip({ mode: 'silence' }).inputs, { audio: 3, video: 3 })).toEqual({ refused: SYNC_3_SILENCE_REFUSED })
    expect(at(lip({ mode: 'fast' }).inputs, { audio: 3, video: 3 })).toEqual({ refused: SYNC_3_MODE_REFUSED })
    const linkedMode = lip({ opts: { sync_mode: undefined } })
    linkedMode.inputs.model_options = JSON.stringify({ engine: 'sync-3', audio: SOUND_VIEW, face_video: VIDEO_VIEW })
    linkedMode.inputs.sync_mode = ['9', 0] as any
    expect(at(linkedMode.inputs)).toEqual({ refused: SYNC_3_MODE_LINKED })
  })

  it('the other engines keep their prices', () => {
    expect(remoteVideoCalls('LipSyncNode', lip({ engine: 'sync' }).inputs, { audio: 3, video: 5 })).toEqual([
      { endpoint: 'kwaivgi/kling-lip-sync', seconds: 5, resolution: null, audio: false },
    ])
    expect(remoteVideoCalls('LipSyncNode', lip({ engine: 'fabric' }).inputs, { audio: 3 })).toEqual([
      { endpoint: 'veed/fabric-1.0', seconds: 3, resolution: '720p', audio: false },
    ])
  })

  it('badge = charge: the canvas estimate, the graph price and the runner\'s node price agree', () => {
    for (const [mode, measured] of [['loop', { audio: 4.2, video: 9 }], ['cut_off', { audio: 12, video: 2.5 }], ['remap', {}]] as const) {
      const node = lip({ mode })
      const price = priceNode('LipSyncNode', node.inputs, { inputSeconds: measured })
      if ('refused' in price) throw new Error('refused')
      expect(nodeCreditEstimate('LipSyncNode', node.inputs, { inputSeconds: measured })).toBe(price.credits + 1)
      expect(priceGraph({ n: node, out: videoCard('n') }, { inputSeconds: { n: measured } }).credits).toBe(price.credits + 1)
      expect(nodeCredits({ class_type: 'LipSyncNode', inputs: node.inputs }, undefined, ON, measured)).toBe(price.credits)
      // Hold ≥ charge: the hold reads nothing measured (the 60 s cap).
      expect(nodeCredits({ class_type: 'LipSyncNode', inputs: node.inputs }, undefined, ON)).toBeGreaterThanOrEqual(price.credits)
    }
  })

  it('every call the family can turn on is verified and non-zero', () => {
    for (const mode of SYNC_3_SYNC_MODES) {
      const calls = remoteVideoCalls('LipSyncNode', lip({ mode }).inputs, { audio: 1, video: 1 }) as { endpoint: string }[]
      for (const c of calls) {
        expect(clipRate(c.endpoint)!.confidence).toBe('verified')
        expect((priceNode('LipSyncNode', lip({ mode }).inputs, { inputSeconds: { audio: 1, video: 1 } }) as { usd: number }).usd).toBeGreaterThan(0)
      }
    }
  })
})

// ── 8. Before the hold: the node's own settings ─────────────────────────────

describe('requestProblems (a runner run): what stops the node before anything is read', () => {
  const problems = (p: ApiPrompt) => requestProblems(p, { runner: true }).map(x => [x.input, x.message])

  it('a set-up it can run: none', () => {
    expect(problems({ 1: lip() })).toEqual([])
    expect(problems({ 1: lip({ inputs: { audio: ['2', 0] } }), 2: card() })).toEqual([])
  })

  it('"silence", or a mode it doesn\'t know', () => {
    expect(problems({ 1: lip({ mode: 'silence' }) })).toEqual([['sync_mode', SYNC_3_SILENCE_REFUSED]])
    expect(problems({ 1: lip({ mode: 'fast' }) })).toEqual([['sync_mode', SYNC_3_MODE_REFUSED]])
  })

  it('no face video, a web link, a link the engine refuses', () => {
    expect(problems({ 1: lip({ opts: { face_video: undefined } }) })).toEqual([['model_options', SYNC_3_NEEDS_VIDEO]])
    expect(problems({ 1: lip({ opts: { face_video: '' } }) })).toEqual([['model_options', SYNC_3_NEEDS_VIDEO]])
    expect(problems({ 1: lip({ opts: { face_video: 'https://example.com/a.mp4' } }) })).toEqual([['model_options', SYNC_3_VIDEO_NOT_A_FILE]])
    expect(problems({ 1: lip({ opts: { face_video: '/view?filename=a.mp4&type=output' } }) })).toEqual([['model_options', SYNC_3_VIDEO_NOT_A_FILE]])
    expect(problems({ 1: lip({ opts: { face_video: '/view?filename=a.mp4&filename=b.mp4&type=input' } }) })).toEqual([['model_options', VIEW_REF_REFUSED]])
  })

  it('no sound, a web link, an empty Audio card', () => {
    expect(problems({ 1: lip({ opts: { audio: '' } }) })).toEqual([['model_options', SYNC_3_NEEDS_SOUND]])
    expect(problems({ 1: lip({ opts: { audio: 'data:audio/wav;base64,AAAA' } }) })).toEqual([['model_options', SYNC_3_SOUND_NOT_A_FILE]])
    expect(problems({ 1: lip({ inputs: { audio: ['2', 0] } }), 2: card('') })).toEqual([['audio', SYNC_3_NEEDS_SOUND]])
  })

  it('the engine path is not judged here (it refuses the engine itself); nor are the other engines', () => {
    expect(requestProblems({ 1: lip({ mode: 'silence' }) })).toEqual([])
    expect(problems({ 1: lip({ engine: 'sync', mode: 'silence', opts: { face_video: 'https://x/a.mp4' } }) })).toEqual([])
  })

  it('the files the node would send', () => {
    expect(sync3Sources({ 1: lip() }, '1')).toEqual({
      video: { file: { filename: 'face.mp4', subfolder: '', type: 'input' } },
      audio: { file: { filename: 'voice.wav', subfolder: '', type: 'input' } },
    })
    expect(sync3Sources({ 1: lip({ inputs: { audio: ['2', 0] } }), 2: card('clips/song.mp3 [input]') }, '1').audio)
      .toEqual({ file: { filename: 'song.mp3', subfolder: 'clips', type: 'input' }, link: ['2', 0] })
    // The Audio card's file is checked as the caller's own, like a Video card's.
    expect(collectInputFiles({ 2: card('voice.wav') })).toEqual([{ filename: 'voice.wav', subfolder: '', type: 'input' }])
  })
})

// ── 9. The media hand-off ───────────────────────────────────────────────────

describe('the media: what the file is, read from its bytes', () => {
  it('formats from the first bytes, never the name', async () => {
    expect(mediaFormat(wav(1))).toBe('wav')
    expect(mediaFormat(await mp4(1))).toBe('mp4')
    expect(mediaFormat(Buffer.from('OggS\0\0\0\0'))).toBe('ogg')
    expect(mediaFormat(Buffer.from('fLaC\0\0\0\0'))).toBe('flac')
    expect(mediaFormat(Buffer.from('ID3\x04\0\0'))).toBe('mp3')
    expect(mediaFormat(Uint8Array.from([0xFF, 0xFB, 0x90, 0x00]))).toBe('mp3')
    expect(mediaFormat(Uint8Array.from([0xFF, 0xF1, 0x50, 0x80]))).toBe('aac')
    expect(mediaFormat(Buffer.from('\0\0\0\x20ftypqt  \0\0\0\0'))).toBe('mov')
    expect(mediaFormat(Buffer.from('\0\0\0\x20ftypM4A \0\0\0\0'))).toBe('m4a')
    expect(mediaFormat(Uint8Array.from([0x1A, 0x45, 0xDF, 0xA3, 0x42, 0x82, 0x84, ...Buffer.from('webm')]))).toBe('webm')
    // Matroska and AVI are told apart since R5.1b (the media module names ffmpeg's demuxer from them); sync-3 still refuses them by its formats.
    expect(mediaFormat(Uint8Array.from([0x1A, 0x45, 0xDF, 0xA3, 0x42, 0x82, 0x88, ...Buffer.from('matroska')]))).toBe('mkv')
    expect(mediaFormat(Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))).toBeNull()
    expect(mediaFormat(Buffer.from('RIFF\0\0\0\0AVI '))).toBe('avi')
  })

  it('length and size measured; limits judged in plain words', async () => {
    const v = await mediaFacts(await mp4(5, 640, 360), SYNC_3_VIDEO_RULE)
    expect(v.format).toBe('mp4')
    expect(v.seconds).toBeCloseTo(5, 3)
    expect([v.width, v.height]).toEqual([640, 360])
    expect(mediaRuleProblem(v, SYNC_3_VIDEO_RULE, true)).toBeNull()
    const a = await mediaFacts(wav(3.5), SYNC_3_SOUND_RULE)
    expect(a.seconds).toBeCloseTo(3.5, 3)
    expect(mediaRuleProblem(a, SYNC_3_SOUND_RULE, true)).toBeNull()
    // A sound as the face video, a video as the sound: the wrong format.
    expect(mediaRuleProblem(await mediaFacts(wav(1), SYNC_3_VIDEO_RULE), SYNC_3_VIDEO_RULE, true)).toBe(SYNC_3_VIDEO_RULE.words.wrongFormat)
    // An MP4 is taken as a sound (fix round 1, finding 6) when it has a sound track; this one has none.
    expect(mediaRuleProblem(await mediaFacts(await mp4(1), SYNC_3_SOUND_RULE), SYNC_3_SOUND_RULE, true)).toBe(SYNC_3_SOUND_RULE.words.unmeasured)
    expect(SYNC_3_SOUND_RULE.formats).toContain('mp4')
    // WebM/Opus sound is on neither sync.so's list nor fal's: refused, naming the formats taken.
    const webm = Uint8Array.from([0x1A, 0x45, 0xDF, 0xA3, 0x42, 0x82, 0x84, ...Buffer.from('webm')])
    expect(mediaRuleProblem(await mediaFacts(webm, SYNC_3_SOUND_RULE), SYNC_3_SOUND_RULE, true))
      .toBe('sync-3 takes sounds as WAV, MP3, Ogg, FLAC, M4A, MP4 or AAC files. Save this one as one of those first.')
    // Over the size limit (judged on the count; never parsed).
    expect(mediaRuleProblem({ ...v, bytes: SYNC_3_MAX_VIDEO_BYTES + 1 }, SYNC_3_VIDEO_RULE, true)).toBe(SYNC_3_VIDEO_RULE.words.tooLarge)
    expect(mediaRuleProblem({ ...a, bytes: SYNC_3_MAX_SOUND_BYTES + 1 }, SYNC_3_SOUND_RULE, true)).toBe(SYNC_3_SOUND_RULE.words.tooLarge)
    expect(mediaRuleProblem({ ...v, bytes: SYNC_3_MAX_VIDEO_BYTES }, SYNC_3_VIDEO_RULE, true)).toBeNull()
    // Over 4K, either way round; 4K itself and a tall 4K are fine.
    const big = await mediaFacts(await mp4(1, 4098, 2160), SYNC_3_VIDEO_RULE)
    expect(mediaRuleProblem(big, SYNC_3_VIDEO_RULE, true)).toBe(SYNC_3_VIDEO_RULE.words.tooManyPixels)
    expect(mediaRuleProblem({ ...v, width: 4096, height: 2160 }, SYNC_3_VIDEO_RULE, true)).toBeNull()
    expect(mediaRuleProblem({ ...v, width: 2160, height: 4096 }, SYNC_3_VIDEO_RULE, true)).toBeNull()
    expect(mediaRuleProblem({ ...v, width: 2400, height: 3000 }, SYNC_3_VIDEO_RULE, true)).toBe(SYNC_3_VIDEO_RULE.words.tooManyPixels)
    // A file it can't measure: refused when strict (hosted), else left to the 60 s cap.
    const junk = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(32, 7)])
    const j = await mediaFacts(junk, SYNC_3_SOUND_RULE)
    expect(j.seconds).toBeNull()
    expect(mediaRuleProblem(j, SYNC_3_SOUND_RULE, true)).toBe(SYNC_3_SOUND_RULE.words.unmeasured)
    expect(mediaRuleProblem(j, SYNC_3_SOUND_RULE, false)).toBeNull()
  })

  it('the upload names the type for sounds and videos too', () => {
    expect(mimeFor('voice.wav')).toBe('audio/wav')
    expect(mimeFor('voice.mp3')).toBe('audio/mpeg')
    expect(mimeFor('voice.ogg')).toBe('audio/ogg')
    expect(mimeFor('voice.flac')).toBe('audio/flac')
    expect(mimeFor('voice.m4a')).toBe('audio/mp4')
    expect(mimeFor('face.mp4')).toBe('video/mp4')
    expect(mimeFor('face.mov')).toBe('video/quicktime')
  })
})

describe('sync3MediaCheck: both files read and judged, the clip made measured', () => {
  const files = async (entries: Record<string, Buffer>) => {
    const root = mkdtempSync(join(tmpdir(), 'sync3-media-'))
    mkdirSync(join(root, 'input'), { recursive: true })
    for (const [name, bytes] of Object.entries(entries)) writeFileSync(join(root, 'input', name), bytes)
    const store = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => true })
    const reads: string[] = []
    return { read: async (f: OutputFile) => { reads.push(f.filename); return store.read(f) }, reads }
  }

  it('fits: the files and their lengths', async () => {
    const f = await files({ 'face.mp4': await mp4(5), 'voice.wav': wav(3.4) })
    const r = await sync3MediaCheck({ 1: lip({ mode: 'loop' }) }, '1', { read: f.read, strict: true })
    if (r.problem !== null) throw new Error(r.problem)
    expect(r.video).toEqual({ filename: 'face.mp4', subfolder: '', type: 'input' })
    expect(r.audio).toEqual({ filename: 'voice.wav', subfolder: '', type: 'input' })
    expect(r.seconds.audio).toBeCloseTo(3.4, 3)
    expect(r.seconds.video).toBeCloseTo(5, 3)
    expect(f.reads.sort()).toEqual(['face.mp4', 'voice.wav'])
  })

  it('over 60 s made: refused — but a long sound under cut off with a short video is fine', async () => {
    const f = await files({ 'face.mp4': await mp4(5), 'voice.wav': wav(61) })
    expect(await sync3MediaCheck({ 1: lip({ mode: 'loop' }) }, '1', { read: f.read, strict: true })).toEqual({ problem: SYNC_3_TOO_LONG })
    const ok = await sync3MediaCheck({ 1: lip({ mode: 'cut_off' }) }, '1', { read: f.read, strict: true })
    expect(ok.problem).toBeNull()
    expect(SYNC_3_TOO_LONG).toBe('sync-3 makes lip-syncs up to 60 seconds. Use a shorter sound.')
  })

  it('a missing file, a wrong one, and one it can\'t read (strict only)', async () => {
    const f = await files({ 'face.mp4': wav(2), 'voice.wav': Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(32, 7)]) })
    expect(await sync3MediaCheck({ 1: lip({ opts: { face_video: '/view?filename=gone.mp4&type=input' } }) }, '1', { read: f.read, strict: true }))
      .toEqual({ problem: SYNC_3_FILE_MISSING })
    expect(await sync3MediaCheck({ 1: lip() }, '1', { read: f.read, strict: true })).toEqual({ problem: SYNC_3_VIDEO_RULE.words.wrongFormat })
    const g = await files({ 'face.mp4': await mp4(2), 'voice.wav': Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE'), Buffer.alloc(32, 7)]) })
    expect(await sync3MediaCheck({ 1: lip() }, '1', { read: g.read, strict: true })).toEqual({ problem: SYNC_3_SOUND_RULE.words.unmeasured })
    const local = await sync3MediaCheck({ 1: lip() }, '1', { read: g.read, strict: false })
    expect(local.problem).toBeNull()
    // Unmeasured: priced at the cap.
    if (local.problem === null) expect(local.seconds.audio).toBeUndefined()
  })

  it('a linked Audio card: its own file at the start; the file its link brought at the node\'s turn', async () => {
    const f = await files({ 'face.mp4': await mp4(5), 'card.wav': wav(2), 'brought.wav': wav(3) })
    const prompt: ApiPrompt = { 1: lip({ inputs: { audio: ['2', 0] } }), 2: card('card.wav') }
    const start = await sync3MediaCheck(prompt, '1', { read: f.read, strict: true })
    if (start.problem !== null) throw new Error(start.problem)
    expect(start.audio.filename).toBe('card.wav')
    const turn = await sync3MediaCheck(prompt, '1', { read: f.read, strict: true, filesFrom: () => [{ filename: 'brought.wav', subfolder: '', type: 'input' }] })
    if (turn.problem !== null) throw new Error(turn.problem)
    expect(turn.audio.filename).toBe('brought.wav')
    expect(turn.seconds.audio).toBeCloseTo(3, 3)
  })
})

// ── 10. The engine, end to end ──────────────────────────────────────────────

describe('the engine', () => {
  const start = (k: ReturnType<typeof makeKit>, take: ApiPrompt) =>
    k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  const kitWith = async (entries: Record<string, Buffer>, o: { families?: ReadonlySet<RunnerFamily>, reread?: Record<string, Buffer> } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'sync3-engine-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
    for (const [name, bytes] of Object.entries(entries)) writeFileSync(join(root, 'input', name), bytes)
    const store = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => true })
    // `reread`: what a file holds from its second read on (it changed after the run started).
    const seen = new Map<string, number>()
    const results = {
      ...store,
      read: async (f: OutputFile) => {
        const n = (seen.get(f.filename) ?? 0) + 1
        seen.set(f.filename, n)
        if (n > 1 && o.reread?.[f.filename]) return new Uint8Array(o.reread[f.filename]!)
        return store.read(f)
      },
    }
    return makeKit({ hosted: true, available: 5000, root, deps: { families: () => o.families ?? ON, results } })
  }

  it('sends the family\'s own endpoint with the handed-off files; holds and charges the clip measured', async () => {
    const k = await kitWith({ 'face.mp4': await mp4(5), 'voice.wav': wav(3.4) })
    await start(k, { 1: lip({ mode: 'loop' }), 2: videoCard() })
    await until(() => ofType(k.seen, 'execution_success').length === 1 || ofType(k.seen, 'execution_error').length === 1)
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    const sent = k.fal.submitted()
    expect(sent.map(r => r.endpoint)).toEqual([SYNC_3_APP])
    expect(sent[0]!.payload).toEqual({ video_url: 'https://fal.storage/face.mp4', audio_url: 'https://fal.storage/voice.wav', sync_mode: 'loop' })
    expect(checkPayload(SCHEMA, sent[0]!.payload)).toEqual([])
    // The hand-off uploaded both with their types.
    expect(k.upload.mock.calls.map(c => [c[1], c[2]]).sort()).toEqual([['face.mp4', 'video/mp4'], ['voice.wav', 'audio/wav']])
    // The tight hold (fix round 1): the 3.4 s sound measured at the start, billed 4 s ($0.533333, 80) + the
    // render credit, held and charged alike.
    const hold = [...k.ledger.holds.values()]
    expect(hold.map(h => h.credits)).toEqual([81])
    const price = priceNode('LipSyncNode', lip({ mode: 'loop' }).inputs, { inputSeconds: { audio: 3.4, video: 5 } })
    expect(price).toEqual({ usd: 0.533333, credits: 80 })
    expect(hold.map(h => h.actual)).toEqual([80 + 1])
  })

  it('a linked Audio card\'s sound, end to end', async () => {
    const k = await kitWith({ 'face.mp4': await mp4(5), 'card.wav': wav(2) })
    await start(k, { 1: lip({ mode: 'cut_off', inputs: { audio: ['3', 0] } }), 2: videoCard(), 3: card('card.wav') })
    await until(() => ofType(k.seen, 'execution_success').length === 1 || ofType(k.seen, 'execution_error').length === 1)
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    expect(k.fal.submitted()[0]!.payload.audio_url).toBe('https://fal.storage/card.wav')
    const price = priceNode('LipSyncNode', lip({ mode: 'cut_off' }).inputs, { inputSeconds: { audio: 2, video: 5 } }) as { usd: number, credits: number }
    expect(price).toEqual({ usd: 0.266667, credits: 41 })
    expect([...k.ledger.holds.values()].map(h => h.actual)).toEqual([price.credits + 1])
  })

  it('refused before the hold: too long, the wrong file, "silence", switched off; nothing sent', async () => {
    const cases: [Record<string, Buffer>, ApiPrompt, string, ReadonlySet<RunnerFamily>?][] = [
      [{ 'face.mp4': await mp4(5), 'voice.wav': wav(61) }, { 1: lip({ mode: 'loop' }), 2: videoCard() }, SYNC_3_TOO_LONG],
      [{ 'face.mp4': wav(5), 'voice.wav': wav(3) }, { 1: lip(), 2: videoCard() }, SYNC_3_VIDEO_RULE.words.wrongFormat],
      [{ 'face.mp4': await mp4(5), 'voice.wav': wav(3) }, { 1: lip({ mode: 'silence' }), 2: videoCard() }, SYNC_3_SILENCE_REFUSED],
      [{ 'face.mp4': await mp4(5), 'voice.wav': wav(3) }, { 1: lip(), 2: videoCard() }, 'can’t run on the Sailor runner', ALL_BUT],
    ]
    for (const [entries, take, message, families] of cases) {
      const k = await kitWith(entries, { families })
      await expect(start(k, take)).rejects.toThrow(message)
      expect(k.fal.reqs.size).toBe(0)
      expect(k.ledger.holds.size).toBe(0)
      expect(k.upload.mock.calls.length).toBe(0)
    }
  })

  it('a file that changed after the run started fails the node before the hand-off; the hold is released', async () => {
    const k = await kitWith({ 'face.mp4': await mp4(5), 'voice.wav': wav(3) }, { reread: { 'voice.wav': wav(61) } })
    await start(k, { 1: lip({ mode: 'loop' }), 2: videoCard() })
    await until(() => ofType(k.seen, 'execution_error').length === 1 || ofType(k.seen, 'execution_success').length === 1)
    expect((ofType(k.seen, 'execution_error')[0] as any)?.data?.exception_message ?? JSON.stringify(ofType(k.seen, 'execution_error'))).toContain(SYNC_3_TOO_LONG)
    expect(k.fal.reqs.size).toBe(0)
    expect(k.upload.mock.calls.length).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })

  it('the files are the caller\'s own (hosted)', async () => {
    const k = await kitWith({ 'face.mp4': await mp4(5), 'voice.wav': wav(3) })
    const owned: string[] = []
    k.deps.ownership.ownsInput = async (_u, f) => { owned.push(f.filename); return f.filename !== 'face.mp4' }
    await expect(start(k, { 1: lip(), 2: videoCard() })).rejects.toThrow('This workflow uses a file that isn’t one of yours')
    expect(owned).toContain('face.mp4')
    expect(k.ledger.holds.size).toBe(0)
  })
})

// ── Fix round 1 (review of 945c3ab42) ───────────────────────────────────────

describe('fix round 1: what is measured is what is sent and charged', () => {
  const start = (k: ReturnType<typeof makeKit>, take: ApiPrompt) =>
    k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })
  const done = (k: ReturnType<typeof makeKit>, n = 1) =>
    until(() => ofType(k.seen, 'execution_success').length + ofType(k.seen, 'execution_error').length >= n)

  /** A kit on real files; `reads` counts reads per file; `later` gives a file's bytes from its second read on. */
  const kitWith = (entries: Record<string, Buffer>, o: { families?: ReadonlySet<RunnerFamily>, later?: Record<string, Buffer> } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'sync3-fix1-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
    for (const [name, bytes] of Object.entries(entries)) writeFileSync(join(root, 'input', name), bytes)
    const store = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => true })
    const reads = new Map<string, number>()
    const results = {
      ...store,
      read: async (f: OutputFile) => {
        const n = (reads.get(f.filename) ?? 0) + 1
        reads.set(f.filename, n)
        if (n > 1 && o.later?.[f.filename]) return new Uint8Array(o.later[f.filename]!)
        return store.read(f)
      },
    }
    // The hand-off reads through the same store, so a read it makes itself is counted (and sees `later`).
    const upload = vi.fn(async (_b: Uint8Array, name: string) => `https://fal.storage/${name}`)
    const handoff = createHandoff({ upload })
    return { k: makeKit({ hosted: true, available: 5000, root, deps: { families: () => o.families ?? ON, results, handoff } }), reads, root, upload }
  }
  /** The same length, other bytes. */
  const otherWav = (seconds: number) => { const b = wav(seconds); b.fill(3, 44); return b }

  it('the hand-off is keyed by the bytes, not the name: an overwritten file is uploaded again; toUrlBytes sends exactly the bytes given', async () => {
    let disk = new Uint8Array([1, 1])
    let n = 0
    const upload = vi.fn(async () => `https://fal.media/up${++n}`)
    const h = createHandoff({ upload })
    const f: OutputFile = { filename: 'voice.wav', subfolder: '', type: 'input' }
    expect(await h.toUrlBytes(f, disk)).toBe('https://fal.media/up1')
    expect(await h.toUrlBytes(f, disk)).toBe('https://fal.media/up1')
    disk = new Uint8Array([2, 2, 2])
    expect(await h.toUrlBytes(f, disk)).toBe('https://fal.media/up2')
    expect(h.hashOf('https://fal.media/up2')).toBe(sha256Hex(new Uint8Array([2, 2, 2])))
    // Bytes the caller already read: those, whatever the file now holds.
    expect(await h.toUrlBytes(f, new Uint8Array([7]))).toBe('https://fal.media/up3')
    expect(upload.mock.calls.map(c => [...(c as unknown as [Uint8Array])[0]])).toEqual([[1, 1], [2, 2, 2], [7]])
    expect(upload.mock.calls.map(c => (c as unknown as [Uint8Array, string, string])[2])).toEqual(['audio/wav', 'audio/wav', 'audio/wav'])
  })

  it('between runs: a sound overwritten under the same name is measured, held, sent and charged anew', async () => {
    const { k, root, upload } = kitWith({ 'face.mp4': await mp4(5), 'voice.wav': wav(3.4) })
    await start(k, { 1: lip({ mode: 'loop' }), 2: videoCard() })
    await done(k, 1)
    writeFileSync(join(root, 'input', 'voice.wav'), wav(5))
    await start(k, { 1: lip({ mode: 'loop' }), 2: videoCard() })
    await done(k, 2)
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    const voices = upload.mock.calls.filter(c => (c as unknown as [Uint8Array, string])[1] === 'voice.wav').map(c => (c as unknown as [Uint8Array])[0].byteLength)
    expect(voices).toEqual([wav(3.4).byteLength, wav(5).byteLength])
    // 3.4 s → 4 s (80) and 5 s (101), each + the render credit, held and charged alike.
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[81, 81], [102, 102]])
  })

  it('mid-run: a longer sound after the start is refused at the node\'s turn; the hold is released, nothing sent', async () => {
    const { k, upload } = kitWith({ 'face.mp4': await mp4(5), 'voice.wav': wav(3) }, { later: { 'voice.wav': wav(4.5) } })
    await start(k, { 1: lip({ mode: 'loop' }), 2: videoCard() })
    await done(k)
    expect((ofType(k.seen, 'execution_error')[0] as any).data.exception_message).toBe(SYNC_3_CHANGED)
    expect(k.fal.reqs.size).toBe(0)
    expect(upload.mock.calls.length).toBe(0)
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.state])).toEqual([[61, 'released']])
  })

  it('mid-run: the same length with other bytes is refused too', async () => {
    const { k } = kitWith({ 'face.mp4': await mp4(5), 'voice.wav': wav(3) }, { later: { 'voice.wav': otherWav(3) } })
    await start(k, { 1: lip({ mode: 'loop' }), 2: videoCard() })
    await done(k)
    expect((ofType(k.seen, 'execution_error')[0] as any).data.exception_message).toBe(SYNC_3_CHANGED)
    expect(k.fal.reqs.size).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })

  it('the node\'s turn reads each file once: the bytes measured are the bytes uploaded', async () => {
    const { k, reads } = kitWith({ 'face.mp4': await mp4(5), 'voice.wav': wav(3) })
    await start(k, { 1: lip({ mode: 'loop' }), 2: videoCard() })
    await done(k)
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    // One read at the start of the run, one at the node's turn (the check and the hand-off share it).
    expect(Object.fromEntries(reads)).toEqual({ 'face.mp4': 2, 'voice.wav': 2 })
  })

  it('a size-priced picture (Rotate camera on 2511) overwritten during its turn: the picture measured is the one sent', async () => {
    const small = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#808080' } }).png().toBuffer()
    const big = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: '#808080' } }).png().toBuffer()
    const qwen: ReadonlySet<RunnerFamily> = new Set(['qwen-2511-angles'])
    const { k, reads, upload } = kitWith({ 'photo.png': small }, { families: qwen, later: { 'photo.png': big } })
    await start(k, {
      11: { class_type: 'Image', inputs: { image: 'photo.png' } },
      1: { class_type: 'RotateCameraNode', inputs: { image: ['11', 0], camera: JSON.stringify({ yaw: 90, pitch: 30, roll: 0 }), seed: 0 } },
      2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
    })
    await done(k)
    expect(k.fal.submitted().map(r => r.endpoint)).toEqual([QWEN_2511_ANGLES_APP])
    expect(reads.get('photo.png')).toBe(1)
    expect((upload.mock.calls[0] as unknown as [Uint8Array])[0].byteLength).toBe(small.byteLength)
    expect([...k.ledger.holds.values()].map(h => h.actual)).toEqual([creditsForUsd(0.035) + 1])
  })

  it('the hold: the measured price when the take has a record; the 60 s cap with none (older runs, a take never measured)', () => {
    const take: ApiPrompt = { 1: lip({ mode: 'loop' }), 2: videoCard() }
    const measured = { 1: { seconds: { audio: 3.4, video: 5 }, sha: { video: 'v', audio: 'a' } } }
    expect(stageEstimate(take, ['1', '2'], true, ON, measured)).toBe(81)
    expect(stageEstimate(take, ['1', '2'], true, ON)).toBe(1201)
    // A record with no lengths (a local run that couldn't measure): the cap.
    expect(stageEstimate(take, ['1', '2'], true, ON, { 1: { seconds: {}, sha: { video: 'v', audio: 'a' } } })).toBe(1201)
  })

  it('the record is kept on the take (with the bytes\' sha256), so every later leg of the run holds from it', async () => {
    const { k } = kitWith({ 'face.mp4': await mp4(5), 'voice.wav': wav(3.4) })
    const { runId } = await start(k, { 1: lip({ mode: 'loop' }), 2: videoCard() })
    await done(k)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.measured!['1']!.sha).toEqual({ video: sha256Hex(await mp4(5)), audio: sha256Hex(wav(3.4)) })
    expect(run.takes[0]!.measured!['1']!.seconds.audio).toBeCloseTo(3.4, 3)
  })
})

describe('fix round 1: the Audio card and the switch-off path', () => {
  const image = { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } }
  const imageCard = { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } }

  it('an image workflow beside a lone Audio card stays on the engine, exporting or not, with sync-3 on', () => {
    expect(isRunnerEligible({ 1: image, 2: imageCard }, ALL)).toBe(true)
    expect(isRunnerEligible({ 1: image, 2: imageCard, 3: card('voice.wav', { export: true }) }, ALL)).toBe(false)
    expect(isRunnerEligible({ 1: image, 2: imageCard, 3: card('voice.wav') }, ALL)).toBe(false)
  })

  it('a card feeding sync-3 is taken only with export off (a set or linked export stays on the engine)', () => {
    const withCard = (c: object): ApiPrompt => ({ 1: lip({ inputs: { audio: ['3', 0] } }), 2: videoCard(), 3: c as any })
    expect(isRunnerEligible(withCard(card()), ON)).toBe(true)
    expect(isRunnerEligible(withCard(card('voice.wav', { export: true })), ALL)).toBe(false)
    expect(isRunnerEligible(withCard(card('voice.wav', { export: ['7', 0] })), ALL)).toBe(false)
  })

  it('switch off: a workflow with Lip-sync or an Audio card is left whole by the validation port (as before F22); on, it is pruned', () => {
    // Output 1 fails validation (a Frame with no layer 1); Lip-sync feeds a Video card.
    const p: ApiPrompt = {
      1: { class_type: 'Compositor', inputs: {} },
      2: lip(),
      3: videoCard('2'),
      4: card(),
    }
    for (const families of [NO_FAMILIES, ALL_BUT]) {
      const off = pruneInvalidOutputs(p, families)
      expect(off.prompt).toBe(p)
      expect(off.dropped).toEqual([])
    }
    const on = pruneInvalidOutputs(p, ALL)
    expect(on.dropped).toEqual(['1'])
    expect(Object.keys(on.prompt).sort()).toEqual(['2', '3', '4'])
  })
})

// ── Fix round 2 (re-review of f49a37424) ────────────────────────────────────

/** An MP4 holding only a sound track (AAC) of `seconds`, muxed without an encoder: a Safari/iOS recording's shape. */
async function mp4Sound(seconds: number): Promise<Buffer> {
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const src = new EncodedAudioPacketSource('aac')
  out.addAudioTrack(src)
  await out.start()
  const frame = 1024 / 44100
  const n = Math.ceil(seconds / frame)
  for (let i = 0; i < n; i++) {
    await src.add(new EncodedPacket(new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8C, 0x1C]), 'key', i * frame, frame),
      i === 0 ? { decoderConfig: { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 1, description: new Uint8Array([0x12, 0x08]) } } : undefined)
  }
  await out.finalize()
  return Buffer.from((out.target as BufferTarget).buffer!)
}

describe('fix round 2', () => {
  const run = (k: ReturnType<typeof makeKit>, take: ApiPrompt) =>
    k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('an MP4 sound with a sound track is accepted and measured (Safari/iOS recordings)', async () => {
    const bytes = await mp4Sound(3)
    expect(mediaFormat(bytes)).toBe('mp4')
    const facts = await mediaFacts(bytes, SYNC_3_SOUND_RULE)
    expect(facts.seconds).toBeGreaterThan(2.9)
    expect(facts.seconds).toBeLessThan(3.1)
    expect(mediaRuleProblem(facts, SYNC_3_SOUND_RULE, true)).toBeNull()
  })

  it('an over-limit file is refused from its size alone, never read (unit and engine)', async () => {
    const reads: string[] = []
    const r = await sync3MediaCheck({ 1: lip() }, '1', {
      read: async (f) => { reads.push(f.filename); return new Uint8Array(f.filename === 'face.mp4' ? await mp4(2) : wav(1)) },
      size: async f => (f.filename === 'voice.wav' ? SYNC_3_MAX_SOUND_BYTES + 1 : 1000),
      strict: true,
    })
    expect(r).toEqual({ problem: SYNC_3_SOUND_RULE.words.tooLarge })
    expect(reads).not.toContain('voice.wav')
    // The engine: a sparse 50 MB + 1 sound on disk, stat'd by the result store and never loaded.
    const root = mkdtempSync(join(tmpdir(), 'sync3-fix2-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
    writeFileSync(join(root, 'input', 'face.mp4'), await mp4(5))
    writeFileSync(join(root, 'input', 'voice.wav'), wav(1))
    truncateSync(join(root, 'input', 'voice.wav'), SYNC_3_MAX_SOUND_BYTES + 1)
    const store = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => true })
    const engineReads: string[] = []
    const results = { ...store, read: async (f: OutputFile) => { engineReads.push(f.filename); return store.read(f) } }
    const k = makeKit({ hosted: true, available: 5000, root, deps: { families: () => ON, results } })
    await expect(run(k, { 1: lip(), 2: videoCard() })).rejects.toThrow(SYNC_3_SOUND_RULE.words.tooLarge)
    expect(engineReads).not.toContain('voice.wav')
    expect(k.ledger.holds.size).toBe(0)
  })

  /** A kit whose engine "crashes" (never wakes from its next sleep) once `crashed` is set. */
  const crashingKit = (root: string, fal: ReturnType<typeof createFakeFal>, ledger: ReturnType<typeof createFakeLedger>) => {
    const state = { crashed: false }
    const k = makeKit({
      hosted: true, fal, ledger, root, deps: {
        families: () => ON,
        sleep: () => (state.crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))),
      },
    })
    return { k, state }
  }
  const media = async () => {
    const root = mkdtempSync(join(tmpdir(), 'sync3-resume-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
    writeFileSync(join(root, 'input', 'face.mp4'), await mp4(5))
    writeFileSync(join(root, 'input', 'voice.wav'), wav(3.4))
    return root
  }

  it('resuming a node whose request was sent before a restart: no re-check, the request and the credits written at submit', async () => {
    const root = await media()
    const fal = createFakeFal()
    const ledger = createFakeLedger(5000)
    const { k: k1, state } = crashingKit(root, fal, ledger)
    fal.holdNext(1)
    const { runId } = await run(k1, { 1: lip({ mode: 'loop' }), 2: videoCard() })
    await until(() => (fal.submitted()[0]?.polls ?? 0) >= 2)
    state.crashed = true
    await new Promise(r => setTimeout(r, 20))
    // While the server is down the sound is replaced: longer, other bytes.
    writeFileSync(join(root, 'input', 'voice.wav'), wav(9))
    const k2 = makeKit({ hosted: true, dir: k1.dir, root, fal, ledger, deps: { families: () => ON } })
    expect(await k2.engine.reattach()).toBe(1)
    fal.release()
    await k2.engine.settled(runId)
    expect(ofType(k2.seen, 'execution_error')).toEqual([])
    // One job, the one sent before the restart; the request written down is unchanged.
    expect(fal.submitted()).toHaveLength(1)
    const stored = (await k2.store.get(runId))!
    expect(stored.status).toBe('done')
    expect(stored.takes[0]!.nodes['1']!.payload).toEqual(fal.submitted()[0]!.payload)
    // Charged what was written down at submit (the 3.4 s sound: 80), + the render credit.
    expect(stored.takes[0]!.nodes['1']!.credits).toBe(80)
    expect([...ledger.holds.values()].map(h => [h.credits, h.state, h.actual])).toEqual([[81, 'settled', 81]])
  })

  it('a stored run with no measured record (saved before the tight hold): a new leg holds the 60 s cap, runs, and charges the clip', async () => {
    const root = await media()
    const fal = createFakeFal()
    const ledger = createFakeLedger(5000)
    const take: ApiPrompt = {
      1: lip({ mode: 'loop' }),
      2: videoCard(),
      3: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      4: { class_type: 'ComfyGateNode', inputs: { data_in: ['3', 0], bypass: false } },
      5: { class_type: 'Image', inputs: { image: '', export: false, images: ['4', 0], batch_index: -1 } },
    }
    const k1 = makeKit({ hosted: true, fal, ledger, root, deps: { families: () => ON } })
    const { runId } = await run(k1, take)
    await k1.engine.settled(runId)
    expect((await k1.store.get(runId))!.status).toBe('paused')
    // As a run stored before the fix: no record on the take.
    const stored = (await k1.store.get(runId))!
    delete stored.takes[0]!.measured
    await k1.store.save(stored)
    const k2 = makeKit({ hosted: true, dir: k1.dir, root, fal, ledger, deps: { families: () => ON } })
    const imagePrice = nodeCredits(take['3']!, undefined, ON)
    const holdsBefore = ledger.holds.size
    await k2.engine.gateAction({ userId: k2.userId, runId, gateId: '4', action: 'restart' })
    await k2.engine.settled(runId)
    const restartHold = [...ledger.holds.values()].slice(holdsBefore)
    // The lip-sync's 60 s cap (1200) + the picture; the render credit was paid in the first leg.
    expect(restartHold.map(h => h.credits)).toEqual([1200 + imagePrice])
    expect(ofType(k2.seen, 'execution_error')).toEqual([])
    // Charged the clip it measured at its turn (80) + the picture again.
    expect(restartHold.map(h => h.actual)).toEqual([80 + imagePrice])
  })
})
