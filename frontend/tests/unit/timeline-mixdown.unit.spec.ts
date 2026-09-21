import { describe, it, expect } from 'vitest'
import {
  voiceFor, voiceBufferWindow, planMixdown, mixSourceKey, encodeWav16,
} from '../../app/lib/engine/audio/mixdown'
import { createDefaultEditState } from '../../shared/timeline/types'
import type { AudioClip, EditState } from '../../shared/timeline/types'

// 30 fps. Clip on the timeline [1s, 3s), reading the file from 2s.
const base = { id: 'a', start_frame: 30, length: 60, in_frame: 60 }

describe('voiceFor', () => {
  it('plain clip from position 0', () => {
    const v = voiceFor(base, 0, 30)!
    expect(v.startSec).toBeCloseTo(1, 10)
    expect(v.clipStartSec).toBeCloseTo(1, 10)
    expect(v.durationSec).toBeCloseTo(2, 10)
    expect(v.sourceStartSec).toBeCloseTo(2, 10)
    expect(v.sourceSpanSec).toBeCloseTo(2, 10)
    expect(v.playbackRate).toBe(1)
    expect(v.reverse).toBe(false)
  })

  it('speed 2 reads twice as much of the file in the same timeline time', () => {
    const v = voiceFor({ ...base, speed: 2 }, 0, 30)!
    expect(v.durationSec).toBeCloseTo(2, 10)
    expect(v.sourceSpanSec).toBeCloseTo(4, 10)
    expect(v.playbackRate).toBe(2)
  })

  it('starting mid-clip at speed 2 skips twice as far into the file', () => {
    const v = voiceFor({ ...base, speed: 2 }, 2, 30)!   // 1s into the clip
    expect(v.startSec).toBeCloseTo(2, 10)
    expect(v.durationSec).toBeCloseTo(1, 10)
    expect(v.sourceStartSec).toBeCloseTo(4, 10)          // 2s + 1s * 2
    expect(v.sourceSpanSec).toBeCloseTo(2, 10)
  })

  it('reverse mid-clip keeps the START of the range and drops the end', () => {
    const v = voiceFor({ ...base, reverse: true }, 2, 30)!
    expect(v.sourceStartSec).toBeCloseTo(2, 10)
    expect(v.sourceSpanSec).toBeCloseTo(1, 10)
    expect(v.reverse).toBe(true)
  })

  it('returns null once the clip is over', () => {
    expect(voiceFor(base, 3, 30)).toBeNull()
  })

  it('speed is floored at 0.1', () => {
    expect(voiceFor({ ...base, speed: 0 }, 0, 30)!.playbackRate).toBe(0.1)
  })
})

describe('voiceBufferWindow', () => {
  const v = voiceFor(base, 0, 30)!   // wants file [2s, 4s)

  it('forward: offset is the source start', () => {
    expect(voiceBufferWindow(v, 10)).toEqual({ offsetSec: 2, spanSec: 2, delaySec: 0 })
  })

  it('forward: a short file just plays less', () => {
    expect(voiceBufferWindow(v, 3)).toEqual({ offsetSec: 2, spanSec: 1, delaySec: 0 })
  })

  it('reverse: offset is measured in the REVERSED file', () => {
    const r = voiceFor({ ...base, reverse: true }, 0, 30)!
    // Reversed 10s file: original [2,4) sits at [6,8).
    expect(voiceBufferWindow(r, 10)).toEqual({ offsetSec: 6, spanSec: 2, delaySec: 0 })
  })

  it('reverse with a short file: the missing part is silence FIRST', () => {
    const r = voiceFor({ ...base, reverse: true, speed: 2 }, 0, 30)!  // wants [2,6)
    // File is 5s: only [2,5) exists. 1s of file missing at speed 2 = 0.5s delay.
    expect(voiceBufferWindow(r, 5)).toEqual({ offsetSec: 0, spanSec: 3, delaySec: 0.5 })
  })
})

function stateWith(tracks: EditState['tracks']): EditState {
  const s = createDefaultEditState()
  s.tracks = tracks
  return s
}
const audio = (id: string, start: number, length: number, extra: Partial<AudioClip> = {}): AudioClip =>
  ({ id, kind: 'audio', asset_id: `asset-${id}`, start_frame: start, in_frame: 0, length, ...extra })

describe('planMixdown', () => {
  it('collects audio clips from every unmuted audio track', () => {
    const s = stateWith([
      { id: 't1', kind: 'audio', name: 'Audio 1', muted: false, locked: false, clips: [audio('a', 0, 30)] },
      { id: 't2', kind: 'audio', name: 'Audio 2', muted: false, locked: false, clips: [audio('b', 60, 30, { volume: 0.5 })] },
      { id: 't3', kind: 'audio', name: 'Audio 3', muted: true, locked: false, clips: [audio('c', 0, 30)] },
    ])
    const plan = planMixdown(s)
    expect(plan.voices.map(v => v.clipId)).toEqual(['a', 'b'])
    expect(plan.voices[1]!.startSec).toBeCloseTo(2, 10)
    expect(plan.voices[1]!.gainPoints[0]).toEqual([0, 0.5])
    expect(plan.totalSec).toBeCloseTo(3, 10)
    expect(plan.fps).toBe(30)
  })

  it('an explicit total_frames wins and drops voices that start after it', () => {
    const s = stateWith([
      { id: 't1', kind: 'audio', name: 'Audio 1', muted: false, locked: false, clips: [audio('a', 0, 30), audio('late', 90, 30)] },
    ])
    s.total_frames = 60
    const plan = planMixdown(s)
    expect(plan.totalSec).toBeCloseTo(2, 10)
    expect(plan.voices.map(v => v.clipId)).toEqual(['a'])
  })

  it('no audio clips → no voices', () => {
    expect(planMixdown(createDefaultEditState()).voices).toEqual([])
  })
})

describe('mixSourceKey', () => {
  it('changes when a volume changes, stable otherwise', () => {
    const mk = (volume: number) => planMixdown(stateWith([
      { id: 't1', kind: 'audio', name: 'Audio 1', muted: false, locked: false, clips: [audio('a', 0, 30, { volume })] },
    ]))
    expect(mixSourceKey(mk(1), ['u'])).toBe(mixSourceKey(mk(1), ['u']))
    expect(mixSourceKey(mk(1), ['u'])).not.toBe(mixSourceKey(mk(0.5), ['u']))
    expect(mixSourceKey(mk(1), ['u'])).not.toBe(mixSourceKey(mk(1), ['other']))
  })
})

describe('encodeWav16', () => {
  it('writes a valid 44-byte header and interleaved, clamped samples', () => {
    const left = new Float32Array([0, 1.5, -1.5])
    const right = new Float32Array([0.5, 0, 0])
    const buf = encodeWav16([left, right], 48000)
    const dv = new DataView(buf)
    const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))
    expect(buf.byteLength).toBe(44 + 3 * 2 * 2)
    expect(tag(0)).toBe('RIFF')
    expect(dv.getUint32(4, true)).toBe(36 + 12)
    expect(tag(8)).toBe('WAVE')
    expect(tag(12)).toBe('fmt ')
    expect(dv.getUint16(20, true)).toBe(1)        // PCM
    expect(dv.getUint16(22, true)).toBe(2)        // channels
    expect(dv.getUint32(24, true)).toBe(48000)
    expect(dv.getUint32(28, true)).toBe(48000 * 4) // byte rate
    expect(dv.getUint16(32, true)).toBe(4)        // block align
    expect(dv.getUint16(34, true)).toBe(16)
    expect(tag(36)).toBe('data')
    expect(dv.getUint32(40, true)).toBe(12)
    expect(dv.getInt16(44, true)).toBe(0)         // L0
    expect(dv.getInt16(46, true)).toBe(16384)     // R0 = round(0.5 * 32767)
    expect(dv.getInt16(48, true)).toBe(32767)     // L1 clamped
    expect(dv.getInt16(52, true)).toBe(-32768)    // L2 clamped
  })
})
