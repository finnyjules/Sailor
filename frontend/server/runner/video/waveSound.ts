/**
 * Audio waveform's sound (step 3, R6.7; nodes_video_pro.py:696-725): the
 * file its `audio_file` names, read the way Python reads it where that
 * matters to the picture, and streamed to the frames.
 *
 *   - No file named ('(no audio found)' or blank), a file that isn't there,
 *     one with no sound in it, or one the build can't read: Python draws
 *     silence, and so does the runner (`silent`: no window reaches a frame).
 *   - The first sound stream, at its own rate, its channels MIXED to one
 *     (their mean) as the decode streams: the user's matching rule fixes
 *     Python's squeezed stereo (a packed stereo file drawn as one track of
 *     interleaved samples). Python's divide-by-the-peak for integer samples
 *     doesn't change the picture (every frame's bands are divided by their
 *     own peak), so the decoder's own float scale is kept.
 *   - Frame f reads samples [f·spf, (f + 1)·spf), spf = max(1, int(rate /
 *     fps)): one decode under the node's lease, paused while the frames are
 *     made (back-pressure), so memory holds one window, never the sound; it
 *     ends as soon as the frames have what they need.
 *
 * Left to the engine before the run (never a failure at the node's turn,
 * start.ts waveformStartProblems): a name outside the input folders (local;
 * hosted refuses it by name, inputs.ts unsafeWaveformNames), a file over the
 * size cap, and a rate over WAVE_MAX_RATE (the work figure's bound).
 */
import { MediaError, inputArgs, runMedia, type MediaLease } from '../../media/run'
import { probeMedia, type MediaProbe } from '../../media/probe'
import type { SoundReadIO } from '../../media/values'
import { pythonInputRef } from '../inputs'
import type { OutputFile } from '../types'

/** The highest sample rate the runner draws (the work figure's bound: its FFT at fps 1). */
export const WAVE_MAX_RATE = 384_000

/** The file an Audio waveform names, as Python opens it (`get_annotated_filepath`), or null when it names none. */
export function waveFileOf(name: unknown): { file: OutputFile } | { outside: true } | null {
  if (typeof name !== 'string' || !name || name === '(no audio found)') return null
  return pythonInputRef(name)
}

export type WaveSound =
  | { kind: 'silent' }
  | { kind: 'sound'; probe: MediaProbe; rate: number; channels: number }
  | { kind: 'engine'; why: 'outside' | 'tooBig' | 'rate' }

/**
 * What the file gives the waveform: silence, its sound's first stream, or a
 * case the runner leaves to the engine. Stop (and the tools missing) fail as
 * they are; any other failure to read it is Python's silence.
 */
export async function waveSoundOf(name: unknown, io: SoundReadIO): Promise<WaveSound> {
  const ref = waveFileOf(name)
  if (!ref) return { kind: 'silent' }
  if ('outside' in ref) return { kind: 'engine', why: 'outside' }
  if (!(await io.access.exists(ref.file))) return { kind: 'silent' }
  let p: MediaProbe
  try {
    const path = await io.access.verifiedPath(ref.file)
    p = await probeMedia(path, { userId: io.userId, signal: io.signal, roots: [io.access.rootOf(ref.file)], kind: 'sound', anyLength: true })
  }
  catch (e) {
    if (io.signal?.aborted) throw new MediaError('stopped')
    if (e instanceof MediaError && (e.word === 'toolsMissing' || e.word === 'stopped')) throw e
    if (e instanceof MediaError && (e.word === 'tooBig' || e.word === 'tooLong')) return { kind: 'engine', why: 'tooBig' }
    return { kind: 'silent' }
  }
  const s = p.sound[0]
  if (!s || !(s.channels >= 1)) return { kind: 'silent' }
  // Python: `a_stream.sample_rate or 48000`.
  const rate = s.rate || 48000
  if (rate > WAVE_MAX_RATE) return { kind: 'engine', why: 'rate' }
  return { kind: 'sound', probe: p, rate, channels: s.channels }
}

/** Python's samples_per_frame (:715). */
export const waveSamplesPerFrame = (rate: number, fps: number) => Math.max(1, Math.trunc(rate / Math.max(1, fps)))

/**
 * The sound's windows of `spf` samples, mixed to one channel, in order: the
 * last one short where the sound ends. One decode job under the lease;
 * leaving the loop early ends it.
 */
export function waveWindows(s: Extract<WaveSound, { kind: 'sound' }>, spf: number, io: SoundReadIO, lease: MediaLease): AsyncIterable<Float32Array> {
  return {
    async* [Symbol.asyncIterator]() {
      const C = s.channels
      const queue: Float32Array[] = []
      let wake: (() => void) | null = null
      let taken: (() => void) | null = null
      let done = false
      let failed: { e: unknown } | null = null
      const stop = new AbortController()
      const signal = io.signal ? AbortSignal.any([io.signal, stop.signal]) : stop.signal
      const nudge = () => { const w = wake; wake = null; w?.() }
      const put = async (w: Float32Array) => {
        queue.push(w)
        nudge()
        while (queue.length && !signal.aborted) await new Promise<void>((r) => { taken = r })
        if (signal.aborted) throw new MediaError('stopped')
      }
      let win = new Float32Array(spf)
      let fill = 0
      let c = 0
      let acc = 0
      let carry = new Uint8Array(0)
      const job = runMedia({
        tool: 'ffmpeg',
        args: [...inputArgs(s.probe.path, s.probe.format), '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
        userId: io.userId, signal, lease,
        onStdout: async (chunk) => {
          let bytes = chunk
          if (carry.length) {
            const joined = new Uint8Array(carry.length + chunk.length)
            joined.set(carry)
            joined.set(chunk, carry.length)
            bytes = joined
          }
          const whole = bytes.length - (bytes.length % 4)
          carry = bytes.slice(whole)
          if (!whole) return
          const floats = new Float32Array(whole / 4)
          new Uint8Array(floats.buffer).set(bytes.subarray(0, whole))
          for (let j = 0; j < floats.length; j++) {
            // The channels' mean, in float32 (as numpy's mean of a planar float32 frame).
            acc = c === 0 ? floats[j]! : Math.fround(acc + floats[j]!)
            if (++c < C) continue
            c = 0
            win[fill++] = Math.fround(acc / C)
            if (fill === spf) {
              const full = win
              win = new Float32Array(spf)
              fill = 0
              await put(full)
            }
          }
        },
      }).then(async () => {
        if (fill > 0) queue.push(win.slice(0, fill))
        done = true
        nudge()
      }, (e: unknown) => {
        failed = { e }
        nudge()
      })
      let finished = false
      try {
        for (;;) {
          if (queue.length) {
            const w = queue.shift()!
            const t = taken as (() => void) | null
            taken = null
            t?.()
            yield w
            continue
          }
          if (failed) throw (failed as { e: unknown }).e
          if (done) { finished = true; return }
          await new Promise<void>((r) => { wake = r })
        }
      }
      finally {
        if (!finished) {
          // Left early (the frames have what they need, a failure, Stop): the decode is ended here.
          stop.abort()
          const t = taken as (() => void) | null
          taken = null
          t?.()
          await job
        }
      }
    },
  }
}

/** The most samples a window can hold (the work and memory figures' bound). */
export const waveMaxWindow = (fps: number) => waveSamplesPerFrame(WAVE_MAX_RATE, fps)
