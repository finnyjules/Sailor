# Timeline Editing Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the multi-track timeline export every audio clip correctly, and make editing behave like a real editor: groups snap and resize together, clips stop landing on top of each other, and a ripple switch closes or opens gaps when you trim or delete.

**Architecture:** Every new behaviour is a small pure TypeScript module with its own unit tests, wired into `TimelineEditor.vue` with thin glue. The audio mix follows the existing "bake in the browser, hand the server a file" pattern used by Motion and Space Type clips, so the Python exporter does not change. Ideas are borrowed from `opencut-classic` (MIT) and re-derived with tests; no OpenCut code is copied verbatim.

**Tech Stack:** Vue 3 + TypeScript (Nuxt 4), Vitest (`tests/unit/**/*.unit.spec.ts`), Web Audio (`OfflineAudioContext`), existing ComfyUI `/upload/image` route and `/sailor/render_timeline_stream` exporter.

## Plain-language summary

What is wrong today:

- Exported videos only contain the **first** audio clip. It always starts at the beginning, at full volume, with no fades. Everything else on the audio tracks is dropped.
- In the preview, a sped-up or reversed audio clip still plays at normal speed, forwards.
- Dragging several clips at once only snaps the clip under the mouse, and it can snap to the other clips that are moving with it.
- You can only trim one clip at a time.
- Clips can be dropped or trimmed on top of other clips on the same track.
- "Ripple" only exists for deleting one clip.

What changes:

1. **Export audio.** Before export, the browser mixes all audio clips (every track, with their position, volume, fades, speed and reverse) into one sound file, uploads it, and the server adds it to the video. It uses the same maths as the preview, so what you hear is what you get.
2. **Preview audio** honours speed and reverse.
3. **Group snap.** When moving a selection, any edge of any selected clip can snap, and the selection never snaps to itself.
4. **Group trim.** Trimming one selected clip trims the whole selection by the same amount. The amount is limited once, by the tightest clip.
5. **No more accidental overlaps.** A trim stops at the neighbouring clip. A moved clip that lands on another clip hops to the nearest free track of the same kind, or gets a new track.
6. **Ripple switch** in the toolbar. When on, trimming or deleting shifts the later clips on that track so no gap (or overlap) is left.

What is risky / what you will notice:

- Sped-up audio will now change pitch (like a tape), in both preview and export. Today's export keeps the pitch for the single clip it handles. Keeping pitch needs a time-stretch library; it is listed under "Later".
- Very long timelines (over 30 minutes) skip the mix and export the old way, with a visible notice.
- With ripple on, the shift happens when you release the mouse, not live during the drag.
- Trims now stop at the neighbour. If someone relied on overlapping clips on one track, they need a second track (which is what the move behaviour now does for them).

Not in this plan (see "Later" at the end): browser-side export, captions/SRT import, markers, export to Premiere/Resolve.

## Global Constraints

- Work directly in the main checkout at `/Users/julien/Documents/GitHub/Sailor`. No worktree, no feature branch.
- **Never run `npm run dev`** or start any server. A dev server for this checkout runs on `127.0.0.1:3002`; ComfyUI on `127.0.0.1:8188`. Use `127.0.0.1`, not `localhost`.
- **Subagents do not commit.** They implement, run tests, and report changed paths plus test output. The controller commits with the private-index recipe below.
- Never `git stash`. Never touch files you did not write, even if they look broken.
- Unit test command (run from `frontend/`): `npx vitest run tests/unit/<file>` — run the named spec alone; full-suite counts are unreliable under load.
- Typecheck is judged against the existing baseline: only errors in files this plan touches count.
- UI copy is sentence case, plain words, no internal identifiers.
- Frames are integers everywhere in `EditState`. Every new function must return integer frames.
- Do not change `comfy_extras/nodes_timeline.py` in this plan.
- When borrowing an idea from OpenCut, add a one-line comment naming it: `// Idea from opencut-classic (MIT): <what>`.
- After every commit the controller updates the "Sailor — State of the Build" dashboard artifact and `docs/STATE.md` (replace, do not append).

**Controller commit recipe (one Bash call for the commit, a second separate Bash call for the resync):**

```bash
cd /Users/julien/Documents/GitHub/Sailor && IDX=$(mktemp -u) && export GIT_INDEX_FILE="$IDX" && git read-tree HEAD && git add -- <exact paths> && git diff --cached --name-only && git commit -q -m "<message>" && rm -f "$IDX"
```

```bash
cd /Users/julien/Documents/GitHub/Sailor && git reset -q -- <the same exact paths> && git status --short -- <the same exact paths>
```

Expected after the second call: no output for those paths.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/app/lib/engine/audio/mixdown.ts` (new) | Pure: turn audio clips into "voices", work out which part of the sound file each voice plays, encode WAV. Browser-only: render the mix offline, upload it. |
| `frontend/app/lib/engine/audio/audioEngine.ts` (modify) | Preview playback uses the same voices, so speed and reverse are honoured. |
| `frontend/shared/timeline/groupEdit.ts` (new) | Pure: group snap, group trim with one shared limit. |
| `frontend/shared/timeline/placement.ts` (new) | Pure: does a track have room, where should clips go, move them there. |
| `frontend/shared/timeline/ripple.ts` (new) | Pure: compare before/after, work out shifts, apply them. |
| `frontend/app/composables/useTimelineStore.ts` (modify) | Expose the gesture's "before" snapshot. |
| `frontend/app/components/vue-canvas/TimelineEditor.vue` (modify) | Glue: export hook, drag/trim/release handlers, ripple switch, delete. |
| `frontend/tests/unit/timeline-mixdown.unit.spec.ts`, `timeline-group-edit.unit.spec.ts`, `timeline-placement.unit.spec.ts`, `timeline-ripple.unit.spec.ts` (new) | Unit tests. |

---

### Task 1: Audio voices and WAV encoder (pure)

**Files:**
- Create: `frontend/app/lib/engine/audio/mixdown.ts`
- Test: `frontend/tests/unit/timeline-mixdown.unit.spec.ts`

**Interfaces:**
- Consumes: `audioScheduleFor(clip, positionSec, fps)` and `AudioClipLike` from `frontend/app/lib/engine/audio/audioEngine.ts`; `EditState`, `Clip`, `computeTotalFrames` from `frontend/shared/timeline/types.ts`.
- Produces:
  - `interface MixVoice { clipId: string; clipStartSec: number; startSec: number; durationSec: number; sourceStartSec: number; sourceSpanSec: number; playbackRate: number; reverse: boolean; gainPoints: [number, number][] }`
  - `voiceFor(clip: VoiceClip, positionSec: number, fps: number): MixVoice | null`
  - `voiceBufferWindow(v: MixVoice, bufferDurationSec: number): { offsetSec: number; spanSec: number; delaySec: number }`
  - `interface MixPlan { voices: MixVoice[]; totalSec: number; fps: number }`
  - `planMixdown(state: EditState): MixPlan`
  - `mixSourceKey(plan: MixPlan, urls: string[]): string`
  - `encodeWav16(channels: Float32Array[], sampleRate: number): ArrayBuffer`
  - constants `MIX_SAMPLE_RATE = 48000`, `MAX_MIX_SEC = 1800`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/timeline-mixdown.unit.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npx vitest run tests/unit/timeline-mixdown.unit.spec.ts`
Expected: FAIL — cannot resolve `../../app/lib/engine/audio/mixdown`.

- [ ] **Step 3: Write the implementation**

Create `frontend/app/lib/engine/audio/mixdown.ts`:

```ts
import type { EditState } from '~~/shared/timeline/types'
import { computeTotalFrames } from '~~/shared/timeline/types'
import { audioScheduleFor, type AudioClipLike } from './audioEngine'

// One mixed sound file for the whole timeline, built in the browser before
// export — the same pattern as the Motion / Space Type bakes: the server can't
// reproduce the preview, so the browser renders it and hands over a file.
// Preview (AudioEngine.play) and export (renderMixdown) both go through
// voiceFor + voiceBufferWindow, so what you hear is what you export.

export const MIX_SAMPLE_RATE = 48000
/** Past this the mix is skipped (memory + upload size); export falls back to
 *  the server's single-clip audio with a visible notice. */
export const MAX_MIX_SEC = 1800

export interface VoiceClip extends AudioClipLike {
  id: string
  speed?: number
  reverse?: boolean
}

export interface MixVoice {
  clipId: string
  /** Timeline second the CLIP starts at — gainPoints are relative to this. */
  clipStartSec: number
  /** Timeline second the VOICE starts at (later than clipStartSec mid-clip). */
  startSec: number
  /** Timeline seconds the voice lasts. */
  durationSec: number
  /** Where in the (forward) file the wanted range starts, and how much file it spans. */
  sourceStartSec: number
  sourceSpanSec: number
  playbackRate: number
  reverse: boolean
  gainPoints: [number, number][]
}

export function voiceFor(clip: VoiceClip, positionSec: number, fps: number): MixVoice | null {
  const s = audioScheduleFor(clip, positionSec, fps)
  if (!s) return null
  const rate = Math.max(0.1, clip.speed ?? 1)
  const clipStartSec = clip.start_frame / fps
  const intoClip = Math.max(0, positionSec - clipStartSec)
  const fileStart = (clip.in_frame ?? 0) / fps
  const reverse = !!clip.reverse
  return {
    clipId: clip.id,
    clipStartSec,
    startSec: positionSec + s.startInSec,
    durationSec: s.durationSec,
    // Forward: skip what already played. Reverse: the END of the range already
    // played, so the start stays put and the span shrinks.
    sourceStartSec: reverse ? fileStart : fileStart + intoClip * rate,
    sourceSpanSec: s.durationSec * rate,
    playbackRate: rate,
    reverse,
    gainPoints: s.gainPoints,
  }
}

/** Which part of the decoded buffer to play. For reverse voices the caller
 *  plays a REVERSED copy of the file, so the offset is measured in that copy.
 *  When the file is shorter than the clip asks for, a reversed clip is silent
 *  FIRST (the missing part would have played first) — that is `delaySec`. */
export function voiceBufferWindow(v: MixVoice, bufferDurationSec: number): { offsetSec: number; spanSec: number; delaySec: number } {
  const wantedEnd = v.sourceStartSec + v.sourceSpanSec
  const a = Math.min(v.sourceStartSec, bufferDurationSec)
  const b = Math.min(wantedEnd, bufferDurationSec)
  const spanSec = Math.max(0, b - a)
  if (!v.reverse) return { offsetSec: a, spanSec, delaySec: 0 }
  return { offsetSec: bufferDurationSec - b, spanSec, delaySec: (wantedEnd - b) / v.playbackRate }
}

export interface MixPlan { voices: MixVoice[]; totalSec: number; fps: number }

export function planMixdown(state: EditState): MixPlan {
  const fps = state.canvas.fps
  const totalSec = computeTotalFrames(state) / fps
  const voices: MixVoice[] = []
  for (const track of state.tracks) {
    if (track.muted || track.kind !== 'audio') continue
    for (const clip of track.clips) {
      if (clip.kind !== 'audio') continue
      const v = voiceFor(clip, 0, fps)
      if (v && v.startSec < totalSec) voices.push(v)
    }
  }
  return { voices, totalSec, fps }
}

/** FNV-1a over everything that changes the mixed sound. */
export function mixSourceKey(plan: MixPlan, urls: string[]): string {
  const s = JSON.stringify({ plan, urls })
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 16-bit PCM WAV, channels interleaved, samples clamped to [-1, 1]. */
export function encodeWav16(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const nCh = channels.length
  const nFrames = channels[0]?.length ?? 0
  const dataBytes = nFrames * nCh * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const dv = new DataView(buf)
  const tag = (o: number, t: string) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, t.charCodeAt(i)) }
  tag(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); tag(8, 'WAVE')
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nCh * 2, true)
  dv.setUint16(32, nCh * 2, true); dv.setUint16(34, 16, true)
  tag(36, 'data'); dv.setUint32(40, dataBytes, true)
  let o = 44
  for (let i = 0; i < nFrames; i++) {
    for (let c = 0; c < nCh; c++) {
      const x = Math.max(-1, Math.min(1, channels[c]![i]!))
      dv.setInt16(o, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true)
      o += 2
    }
  }
  return buf
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/timeline-mixdown.unit.spec.ts tests/unit/audio-schedule.unit.spec.ts`
Expected: PASS, both files (the existing schedule spec must stay green — `audioEngine.ts` is untouched so far).

- [ ] **Step 5: Commit (controller)**

Paths: `frontend/app/lib/engine/audio/mixdown.ts`, `frontend/tests/unit/timeline-mixdown.unit.spec.ts`
Message: `feat(timeline): audio voices + WAV encoder — the shared maths for preview and export sound`

---

### Task 2: Preview audio honours speed and reverse

**Files:**
- Modify: `frontend/app/lib/engine/audio/mixdown.ts` (add `reverseAudioBuffer`)
- Modify: `frontend/app/lib/engine/audio/audioEngine.ts:119-152` (`play`), `:76` and `:154-172` (reversed-buffer cache)

**Interfaces:**
- Consumes: `voiceFor`, `voiceBufferWindow`, `MixVoice` from Task 1.
- Produces: `reverseAudioBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer` in `mixdown.ts` (used again in Task 3).

Note the import direction: `mixdown.ts` imports `audioScheduleFor` from `audioEngine.ts`, and `audioEngine.ts` will now import from `mixdown.ts`. Both only use each other's exports inside function bodies (never at module top level), so the cycle is safe — do not add any top-level call across the two files.

- [ ] **Step 1: Add `reverseAudioBuffer` to `mixdown.ts`** (append at the end of the file)

```ts
/** A reversed copy of a decoded file. Browser-only (needs a real AudioBuffer). */
export function reverseAudioBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i]!
  }
  return out
}
```

- [ ] **Step 2: Make `AudioEngine.play` use voices**

In `frontend/app/lib/engine/audio/audioEngine.ts`:

Add below the existing import on line 1:

```ts
import { voiceFor, voiceBufferWindow, reverseAudioBuffer } from './mixdown'
```

Add a field next to `private buffers` (line 76):

```ts
  private reversed = new Map<string, AudioBuffer>() // clip id → reversed copy, built on first use
```

In `load()`, directly after `this.buffers.clear()`, add:

```ts
    this.reversed.clear()
```

In `dispose()`, directly after `this.buffers.clear()`, add:

```ts
    this.reversed.clear()
```

Replace the whole body of the inner `for (const clip of track.clips)` loop in `play()` (from `if (clip.kind !== 'audio') continue` through `this.voices.push({ src, gain })`) with:

```ts
        if (clip.kind !== 'audio') continue
        const buf = this.buffers.get(clip.id)
        if (!buf) continue
        const v = voiceFor(clip, positionSec, this.fps)
        if (!v) continue
        const w = voiceBufferWindow(v, buf.duration)
        if (w.spanSec <= 0) continue

        let playBuf = buf
        if (v.reverse) {
          playBuf = this.reversed.get(clip.id) ?? reverseAudioBuffer(this.ctx, buf)
          this.reversed.set(clip.id, playBuf)
        }

        const src = this.ctx.createBufferSource()
        src.buffer = playBuf
        src.playbackRate.value = v.playbackRate
        const gain = this.ctx.createGain()
        src.connect(gain).connect(this.ctx.destination)

        // The clip's timeline start expressed in AudioContext time. When the
        // playhead is already inside the clip this lies in the past; only
        // anchors after the source start become ramps.
        const clipStartAbs = t0 + v.clipStartSec - positionSec
        const sourceStartAbs = t0 + (v.startSec - positionSec)
        gain.gain.setValueAtTime(gainAt(v.gainPoints, Math.max(0, positionSec - v.clipStartSec)), sourceStartAbs)
        for (const [t, g] of v.gainPoints) {
          const abs = clipStartAbs + t
          if (abs > sourceStartAbs) gain.gain.linearRampToValueAtTime(g, abs)
        }

        // offset and duration are in FILE seconds; playbackRate stretches them.
        src.start(sourceStartAbs + w.delaySec, w.offsetSec, w.spanSec)
        this.voices.push({ src, gain })
```

- [ ] **Step 3: Run the unit tests**

Run: `npx vitest run tests/unit/audio-schedule.unit.spec.ts tests/unit/timeline-mixdown.unit.spec.ts`
Expected: PASS (behaviour for speed 1 / forward is unchanged: `startSec - positionSec` equals the old `s.startInSec`, `w.offsetSec` equals the old `s.offsetSec`, `w.spanSec` equals the old `s.durationSec` whenever the file is long enough).

- [ ] **Step 4: Typecheck the two files**

Run (from `frontend/`): `npx vue-tsc --noEmit 2>&1 | grep -E "engine/audio/(audioEngine|mixdown)\.ts" ; echo "exit: done"`
Expected: no lines before `exit: done`.

- [ ] **Step 5: Browser check (controller, on the running `127.0.0.1:3002` app)**

Open a Timeline node's editor, put one audio clip on the audio track, set its speed to 2× in the clip settings, press play. Expected: it plays fast and higher-pitched and ends when the clip ends. Tick "reverse": it plays backwards. Set speed back to 1×, reverse off: it sounds exactly as before. Check the browser console for errors.

- [ ] **Step 6: Commit (controller)**

Paths: `frontend/app/lib/engine/audio/audioEngine.ts`, `frontend/app/lib/engine/audio/mixdown.ts`
Message: `fix(timeline): preview audio honours clip speed and reverse`

---

### Task 3: Mix all audio before export

**Files:**
- Modify: `frontend/app/lib/engine/audio/mixdown.ts` (add `renderMixdown`, `uploadMix`, `ensureTimelineMix`)
- Modify: `frontend/app/components/vue-canvas/TimelineEditor.vue` (`renderViaFFmpeg`, ~line 1070-1160; notice line in the template near line 1838)

**Interfaces:**
- Consumes: Task 1 exports; `reverseAudioBuffer` from Task 2; `resolveAudioUrl(clip: Clip): string | null` already in `TimelineEditor.vue:211`.
- Produces: `ensureTimelineMix(state: EditState, resolveClipUrl: (clip: Clip) => string | null): Promise<string | null>` — resolves to an `input/` filename, `null` when the timeline has no audio, and throws `Error('too long')`-style errors the caller turns into a notice.

How the server picks it up (no server change): `comfy_extras/nodes_timeline.py` `_adapt_edit_state` reads `state["audio_path"]` first and only falls back to "first audio clip" when it is empty; the route joins a relative `audio_path` onto the input directory; the muxer starts audio at 0 and clamps it to the video length. A pre-set `audio_path` also leaves `audio_speed` at 1.0, which is right because the mix already contains speed and reverse.

- [ ] **Step 1: Add the browser-side functions to `mixdown.ts`** (append; also add `Clip` to the type import at the top: `import type { EditState, Clip } from '~~/shared/timeline/types'`)

```ts
/** Render the plan offline. `buffers` maps clip id → decoded file. */
export async function renderMixdown(plan: MixPlan, buffers: Map<string, AudioBuffer>, ctx: OfflineAudioContext): Promise<Float32Array[]> {
  // No limiter node: Web Audio's DynamicsCompressor was measured during the
  // build and adds ~7% makeup gain to every mix. `fitPeak` (pure, unit-tested,
  // in this file) turns the whole mix down only when it would clip.
  for (const v of plan.voices) {
    const buf = buffers.get(v.clipId)
    if (!buf) continue
    const w = voiceBufferWindow(v, buf.duration)
    if (w.spanSec <= 0) continue
    const src = ctx.createBufferSource()
    src.buffer = v.reverse ? reverseAudioBuffer(ctx, buf) : buf
    src.playbackRate.value = v.playbackRate
    const gain = ctx.createGain()
    src.connect(gain).connect(ctx.destination)
    const [first, ...rest] = v.gainPoints
    gain.gain.setValueAtTime(first ? first[1] : 1, v.clipStartSec)
    for (const [t, g] of rest) gain.gain.linearRampToValueAtTime(g, v.clipStartSec + t)
    src.start(v.startSec + w.delaySec, w.offsetSec, w.spanSec)
  }
  const out = await ctx.startRendering()
  const channels = [out.getChannelData(0), out.getChannelData(1)]
  fitPeak(channels)   // fitPeak(channels, ceiling = 0.98): scales in place, returns the gain applied
  return channels
}

/** Same upload route the frame bakes use; ComfyUI writes any file type to input/. */
export async function uploadMix(wav: ArrayBuffer): Promise<string> {
  const fname = `timeline_mix_${Date.now()}.wav`
  const fd = new FormData()
  fd.append('image', new File([wav], fname, { type: 'audio/wav' }))
  fd.append('overwrite', 'true')
  const res = await fetch('/upload/image', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`mix upload failed (${res.status})`)
  const data = await res.json() as { name?: string; subfolder?: string }
  return data.subfolder ? `${data.subfolder}/${data.name}` : (data.name || fname)
}

const mixCache = new Map<string, string>()   // source key → uploaded filename (this session)

/** Mix every audio clip into one uploaded WAV. null = nothing to mix. */
export async function ensureTimelineMix(state: EditState, resolveClipUrl: (clip: Clip) => string | null): Promise<string | null> {
  const plan = planMixdown(state)
  if (!plan.voices.length) return null
  if (plan.totalSec > MAX_MIX_SEC) throw new Error('timeline is longer than 30 minutes')

  const clips = new Map<string, Clip>()
  for (const track of state.tracks) for (const clip of track.clips) clips.set(clip.id, clip)
  const urlByClip = new Map<string, string>()
  for (const v of plan.voices) {
    const url = resolveClipUrl(clips.get(v.clipId)!)
    if (!url) throw new Error('an audio clip has no file')
    urlByClip.set(v.clipId, url)
  }

  const key = mixSourceKey(plan, plan.voices.map(v => urlByClip.get(v.clipId)!))
  const cached = mixCache.get(key)
  if (cached) return cached

  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(plan.totalSec * MIX_SAMPLE_RATE)), MIX_SAMPLE_RATE)
  const byUrl = new Map<string, Promise<AudioBuffer>>()
  const buffers = new Map<string, AudioBuffer>()
  for (const [clipId, url] of urlByClip) {
    if (!byUrl.has(url)) {
      byUrl.set(url, fetch(url).then(r => {
        if (!r.ok) throw new Error(`audio fetch ${r.status}`)
        return r.arrayBuffer()
      }).then(b => ctx.decodeAudioData(b)))
    }
    buffers.set(clipId, await byUrl.get(url)!)
  }

  const channels = await renderMixdown(plan, buffers, ctx)
  const filename = await uploadMix(encodeWav16(channels, MIX_SAMPLE_RATE))
  mixCache.set(key, filename)
  return filename
}
```

- [ ] **Step 2: Confirm the upload route accepts a WAV (controller)**

This uploads one 48-byte silent file named `timeline_mix_probe.wav` into ComfyUI's input folder; it is harmless and can stay. Run:

```bash
python3 - <<'EOF'
import struct, urllib.request, uuid, json
wav = b'RIFF' + struct.pack('<I', 36 + 4) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, 48000, 96000, 2, 16) + b'data' + struct.pack('<I', 4) + b'\0\0\0\0'
b = uuid.uuid4().hex
body = (f'--{b}\r\nContent-Disposition: form-data; name="image"; filename="timeline_mix_probe.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode() + wav + (f'\r\n--{b}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{b}--\r\n').encode()
r = urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8188/upload/image', data=body, headers={'Content-Type': f'multipart/form-data; boundary={b}'}))
print(r.status, json.load(r))
EOF
```

Expected: `200 {'name': 'timeline_mix_probe.wav', 'subfolder': '', 'type': 'input'}`. If the route rejects `.wav`, STOP and report — the plan then needs a small dedicated upload route and that is a decision for Julien.

- [ ] **Step 3: Hook the mix into the export**

In `frontend/app/components/vue-canvas/TimelineEditor.vue`:

Add to the imports near line 22:

```ts
import { ensureTimelineMix } from '~/lib/engine/audio/mixdown'
```

Add next to `renderError` (near line 1062):

```ts
/** Something the export could not do, shown beside the result (not a failure). */
const renderNotice = ref<string | null>(null)
```

In `renderViaFFmpeg`, add `renderNotice.value = null` next to the existing `renderError.value = null` reset.

Directly BEFORE the line `renderPhase.value = 'rendering'` (near line 1130), add:

```ts
  // Mix every audio clip (all tracks, position, volume, fades, speed, reverse)
  // into one file in the browser — the same voices the preview plays — and hand
  // the server that. If it fails the export still runs, with the old
  // first-clip-only sound, and says so.
  let mixFile: string | null = null
  try {
    mixFile = await ensureTimelineMix(es, clip => resolveAudioUrl(clip))
  } catch (err: any) {
    console.warn('[timeline] audio mix failed', err)
    renderNotice.value = `Audio could not be mixed (${err?.message ?? err}), so this export only has the first audio clip.`
  }
```

Directly AFTER the `for (const track of payload.tracks) { … }` block that fills `clip.path` (ends near line 1160), add:

```ts
  if (mixFile) payload.audio_path = mixFile
```

In the template, directly after the `renderError` span (near line 1838), add:

```html
          <span v-if="renderNotice" class="text-xs text-white/50 truncate max-w-[280px]" :title="renderNotice">{{ renderNotice }}</span>
```

- [ ] **Step 4: Unit tests + typecheck**

Run: `npx vitest run tests/unit/timeline-mixdown.unit.spec.ts`
Expected: PASS.
Run: `npx vue-tsc --noEmit 2>&1 | grep -E "engine/audio/mixdown\.ts|vue-canvas/TimelineEditor\.vue" ; echo "exit: done"`
Expected: no NEW lines compared with the same command run before this task (record the before-count first; `TimelineEditor.vue` may have baseline errors).

- [ ] **Step 5: End-to-end proof (controller)**

In the running app: build a 6-second timeline with a video or image clip; audio track 1 has clip A at 0s; add a second audio track with clip B starting at 3s with a 1s fade-in and volume 50%. Export. Then measure the exported file:

```bash
cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python - <<'EOF'
import av, numpy as np, glob, os
path = max(glob.glob('output/timeline*.mp4'), key=os.path.getmtime)
c = av.open(path); a = c.streams.audio[0]
pcm = np.concatenate([f.to_ndarray().mean(axis=0) for f in c.decode(a)])
sr = a.rate
for t0 in (0.5, 2.5, 3.2, 4.5):
    w = pcm[int(t0*sr):int((t0+0.3)*sr)]
    print(f'{t0:>4}s rms={float(np.sqrt((w**2).mean())):.4f}')
print('duration', round(len(pcm)/sr, 2), 'file', path)
EOF
```

Expected: RMS at 3.2s is higher than at 2.5s but lower than at 4.5s (B fading in on top of A); duration ≈ 6s. Then mute track 2 and export again: 4.5s RMS drops back to the 2.5s level. Re-export without changes: the browser network panel shows NO second `timeline_mix_*.wav` upload (cache hit).

- [ ] **Step 6: Commit (controller)**

Paths: `frontend/app/lib/engine/audio/mixdown.ts`, `frontend/app/components/vue-canvas/TimelineEditor.vue`
Message: `fix(timeline): exports carry every audio clip — mixed in the browser with position, volume, fades, speed`

---

### Task 4: Group snap

**Files:**
- Create: `frontend/shared/timeline/groupEdit.ts`
- Test: `frontend/tests/unit/timeline-group-edit.unit.spec.ts`
- Modify: `frontend/app/components/vue-canvas/TimelineEditor.vue:577-607` (`buildSnapTargets`, `snapFrame`), `:771-813` (move branch), `:817`, `:827` (callers)

**Interfaces:**
- Produces:
  - `interface Span { start: number; end: number }` (end exclusive)
  - `snapGroupDelta(members: Span[], rawDelta: number, targets: number[], thresholdFrames: number): { delta: number; guideFrame: number | null }`
- Changes in the editor: `buildSnapTargets(exclude: ReadonlySet<string>)` and `snapFrame(rawFrame: number, exclude: ReadonlySet<string>)`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/timeline-group-edit.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { snapGroupDelta } from '../../shared/timeline/groupEdit'

describe('snapGroupDelta', () => {
  const members = [{ start: 100, end: 160 }, { start: 200, end: 230 }]

  it('no target in range: delta passes through', () => {
    expect(snapGroupDelta(members, 7, [500], 5)).toEqual({ delta: 7, guideFrame: null })
  })

  it('snaps on the dragged clip start', () => {
    // 100 + 8 = 108, target 110 is 2 away.
    expect(snapGroupDelta(members, 8, [110], 5)).toEqual({ delta: 10, guideFrame: 110 })
  })

  it('snaps on ANOTHER member end when that is closest', () => {
    // second member end 230 + 8 = 238; target 239 is 1 away; target 111 is 3 away from 108.
    expect(snapGroupDelta(members, 8, [111, 239], 5)).toEqual({ delta: 9, guideFrame: 239 })
  })

  it('threshold is strict', () => {
    expect(snapGroupDelta(members, 8, [113], 5)).toEqual({ delta: 8, guideFrame: null })
  })

  it('never pushes the earliest member below frame 0, and drops the guide', () => {
    expect(snapGroupDelta(members, -150, [], 5)).toEqual({ delta: -100, guideFrame: null })
  })

  it('a snap that would go below 0 is clamped too', () => {
    const m = [{ start: 3, end: 10 }, { start: 20, end: 30 }]
    // second end 30 - 5 = 25, target 21 → delta -9 → first start -6 → clamp to -3.
    expect(snapGroupDelta(m, -5, [21], 5)).toEqual({ delta: -3, guideFrame: null })
  })

  it('returns integer deltas for fractional input', () => {
    expect(snapGroupDelta(members, 7.6, [], 5).delta).toBe(8)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/timeline-group-edit.unit.spec.ts`
Expected: FAIL — cannot resolve `../../shared/timeline/groupEdit`.

- [ ] **Step 3: Write the implementation**

Create `frontend/shared/timeline/groupEdit.ts`:

```ts
// Moving and trimming several clips as one. Pure frame maths; the editor owns
// pointers and pixels.

/** A clip's place on the timeline. `end` is exclusive (start + length). */
export interface Span { start: number; end: number }

/** Snap a whole moving selection: EVERY member's start and end may snap, and
 *  the closest hit wins. Callers must leave the moving clips out of `targets`,
 *  or the selection snaps to itself.
 *  Idea from opencut-classic (MIT): group snap tests all member edges. */
export function snapGroupDelta(
  members: Span[], rawDelta: number, targets: number[], thresholdFrames: number,
): { delta: number; guideFrame: number | null } {
  const raw = Math.round(rawDelta)
  let delta = raw
  let guideFrame: number | null = null
  let bestDist = thresholdFrames
  for (const m of members) {
    for (const edge of [m.start, m.end]) {
      const moved = edge + raw
      for (const t of targets) {
        const d = Math.abs(t - moved)
        if (d < bestDist) { bestDist = d; delta = raw + (t - moved); guideFrame = t }
      }
    }
  }
  let minStart = Infinity
  for (const m of members) minStart = Math.min(minStart, m.start)
  if (members.length && minStart + delta < 0) { delta = -minStart; guideFrame = null }
  return { delta, guideFrame }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/timeline-group-edit.unit.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire it into the editor**

In `frontend/app/components/vue-canvas/TimelineEditor.vue`:

Add to the imports near line 22:

```ts
import { snapGroupDelta, type Span } from '~~/shared/timeline/groupEdit'
```

Replace `buildSnapTargets` and `snapFrame` (lines 577-607) with:

```ts
function buildSnapTargets(exclude: ReadonlySet<string>): number[] {
  const targets: number[] = [0, store.playheadFrame.value]
  for (const track of store.state.value.tracks) {
    for (const clip of track.clips) {
      if (exclude.has(clip.id)) continue
      targets.push(clip.start_frame)
      targets.push(clip.start_frame + clip.length)
    }
  }
  // Major ticks within the visible range — gives users a "stick to second" feel.
  const stepFrames = Math.max(1, Math.round(tickStepSec.value * store.fps.value))
  const { start, end } = visibleFrameRange.value
  const first = Math.floor(start / stepFrames) * stepFrames
  for (let f = first; f <= end; f += stepFrames) targets.push(f)
  return targets
}

function snapFrame(rawFrame: number, exclude: ReadonlySet<string>): number {
  const active = snapEnabled.value !== altHeld.value   // XOR: Alt inverts
  if (!active) { snapGuideFrame.value = null; return rawFrame }
  const targets = buildSnapTargets(exclude)
  const thresholdFrames = SNAP_PX / pxPerFrame.value
  let best = rawFrame
  let bestDist = thresholdFrames
  for (const t of targets) {
    const d = Math.abs(t - rawFrame)
    if (d < bestDist) { bestDist = d; best = t }
  }
  snapGuideFrame.value = best !== rawFrame ? best : null
  return best
}

/** The clips that move or trim together in the current drag. */
function draggingIds(): Set<string> {
  if (dragGroupStarts && dragGroupStarts.size > 1) return new Set(dragGroupStarts.keys())
  return new Set(drag.value ? [drag.value.clipId] : [])
}
```

Run `grep -n "snapFrame(\|buildSnapTargets(" app/components/vue-canvas/TimelineEditor.vue` and update EVERY remaining caller: a call that passed a clip id `x` now passes `new Set([x])`; a call that passed `null` now passes `new Set<string>()`. (The two resize callers at lines ~817 and ~827 are rewritten in Task 5; for this task change them to `snapFrame(rawEnd, draggingIds())` and `snapFrame(rawStart, draggingIds())`.)

Replace the first part of the move branch — from `const rawStart = Math.max(0, drag.value.startStart + dframes)` through the line `if (startDist >= SNAP_PX / pxPerFrame.value && endDist >= SNAP_PX / pxPerFrame.value) snapGuideFrame.value = null` (lines 772-781) — with:

```ts
    const moving = draggingIds()
    const members: Span[] = []
    for (const track of store.state.value.tracks) {
      for (const c of track.clips) {
        if (!moving.has(c.id)) continue
        const s0 = dragGroupStarts?.get(c.id) ?? drag.value.startStart
        members.push({ start: s0, end: s0 + c.length })
      }
    }
    const snapOn = snapEnabled.value !== altHeld.value   // XOR: Alt inverts
    const snapped = snapGroupDelta(members, dframes, snapOn ? buildSnapTargets(moving) : [], SNAP_PX / pxPerFrame.value)
    snapGuideFrame.value = snapped.guideFrame
    const finalStart = drag.value.startStart + snapped.delta
```

In the bulk-move block just below, replace these five lines:

```ts
      const realDelta = Math.max(0, finalStart) - drag.value.startStart
      // Don't let any clip go below 0.
      let minStart = Infinity
      for (const [, s] of dragGroupStarts) minStart = Math.min(minStart, s)
      const clampedDelta = Math.max(realDelta, -minStart)
```

with:

```ts
      const clampedDelta = snapped.delta   // already kept above frame 0 by snapGroupDelta
```

Leave the single-clip `else` branch as it is (it already uses `finalStart`).

- [ ] **Step 6: Tests, typecheck, browser check**

Run: `npx vitest run tests/unit/timeline-group-edit.unit.spec.ts tests/unit/timeline-gesture.unit.spec.ts`
Expected: PASS.
Run the typecheck grep for `TimelineEditor.vue` and `groupEdit.ts`; expected: no new lines.
Browser (controller): select two clips with a gap between them, drag them left toward a third clip. Expected: the guide line appears when the SECOND clip's edge meets the third clip; the pair never snaps to each other; dragging far left stops with the first clip at 0. Drag with real mouse input — synthetic pointer events prove nothing here.

- [ ] **Step 7: Commit (controller)**

Paths: `frontend/shared/timeline/groupEdit.ts`, `frontend/tests/unit/timeline-group-edit.unit.spec.ts`, `frontend/app/components/vue-canvas/TimelineEditor.vue`
Message: `feat(timeline): a moving selection snaps on any of its edges, never on itself`

---

### Task 5: Group trim, and trims stop at the neighbour

**Files:**
- Modify: `frontend/shared/timeline/groupEdit.ts`
- Modify: `frontend/tests/unit/timeline-group-edit.unit.spec.ts`
- Modify: `frontend/app/components/vue-canvas/TimelineEditor.vue` (`onClipPointerDown` ~650-683, the two resize branches ~814-832, `onPointerUp` ~863-868)

**Interfaces:**
- Consumes: `computeLeftTrim`, `TrimBase` from `frontend/shared/timeline/trim.ts`.
- Produces:
  - `interface ResizeMember { id: string; start_frame: number; in_frame: number; length: number; anchored: boolean; sourceFrames: number | null; speed: number; gapBefore: number | null; gapAfter: number | null }`
  - `neighbourGaps(clips: { id: string; start_frame: number; length: number }[], memberId: string, ignore: ReadonlySet<string>): { gapBefore: number | null; gapAfter: number | null }`
  - `computeGroupResize(members: ResizeMember[], edge: 'left' | 'right', rawDelta: number): { delta: number; patches: Map<string, TrimBase> }`

`gapBefore` / `gapAfter` are the free frames up to the nearest clip on the same track that is NOT part of the trim (`null` = nothing there / no limit). Task 8 passes `null` for both when ripple is on, because ripple moves the neighbours out of the way on release.

- [ ] **Step 1: Add the failing tests** (append to `timeline-group-edit.unit.spec.ts`; extend the import line to `import { snapGroupDelta, computeGroupResize, neighbourGaps, type ResizeMember } from '../../shared/timeline/groupEdit'`)

```ts
const member = (id: string, over: Partial<ResizeMember> = {}): ResizeMember => ({
  id, start_frame: 100, in_frame: 30, length: 60, anchored: true,
  sourceFrames: null, speed: 1, gapBefore: null, gapAfter: null, ...over,
})

describe('computeGroupResize — right edge', () => {
  it('applies one delta to every member', () => {
    const r = computeGroupResize([member('a'), member('b', { start_frame: 300, length: 20 })], 'right', 10)
    expect(r.delta).toBe(10)
    expect(r.patches.get('a')).toEqual({ start_frame: 100, in_frame: 30, length: 70 })
    expect(r.patches.get('b')).toEqual({ start_frame: 300, in_frame: 30, length: 30 })
  })

  it('the shortest member limits shrinking (min length 1)', () => {
    const r = computeGroupResize([member('a'), member('b', { length: 5 })], 'right', -40)
    expect(r.delta).toBe(-4)
    expect(r.patches.get('b')!.length).toBe(1)
    expect(r.patches.get('a')!.length).toBe(56)
  })

  it('the source length limits growing, scaled by speed', () => {
    // 200 source frames, in 30, speed 2 → room for floor(170 / 2) = 85 frames; has 60 → +25.
    const r = computeGroupResize([member('a', { sourceFrames: 200, speed: 2 })], 'right', 100)
    expect(r.delta).toBe(25)
  })

  it('a clip already longer than its source cannot grow but is not forced to shrink', () => {
    const r = computeGroupResize([member('a', { sourceFrames: 50 })], 'right', 10)
    expect(r.delta).toBe(0)
  })

  it('stops at the neighbour', () => {
    expect(computeGroupResize([member('a', { gapAfter: 7 })], 'right', 50).delta).toBe(7)
  })
})

describe('computeGroupResize — left edge', () => {
  it('moves start, in_frame and length together for anchored clips', () => {
    const r = computeGroupResize([member('a')], 'left', 10)
    expect(r.patches.get('a')).toEqual({ start_frame: 110, in_frame: 40, length: 50 })
  })

  it('cannot rewind before the source start: the tightest in_frame wins', () => {
    const r = computeGroupResize([member('a'), member('b', { in_frame: 4 })], 'left', -50)
    expect(r.delta).toBe(-4)
    expect(r.patches.get('b')).toEqual({ start_frame: 96, in_frame: 0, length: 64 })
    expect(r.patches.get('a')).toEqual({ start_frame: 96, in_frame: 26, length: 64 })
  })

  it('unanchored clips keep in_frame and are limited by frame 0', () => {
    const r = computeGroupResize([member('a', { anchored: false, start_frame: 12 })], 'left', -50)
    expect(r.delta).toBe(-12)
    expect(r.patches.get('a')).toEqual({ start_frame: 0, in_frame: 30, length: 72 })
  })

  it('stops at the neighbour and never shrinks below 1 frame', () => {
    expect(computeGroupResize([member('a', { gapBefore: 3 })], 'left', -50).delta).toBe(-3)
    expect(computeGroupResize([member('a')], 'left', 500).delta).toBe(59)
  })

  it('every patch keeps start + length (the right edge) fixed', () => {
    const r = computeGroupResize([member('a'), member('b', { start_frame: 40, length: 9 })], 'left', 6)
    for (const [id, p] of r.patches) {
      const m = id === 'a' ? 160 : 49
      expect(p.start_frame + p.length).toBe(m)
    }
  })
})

describe('neighbourGaps', () => {
  const clips = [
    { id: 'x', start_frame: 0, length: 50 },
    { id: 'a', start_frame: 60, length: 40 },
    { id: 'b', start_frame: 100, length: 20 },
    { id: 'y', start_frame: 150, length: 10 },
  ]
  it('measures to the nearest clip that is not being trimmed', () => {
    expect(neighbourGaps(clips, 'a', new Set(['a', 'b']))).toEqual({ gapBefore: 10, gapAfter: 50 })
  })
  it('null when nothing is there', () => {
    // Nearest clip before y (150) is b, which ends at 120 → 30 frames of room.
    expect(neighbourGaps(clips, 'y', new Set(['y']))).toEqual({ gapBefore: 30, gapAfter: null })
    expect(neighbourGaps(clips, 'x', new Set(['x']))).toEqual({ gapBefore: null, gapAfter: 10 })
  })
  it('already-overlapping neighbours count as zero room, not negative', () => {
    const over = [{ id: 'a', start_frame: 0, length: 50 }, { id: 'n', start_frame: 40, length: 30 }]
    expect(neighbourGaps(over, 'a', new Set(['a'])).gapAfter).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/timeline-group-edit.unit.spec.ts`
Expected: FAIL — `computeGroupResize` / `neighbourGaps` are not exported.

- [ ] **Step 3: Implement** (append to `frontend/shared/timeline/groupEdit.ts`; add at the top: `import { computeLeftTrim, type TrimBase } from './trim'`)

```ts
export interface ResizeMember {
  id: string
  start_frame: number
  in_frame: number
  length: number
  /** Source-backed kinds (video/audio): the left edge trims INTO the source. */
  anchored: boolean
  /** Known source length in frames; null = unbounded. */
  sourceFrames: number | null
  speed: number
  /** Free frames to the nearest non-trimming clip on the same track; null = no limit. */
  gapBefore: number | null
  gapAfter: number | null
}

/** Room on each side of `memberId`, measured to the nearest clip on the same
 *  track that is not part of the trim. Overlapping neighbours give 0. */
export function neighbourGaps(
  clips: { id: string; start_frame: number; length: number }[], memberId: string, ignore: ReadonlySet<string>,
): { gapBefore: number | null; gapAfter: number | null } {
  const me = clips.find(c => c.id === memberId)
  if (!me) return { gapBefore: null, gapAfter: null }
  const myEnd = me.start_frame + me.length
  let gapBefore: number | null = null
  let gapAfter: number | null = null
  for (const c of clips) {
    if (ignore.has(c.id)) continue
    const cEnd = c.start_frame + c.length
    if (c.start_frame >= me.start_frame) {
      const g = Math.max(0, c.start_frame - myEnd)
      gapAfter = gapAfter == null ? g : Math.min(gapAfter, g)
    } else {
      const g = Math.max(0, me.start_frame - cEnd)
      gapBefore = gapBefore == null ? g : Math.min(gapBefore, g)
    }
  }
  return { gapBefore, gapAfter }
}

/** Trim a whole selection by ONE shared amount. Every member's limits are
 *  intersected first, the delta is clamped once, and every field is derived
 *  from that one number — so start + length (and in_frame) can never drift
 *  apart between members. Callers snap `rawDelta` BEFORE calling.
 *  Idea from opencut-classic (MIT): clamp the group delta once, derive all fields from it. */
export function computeGroupResize(
  members: ResizeMember[], edge: 'left' | 'right', rawDelta: number,
): { delta: number; patches: Map<string, TrimBase> } {
  let min = -Infinity
  let max = Infinity
  for (const m of members) {
    if (edge === 'right') {
      min = Math.max(min, 1 - m.length)
      if (m.sourceFrames != null) {
        const budget = Math.floor((m.sourceFrames - m.in_frame) / Math.max(0.1, m.speed))
        max = Math.min(max, Math.max(0, budget - m.length))
      }
      if (m.gapAfter != null) max = Math.min(max, m.gapAfter)
    } else {
      max = Math.min(max, m.length - 1)
      min = Math.max(min, -m.start_frame)
      if (m.anchored) min = Math.max(min, -m.in_frame)
      if (m.gapBefore != null) min = Math.max(min, -m.gapBefore)
    }
  }
  // `|| 0` turns -0 into 0 so patches compare cleanly.
  const delta = members.length ? (Math.max(min, Math.min(Math.round(rawDelta), max)) || 0) : 0
  const patches = new Map<string, TrimBase>()
  for (const m of members) {
    const base: TrimBase = { start_frame: m.start_frame, in_frame: m.in_frame, length: m.length }
    patches.set(m.id, edge === 'right'
      ? { ...base, length: m.length + delta }
      : computeLeftTrim(base, m.start_frame + delta, m.anchored))
  }
  return { delta, patches }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/timeline-group-edit.unit.spec.ts tests/unit/timeline-trim.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the editor**

In `TimelineEditor.vue`:

Extend the Task 4 import: `import { snapGroupDelta, computeGroupResize, neighbourGaps, type Span, type ResizeMember } from '~~/shared/timeline/groupEdit'`

Next to `let dragGroupStarts` (line ~610) add:

```ts
// Snapshot of every clip taking part in a trim, taken at drag-start.
let dragResizeMembers: ResizeMember[] | null = null

function snapshotResizeMembers(primaryId: string): ResizeMember[] {
  const ids = selectedClipIds.value.size > 1 && selectedClipIds.value.has(primaryId)
    ? new Set(selectedClipIds.value) : new Set([primaryId])
  const out: ResizeMember[] = []
  for (const track of store.state.value.tracks) {
    if (track.locked) continue
    for (const c of track.clips) {
      if (!ids.has(c.id)) continue
      out.push({
        id: c.id, start_frame: c.start_frame, in_frame: c.in_frame ?? 0, length: c.length,
        anchored: c.kind === 'video' || c.kind === 'audio',
        sourceFrames: clipSourceFrames(c), speed: c.speed ?? 1,
        ...neighbourGaps(track.clips, c.id, ids),
      })
    }
  }
  return out
}
```

In `onClipPointerDown`, directly after the existing `if (mode === 'move' && …) { … } else { dragGroupStarts = null }` block, add:

```ts
  dragResizeMembers = mode === 'move' ? null : snapshotResizeMembers(clipId)
```

Update `draggingIds()` (added in Task 4) so trims exclude all their members from snapping:

```ts
function draggingIds(): Set<string> {
  if (dragResizeMembers) return new Set(dragResizeMembers.map(m => m.id))
  if (dragGroupStarts && dragGroupStarts.size > 1) return new Set(dragGroupStarts.keys())
  return new Set(drag.value ? [drag.value.clipId] : [])
}
```

Replace BOTH resize branches (`} else if (drag.value.mode === 'resize-right') { … } else if (drag.value.mode === 'resize-left') { … }`, lines ~814-832) with:

```ts
  } else if (drag.value.mode === 'resize-right' || drag.value.mode === 'resize-left') {
    const edge = drag.value.mode === 'resize-right' ? 'right' : 'left'
    const members = dragResizeMembers ?? []
    // Snap the edge under the mouse, then let the group clamp it ONCE.
    const startEdge = edge === 'right' ? drag.value.startStart + drag.value.startLength : drag.value.startStart
    const snappedEdge = snapFrame(startEdge + dframes, draggingIds())
    const { patches } = computeGroupResize(members, edge, snappedEdge - startEdge)
    store.mutate(s => {
      for (const track of s.tracks) {
        for (const c of track.clips) {
          const p = patches.get(c.id)
          if (p) { c.start_frame = p.start_frame; c.in_frame = p.in_frame; c.length = p.length }
        }
      }
    })
    const mine = patches.get(drag.value.clipId)
    if (mine) showTrimHud(e, mine.length, mine.length - drag.value.startLength)
```

(The `} else if (drag.value.mode === 'playhead') {` branch that follows stays as it is.)

In `onPointerUp`, next to `dragGroupStarts = null`, add `dragResizeMembers = null`.

`clampLengthToSource` is no longer used in this file: run `grep -n "clampLengthToSource" app/components/vue-canvas/TimelineEditor.vue`; if the only hit left is the import on line 22, change that import to `import { computeLeftTrim } from '~~/shared/timeline/trim'`; if `computeLeftTrim` has no other hits either, remove the import line.

- [ ] **Step 6: Tests, typecheck, browser check**

Run: `npx vitest run tests/unit/timeline-group-edit.unit.spec.ts tests/unit/timeline-trim.unit.spec.ts tests/unit/timeline-gesture.unit.spec.ts`
Expected: PASS.
Typecheck grep for `TimelineEditor.vue` / `groupEdit.ts`: no new lines.
Browser (controller, real mouse): (1) trim one clip's right edge toward the next clip — it stops at the neighbour; (2) select three clips on different tracks, drag one right edge — all three grow/shrink together and stop when the shortest hits 1 frame; (3) one Cmd+Z undoes the whole trim; (4) a video clip cannot grow past its source length.

- [ ] **Step 7: Commit (controller)**

Paths: `frontend/shared/timeline/groupEdit.ts`, `frontend/tests/unit/timeline-group-edit.unit.spec.ts`, `frontend/app/components/vue-canvas/TimelineEditor.vue`
Message: `feat(timeline): trim a whole selection at once; a trim stops at the neighbouring clip`

---

### Task 6: A moved clip that lands on another hops to a free track

**Files:**
- Create: `frontend/shared/timeline/placement.ts`
- Test: `frontend/tests/unit/timeline-placement.unit.spec.ts`
- Modify: `frontend/app/components/vue-canvas/TimelineEditor.vue` (`onPointerUp`, ~line 863)

**Interfaces:**
- Consumes: `Span` from `groupEdit.ts`; `EditState`, `Track` from `types.ts`.
- Produces:
  - `trackHasRoom(track: Track, spans: Span[], ignore: ReadonlySet<string>): boolean`
  - `type Placement = { type: 'track'; trackId: string } | { type: 'new_track'; kind: Track['kind'] }`
  - `resolvePlacement(state: EditState, fromTrackId: string, spans: Span[], ignore: ReadonlySet<string>): Placement`
  - `relocateClips(state: EditState, clipIds: ReadonlySet<string>, placement: Placement, newTrackId: string): boolean`
  - `settleOverlaps(state: EditState, movedIds: ReadonlySet<string>, newId: () => string): boolean`

New tracks are appended at the end of `state.tracks`, the same place the existing "add track" command puts them.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/timeline-placement.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { trackHasRoom, resolvePlacement, relocateClips, settleOverlaps } from '../../shared/timeline/placement'
import { createDefaultEditState } from '../../shared/timeline/types'
import type { EditState, Track, Clip } from '../../shared/timeline/types'

const img = (id: string, start: number, length: number): Clip =>
  ({ id, kind: 'image', asset_id: 'x', start_frame: start, in_frame: 0, length })
const track = (id: string, kind: Track['kind'], clips: Clip[], locked = false): Track =>
  ({ id, kind, name: id, muted: false, locked, clips })
function state(tracks: Track[]): EditState {
  const s = createDefaultEditState()
  s.tracks = tracks
  return s
}

describe('trackHasRoom', () => {
  const t = track('v1', 'video', [img('a', 0, 50), img('b', 100, 50)])
  it('touching edges is fine, overlapping is not', () => {
    expect(trackHasRoom(t, [{ start: 50, end: 100 }], new Set())).toBe(true)
    expect(trackHasRoom(t, [{ start: 49, end: 100 }], new Set())).toBe(false)
  })
  it('ignored clips do not block', () => {
    expect(trackHasRoom(t, [{ start: 0, end: 50 }], new Set(['a']))).toBe(true)
  })
})

describe('resolvePlacement', () => {
  it('stays put when there is room', () => {
    const s = state([track('v1', 'video', [img('a', 0, 50)])])
    expect(resolvePlacement(s, 'v1', [{ start: 60, end: 80 }], new Set())).toEqual({ type: 'track', trackId: 'v1' })
  })

  it('takes the nearest free track of the same kind, skipping locked and other kinds', () => {
    const s = state([
      track('v1', 'video', [img('a', 0, 50)]),
      track('a1', 'audio', []),
      track('v2', 'video', [], true),
      track('v3', 'video', []),
    ])
    expect(resolvePlacement(s, 'v1', [{ start: 10, end: 20 }], new Set())).toEqual({ type: 'track', trackId: 'v3' })
  })

  it('on a distance tie the LATER track wins (it renders on top)', () => {
    const s = state([track('v0', 'video', []), track('v1', 'video', [img('a', 0, 50)]), track('v2', 'video', [])])
    expect(resolvePlacement(s, 'v1', [{ start: 10, end: 20 }], new Set())).toEqual({ type: 'track', trackId: 'v2' })
  })

  it('asks for a new track when nothing has room', () => {
    const s = state([track('v1', 'video', [img('a', 0, 50)]), track('v2', 'video', [img('b', 0, 50)])])
    expect(resolvePlacement(s, 'v1', [{ start: 10, end: 20 }], new Set())).toEqual({ type: 'new_track', kind: 'video' })
  })
})

describe('relocateClips', () => {
  it('moves clips, names the new track like the add-track button does, and drops their transitions', () => {
    const s = state([track('v1', 'video', [img('a', 0, 50), img('m', 10, 20)])])
    s.transitions = [{ id: 't', track_id: 'v1', from_clip_id: 'a', to_clip_id: 'm', kind: 'crossfade', duration: 10 }]
    expect(relocateClips(s, new Set(['m']), { type: 'new_track', kind: 'video' }, 'NEW')).toBe(true)
    expect(s.tracks.map(t => t.id)).toEqual(['v1', 'NEW'])
    expect(s.tracks[1]!.name).toBe('Video 2')
    expect(s.tracks[1]!.clips.map(c => c.id)).toEqual(['m'])
    expect(s.tracks[0]!.clips.map(c => c.id)).toEqual(['a'])
    expect(s.transitions).toEqual([])
  })

  it('does nothing when the clips already sit on the target track', () => {
    const s = state([track('v1', 'video', [img('m', 10, 20)])])
    expect(relocateClips(s, new Set(['m']), { type: 'track', trackId: 'v1' }, 'NEW')).toBe(false)
  })
})

describe('settleOverlaps', () => {
  it('moves only the clips that actually collide, grouped per track', () => {
    const s = state([
      track('v1', 'video', [img('a', 0, 50), img('m1', 40, 20), img('m2', 200, 20)]),
      track('v2', 'video', []),
    ])
    let n = 0
    expect(settleOverlaps(s, new Set(['m1', 'm2']), () => `new${n++}`)).toBe(true)
    // m1 and m2 moved together as one group from v1 (keeps the selection on one row).
    expect(s.tracks[1]!.clips.map(c => c.id).sort()).toEqual(['m1', 'm2'])
    expect(s.tracks[0]!.clips.map(c => c.id)).toEqual(['a'])
  })

  it('leaves a clean drop alone', () => {
    const s = state([track('v1', 'video', [img('a', 0, 50), img('m', 60, 20)])])
    expect(settleOverlaps(s, new Set(['m']), () => 'x')).toBe(false)
  })

  it('never touches a locked track', () => {
    const s = state([track('v1', 'video', [img('a', 0, 50), img('m', 40, 20)], true)])
    expect(settleOverlaps(s, new Set(['m']), () => 'x')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/timeline-placement.unit.spec.ts`
Expected: FAIL — cannot resolve `../../shared/timeline/placement`.

- [ ] **Step 3: Implement**

Create `frontend/shared/timeline/placement.ts`:

```ts
import type { EditState, Track, Clip } from './types'
import type { Span } from './groupEdit'

// Where clips may land. Two clips on one track must not cover the same frames;
// when a move would do that, the moved clips hop to the nearest free track of
// the same kind, or get a new one.
// Idea from opencut-classic (MIT): placement resolves to "existing track" or "new track".

/** True when none of `spans` overlaps a clip on `track` (touching edges is fine). */
export function trackHasRoom(track: Track, spans: Span[], ignore: ReadonlySet<string>): boolean {
  for (const c of track.clips) {
    if (ignore.has(c.id)) continue
    const cEnd = c.start_frame + c.length
    for (const s of spans) if (s.start < cEnd && c.start_frame < s.end) return false
  }
  return true
}

export type Placement = { type: 'track'; trackId: string } | { type: 'new_track'; kind: Track['kind'] }

/** Prefer `fromTrackId`; otherwise walk outward to the nearest unlocked track
 *  of the same kind with room (on a tie the later track wins — it renders on
 *  top); otherwise ask for a new track. */
export function resolvePlacement(state: EditState, fromTrackId: string, spans: Span[], ignore: ReadonlySet<string>): Placement {
  const i = state.tracks.findIndex(t => t.id === fromTrackId)
  const from = state.tracks[i]
  if (!from) return { type: 'new_track', kind: 'video' }
  if (trackHasRoom(from, spans, ignore)) return { type: 'track', trackId: from.id }
  for (let d = 1; d < state.tracks.length; d++) {
    for (const j of [i + d, i - d]) {
      const t = state.tracks[j]
      if (t && t.kind === from.kind && !t.locked && trackHasRoom(t, spans, ignore)) return { type: 'track', trackId: t.id }
    }
  }
  return { type: 'new_track', kind: from.kind }
}

const KIND_LABEL: Record<Track['kind'], string> = { video: 'Video', audio: 'Audio', captions: 'Captions' }

/** Move `clipIds` to the placement. Transitions touching a moved clip are
 *  dropped — a transition only makes sense between neighbours on one track. */
export function relocateClips(state: EditState, clipIds: ReadonlySet<string>, placement: Placement, newTrackId: string): boolean {
  const existing = placement.type === 'track' ? state.tracks.find(t => t.id === placement.trackId) : undefined
  if (placement.type === 'track' && !existing) return false
  const moved: Clip[] = []
  for (const track of state.tracks) {
    if (track === existing) continue
    const keep: Clip[] = []
    for (const c of track.clips) (clipIds.has(c.id) ? moved : keep).push(c)
    if (keep.length !== track.clips.length) track.clips = keep
  }
  if (!moved.length) return false
  let target = existing
  if (!target) {
    const kind = placement.type === 'new_track' ? placement.kind : 'video'
    const count = state.tracks.filter(t => t.kind === kind).length
    target = { id: newTrackId, kind, name: `${KIND_LABEL[kind]} ${count + 1}`, muted: false, locked: false, clips: [] }
    state.tracks.push(target)
  }
  target.clips.push(...moved)
  const ids = new Set(moved.map(c => c.id))
  state.transitions = state.transitions.filter(t => !ids.has(t.from_clip_id) && !ids.has(t.to_clip_id))
  return true
}

/** After a move: for each track, if any moved clip on it now overlaps a clip
 *  that did not move, all the moved clips on that track go elsewhere together. */
export function settleOverlaps(state: EditState, movedIds: ReadonlySet<string>, newId: () => string): boolean {
  let changed = false
  for (const track of [...state.tracks]) {
    if (track.locked) continue
    const mine = track.clips.filter(c => movedIds.has(c.id))
    if (!mine.length) continue
    const spans = mine.map(c => ({ start: c.start_frame, end: c.start_frame + c.length }))
    if (trackHasRoom(track, spans, movedIds)) continue
    const placement = resolvePlacement(state, track.id, spans, movedIds)
    if (relocateClips(state, new Set(mine.map(c => c.id)), placement, newId())) changed = true
  }
  return changed
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/timeline-placement.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the release handler**

In `TimelineEditor.vue`, add the import: `import { settleOverlaps } from '~~/shared/timeline/placement'`

In `onPointerUp`, directly BEFORE the final block that starts with `drag.value = null` (line ~863), add:

```ts
  // A move that ended on top of another clip: hop to a free track (still inside
  // the gesture, so it is part of the same single undo step).
  if (drag.value?.mode === 'move') {
    const moved = draggingIds()
    store.mutate(s => { settleOverlaps(s, moved, () => crypto.randomUUID()) })
  }
```

`store.mutate` inside a gesture does not push its own undo entry (the gesture owns the snapshot), and `endGesture()` only records a step when the state actually changed, so a clean drop adds nothing.

- [ ] **Step 6: Tests, typecheck, browser check**

Run: `npx vitest run tests/unit/timeline-placement.unit.spec.ts tests/unit/timeline-gesture.unit.spec.ts`
Expected: PASS.
Typecheck grep for `TimelineEditor.vue` / `placement.ts`: no new lines.
Browser (controller, real mouse): with one video track holding two clips, drag one onto the other and release → a new track named "Video 2" appears holding the dragged clip; Cmd+Z puts it back AND removes the track in one step. Add an empty second video track, repeat → the clip lands on the existing empty track instead. Drop onto free space → nothing moves.

- [ ] **Step 7: Commit (controller)**

Paths: `frontend/shared/timeline/placement.ts`, `frontend/tests/unit/timeline-placement.unit.spec.ts`, `frontend/app/components/vue-canvas/TimelineEditor.vue`
Message: `feat(timeline): a clip dropped on another hops to the nearest free track, or gets a new one`

---

### Task 7: Ripple maths (pure)

**Files:**
- Create: `frontend/shared/timeline/ripple.ts`
- Test: `frontend/tests/unit/timeline-ripple.unit.spec.ts`

**Interfaces:**
- Produces:
  - `interface RippleEdit { trackId: string; fromFrame: number; delta: number }`
  - `computeRippleEdits(before: EditState, after: EditState): RippleEdit[]`
  - `applyRippleEdits(state: EditState, edits: RippleEdit[]): boolean`

Rules (all on the same track only; locked tracks never shift):

| What happened to a clip between `before` and `after` | Edit |
|---|---|
| Deleted (gone from every track) | `fromFrame = old end`, `delta = -length` |
| Right edge moved (start same) | `fromFrame = old end`, `delta = new end - old end` |
| Left edge moved (end same) | `fromFrame = min(old start, new start)`, `delta = old start - new start` — this also slides the trimmed clip itself back to where it started |
| Moved (start and end changed by the same amount), or changed track | nothing |

A clip's total shift is the sum of every edit on its track whose `fromFrame` is at or before the clip's start. Summing (instead of applying one after another) makes the result independent of order.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/unit/timeline-ripple.unit.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeRippleEdits, applyRippleEdits } from '../../shared/timeline/ripple'
import { createDefaultEditState } from '../../shared/timeline/types'
import type { EditState, Track, Clip } from '../../shared/timeline/types'

const img = (id: string, start: number, length: number): Clip =>
  ({ id, kind: 'image', asset_id: 'x', start_frame: start, in_frame: 0, length })
function state(tracks: Track[]): EditState {
  const s = createDefaultEditState()
  s.tracks = tracks
  return s
}
const v1 = (clips: Clip[], locked = false): Track => ({ id: 'v1', kind: 'video', name: 'Video 1', muted: false, locked, clips })
const clone = (s: EditState): EditState => JSON.parse(JSON.stringify(s))
const starts = (s: EditState) => Object.fromEntries(s.tracks.flatMap(t => t.clips).map(c => [c.id, c.start_frame]))

describe('ripple', () => {
  const before = state([v1([img('a', 0, 50), img('b', 50, 50), img('c', 100, 50)])])

  it('delete closes the gap', () => {
    const after = clone(before)
    after.tracks[0]!.clips = after.tracks[0]!.clips.filter(c => c.id !== 'b')
    const edits = computeRippleEdits(before, after)
    expect(edits).toEqual([{ trackId: 'v1', fromFrame: 100, delta: -50 }])
    expect(applyRippleEdits(after, edits)).toBe(true)
    expect(starts(after)).toEqual({ a: 0, c: 50 })
  })

  it('deleting two clips sums both gaps', () => {
    const after = clone(before)
    after.tracks[0]!.clips = after.tracks[0]!.clips.filter(c => c.id === 'c')
    applyRippleEdits(after, computeRippleEdits(before, after))
    expect(starts(after)).toEqual({ c: 0 })
  })

  it('shortening the right edge pulls later clips in', () => {
    const after = clone(before)
    after.tracks[0]!.clips[0]!.length = 30
    applyRippleEdits(after, computeRippleEdits(before, after))
    expect(starts(after)).toEqual({ a: 0, b: 30, c: 80 })
  })

  it('growing the right edge pushes later clips out', () => {
    const after = clone(before)
    after.tracks[0]!.clips[0]!.length = 70
    applyRippleEdits(after, computeRippleEdits(before, after))
    expect(starts(after)).toEqual({ a: 0, b: 70, c: 120 })
  })

  it('left trim: the clip slides back to its old start and the rest follows', () => {
    const after = clone(before)
    Object.assign(after.tracks[0]!.clips[1]!, { start_frame: 60, in_frame: 10, length: 40 })
    applyRippleEdits(after, computeRippleEdits(before, after))
    expect(starts(after)).toEqual({ a: 0, b: 50, c: 90 })
    expect(after.tracks[0]!.clips[1]!.length).toBe(40)
    expect(after.tracks[0]!.clips[1]!.in_frame).toBe(10)
  })

  it('left extend: the clip keeps its old start, later clips are pushed', () => {
    const b2 = state([v1([img('a', 0, 40), img('b', 50, 50), img('c', 100, 50)])])
    const after = clone(b2)
    Object.assign(after.tracks[0]!.clips[1]!, { start_frame: 45, length: 55 })
    applyRippleEdits(after, computeRippleEdits(b2, after))
    expect(starts(after)).toEqual({ a: 0, b: 50, c: 105 })
  })

  it('a plain move produces no edits', () => {
    const after = clone(before)
    after.tracks[0]!.clips[1]!.start_frame = 300
    expect(computeRippleEdits(before, after)).toEqual([])
  })

  it('a clip that changed track produces no edits', () => {
    const b2 = state([v1([img('a', 0, 50), img('b', 50, 50)]), { id: 'v2', kind: 'video', name: 'Video 2', muted: false, locked: false, clips: [] }])
    const after = clone(b2)
    after.tracks[1]!.clips.push(after.tracks[0]!.clips.pop()!)
    expect(computeRippleEdits(b2, after)).toEqual([])
  })

  it('locked tracks never shift, other tracks are untouched', () => {
    const b2 = state([v1([img('a', 0, 50), img('b', 50, 50)], true), { id: 'v2', kind: 'video', name: 'Video 2', muted: false, locked: false, clips: [img('z', 500, 10)] }])
    const after = clone(b2)
    after.tracks[0]!.clips[0]!.length = 10
    expect(applyRippleEdits(after, computeRippleEdits(b2, after))).toBe(false)
    expect(starts(after)).toEqual({ a: 0, b: 50, z: 500 })
  })

  it('never shifts a clip below frame 0 and reports no-change honestly', () => {
    const s = state([v1([img('a', 10, 5)])])
    expect(applyRippleEdits(s, [{ trackId: 'v1', fromFrame: 0, delta: -100 }])).toBe(true)
    expect(starts(s)).toEqual({ a: 0 })
    expect(applyRippleEdits(s, [])).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/timeline-ripple.unit.spec.ts`
Expected: FAIL — cannot resolve `../../shared/timeline/ripple`.

- [ ] **Step 3: Implement**

Create `frontend/shared/timeline/ripple.ts`:

```ts
import type { EditState } from './types'

// Ripple: after a trim or a delete, later clips on the same track slide so no
// gap (or overlap) is left. The shifts are worked out by comparing the timeline
// BEFORE and AFTER the edit, so any edit gets ripple without its own code.
// Idea from opencut-classic (MIT): infer ripple from a before/after diff.

export interface RippleEdit { trackId: string; fromFrame: number; delta: number }

export function computeRippleEdits(before: EditState, after: EditState): RippleEdit[] {
  const afterById = new Map<string, { trackId: string; start: number; end: number }>()
  for (const t of after.tracks) {
    for (const c of t.clips) afterById.set(c.id, { trackId: t.id, start: c.start_frame, end: c.start_frame + c.length })
  }
  const edits: RippleEdit[] = []
  for (const t of before.tracks) {
    for (const c of t.clips) {
      const oldStart = c.start_frame
      const oldEnd = c.start_frame + c.length
      const now = afterById.get(c.id)
      if (!now) { edits.push({ trackId: t.id, fromFrame: oldEnd, delta: -c.length }); continue }
      if (now.trackId !== t.id) continue
      const dStart = now.start - oldStart
      const dEnd = now.end - oldEnd
      if (dStart === dEnd) continue                       // moved or untouched
      if (dStart !== 0) edits.push({ trackId: t.id, fromFrame: Math.min(oldStart, now.start), delta: -dStart })
      if (dEnd !== 0) edits.push({ trackId: t.id, fromFrame: oldEnd, delta: dEnd })
    }
  }
  return edits
}

/** Shift clips in place. Returns whether anything moved. */
export function applyRippleEdits(state: EditState, edits: RippleEdit[]): boolean {
  let changed = false
  for (const track of state.tracks) {
    if (track.locked) continue
    const mine = edits.filter(e => e.trackId === track.id)
    if (!mine.length) continue
    for (const c of track.clips) {
      let shift = 0
      for (const e of mine) if (e.fromFrame <= c.start_frame) shift += e.delta
      const next = Math.max(0, c.start_frame + shift)
      if (next !== c.start_frame) { c.start_frame = next; changed = true }
    }
  }
  return changed
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/timeline-ripple.unit.spec.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit (controller)**

Paths: `frontend/shared/timeline/ripple.ts`, `frontend/tests/unit/timeline-ripple.unit.spec.ts`
Message: `feat(timeline): ripple maths — work out the shifts from a before/after comparison`

---

### Task 8: Ripple switch in the toolbar

**Files:**
- Modify: `frontend/app/composables/useTimelineStore.ts` (add `gestureBaseState`, export it)
- Modify: `frontend/app/components/vue-canvas/TimelineEditor.vue` (toggle state near line 556, `snapshotResizeMembers`, `onPointerUp`, `deleteSelection` ~1423, toolbar ~2305, icon import line 6)
- Test: `frontend/tests/unit/timeline-gesture.unit.spec.ts` (add one test)

**Interfaces:**
- Consumes: `computeRippleEdits`, `applyRippleEdits` (Task 7); `dragResizeMembers`, `snapshotResizeMembers` (Task 5).
- Produces: `store.gestureBaseState(): EditState | null`; local setting key `Timeline.Ripple` (`'true'` / `'false'`, default off).

- [ ] **Step 1: Know the existing spec's setup**

`tests/unit/timeline-gesture.unit.spec.ts` has one `describe('gesture transactions', …)` with `const store = useTimelineStore()`, a `beforeEach` that calls `store.bind('test-node', () => undefined, () => {})` (which resets state and history), and a helper `img(id, start, length)` that builds an image clip. The new test goes inside that `describe` and uses both.

- [ ] **Step 2: Add the failing test** (append as the last `it` inside `describe('gesture transactions', …)`)

```ts
  it('gestureBaseState is the snapshot taken at beginGesture, and null outside a gesture', () => {
    expect(store.gestureBaseState()).toBeNull()
    const trackId = store.state.value.tracks[0]!.id
    store.addClip(trackId, img('g1', 0, 30))
    store.beginGesture()
    store.updateClip('g1', { length: 10 })
    const base = store.gestureBaseState()!
    expect(base.tracks[0]!.clips.find(c => c.id === 'g1')!.length).toBe(30)
    // It is a copy: editing it must not touch the live state.
    base.tracks[0]!.clips = []
    expect(store.state.value.tracks[0]!.clips.length).toBeGreaterThan(0)
    store.endGesture()
    expect(store.gestureBaseState()).toBeNull()
  })
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/unit/timeline-gesture.unit.spec.ts`
Expected: FAIL — `store.gestureBaseState is not a function`.

- [ ] **Step 4: Implement in the store**

In `frontend/app/composables/useTimelineStore.ts`, directly after the `endGesture` function (line ~192), add:

```ts
  /** The timeline as it was when the current drag began (a copy), or null when
   *  no gesture is open. Ripple compares this with the live state on release. */
  function gestureBaseState(): EditState | null {
    return gestureBase === null ? null : JSON.parse(gestureBase) as EditState
  }
```

In the returned object, add `gestureBaseState,` directly after `endGesture,` (line ~493).

Run: `npx vitest run tests/unit/timeline-gesture.unit.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire the switch into the editor**

In `TimelineEditor.vue`:

Add `ChevronsLeft` to the lucide import list on line 6 (next to `Magnet`).

Add the import: `import { computeRippleEdits, applyRippleEdits } from '~~/shared/timeline/ripple'`

Directly after the `toggleSnap` function (line ~560) add:

```ts
// Ripple: when on, trimming or deleting slides the later clips on that track
// so no gap or overlap is left. Off by default — it moves clips you didn't touch.
const rippleEnabled = ref(getLocalSetting('Timeline.Ripple') === 'true')
function toggleRipple() {
  rippleEnabled.value = !rippleEnabled.value
  setLocalSetting('Timeline.Ripple', String(rippleEnabled.value))
}
```

In `snapshotResizeMembers` (Task 5), a growing right edge must not be stopped by the neighbour when ripple will push it. Replace the line `...neighbourGaps(track.clips, c.id, ids),` with:

```ts
        ...(() => {
          const g = neighbourGaps(track.clips, c.id, ids)
          // With ripple on, the neighbours get pushed, so they are not a limit.
          return rippleEnabled.value ? { gapBefore: null, gapAfter: null } : g
        })(),
```

In `onPointerUp`, directly BEFORE the Task 6 block (`if (drag.value?.mode === 'move') { … }`), add:

```ts
  // Ripple a finished trim: compare with the timeline as the drag began.
  if (rippleEnabled.value && (drag.value?.mode === 'resize-right' || drag.value?.mode === 'resize-left')) {
    const base = store.gestureBaseState()
    if (base) store.mutate(s => { applyRippleEdits(s, computeRippleEdits(base, s)) })
  }
```

Replace `deleteSelection` (line ~1423) with:

```ts
// Delete everything selected as ONE undo step. With ripple on, later clips
// close the gaps.
function deleteSelection() {
  const ids = selectedClipIds.value.size > 1
    ? new Set(selectedClipIds.value)
    : new Set(store.selectedClipId.value ? [store.selectedClipId.value] : [])
  if (!ids.size) return
  store.mutate(s => {
    const before: EditState = JSON.parse(JSON.stringify(s))
    for (const track of s.tracks) track.clips = track.clips.filter(c => !ids.has(c.id))
    s.transitions = s.transitions.filter(t => !ids.has(t.from_clip_id) && !ids.has(t.to_clip_id))
    if (rippleEnabled.value) applyRippleEdits(s, computeRippleEdits(before, s))
  })
  if (store.selectedClipId.value && ids.has(store.selectedClipId.value)) store.selectedClipId.value = null
  clearSelection()
}
```

(This also fixes an existing bug: deleting a multi-selection left transitions pointing at deleted clips.) If `EditState` is not already imported as a type in this file, add it to the existing `~~/shared/timeline/types` type import.

In the toolbar, directly after the snap `<button … ><Magnet class="size-3.5" /></button>` (line ~2308), add:

```html
            <button class="size-6 flex items-center justify-center rounded transition-colors"
              :class="rippleEnabled ? 'bg-white/15 text-white' : 'hover:bg-white/10 text-white/40'"
              :title="rippleEnabled ? 'Ripple on: trimming or deleting moves the later clips' : 'Ripple off: trimming or deleting leaves the later clips where they are'"
              @click="toggleRipple"><ChevronsLeft class="size-3.5" /></button>
```

- [ ] **Step 6: Tests, typecheck, browser check**

Run: `npx vitest run tests/unit/timeline-gesture.unit.spec.ts tests/unit/timeline-ripple.unit.spec.ts tests/unit/timeline-group-edit.unit.spec.ts`
Expected: PASS.
Typecheck grep for `TimelineEditor.vue` / `useTimelineStore.ts`: no new lines.
Browser (controller, real mouse), three clips in a row on one track:
1. Ripple off: shorten the first clip → a gap stays. Delete the middle clip → a gap stays.
2. Ripple on: shorten the first clip → on release the other two slide left and stay touching. Cmd+Z → everything returns in ONE step.
3. Ripple on: lengthen the first clip past its neighbour → on release the others are pushed right, no overlap.
4. Ripple on: trim the LEFT edge of the middle clip inward → on release it slides back against the first clip and the third follows.
5. Ripple on: select clips 1 and 2, press Delete → clip 3 lands at 0.
6. Reload the page → the switch remembers its state.
7. Existing Cmd+Delete ripple delete still works with the switch off.

- [ ] **Step 7: Commit (controller)**

Paths: `frontend/app/composables/useTimelineStore.ts`, `frontend/app/components/vue-canvas/TimelineEditor.vue`, `frontend/tests/unit/timeline-gesture.unit.spec.ts`
Message: `feat(timeline): ripple switch — trimming or deleting closes the gap when it is on`

---

## Later (not in this plan — each needs its own decision)

1. **Export in the browser** (the `mediabunny` library, MPL-2.0; WebAV as the reference). Timeline export is switched off entirely in hosted mode today because the server writes to a shared folder. A browser export would fix that for the consumer product, and the mix from Task 3 is already the audio half of it. Needs a design pass: does the preview engine draw every clip kind well enough to be the export renderer.
2. **Captions.** Caption clips exist in the data model but nothing draws them, in preview or export. SRT/VTT import (OpenCut has good parsers to follow) only makes sense after caption drawing lands.
3. **Keep pitch when audio is sped up** (needs a time-stretch library such as SoundTouch).
4. **Live ripple during the drag** instead of on release.
5. **Markers** on the ruler, as snap targets.
6. **Export to Premiere / Resolve / Final Cut** through OpenTimelineIO (Python, server side).
7. **Saved-format convention** from OpenCut, to adopt at the next `EditState` version bump: each version step is a pure function with its own test and a saved example from that era; steps re-declare old defaults locally; steps only add fields, never delete them.

## Build notes — where the build departed from the text above

- **No limiter node (Task 3).** Web Audio's `DynamicsCompressor` was measured adding ~7% makeup gain to every mix, so a lone clip would export louder than it previews. Replaced by the pure, unit-tested `fitPeak`: the whole mix is turned down only when it would clip.
- **No cache of finished mixes, no `mixSourceKey` (Tasks 1 and 3).** A mix plus upload measured 33 ms, so the cache bought nothing — and it could not be made safe: Sailor's `/view` route keeps a permanent copy of every file it has served, so a deleted mix still looks present through it, and the server skips a missing audio file without complaint (a silent export). Instead each timeline writes ONE file, `timeline_mix_<node id>.wav`, overwritten on every export (`mixFileName`), so exports do not pile sound files up in `input/`.
- **Task 2 review finding judged a false positive.** The gain envelope is scheduled in clip time (like the visual fades), so a reversed clip that starts late because its file is short correctly enters at the envelope's current level.
