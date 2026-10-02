/**
 * R5.7's owed "hosted by hand" checks, run free against the engine kit in
 * hosted mode (fakes for the providers, the ledger and the ownership check;
 * Sailor's own built ffmpeg/ffprobe for the probes):
 *
 *  (1) an HLS playlist uploaded with a `.mp4` name is refused before the hold;
 *  (2) a 4097 × 4097 frame (past the hosted 4096 × 4096 frame cap) is refused
 *      before the hold;
 *  (3) another account's file is refused (ownership) before the hold.
 *
 * Each take also carries a paid node (Person swap (video) on fal Pixverse
 * Swap, a good clip) so a refusal "before the hold" is a real claim: the
 * control take, with the same paid node and a good file, IS held.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { NOT_YOURS } from '~~/server/runner/inputs'
import { PERSON_SWAP_RULE } from '~~/server/runner/personSwapMedia'
import type { OutputFile } from '~~/server/runner/types'
import { makeKit } from './__runner__/kit'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'

const LONG = { timeout: 120_000 }
const FAMILIES: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'person-swap-video'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const GOOD_CLIP = 'v_stereo_aac.mp4'
const HLS = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n'

const PERSON_PNG = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer()

const view = (name: string) => `/view?filename=${name}&type=input`
const loadVideo = (file: string) => ({ class_type: 'LoadVideo', inputs: { file } })
const saveVideo = (src: string) => ({ class_type: 'SaveVideo', inputs: { video: [src, 0], filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })
/** The paid node: Person swap (video) on a clip, the person from an Image card. */
const swap = (clip: string): ApiPrompt => ({
  p: { class_type: 'Image', inputs: { image: 'person.png' } },
  s: { class_type: 'PersonSwapVideo', inputs: { image: ['p', 0], video_url: view(clip), resolution: '360p' } },
})

/** A one-frame FFV1 MOV of `side` × `side` grey, made by Sailor's own ffmpeg (no lavfi in the build: raw grey on stdin). */
async function squareVideo(path: string, side: number): Promise<void> {
  const tools = await requireMediaTools()
  const r = spawnSync(tools.ffmpeg, [
    '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${side}x${side}`, '-r', '25', '-i', 'pipe:0',
    '-frames:v', '1', '-c:v', 'ffv1', path,
  ], { input: Buffer.alloc(side * side, 128), maxBuffer: 1 << 20 })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString()}`)
}

function hostedKit(o: { notYours?: string[] } = {}) {
  const k = makeKit({
    hosted: true,
    deps: {
      families: () => FAMILIES,
      ...(o.notYours
        ? { ownership: { ownsInput: async (_u: string, f: OutputFile) => !o.notYours!.includes(f.filename), ownsOutput: async () => true } }
        : {}),
    },
  })
  copyFileSync(clipPath(GOOD_CLIP), join(k.root, 'input', GOOD_CLIP))
  writeFileSync(join(k.root, 'input', 'person.png'), PERSON_PNG)
  return k
}

const refusal = (k: ReturnType<typeof makeKit>, take: ApiPrompt) =>
  k.engine.startRun({ userId: k.userId, takes: [take], ...START }).then(() => null, (e: unknown) => e as Error)

/** Nothing held, nothing sent, nothing handed off. */
function nothingSpent(k: ReturnType<typeof makeKit>) {
  expect(k.ledger.hold).not.toHaveBeenCalled()
  expect(k.ledger.holds.size).toBe(0)
  expect(k.fal.reqs.size).toBe(0)
  expect(k.upload).not.toHaveBeenCalled()
}

describe('hosted by hand (R5.7), with fakes', () => {
  it('control: the paid node with a good clip, beside a good Load video → Save video, is held (so "before the hold" below means something)', LONG, async () => {
    await requireMediaTools()
    const k = hostedKit()
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ ...swap(GOOD_CLIP), l: loadVideo(GOOD_CLIP), v: saveVideo('l') }], ...START })
    expect(runId).toBeTruthy()
    expect(k.ledger.hold).toHaveBeenCalled()
    await k.engine.settled(runId)
  })

  describe('(1) an HLS playlist uploaded with a .mp4 name', () => {
    it('as Load video’s file: refused before the hold, in plain words, with a paid node in the same take', LONG, async () => {
      await requireMediaTools()
      const k = hostedKit()
      writeFileSync(join(k.root, 'input', 'playlist.mp4'), HLS)
      const err = await refusal(k, { ...swap(GOOD_CLIP), l: loadVideo('playlist.mp4'), v: saveVideo('l') })
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain(MEDIA_WORDS.unreadable)
      nothingSpent(k)
    })

    it('as Person swap (video)’s video: refused as the wrong format before the hold (never handed to fal)', LONG, async () => {
      const k = hostedKit()
      writeFileSync(join(k.root, 'input', 'playlist.mp4'), HLS)
      const err = await refusal(k, swap('playlist.mp4'))
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain(PERSON_SWAP_RULE.words.wrongFormat)
      nothingSpent(k)
    })
  })

  describe('(2) a 4097 × 4097 frame (the hosted side cap)', () => {
    it('the hosted cap is 4096 × 4096 pixels a frame', () => {
      expect(MEDIA_CAPS.hosted.framePixels).toBe(4096 * 4096)
    })

    it('as Load video’s file: refused from its header before the hold; the same file at 4096 × 4096 passes the start', LONG, async () => {
      const k = hostedKit()
      await squareVideo(join(k.root, 'input', 'big4097.mov'), 4097)
      const err = await refusal(k, { ...swap(GOOD_CLIP), l: loadVideo('big4097.mov'), v: saveVideo('l') })
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain(MEDIA_WORDS.tooBig)
      nothingSpent(k)

      // The boundary: 4096 × 4096 is not refused at the start (it is held, then runs).
      const ok = hostedKit()
      await squareVideo(join(ok.root, 'input', 'ok4096.mov'), 4096)
      const { runId } = await ok.engine.startRun({ userId: ok.userId, takes: [{ ...swap(GOOD_CLIP), l: loadVideo('ok4096.mov'), v: saveVideo('l') }], ...START })
      expect(ok.ledger.hold).toHaveBeenCalled()
      await ok.engine.settled(runId)
    })
  })

  describe('(3) another account’s file', () => {
    it('as Load video’s file: refused (not yours) before the hold', async () => {
      const k = hostedKit({ notYours: ['theirs.mp4'] })
      copyFileSync(clipPath(GOOD_CLIP), join(k.root, 'input', 'theirs.mp4'))
      const err = await refusal(k, { ...swap(GOOD_CLIP), l: loadVideo('theirs.mp4'), v: saveVideo('l') })
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain(NOT_YOURS)
      nothingSpent(k)
    })

    it('as Person swap (video)’s video: refused (not yours) before the hold', async () => {
      const k = hostedKit({ notYours: ['theirs.mp4'] })
      copyFileSync(clipPath(GOOD_CLIP), join(k.root, 'input', 'theirs.mp4'))
      const err = await refusal(k, swap('theirs.mp4'))
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain(NOT_YOURS)
      nothingSpent(k)
    })
  })
})
