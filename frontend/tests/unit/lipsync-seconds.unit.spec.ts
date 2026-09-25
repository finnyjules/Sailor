/**
 * Task P5 fix round 1 (review I1–I4, M2, M3):
 *  - lip-sync is billed by the measured clip — the /prompt gate reads the sound
 *    file (and Kling lip-sync's source video) with mediabunny; the 60 s cap only
 *    when it can't (graphInputSeconds.ts, clipSettings.ts billedSeconds);
 *  - sync.so "silence" (and a linked sync mode) is refused;
 *  - the badge shows the same figure where the canvas knows the length, else
 *    "up to" the 60 s figure — never below the charge;
 *  - the input-picture cap is the widest Nano Banana 4K picture;
 *  - Frame Animate asks the graph runs' cost confirm in hosted mode.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_FORMATS, BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny'
import * as PriceBook from '~~/server/utils/priceBook'
import { UnpricedGraphError, priceGraph } from '~~/server/utils/priceBook'
import { MAX_MEASURED_FILES, createGateReads, graphInputPixels } from '~~/server/utils/graphInputPixels'
import { graphInputSeconds, mediaSeconds, type MediaFile, type MediaKind } from '~~/server/utils/graphInputSeconds'
import { meterGraphSubmit, validateGraphFileRefs } from '~~/server/utils/meterGraphRun'
import { GRAPH_FILE_READERS, extractFileRefs } from '~~/server/utils/engineFileSurface'
import { RUNNER_NODE_RULES } from '#shared/runner/eligibility'
import { CLIP_RATES } from '#shared/pricing/clipRates'
import { VIDEO_RATES } from '#shared/pricing/videoRates'
import { LARGEST_INPUT_PIXELS, nanoBananaPixels } from '#shared/pricing/editSettings'
import {
  LIPSYNC_MEDIA_READS, VIEW_REF_REFUSED, ViewRefRefusedError, allotMediaFiles, billedSeconds, gateNodeOrder, parseViewRef, pyParseQs,
  readViewRef, secondsPricedMedia, sourceAudioSeconds,
} from '#shared/pricing/clipSettings'
import { creditsForUsd } from '#shared/pricing/markup'
import { priceNode } from '#shared/pricing/nodePrice'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes, upstreamInputSeconds, vueNodesToEstimateInput } from '~/lib/costEstimate'
import { COST_CONFIRM_EVENT, requestCostConfirm, type CostConfirmRequestDetail } from '~/lib/costConfirmRequest'
import { confirmAnimateCost } from '~/composables/useLayerAnimate'
import { clipPriceCredits } from '~/data/clip-models'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const SINK = { class_type: 'SaveVideo', inputs: {} }
const LINK = ['9', 0]
const charge = (prompt: Record<string, any>, inputSeconds?: Record<string, any>) => priceGraph({ ...prompt, out: SINK }, { inputSeconds }).credits

/** A 16-bit mono PCM WAV of `seconds`. */
function wav(seconds: number, rate = 8000): Buffer {
  const n = Math.round(seconds * rate)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  return b
}

/** A silent-picture MP4 whose video track lasts `seconds` (10 fps), muxed without an encoder. */
async function mp4(seconds: number): Promise<Buffer> {
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const src = new EncodedVideoPacketSource('avc')
  out.addVideoTrack(src, { frameRate: 10 })
  await out.start()
  const description = new Uint8Array([1, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0, 0x0A, 0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x02, 0x80, 0xBF, 0xE5, 0x84, 1, 0, 4, 0x68, 0xCE, 0x3C, 0x80])
  const frames = Math.round(seconds * 10)
  for (let i = 0; i < frames; i++) {
    await src.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65]), i === 0 ? 'key' : 'delta', i / 10, 0.1),
      i === 0 ? { decoderConfig: { codec: 'avc1.42c01e', codedWidth: 320, codedHeight: 240, description } } : undefined)
  }
  await out.finalize()
  return Buffer.from((out.target as BufferTarget).buffer!)
}
void ALL_FORMATS

// ── The shared price ──────────────────────────────────────────────────────

describe('lip-sync billed by the measured clip', () => {
  it('billed seconds: whole seconds rounded up, at most 60; unmeasured → 60', () => {
    expect(billedSeconds(7.3)).toBe(8)
    expect(billedSeconds(8)).toBe(8)
    expect(billedSeconds(8.0000000001)).toBe(8)       // float noise off the container duration
    expect(billedSeconds(0.2)).toBe(1)
    expect(billedSeconds(59.5)).toBe(60)
    expect(billedSeconds(600)).toBe(60)
    for (const v of [null, undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) expect(billedSeconds(v as any)).toBe(60)
  })

  it('Fabric, sync.so and Kling lip-sync bill their own clip', () => {
    // Fabric bills the sound: 7.3 s → 8 × $0.15 (720p) = $1.20 → 180.
    expect(priceNode('LipSyncNode', {}, { inputSeconds: { audio: 7.3 } })).toEqual({ usd: 1.2, credits: 180 })
    expect(priceNode('LipSyncNode', { resolution: '480p' }, { inputSeconds: { audio: 7.3 } })).toEqual({ usd: 0.64, credits: 96 })
    // A measured source video does not move Fabric's price.
    expect(priceNode('LipSyncNode', {}, { inputSeconds: { audio: 7.3, video: 3 } })).toEqual({ usd: 1.2, credits: 180 })
    // sync.so: 12.4 s → 13 × $0.08325.
    for (const ct of ['LipsyncNode', 'LipsyncRemoteNode']) {
      expect(priceNode(ct, { sync_mode: 'cut_off' }, { inputSeconds: { audio: 12.4 } })).toEqual({ usd: 1.08225, credits: creditsForUsd(1.08225) })
    }
    // Kling lip-sync bills the source video: 5.2 s → 6 × $0.014; the sound's length doesn't matter.
    expect(priceNode('LipSyncNode', { engine: 'sync' }, { inputSeconds: { audio: 40, video: 5.2 } })).toEqual({ usd: 0.084, credits: 17 })
    // Kling with only the sound measured: the video is unmeasured → 60 s.
    expect(priceNode('LipSyncNode', { engine: 'sync' }, { inputSeconds: { audio: 5 } })).toEqual({ usd: 0.84, credits: 126 })
    // A linked engine: the dearer of Fabric (sound) and Kling (video).
    expect(priceNode('LipSyncNode', { engine: LINK }, { inputSeconds: { audio: 4, video: 10 } })).toEqual({ usd: 0.6, credits: 90 })
    // Anything over 60 s is billed 60 (the audio cap / Fabric's longest output).
    expect(priceNode('LipSyncNode', {}, { inputSeconds: { audio: 300 } })).toEqual({ usd: 9, credits: 1350 })
  })

  it('sync.so "silence", a linked mode, or an unknown mode is refused, plainly; hosted fails closed', () => {
    for (const ct of ['LipsyncNode', 'LipsyncRemoteNode']) {
      const silence = priceNode(ct, { sync_mode: 'silence' })
      expect(silence).toEqual({ refused: expect.stringContaining('"silence" can\'t be priced') })
      expect((silence as any).refused).toContain('Choose loop, bounce, cut off or remap')
      expect(priceNode(ct, { sync_mode: LINK })).toEqual({ refused: expect.stringContaining('must be set on the node, not linked') })
      expect(priceNode(ct, { sync_mode: 'stretch' })).toEqual({ refused: expect.stringContaining('not one Sailor can price') })
      expect(() => priceGraph({ 1: { class_type: ct, inputs: { sync_mode: 'silence' } }, 2: SINK })).toThrow(UnpricedGraphError)
      expect(nodeCreditEstimate(ct, { sync_mode: 'silence' })).toBeNull()
    }
    // The Python offers exactly these five modes on both nodes.
    const py = readFileSync(`${REPO}comfy_api_nodes/nodes_replicate.py`, 'utf8')
    expect(py.match(/options=\["loop", "bounce", "cut_off", "silence", "remap"\]/g)!.length).toBe(2)
  })

  it('the media a lip-sync price reads, as execute resolves it', () => {
    const mo = (o: object) => JSON.stringify(o)
    expect(secondsPricedMedia('Veo3RemoteNode', {})).toBeNull()
    expect(secondsPricedMedia('LipsyncNode', { audio: LINK })).toEqual({ audio: { link: LINK }, video: null })
    // A wired audio port wins over model_options.audio.
    expect(secondsPricedMedia('LipSyncNode', { audio: LINK, model_options: mo({ audio: '/view?filename=a.mp3&type=input' }) }))
      .toEqual({ audio: { link: LINK }, video: null })
    expect(secondsPricedMedia('LipSyncNode', { model_options: mo({ audio: '/view?filename=a.mp3&type=input', face_video: '/view?filename=v.mp4&type=input' }) }))
      .toEqual({ audio: { inputFile: 'a.mp3' }, video: { inputFile: 'v.mp4' } })
    // External URLs, data URLs and a linked model_options name nothing measurable.
    expect(secondsPricedMedia('LipSyncNode', { model_options: mo({ audio: 'https://x/a.mp3', face_video: 'data:video/mp4;base64,AA' }) }))
      .toEqual({ audio: null, video: null })
    expect(secondsPricedMedia('LipSyncNode', { model_options: LINK })).toEqual({ audio: null, video: null })
  })

  it('parseViewRef mirrors video_models.parse_view_ref', () => {
    expect(parseViewRef('/view?filename=voice.mp3&type=input')).toBe('voice.mp3')
    expect(parseViewRef('/view?type=input&filename=a%20b.wav')).toBe('a b.wav')
    expect(parseViewRef('/view?filename=x.png&type=output')).toBeNull()
    expect(parseViewRef('/view?filename=../x.png&type=input')).toBeNull()
    expect(parseViewRef('/view?filename=sub/x.png&type=input')).toBeNull()
    expect(parseViewRef('/view?filename=sub\\x.png&type=input')).toBeNull()
    expect(parseViewRef('https://site/view?filename=x.png&type=input')).toBeNull()
    expect(parseViewRef(7)).toBeNull()
    const py = readFileSync(`${REPO}comfy_api_nodes/video_models.py`, 'utf8')
    expect(py).toContain('if not isinstance(src, str) or not src.startswith("/view?"):')
    expect(py).toContain('if not name or "/" in name or "\\\\" in name or ".." in name:')
  })

  it('MusicGen / Generate music: the duration widget, 1–30 s; anything else unknown', () => {
    expect(sourceAudioSeconds('MusicGenRemoteNode', { duration: 12 })).toBe(12)
    expect(sourceAudioSeconds('GenerateMusicNode', { duration: '45' })).toBe(30)
    expect(sourceAudioSeconds('GenerateMusicNode', { duration: 0 })).toBe(1)
    expect(sourceAudioSeconds('GenerateMusicNode', { duration: LINK })).toBe(30)
    expect(sourceAudioSeconds('GenerateSpeechNode', { text: 'hi' })).toBeNull()
    const py = readFileSync(`${REPO}comfy_api_nodes/nodes_replicate.py`, 'utf8')
    expect(py).toContain('IO.Int.Input("duration", default=8, min=1, max=30, step=1, tooltip="Seconds.")')
  })

  it('the runner does not run lip-sync (nothing to measure there until F22)', () => {
    for (const ct of ['LipSyncNode', 'LipsyncNode', 'LipsyncRemoteNode']) expect(Object.prototype.hasOwnProperty.call(RUNNER_NODE_RULES, ct), ct).toBe(false)
  })
})

// ── The gate measures the media ───────────────────────────────────────────

describe('the /prompt gate measures lip-sync media', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p5-secs-'))
  writeFileSync(join(dir, 'voice.wav'), wav(7.3))
  writeFileSync(join(dir, 'long.wav'), wav(75))
  writeFileSync(join(dir, 'notes.txt'), 'not media')
  const video = mp4(5.2).then(b => writeFileSync(join(dir, 'face.mp4'), b))
  const read = async (f: MediaFile, kind: MediaKind) => mediaSeconds(join(dir, f.value.replace(/ \[input\]$/, '')), kind)

  it('mediabunny reads the sound and video lengths from byte ranges; too big, wrong kind or not media → null', async () => {
    await video
    expect(await mediaSeconds(join(dir, 'voice.wav'), 'audio')).toBeCloseTo(7.3, 5)
    expect(await mediaSeconds(join(dir, 'face.mp4'), 'video')).toBeCloseTo(5.2, 5)
    expect(await mediaSeconds(join(dir, 'face.mp4'), 'audio')).toBeNull()        // no audio track
    expect(await mediaSeconds(join(dir, 'notes.txt'), 'audio')).toBeNull()
    expect(await mediaSeconds(join(dir, 'missing.wav'), 'audio')).toBeNull()
    expect(await mediaSeconds(join(dir, 'voice.wav'), 'audio', { maxBytes: 100 })).toBeNull()
  })

  it('follows LoadAudio, Audio cards (source first), MusicGen and the Studio’s /view links; TTS and URLs stay unmeasured', async () => {
    await video
    const mo = (o: object) => JSON.stringify(o)
    const prompt = {
      1: { class_type: 'LoadAudio', inputs: { audio: 'voice.wav [input]' } },
      2: { class_type: 'LipsyncNode', inputs: { audio: ['1', 0], sync_mode: 'cut_off' } },
      3: { class_type: 'MusicGenRemoteNode', inputs: { duration: 12 } },
      4: { class_type: 'Audio', inputs: { audio: 'long.wav', source: ['3', 0] } },       // source wins over the file
      5: { class_type: 'LipsyncRemoteNode', inputs: { audio: ['4', 0], sync_mode: 'loop' } },
      6: { class_type: 'Audio', inputs: { audio: 'long.wav' } },
      7: { class_type: 'LipSyncNode', inputs: { audio: ['6', 0] } },
      8: { class_type: 'Audio', inputs: { audio: '' } },                                 // 1 s placeholder silence
      9: { class_type: 'LipSyncNode', inputs: { audio: ['8', 0] } },
      10: { class_type: 'GenerateSpeechNode', inputs: { text: 'hello' } },
      11: { class_type: 'LipsyncNode', inputs: { audio: ['10', 0], sync_mode: 'cut_off' } },
      12: { class_type: 'LipSyncNode', inputs: { engine: 'sync', model_options: mo({ audio: '/view?filename=voice.wav&type=input', face_video: '/view?filename=face.mp4&type=input' }) } },
      13: { class_type: 'LipSyncNode', inputs: { model_options: mo({ audio: 'https://cdn/x.mp3' }) } },
    }
    const secs = await graphInputSeconds(prompt, read)
    expect(secs[2]!.audio).toBeCloseTo(7.3, 5)
    expect(secs[5]).toEqual({ audio: 12 })
    expect(secs[7]!.audio).toBeCloseTo(75, 5)
    expect(secs[9]).toEqual({ audio: 1 })
    expect(secs[11]).toBeUndefined()
    expect(secs[12]!.audio).toBeCloseTo(7.3, 5)
    expect(secs[12]!.video).toBeCloseTo(5.2, 5)
    expect(secs[13]).toBeUndefined()
    // The charge reads it.
    const p = priceGraph(prompt as any, { inputSeconds: secs })
    const by = (a: string) => p.breakdown.find(b => b.action === a)!.credits
    expect(p.breakdown.filter(b => b.action.startsWith('LipsyncNode')).map(b => b.credits).sort((a, b) => a - b))
      .toEqual([creditsForUsd(8 * 0.08325), creditsForUsd(60 * 0.08325)])    // 7.3 s measured, TTS unmeasured
    expect(by('LipsyncRemoteNode')).toBe(creditsForUsd(12 * 0.08325))
    expect(p.breakdown.filter(b => b.action === 'LipSyncNode').map(b => b.credits).sort((a, b) => a - b))
      .toEqual([creditsForUsd(6 * 0.014), creditsForUsd(1 * 0.15), creditsForUsd(60 * 0.15), creditsForUsd(60 * 0.15)])   // Kling 5.2 s video, the 1 s placeholder, 75 s capped, a URL
  })

  it('lip-sync media have their own reserved slots: a graph full of pictures can\'t use them up (fix round 2)', async () => {
    const reads = createGateReads()
    const calls = { pictures: 0, media: 0 }
    const nodes: Record<string, any> = {}
    for (let i = 0; i < 12; i++) {                       // more pictures than the picture budget, and read FIRST
      nodes[`${100 + i}`] = { class_type: 'LoadImage', inputs: { image: `p${i}.png` } }
      nodes[`${200 + i}`] = { class_type: 'UpscaleImageNode', inputs: { model: 'Crystal', image: [`${100 + i}`, 0] } }
    }
    for (let i = 0; i < 3; i++) {
      nodes[`${300 + i}`] = { class_type: 'LoadAudio', inputs: { audio: `v${i}.wav` } }
      nodes[`${400 + i}`] = { class_type: 'LipsyncNode', inputs: { audio: [`${300 + i}`, 0], sync_mode: 'cut_off' } }
    }
    nodes['403'] = { class_type: 'LipsyncNode', inputs: { audio: ['300', 0], sync_mode: 'cut_off' } }  // same file: memoised
    const px = await graphInputPixels(nodes, async () => { calls.pictures++; return 1e6 }, reads)
    const secs = await graphInputSeconds(nodes, async () => { calls.media++; return 3 }, reads)
    expect(calls).toEqual({ pictures: MAX_MEASURED_FILES, media: 3 })
    expect(Object.keys(px)).toHaveLength(MAX_MEASURED_FILES)
    expect(Object.keys(secs).sort()).toEqual(['400', '401', '402', '403'])
    expect(LIPSYNC_MEDIA_READS).toBe(8)
  })

  it('past the media budget, the first files in gate order get a read and the rest price at 60 s', async () => {
    const nodes: Record<string, any> = {}
    for (let i = 0; i < 10; i++) {
      nodes[`${10 + i}`] = { class_type: 'LoadAudio', inputs: { audio: `v${i}.wav` } }
      nodes[`${30 + i}`] = { class_type: 'LipsyncNode', inputs: { audio: [`${10 + i}`, 0], sync_mode: 'cut_off' } }
    }
    const read = vi.fn(async () => 5)
    const secs = await graphInputSeconds(nodes, read)
    expect(read).toHaveBeenCalledTimes(LIPSYNC_MEDIA_READS)
    expect(Object.keys(secs).sort()).toEqual(['30', '31', '32', '33', '34', '35', '36', '37'])
    const p = priceGraph(nodes, { inputSeconds: secs })
    expect(p.breakdown.filter(b => b.action.startsWith('LipsyncNode')).map(b => b.credits))
      .toEqual([...Array(8).fill(creditsForUsd(5 * 0.08325)), creditsForUsd(60 * 0.08325), creditsForUsd(60 * 0.08325)])
    // The order: integer ids ascending, then the rest in string order.
    expect(gateNodeOrder(['10', '9', 'b', '12:3', 'a', '100'])).toEqual(['9', '10', '100', '12:3', 'a', 'b'])
    expect([...allotMediaFiles(['x', 'y', 'x', 'z'], 2)]).toEqual(['x', 'y'])
  })

  it('meterGraphSubmit holds on the measured length, and on 60 s without it', async () => {
    const prompt = { 1: { class_type: 'LoadAudio', inputs: { audio: 'voice.wav' } }, 2: { class_type: 'LipSyncNode', inputs: { audio: ['1', 0] } }, 3: SINK }
    const held: number[] = []
    const deps = {
      priceGraph, measureInputSeconds: async () => ({ 2: { audio: 7.3 } }),
      spendGuard: async () => {}, validateFileRefs: async () => {}, moderatePrompt: async () => ({ ok: true as const }),
      hold: async (_u: string, credits: number) => { held.push(credits); return { ok: true as const, holdId: 1 } },
      getAvailable: async () => 0, forward: async () => ({ status: 200, body: { prompt_id: 'p' } }),
      registerRun: async () => {}, startSettle: () => {}, releaseHold: async () => {},
    }
    await meterGraphSubmit('u', { prompt }, deps)
    await meterGraphSubmit('u', { prompt }, { ...deps, measureInputSeconds: undefined })
    await meterGraphSubmit('u', { prompt }, { ...deps, measureInputSeconds: async () => { throw new Error('boom') } })
    expect(held).toEqual([180 + 1, 1350 + 1, 1350 + 1])
    // The live wiring shares one read budget between pictures and lengths.
    const src = readFileSync(`${REPO}frontend/server/utils/meterGraphRun.ts`, 'utf8')
    expect(src).toContain('measureInputPixels: prompt => graphInputPixels(prompt, undefined, reads)')
    expect(src).toContain('measureInputSeconds: prompt => graphInputSeconds(prompt, undefined, reads)')
  })

  it('the Studio’s /view links are ownership-checked before anything is read or priced', async () => {
    const spec = GRAPH_FILE_READERS.LipSyncNode![0]!
    const mo = JSON.stringify({ audio: '/view?filename=voice.mp3&type=input', face_video: '/view?filename=v.mp4&type=input', face_image: 'https://x/y.png' })
    expect(extractFileRefs(spec, mo)).toEqual(['v.mp4', 'voice.mp3'])   // face_video, audio; the https image is not a file
    expect(extractFileRefs(spec, '{}')).toEqual([])
    expect(extractFileRefs(spec, '[1]')).toEqual([])
    expect(extractFileRefs(spec, '{nope')).toBeNull()      // unreadable: refused
    const ctx = (owned: string[]) => ({
      uploadFlagged: new Set<string>(), callerHash: 'h',
      ownsInput: async (n: string) => owned.includes(n), ownsOutput: async () => false,
    })
    const prompt = { 1: { class_type: 'LipSyncNode', inputs: { model_options: mo } } }
    await expect(validateGraphFileRefs(prompt, ctx(['voice.mp3']))).rejects.toThrow(/input file you do not own \(LipSyncNode\.model_options\)/)
    await expect(validateGraphFileRefs(prompt, ctx(['voice.mp3', 'v.mp4']))).resolves.toBeUndefined()
    await expect(validateGraphFileRefs({ 1: { class_type: 'LipSyncNode', inputs: { model_options: LINK } } }, ctx([]))).rejects.toThrow(/unexpected shape/)
  })
})

// ── The badge ─────────────────────────────────────────────────────────────

describe('badge: the same figure where the canvas knows the length, else "up to" the 60 s figure', () => {
  const def = (names: string[]) => names.map(name => ({ name }))
  const lipsync = (id: string, values: Record<string, unknown>, ins: string[] = ['audio']) => ({
    id, data: { nodeType: 'LipSyncNode', widgetDefs: def(Object.keys(values)), widgetsValues: Object.values(values), inputs: ins.map(name => ({ name })) },
  })
  const audioCard = (id: string, file: string, meta?: { file: string, seconds: number }) => ({
    id, data: { nodeType: 'Audio', widgetDefs: def(['audio']), widgetsValues: [file], inputs: [{ name: 'source' }], audioSeconds: meta },
  })
  const edge = (source: string, target: string, port = 0) => ({ source, target, targetHandle: `input-${port}` })

  it('an Audio card that read its file: badge = gate charge for the same length', () => {
    const card = audioCard('c', 'voice.wav', { file: 'voice.wav', seconds: 7.3 })
    const node = lipsync('n', { engine: 'auto', resolution: '720p' })
    const nodes = [card, node]
    const edges = [edge('c', 'n')]
    const s = upstreamInputSeconds(node, nodes, edges)!
    expect(s).toEqual({ seconds: { audio: 7.3 }, upTo: false })
    const badge = nodeCreditEstimate('LipSyncNode', { engine: 'auto', resolution: '720p', audio: LINK }, { inputSeconds: s.seconds })
    const gate = charge({ c: { class_type: 'Audio', inputs: { audio: 'voice.wav' } }, n: { class_type: 'LipSyncNode', inputs: { engine: 'auto', resolution: '720p', audio: ['c', 0] } } }, { n: { audio: 7.3 } })
    expect(badge).toBe(gate)
    expect(badge).toBe(181)
    // The run estimate (the confirm dialog) reads the same.
    expect(estimateUsdForNodes(vueNodesToEstimateInput(nodes as any, edges), { hosted: true })!.hostedCredits).toBe(181)
  })

  it('a card whose length is for another file, a loaded file, TTS or a Studio link: "up to" the 60 s figure', () => {
    const node = lipsync('n', { engine: 'auto', resolution: '720p' })
    const stale = audioCard('c', 'new.wav', { file: 'old.wav', seconds: 3 })
    expect(upstreamInputSeconds(node, [stale, node], [edge('c', 'n')])).toEqual({ seconds: {}, upTo: true })
    const tts = { id: 't', data: { nodeType: 'GenerateSpeechNode', widgetDefs: def(['text']), widgetsValues: ['hi'], inputs: [] } }
    expect(upstreamInputSeconds(node, [tts, node], [edge('t', 'n')])!.upTo).toBe(true)
    const studio = lipsync('s', { engine: 'auto', model_options: JSON.stringify({ audio: '/view?filename=v.mp3&type=input' }) })
    expect(upstreamInputSeconds(studio, [studio], [])!.upTo).toBe(true)
    // "up to" is the ceiling: never below any charge the gate can make.
    const ceiling = nodeCreditEstimate('LipSyncNode', { engine: 'auto', resolution: '720p', audio: LINK })!
    expect(ceiling).toBe(1351)
    for (const a of [0.5, 7.3, 30, 59.9, 60, 500]) {
      expect(ceiling).toBeGreaterThanOrEqual(charge({ n: { class_type: 'LipSyncNode', inputs: { engine: 'auto', resolution: '720p', audio: ['c', 0] } } }, { n: { audio: a } }))
    }
  })

  it('MusicGen upstream (through an Audio card’s source) and an empty card are known exactly', () => {
    const music = { id: 'm', data: { nodeType: 'GenerateMusicNode', widgetDefs: def(['duration']), widgetsValues: [12], inputs: [] } }
    const card = audioCard('c', 'ignored.wav')
    const node = { id: 'n', data: { nodeType: 'LipsyncNode', widgetDefs: def(['sync_mode']), widgetsValues: ['cut_off'], inputs: [{ name: 'audio' }] } }
    const s = upstreamInputSeconds(node, [music, card, node], [edge('m', 'c'), edge('c', 'n')])
    expect(s).toEqual({ seconds: { audio: 12 }, upTo: false })
    const empty = audioCard('e', '')
    expect(upstreamInputSeconds(node, [empty, node], [edge('e', 'n')])).toEqual({ seconds: { audio: 1 }, upTo: false })
  })

  it('more measurable files on the canvas than the gate reads: the ones past the budget say "up to" the capped figure', () => {
    const nodes: any[] = []
    const edges: any[] = []
    for (let i = 0; i < 10; i++) {
      nodes.push(audioCard(`${10 + i}`, `v${i}.wav`, { file: `v${i}.wav`, seconds: 5 }))
      nodes.push({ id: `${30 + i}`, data: { nodeType: 'LipsyncNode', widgetDefs: def(['sync_mode']), widgetsValues: ['cut_off'], inputs: [{ name: 'audio' }] } })
      edges.push(edge(`${10 + i}`, `${30 + i}`))
    }
    const at = (id: string) => upstreamInputSeconds(nodes.find(n => n.id === id), nodes, edges)!
    expect(at('37')).toEqual({ seconds: { audio: 5 }, upTo: false })     // the 8th file: read by the gate
    expect(at('38')).toEqual({ seconds: {}, upTo: true })                // the 9th: priced at the cap
    // Mirror the gate: the same graph, measured there, charges exactly what each badge shows (or less, for "up to").
    const prompt: Record<string, any> = {}
    for (let i = 0; i < 10; i++) {
      prompt[`${10 + i}`] = { class_type: 'Audio', inputs: { audio: `v${i}.wav` } }
      prompt[`${30 + i}`] = { class_type: 'LipsyncNode', inputs: { audio: [`${10 + i}`, 0], sync_mode: 'cut_off' } }
    }
    return graphInputSeconds(prompt, async () => 5).then((secs) => {
      for (let i = 0; i < 10; i++) {
        const id = `${30 + i}`
        const s = at(id)
        const badge = nodeCreditEstimate('LipsyncNode', { sync_mode: 'cut_off', audio: LINK }, { inputSeconds: s.seconds })!
        const gate = nodeCreditEstimate('LipsyncNode', { sync_mode: 'cut_off', audio: LINK }, { inputSeconds: secs[id] })!
        expect(badge, id).toBe(gate)
      }
    })
  })

  it('a muted lip-sync node on the canvas takes no slot; a subgraph’s inner nodes sort after every canvas id', () => {
    const nodes: any[] = []
    const edges: any[] = []
    for (let i = 0; i < 9; i++) {
      nodes.push(audioCard(`${10 + i}`, `v${i}.wav`, { file: `v${i}.wav`, seconds: 5 }))
      nodes.push({ id: `${30 + i}`, data: { nodeType: 'LipsyncNode', mode: i === 0 ? 2 : 0, widgetDefs: def(['sync_mode']), widgetsValues: ['cut_off'], inputs: [{ name: 'audio' }] } })
      edges.push(edge(`${10 + i}`, `${30 + i}`))
    }
    expect(upstreamInputSeconds(nodes.find(n => n.id === '38'), nodes, edges)!.upTo).toBe(false)
    expect(gateNodeOrder(['38', '5:1', '1000'])).toEqual(['38', '1000', '5:1'])
  })

  it('Kling lip-sync: the source video is never known on the canvas → "up to"', () => {
    const card = audioCard('c', 'voice.wav', { file: 'voice.wav', seconds: 7.3 })
    const node = lipsync('n', { engine: 'sync' })
    expect(upstreamInputSeconds(node, [card, node], [edge('c', 'n')])!.upTo).toBe(true)
  })

  it('ComfyNode shows "up to" while a length is unknown (a two-line hunk), and the Audio card records its file’s length', () => {
    const vue = readFileSync(`${REPO}frontend/app/components/vue-canvas/ComfyNode.vue`, 'utf8')
    expect(vue).toContain("return `${secs?.upTo ? 'up to ' : '~'}${est} cr`")
    const card = readFileSync(`${REPO}frontend/app/components/vue-canvas/ArtifactAudioNode.vue`, 'utf8')
    expect(card).toContain('(props.data as any).audioSeconds = { file: widgetFilename.value, seconds }')
  })
})

// ── Frame Animate asks the cost confirm (hosted) ──────────────────────────

describe('Frame Animate goes through the graph runs’ cost confirm in hosted mode', () => {
  afterEach(() => vi.unstubAllGlobals())
  const listen = (reply: (d: CostConfirmRequestDetail) => void) => {
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    target.addEventListener(COST_CONFIRM_EVENT, e => reply((e as CustomEvent<CostConfirmRequestDetail>).detail))
  }

  it('hosted: the dialog is asked with clipPriceCredits — the credits the hold takes', async () => {
    const seen: CostConfirmRequestDetail[] = []
    listen((d) => { seen.push(d); d.answer(Promise.resolve(true)) })
    expect(await confirmAnimateCost('seedance-2.0', 12, true)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.estimate.hostedCredits).toBe(clipPriceCredits('seedance-2.0', 12))
    expect(seen[0]!.estimate.hostedCredits).toBe(547)
    expect(creditsForUsd(seen[0]!.estimate.usd)).toBe(547)
    expect(seen[0]!.estimate.breakdown).toEqual([{ id: 'frame-animate', label: 'Animate: Seedance 2.0, 12 s', usd: 3.6408 }])
    // A length the model doesn't offer: the default the route falls back to, in the label and the price.
    await confirmAnimateCost('hailuo-h3', 7, true)
    expect(seen[1]!.estimate.breakdown[0]!.label).toBe('Animate: Hailuo H3, 5 s')
    expect(seen[1]!.estimate.hostedCredits).toBe(clipPriceCredits('hailuo-h3', 5))
  })

  it('cancel → false; local mode and an unknown model never ask', async () => {
    const seen: unknown[] = []
    listen((d) => { seen.push(d); d.answer(Promise.resolve(false)) })
    expect(await confirmAnimateCost('kling-v3-pro', 10, true)).toBe(false)
    expect(await confirmAnimateCost('kling-v3-pro', 10, false)).toBe(true)
    expect(await confirmAnimateCost('nope', 10, true)).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('no gate on the page: go ahead (the server still holds the same figure)', async () => {
    vi.stubGlobal('window', new EventTarget())
    expect(await requestCostConfirm({ usd: 1, approximate: false, breakdown: [], hostedCredits: 150 })).toBe(true)
  })

  it('the layout answers with the same threshold and dialog as graph runs; the composable asks before sending', () => {
    const layout = readFileSync(`${REPO}frontend/app/layouts/default.vue`, 'utf8')
    expect(layout).toContain('window.addEventListener(COST_CONFIRM_EVENT, handleConfirmCost)')
    expect(layout).toContain('d?.answer(d.estimate.usd >= costConfirmThresholdUsd() ? confirmRunCost(d.estimate) : Promise.resolve(true))')
    const comp = readFileSync(`${REPO}frontend/app/composables/useLayerAnimate.ts`, 'utf8')
    const ask = comp.indexOf('await confirmAnimateCost(')
    expect(ask).toBeGreaterThan(0)
    expect(ask).toBeLessThan(comp.indexOf("$fetch<"))
  })
})

// ── Review I2, M2, M3 ─────────────────────────────────────────────────────

describe('review I2, M2, M3', () => {
  it('I2: the input cap is NB_SIZES’ largest entry, 12288 × 1536', () => {
    expect(LARGEST_INPUT_PIXELS).toBe(18_874_368)
    expect(nanoBananaPixels('4K', null)).toBe(LARGEST_INPUT_PIXELS)
    expect(nanoBananaPixels('4K', '8:1')).toBe(LARGEST_INPUT_PIXELS)
  })
  it('M2: the Animate Seedance, H3 and H3 Max cards take their figures from VIDEO_RATES', () => {
    expect(CLIP_RATES['bytedance/seedance-2.0/image-to-video']!.byResolution).toBe(VIDEO_RATES['seedance-2.0']!.byResolution)
    expect(CLIP_RATES['minimax/h3/image-to-video']!.byResolution).toBe(VIDEO_RATES['hailuo-h3']!.byResolution)
    expect(CLIP_RATES['minimax/h3-max/image-to-video']!.byResolution).toBe(VIDEO_RATES['hailuo-h3-max']!.byResolution)
  })
  it('M3: RESTYLE_LORA_CREDITS is gone', () => {
    expect('RESTYLE_LORA_CREDITS' in PriceBook).toBe(false)
    expect(PriceBook.PRICE_BOOK_VERSION).toBe('lineup-f20')
  })
})

// ── Fix round 2, CRITICAL 1: the one `/view?` parser, Python's exactly ─────

describe('the /view? link parser reads links exactly as the engine does', () => {
  type Case = { src: string, python: string | null, lists: Record<'filename' | 'type' | 'subfolder', string[]> }
  // Recorded from .venv/bin/python: video_models.parse_view_ref and
  // parse_qs(urlsplit(src).query) for each case (tab/CR/LF, "#", "&amp;", "+",
  // %20, %2B, blank values, duplicate keys, bad percent escapes, bad UTF-8, …).
  const CASES = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/pricing/view-ref-python.json', import.meta.url)), 'utf8')) as Case[]
  /** Refused: a key named more than once with a value, or bytes Python would replace with U+FFFD. */
  const shouldRefuse = (c: Case) => Object.values(c.lists).some(l => l.length > 1) || c.src.includes('%C3.mp3')

  it('the fixture covers the cases the review named', () => {
    const srcs = CASES.map(c => c.src)
    for (const s of ['/view?filename=&filename=secret.mp4&type=input', '/view?filename=a.mp3&type=&type=input', '/view?filename=a.mp3&amp;type=input',
      '/view?filename=a+b.mp3&type=input', '/view?filename=a%20b.mp3&type=input', '/view?type=input&filename=a.mp3&filename=b.mp3']) expect(srcs).toContain(s)
    expect(CASES.length).toBeGreaterThan(40)
  })

  it('every case: the name is Python’s, or the link is refused', () => {
    for (const c of CASES) {
      const r = readViewRef(c.src)
      if (!c.src.startsWith('/view?')) { expect(r, c.src).toBeNull(); continue }
      if (shouldRefuse(c)) {
        expect(r!.refused, JSON.stringify(c.src)).toBe(VIEW_REF_REFUSED)
        expect(() => parseViewRef(c.src), JSON.stringify(c.src)).toThrow(ViewRefRefusedError)
      }
      else {
        expect(r, JSON.stringify(c.src)).toEqual({ name: c.python, refused: null })
        expect(parseViewRef(c.src), JSON.stringify(c.src)).toBe(c.python)
      }
    }
  })

  it('the bypass the review found now vets the file Python opens', () => {
    expect(parseViewRef('/view?filename=&filename=secret.mp4&type=input')).toBe('secret.mp4')
    expect(parseViewRef('/view?filename=secret.mp4&type=&type=input')).toBe('secret.mp4')
    // URLSearchParams (the old reader) saw nothing here:
    expect(new URLSearchParams('filename=&filename=secret.mp4&type=input').get('filename')).toBe('')
  })

  it('parse_qs: blank values dropped, "+" is a space, keys decoded, ";" is not a separator', () => {
    const q = pyParseQs('a=&a=1&b&c=x+y&%64=z&e=1;f=2&&g=%2B')!
    expect(Object.fromEntries(q)).toEqual({ a: ['1'], c: ['x y'], d: ['z'], e: ['1;f=2'], g: ['+'] })
    expect(pyParseQs('filename=%C3')).toBeNull()
    expect(pyParseQs('filename=%zz%4')!.get('filename')).toEqual(['%zz%4'])
  })

  it('live parity with the engine’s own parser, when the repo venv is here', async () => {
    const py = `${REPO}.venv/bin/python`
    const { existsSync } = await import('node:fs')
    if (!existsSync(py)) return
    const { execFileSync } = await import('node:child_process')
    const script = 'import json,sys\nfrom comfy_api_nodes.video_models import parse_view_ref\nprint(json.dumps([parse_view_ref(s) for s in json.load(sys.stdin)]))'
    const got = JSON.parse(execFileSync(py, ['-c', script], { cwd: REPO, input: JSON.stringify(CASES.map(c => c.src)), encoding: 'utf8' })) as (string | null)[]
    expect(got).toEqual(CASES.map(c => c.python))
  })

  it('the gate refuses a refused link with a plain 403 — no hold, nothing read', async () => {
    const ctx = { uploadFlagged: new Set<string>(), callerHash: 'h', ownsInput: async () => true, ownsOutput: async () => false }
    const bad = '/view?type=input&filename=mine.mp3&filename=secret.mp3'
    for (const [ct, mo] of [['LipSyncNode', { audio: bad }], ['LipSyncNode', { face_video: bad }]] as const) {
      const err = await validateGraphFileRefs({ 1: { class_type: ct, inputs: { model_options: JSON.stringify(mo) } } }, ctx).catch(e => e)
      expect(err, ct).toBeInstanceOf(ViewRefRefusedError)
      expect(err.statusCode).toBe(403)
      expect(err.message).toBe(VIEW_REF_REFUSED)
      expect((err.constructor as any).__h3_error__).toBe(true)
    }
    // The shared price never measures a refused link.
    expect(secondsPricedMedia('LipSyncNode', { model_options: JSON.stringify({ audio: bad }) })).toEqual({ audio: null, video: null })
    // Every /view parser the gate, the measurer and the price use is this one.
    for (const f of ['server/utils/engineFileSurface.ts', 'server/utils/graphInputSeconds.ts', 'server/utils/graphInputPixels.ts', 'shared/pricing/clipSettings.ts']) {
      const src = readFileSync(`${REPO}frontend/${f}`, 'utf8')
      expect(src, f).not.toMatch(/new URLSearchParams/)
    }
  })
})
