/**
 * Lip-sync a character on Fabric or Kling (step 3, R11.3, family
 * `sound-in`): LipSyncNode.execute's request, `_lipsync_build_input`
 * (comfy_api_nodes/nodes_replicate.py :2214), on Replicate, no backup:
 *   - Fabric:  veed/fabric-1.0          {image, audio, resolution}
 *   - Kling:   kwaivgi/kling-lip-sync   {video_url, audio_file}
 * (schemas: tests/unit/fixtures/provider-schemas/replicate/veed__fabric-1.0.json
 * and kwaivgi__kling-lip-sync.json). Each answer is one video URL
 * (`_first_output_url`), saved like a video, waited on as a video.
 *
 * The media (#shared/runner/lipSyncEngines): an upload is handed off from
 * its file (the bytes the start of the run measured); an https address is
 * sent as typed; a wired sound is Python's 16-bit WAV of its first 60 s, the
 * very WAV the engine measured for this turn (`ctx.soundWav`), handed off as
 * `audio.wav`. Python hands Fabric data: links and Kling fal-storage links of
 * the same bytes (its WAV under the name "lipsync-voice.mp3"): the runner hands
 * every file off one way. A resumed node takes the links written down when
 * it was sent and reads nothing again.
 */
import type { ApiLink } from '#shared/runner/graph'
import {
  FABRIC_LIPSYNC_SLUG, KLING_LIPSYNC_MAX_SOUND_BYTES, KLING_LIPSYNC_SLUG, KLING_LIPSYNC_SOUND_TOO_LARGE, LIPSYNC_NEEDS_SOUND,
  fabricLipSyncResolution, lipSyncEngineMedia, lipSyncEngineProblem, lipSyncRunEngine, type LipSyncMediaRef,
} from '#shared/runner/lipSyncEngines'
import type { NodePlan, PlanContext } from '../executors'
import { firstOutputUrl } from './repair'

/** `_lipsync_build_input` for Fabric: `{"image": image, "audio": audio, "resolution": resolution}`. */
export function fabricLipSyncInput(a: { image: string, audio: string, resolution: string }): Record<string, unknown> {
  return { image: a.image, audio: a.audio, resolution: a.resolution }
}

/** `_lipsync_build_input` for Kling (Python's "sync"): `{"video_url": video, "audio_file": audio}`. */
export function klingLipSyncInput(a: { video: string, audio: string }): Record<string, unknown> {
  return { video_url: a.video, audio_file: a.audio }
}

/** The plan for a Fabric or Kling node (planNode's LipSyncNode case). */
export async function planLipSyncEngine(ctx: PlanContext): Promise<NodePlan> {
  const inputs = ctx.prompt[ctx.nodeId]?.inputs ?? {}
  const engine = lipSyncRunEngine(inputs)
  if (engine !== 'fabric' && engine !== 'kling') throw new Error('The runner runs Lip-sync a character on Fabric, Kling or sync-3 only')
  const bad = lipSyncEngineProblem(inputs)
  if (bad) throw new Error(bad.message)
  const m = lipSyncEngineMedia(inputs)
  const recorded = ctx.recordedPayload
  const sent = (key: string): string | null => (recorded && typeof recorded[key] === 'string' ? recorded[key] as string : null)

  const urlOf = async (r: LipSyncMediaRef, key: string): Promise<string> => {
    const was = sent(key)
    if (was !== null) return was
    if ('upload' in r) return ctx.toUrl({ filename: r.upload, subfolder: '', type: 'input' })
    if ('https' in r) return r.https
    if ('wired' in r) {
      if (!ctx.soundWav || !ctx.bytesToUrl) throw new Error(LIPSYNC_NEEDS_SOUND)
      const w = await ctx.soundWav(r.wired as ApiLink)
      // Kling's schema takes sounds under 5 MB (a long stereo WAV is more): refused before the call.
      if (engine === 'kling' && w.wav.byteLength > KLING_LIPSYNC_MAX_SOUND_BYTES) throw new Error(KLING_LIPSYNC_SOUND_TOO_LARGE)
      return ctx.bytesToUrl({ filename: 'audio.wav', subfolder: '', type: 'kept' }, w.wav)
    }
    // A blank or unreadable medium never reaches here (lipSyncEngineProblem, the row's input check).
    throw new Error(LIPSYNC_NEEDS_SOUND)
  }

  const payload = engine === 'fabric'
    ? fabricLipSyncInput({ image: await urlOf(m.image, 'image'), audio: await urlOf(m.audio, 'audio'), resolution: fabricLipSyncResolution(inputs) })
    : klingLipSyncInput({ video: await urlOf(m.video, 'video_url'), audio: await urlOf(m.audio, 'audio_file') })
  return {
    kind: 'provider', provider: 'replicate', endpoint: engine === 'fabric' ? FABRIC_LIPSYNC_SLUG : KLING_LIPSYNC_SLUG, payload,
    media: 'video', take: 'first', urlsOf: firstOutputUrl, prefix: 'lip_sync', wait: 'video',
    // LipSyncNode shows nothing itself (its Python execute returns only the video); a Video card after it does.
    uiFor: () => null,
  }
}
