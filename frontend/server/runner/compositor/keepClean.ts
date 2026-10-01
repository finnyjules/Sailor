/**
 * Blend scene's kept subject, cleaned (step 3, R8.1 live-check fix,
 * USER ruling 2026-10-01: "only one product, the exact original at its
 * placed spot").
 *
 * The live check found Flux Kontext redrawing the kept car slightly lower
 * than it was placed; laying the original back on top (Python's keep step,
 * keep.ts) then showed the car twice. ComfyUI's node does the same.
 *
 * With keep_subject wired and both Background remove (`bg-remove`) and
 * Object removal (`object-remove`) on, Blend runs as a pipeline of three
 * calls, each priced and held (shared/pricing/nodePrice.ts
 * blendKeepCleanCalls):
 *
 *  1. `blend`: the node's own request, as before.
 *  2. `cutout`: 851-labs/background-remover on the answer, so the answer's
 *     subject is known.
 *  3. `fill`: LaMa (zylim0702/remove-object) on the answer, with the mask of
 *     the model's copy of the subject and the kept region
 *     (../pixels/keepClean.ts), so the scene is relit with no subject in it.
 *
 * Then the original is laid on top as before (keep.ts KeepStep.apply).
 *
 * A step that delivers nothing never fails the node. A cut-out or fill call
 * that fails, names no file, or whose file can't be fetched costs nothing,
 * and the original is laid on the answer as before. A cut-out that finds
 * nothing to fill (or takes the whole scene) is charged, since it was
 * delivered and read, and the fill is not made. Stop ends the node at once.
 */
import sharp from 'sharp'
import { BG_REMOVE_SLUG, OBJECT_REMOVE_SLUG } from '#shared/runner/localModels'
import { answerRgbPng, pilRaw } from '../pictures/pythonView'
import { pixelsInWorker } from './worker'
import { readMaskPng, type KeepStep } from './keep'
import { bgRemoveInput } from '../generators/localModels'
import { fillInput, maskPng } from '../generators/splitLayers'
import { firstOutputUrl } from '../generators/repair'
import type { NodePlan, PipelineIO, PipelineCall } from '../executors'
import type { RunnerProvider } from '../types'

const CLEAN_TIMEOUT = 'Finding the redrawn subject took longer than 2 minutes, so it was stopped'

/** The blend answered with no picture, after its call. */
export const BLEND_NO_ANSWER = 'The service sent back no picture'

export interface KeepCleanPlanInput {
  provider: RunnerProvider
  endpoint: string
  payload: Record<string, unknown>
  keep: KeepStep
  usd: { blend: number; cutout: number; fill: number }
}

/** What the cleaning steps did (tests read it; the node's record carries its calls). */
export type KeepCleanOutcome = 'cleaned' | 'nothing-to-fill' | 'whole-scene' | 'cutout-lost' | 'fill-lost'

export function planBlendKeepClean(p: KeepCleanPlanInput, onOutcome?: (o: KeepCleanOutcome) => void): NodePlan {
  return {
    kind: 'pipeline', prefix: 'blend_scene', keep: p.keep,
    run: async (io: PipelineIO) => {
      const aborted = () => io.signal?.aborted === true
      const blendCall: PipelineCall = { key: 'blend', provider: p.provider, endpoint: p.endpoint, payload: p.payload, media: 'image', usd: p.usd.blend }
      const blend = await io.call(blendCall)
      const url = blend.urls[0]
      if (!url) {
        await io.undelivered?.('blend', 'no-file')
        throw new Error(BLEND_NO_ANSWER)
      }
      const answerFile = await io.savedOnce('blend', 'answer', async () => io.keep((await io.download(url)).bytes, 'bin'))
      const answer = await io.read(answerFile)

      /** Steps 2 and 3: the answer with the model's copy filled, or null to lay the original on the answer as it is. */
      const cleaned = async (): Promise<Uint8Array | null> => {
        const rgb = await answerRgbPng(answer)
        const meta = await sharp(rgb).metadata()
        const w = meta.width!
        const h = meta.height!
        const answerUrl = await io.handOff(rgb, 'blend_answer.png')
        // 2. The answer's subject.
        let cutBytes: Uint8Array
        try {
          const cut = await io.call({ key: 'cutout', provider: 'replicate', endpoint: BG_REMOVE_SLUG, payload: bgRemoveInput(answerUrl), media: 'image', usd: p.usd.cutout })
          const cutUrl = firstOutputUrl(cut.result)[0]
          if (!cutUrl) {
            await io.undelivered?.('cutout', 'no-file')
            onOutcome?.('cutout-lost')
            return null
          }
          const kept = await io.savedOnce('cutout', 'answer', async () => io.keep((await io.download(cutUrl)).bytes, 'bin'))
          cutBytes = await io.read(kept)
        }
        catch (e) {
          if (aborted()) throw e
          onOutcome?.('cutout-lost')
          return null
        }
        // The fill's mask: the model's copy (the parts of the answer's subject near the kept region) and the kept region.
        let mask: Uint8Array
        try {
          const raw = await pilRaw(cutBytes)
          const alpha = await pixelsInWorker(io.signal, worker => worker.splitMask(raw, 1), CLEAN_TIMEOUT)
          const m = await readMaskPng(await p.keep.maskBytes())
          const got = await pixelsInWorker(io.signal, worker => worker.keepClean({
            alpha, aw: raw.width, ah: raw.height, mask16: m.scanlines, mw: m.w, mh: m.h, w, h,
          }), CLEAN_TIMEOUT)
          if ('skip' in got) {
            onOutcome?.(got.skip === 'empty' ? 'nothing-to-fill' : 'whole-scene')
            return null
          }
          mask = got.mask
        }
        catch (e) {
          if (aborted()) throw e
          // A cut-out Sailor couldn't read: delivered but unusable, so not charged.
          await io.undelivered?.('cutout', 'sailor-fault')
          onOutcome?.('cutout-lost')
          return null
        }
        // 3. The scene without the subject: the copy and the kept region filled from around them.
        try {
          const maskUrl = await io.handOff(await maskPng(mask, w, h), 'blend_fill_mask.png')
          const fill = await io.call({ key: 'fill', provider: 'replicate', endpoint: OBJECT_REMOVE_SLUG, payload: fillInput(answerUrl, maskUrl), media: 'image', usd: p.usd.fill })
          const fillUrl = firstOutputUrl(fill.result)[0]
          if (!fillUrl) {
            await io.undelivered?.('fill', 'no-file')
            onOutcome?.('fill-lost')
            return null
          }
          const kept = await io.savedOnce('fill', 'answer', async () => io.keep((await io.download(fillUrl)).bytes, 'bin'))
          const filled = await io.read(kept)
          onOutcome?.('cleaned')
          return filled
        }
        catch (e) {
          if (aborted()) throw e
          onOutcome?.('fill-lost')
          return null
        }
      }

      const edited = (await cleaned()) ?? answer
      // The original laid on top, exactly as before (Python's keep step), on the cleaned scene.
      const png = await p.keep.apply(edited, io.signal)
      const file = await io.saveAsset(png, { prefix: 'blend_scene', ext: 'png' })
      return { values: { 0: { kind: 'files', files: [file] } }, ui: { images: [file], animated: [false] } }
    },
  }
}
