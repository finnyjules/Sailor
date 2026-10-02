/**
 * Text on video, family `video-text` (server/runner/video/, R6.8): Text clip
 * and Caption track, against the real Python
 * (scripts/runner_media_fixtures.py --group vfx-text).
 *
 * The user's matching rule, applied to R6.8 by the controller (it overrides
 * ruling (c) and the task text): text must be READABLE and PLACED as Python
 * places it; the letters need not match FreeType's. So:
 *   - EXACT: the timing (which frames show a caption, and which caption: a
 *     frame without one is Python's bytes), Python's line breaks, and each
 *     line's place (to within a pixel or two: the layout is Python's
 *     arithmetic on fontkit's reading of the same font);
 *   - LOOSE: the text's pixels land inside Python's text box (grown by a
 *     margin written below), and the look numbers (the mean difference and
 *     the share of pixels far apart around the text) are printed and held to
 *     a loose bound;
 *   - the font: this Mac's Helvetica where Python finds it, the bundled
 *     DejaVu Sans Bold otherwise, and ONLY the bundled one in hosted (a spy
 *     on the file reads).
 *
 * Plus: the family off leaves the workflow to the engine; rule 12; the
 * limits; the text never reaches the SVG; Stop and an early leave leave no
 * process and no kept file. The plan parts need the real tools (R5 rule 10).
 * VFX_TEXT_LOOKS names a folder for side-by-side PNGs (Python's frame beside
 * the runner's).
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** Every tool process started, by pid (a spy on the process table's side of spawn). */
const PROCS = vi.hoisted(() => ({ pids: [] as number[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: ((...a: Parameters<typeof real.spawn>) => {
      const c = real.spawn(...a)
      if (c.pid) PROCS.pids.push(c.pid)
      return c
    }) as typeof real.spawn,
  }
})

/** Every file read (a spy on readFileSync): which font files text reads. */
const READS = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: ((...a: Parameters<typeof real.readFileSync>) => {
      if (typeof a[0] === 'string') READS.paths.push(a[0])
      return real.readFileSync(...a)
    }) as typeof real.readFileSync,
  }
})

/** A hook in the writer: on its Nth frame, Stop the node, or fail the write (an early leave). */
const HOOK = vi.hoisted(() => ({ puts: 0, at: 0, mode: 'stop' as 'stop' | 'fail', ctl: null as AbortController | null, firedAt: 0 }))
vi.mock('~~/server/media/values', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/values')>()
  return {
    ...real,
    framesSink: ((...a: Parameters<typeof real.framesSink>) => {
      const sink = real.framesSink(...a)
      return {
        ...sink,
        async put(rgb: Uint8Array) {
          if (HOOK.at && ++HOOK.puts === HOOK.at) {
            HOOK.firedAt = Date.now()
            if (HOOK.mode === 'fail') throw new Error('the writer failed (test)')
            HOOK.ctl?.abort()
          }
          return sink.put(rgb)
        },
      }
    }) as typeof real.framesSink,
  }
})

import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { FRAMES_OUTPUTS, MEDIA_EFFECTS_PORTED, MEDIA_EFFECT_OUTPUT_NODES, MEDIA_EFFECT_WORDS, mediaEffectRows, mediaEffectSwitchedClasses } from '#shared/runner/mediaEffects'
import { PICTURE_OUTPUTS } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { LOCAL_LIVE_PREVIEW_SUBFOLDER } from '~~/server/runner/results'
import { workerScript } from '~~/server/runner/compositor/worker'
import { videoCores } from '~~/server/runner/video/cores'
import { CAPTIONS_MAX_CHARS, TEXT_MAX_CHARS, VIDEO_EFFECTS, mediaEffectParams } from '~~/server/runner/video/table'
import { mediaEffectStartProblems } from '~~/server/runner/video/start'
import {
  TEXT_FONT_PATHS, __setTextFontsForTests, bundledFontFile, captionAt, captionPlace, captionSegments, faceAt, textBbox, textClipLayout, textClipMask,
  textFont, textSvgs, wrapText,
} from '~~/server/runner/video/text'
import { captionFeed, captionFontBoxEm, captionLaid, captionLinesAtMost, captionMaxWidth, captionSweep, laidSvgs, textMasks, wrapCaption } from '~~/server/runner/video/text'
import { withWiredValues } from '~~/server/runner/values'
import { requireMediaTools } from './__runner__/mediaParity'
import {
  batchBytes, hash16, invariantAnswers, keptBatch, previewPixels, rule12Pin, runVfxNode, sha256, vfxFixture, vfxHarness, vfxRunId,
  type VfxHarness, type VfxRun,
} from './__runner__/mediaEffectsParity'

type Box = [number, number, number, number]
interface TextRun extends VfxRun {
  font: 'system' | 'bundled'
  layout?: { font: string; maxW: number; sample: Box; lines: { text: string; x: number; y: number; bbox: Box }[] }
  ink?: Box | null
  u8z?: string
  clip?: [number, number, number]
  fontPath?: string
  frames?: { sha256: string; ink: Box | null; crop?: Box; u8z?: string }[]
}
const FX = vfxFixture('vfx-text') as ReturnType<typeof vfxFixture> & { bundled: { path: string; sha256: string } }
const RUNS = FX.runs as TextRun[]
const TEXTS = RUNS.filter(r => r.class_type === 'TextClip')
const CAPS = RUNS.filter(r => r.class_type === 'CaptionTrack')
const LONG = { timeout: 120_000 }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-text'])
const OFF: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-time', 'video-join', 'video-look', 'video-stabilize', 'video-flow', 'video-draw'])
const HELVETICA = '/System/Library/Fonts/Helvetica.ttc'

const scratch = mkdtempSync(join(tmpdir(), 'media-vfx-text-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
afterAll(() => __setTextFontsForTests(null))
let runs = 0

type Link = [string, number]
const unz = (s: string) => new Uint8Array(inflateSync(Buffer.from(s, 'base64')))
const paramsOf = (cls: string, w: Record<string, unknown>) => mediaEffectParams(MEDIA_EFFECT_SCHEMAS[cls], w)

/** The fonts a case ran with: this machine's list, or the bundled file only (the fixture's patch of `_FONT_PATHS`). */
const useFonts = (c: TextRun) => __setTextFontsForTests(c.font === 'bundled' ? { system: [] } : null)

/** The look numbers: printed, and written where VFX_FIGURES names (for the task's report). */
function figuresOut(text: string): void {
  console.info(text)
  if (process.env.VFX_FIGURES) appendFileSync(process.env.VFX_FIGURES, `${text}\n`)
}

/** Caption track's input (the fixture's formula): frame i's pixel (x, y) is ((2x + 5i) & 255, (3y + 7i) & 255, (x + y + 11i) & 255). */
function gradClip(T: number, W: number, H: number): { frames: Uint8Array[]; w: number; h: number } {
  const frames: Uint8Array[] = []
  for (let i = 0; i < T; i++) {
    const f = new Uint8Array(W * H * 3)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 3
        f[o] = (2 * x + 5 * i) & 255
        f[o + 1] = (3 * y + 7 * i) & 255
        f[o + 2] = (x + y + 11 * i) & 255
      }
    }
    frames.push(f)
  }
  return { frames, w: W, h: H }
}

/** The box [x0, y0, x1, y1) where two rgb24 frames differ (null: nowhere). */
function inkBox(a: Uint8Array, b: Uint8Array, W: number): Box | null {
  let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1
  for (let i = 0, p = 0; i < a.length; i += 3, p++) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue
    const x = p % W
    const y = (p - x) / W
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1)
  }
  return x1 < 0 ? null : [x0, y0, x1, y1]
}

/**
 * The loose placement check: the runner's text box inside Python's grown by
 * `m` each side, and Python's inside the runner's grown by `m` (the text
 * neither spills out of Python's place nor shrinks away from it).
 */
function expectPlaced(got: Box | null, py: Box | null, m: number, what: string): void {
  if (!py) { expect(got, what).toBeNull(); return }
  expect(got, what).not.toBeNull()
  for (let k = 0; k < 4; k++) expect(Math.abs(got![k]! - py[k]!), `${what}: edge ${k} of ${JSON.stringify(got)} vs Python's ${JSON.stringify(py)}`).toBeLessThanOrEqual(m)
}

/** The margin a text box may move by: two pixels, or a tenth of the font's size (a letter's hinting and edge). */
const marginOf = (fontSize: number) => Math.max(2, Math.ceil(0.1 * fontSize))

/** The look numbers of two rgb24 crops: the mean difference (255-scale, every channel) and the share of pixels more than 32 apart. */
function lookNumbers(a: ArrayLike<number>, b: ArrayLike<number>): { mean: number; far: number } {
  let sum = 0
  let far = 0
  for (let i = 0; i < a.length; i += 3) {
    let d = 0
    for (let k = 0; k < 3; k++) {
      const e = Math.abs(a[i + k]! - b[i + k]!)
      sum += e
      d = Math.max(d, e)
    }
    if (d > 32) far++
  }
  return { mean: sum / a.length, far: far / (a.length / 3) }
}

/** An rgb24 frame's crop [x0, y0, x1, y1). */
function crop(f: Uint8Array, W: number, c: Box): Uint8Array {
  const w = c[2] - c[0]
  const out = new Uint8Array(w * (c[3] - c[1]) * 3)
  for (let y = c[1]; y < c[3]; y++) out.set(f.subarray((y * W + c[0]) * 3, (y * W + c[2]) * 3), (y - c[1]) * w * 3)
  return out
}

/** Python's frame beside the runner's, as a PNG in VFX_TEXT_LOOKS (for the controller's look). */
async function sideBySide(name: string, py: Uint8Array, got: Uint8Array, w: number, h: number): Promise<void> {
  const dir = process.env.VFX_TEXT_LOOKS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const gap = 8
  const both = new Uint8Array((2 * w + gap) * h * 3).fill(128)
  for (let y = 0; y < h; y++) {
    both.set(py.subarray(y * w * 3, (y + 1) * w * 3), y * (2 * w + gap) * 3)
    both.set(got.subarray(y * w * 3, (y + 1) * w * 3), (y * (2 * w + gap) + w + gap) * 3)
  }
  await sharp(Buffer.from(both), { raw: { width: 2 * w + gap, height: h, channels: 3 } }).png().toFile(join(dir, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`))
}

// ── The graph ────────────────────────────────────────────────────────────────

const made = (cls: string, widgets: Record<string, unknown>) => ({ class_type: cls, inputs: { ...widgets } })
const captioned = (widgets: Record<string, unknown>, from = 'g') => ({ class_type: 'CaptionTrack', inputs: { frames: [from, 0] as Link, ...widgets } })
const getComp = (from = 'l') => ({ class_type: 'GetVideoComponents', inputs: { video: [from, 0] as Link } })
const loadVideo = (file = 'a.mp4') => ({ class_type: 'LoadVideo', inputs: { file } })
const sources = () => ({ l: loadVideo('a.mp4'), g: getComp('l') })
const trimOf = (from: string) => ({ class_type: 'VideoTrim', inputs: { frames: [from, 0] as Link, start: 0, end: -1 } })
const createVideo = (from: string) => ({ class_type: 'CreateVideo', inputs: { images: [from, 0] as Link, fps: 24 } })
const saveVideo = (from: string) => ({ class_type: 'SaveVideo', inputs: { video: [from, 0] as Link, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })
const saveFrames = (from: string) => ({ class_type: 'SaveVideoFrames', inputs: { frames: [from, 0] as Link, fps: 24, filename_prefix: 'video/ComfyUI', crf: 20, audio_file: '(none)' } })

/** A Text clip's frame from the core on this thread (the mask drawn, then blended), as the plan makes it. */
async function textFrame(widgets: Record<string, unknown>): Promise<Uint8Array> {
  const p = paramsOf('TextClip', widgets)
  const state = await textClipMask(p, false)
  const r = videoCores.txt.clip([], p, state, 0, 1)
  return videoCores.vx.toRgb(r.out, 'trunc')
}

// ── The fixture and the font ─────────────────────────────────────────────────

describe('the fixture and the font', () => {
  it('was made from the real nodes, each case with this Mac’s font and with the bundled DejaVu Sans Bold', () => {
    expect(RUNS.filter(r => r.error)).toEqual([])
    expect(TEXTS.length).toBeGreaterThan(20)
    expect(CAPS.length).toBeGreaterThan(20)
    for (const c of RUNS) {
      const used = c.layout?.font ?? c.fontPath
      expect(used, c.name).toBe(c.font === 'bundled' ? FX.bundled.path : HELVETICA)
    }
  })

  it('the bundled file is the one Python ran with, and its licence is beside it', () => {
    const file = bundledFontFile()!
    expect(file).toMatch(/server\/runner\/video\/fonts\/DejaVuSans-Bold\.ttf$/)
    expect(sha256(new Uint8Array(readFileSyncReal(file)))).toBe(FX.bundled.sha256)
    expect(readFileSyncReal(join(file, '..', 'LICENSE_DEJAVU')).toString('utf8')).toContain('Bitstream Vera')
  })

  it('locally: Python’s list in order (Helvetica on this Mac), else the bundled file; hosted: the bundled file only, no system path read', () => {
    __setTextFontsForTests(null)
    expect(textFont(false)!.path).toBe(HELVETICA)
    __setTextFontsForTests({ system: ['/nowhere/a.ttf', '/nowhere/b.ttc'] })
    expect(textFont(false)!.path).toBe(bundledFontFile())
    __setTextFontsForTests(null)
    READS.paths.length = 0
    expect(textFont(true)!.path).toBe(bundledFontFile())
    expect(READS.paths).toEqual([bundledFontFile()])
    for (const p of TEXT_FONT_PATHS) expect(READS.paths).not.toContain(p)
  })

  it('in hosted, a Text clip and a caption read only the bundled font, even with Helvetica on the machine', LONG, async () => {
    __setTextFontsForTests(null)
    READS.paths.length = 0
    await textClipMask(paramsOf('TextClip', TEXTS[0]!.widgets), true)
    const it = (VIDEO_EFFECTS.CaptionTrack!.feed!)(paramsOf('CaptionTrack', CAPS[0]!.widgets), { access: null as never, userId: 'user_1', hosted: true }, [{ count: 96, w: 480, h: 270, exact: true }])
    const first = await (await it)!(null as never)[Symbol.asyncIterator]().next()
    expect((first.value as { _cap: unknown })._cap).not.toBeNull()
    expect(READS.paths.filter(p => /\.(ttf|ttc|otf)$/i.test(p))).toEqual([bundledFontFile()])
  })
})

/** A file's bytes (the spy records the read, then reads it). */
const readFileSyncReal = (p: string): Buffer => readFileSync(p)

// ── Layout: Python's line breaks and places ──────────────────────────────────

describe('Text clip’s layout: Python’s line breaks, each line’s place within a pixel or two', () => {
  const figures: string[] = []
  let edgeBreaks = 0
  afterAll(() => figuresOut(`[text layout] most a line's (x, y) moved off Python's; ${edgeBreaks} of ${TEXTS.length} cases with a word across the edge:\n${figures.join('\n')}`))
  for (const c of TEXTS) {
    it(c.name, () => {
      useFonts(c)
      const p = paramsOf('TextClip', c.widgets)
      const face = faceAt(textFont(false)!.font, p.font_size as number)
      const sample = textBbox(face, 'Ag')
      // The line height's sample: FreeType's hinting can move an edge by a pixel.
      expect(Math.abs((sample[3] - sample[1]) - (c.layout!.sample[3] - c.layout!.sample[1])), 'the line height’s sample').toBeLessThanOrEqual(1)
      const got = textClipLayout(face, p)
      const lines = got.map(l => l.text)
      const want = c.layout!.lines.map(l => l.text)
      // The same words, wrapped at the same width: where FreeType's hinted advances and fontkit's rounded ones
      // differ by a pixel, a word right at the edge may fall on the other side (counted, and at most one word a line).
      expect(lines.join(' ').split(/\s+/), 'the words').toEqual(want.join(' ').split(/\s+/))
      const same = lines.length === want.length && lines.every((l, i) => l === want[i])
      if (!same) {
        edgeBreaks++
        expect(Math.abs(lines.length - want.length), 'the line count').toBeLessThanOrEqual(1)
        for (let i = 0; i < Math.min(lines.length, want.length); i++) {
          const a = lines[i]!.split(' ').length
          const b = want[i]!.split(' ').length
          expect(Math.abs(a - b), `line ${i}: one word across the edge at most`).toBeLessThanOrEqual(1)
        }
      }
      let most = 0
      got.forEach((l, i) => {
        const py = c.layout!.lines[i]!
        if (lines[i] === want[i]) most = Math.max(most, Math.abs(l.x - py.x), Math.abs(l.y - py.y))
        else most = Math.max(most, Math.abs(l.y - py.y))
      })
      figures.push(`  ${c.name}: ${most}${same ? '' : ' (a word across the edge)'}`)
      expect(most, 'a line’s (x, y)').toBeLessThanOrEqual(marginOf(p.font_size as number))
    })
  }
})

describe('Caption track’s timing: EXACT', () => {
  it('the parse and the caption each frame shows are Python’s', () => {
    expect(captionSegments('0 30 Hello\n30 60 Welcome to the show\n60 90 Subscribe please')).toEqual([
      { s: 0, e: 30, text: 'Hello' }, { s: 30, e: 60, text: 'Welcome to the show' }, { s: 60, e: 90, text: 'Subscribe please' },
    ])
    // split(None, 2): the text keeps its own inner spaces, trailing blanks stripped with the line; int() takes signs and underscores.
    expect(captionSegments('x y nope\n2\n3 8\n  10 12   spaced   text  \n-3 2 neg\n1_6 2_0 u\n+20 22 p')).toEqual([
      { s: 10, e: 12, text: 'spaced   text' }, { s: -3, e: 2, text: 'neg' }, { s: 16, e: 20, text: 'u' }, { s: 20, e: 22, text: 'p' },
    ])
    const segs = captionSegments('0 10 First\n5 20 Second\n15 24 Third')
    expect([0, 4, 5, 14, 15, 19, 20, 23, 24].map(i => captionAt(segs, i))).toEqual(['First', 'First', 'Second', 'Second', 'Third', 'Third', 'Third', 'Third', null])
  })
})

// ── Text clip: looks the same ────────────────────────────────────────────────

describe('Text clip on this thread: the text inside Python’s box, the look numbers', () => {
  const figures: string[] = []
  afterAll(() => figuresOut(`[text clip] box edges off Python's (most) | mean difference, pixels > 32 apart around the text | 4 × 4 blocks' ink off Python's (and with no text drawn):\n${figures.join('\n')}`))
  for (const c of TEXTS) {
    it(c.name, LONG, async () => {
      useFonts(c)
      const p = paramsOf('TextClip', c.widgets)
      const W = p.width as number
      const H = p.height as number
      const got = await textFrame(c.widgets)
      const py = unz(c.u8z!)
      expect(got.length).toBe(py.length)
      const bg = new Uint8Array(W * H * 3)
      const ink = videoCores.txt.ink(p.bg_color, [0, 0, 0])
      for (let i = 0; i < W * H; i++) bg.set(ink, 3 * i)
      const box = inkBox(got, bg, W)
      // Where a word fell across the wrap's edge the other way (see the layout's figures), the lines' sides differ.
      const face = faceAt(textFont(false)!.font, p.font_size as number)
      const sameBreaks = JSON.stringify(textClipLayout(face, p).map(l => l.text)) === JSON.stringify(c.layout!.lines.map(l => l.text))
      if (sameBreaks) expectPlaced(box, c.ink ?? null, marginOf(p.font_size as number), 'the text’s box')
      else expectPlaced(box && [c.ink![0], box[1], c.ink![2], box[3]], c.ink ?? null, marginOf(p.font_size as number), 'the text’s box (top and bottom)')
      let line = `  ${c.name}: `
      if (box && c.ink && sameBreaks) {
        const u: Box = [Math.min(box[0], c.ink[0]), Math.min(box[1], c.ink[1]), Math.max(box[2], c.ink[2]), Math.max(box[3], c.ink[3])]
        const n = lookNumbers(crop(got, W, u), crop(py, W, u))
        const colour = videoCores.txt.ink(p.color, [1, 1, 1])
        const cov = (f: Uint8Array) => blockCoverage(crop(f, W, u), u[2] - u[0], ink, colour)
        const blocks = meanAbs(cov(got), cov(py))
        const none = meanAbs(cov(bg), cov(py))
        line += `${Math.max(...box.map((v, k) => Math.abs(v - c.ink![k]!)))} | ${lookLine(n)} | blocks ${blocks.toFixed(3)} (no text: ${none.toFixed(3)})`
        expectLooks(n, 'around the text')
        expect(blocks, 'each 4 × 4 block’s ink, against Python’s').toBeLessThanOrEqual(LOOK_BLOCK_BOUND)
        // The teeth: no text at all is past the bound, and at least twice as far off as the runner's text.
        expect(none, 'the teeth: no text at all').toBeGreaterThan(Math.max(LOOK_BLOCK_BOUND, 2 * blocks))
      }
      else if (!sameBreaks) line += '(a word across the wrap’s edge: the box’s top and bottom only)'
      
      figures.push(line)
      if (/defaults|left top|accented|emoji|512|junk/.test(c.name)) await sideBySide(`text-clip ${c.name}`, py, got, W, H)
    })
  }
})

/**
 * The look bounds (VISUAL, the user's matching rule). The letters are the
 * same font at the same place and size; they differ at their edges
 * (FreeType's hinting thins and snaps stems where sharp's librsvg
 * antialiases the plain outline, so the runner's letters are a touch bolder
 * and a line can sit a pixel off). Around the text (the union of both text
 * boxes; Python's box and 8 pixels more for a caption), where letters cover
 * most pixels, the raw numbers are printed and only loosely held (measured
 * at most a mean of 40 and 29% of pixels, on the 24 × 16 clip that is all
 * outline and the middle-of-the-frame captions). What a reader sees is held
 * tighter on Text clip's plain background: each 4 × 4 block's ink coverage
 * (how much of the block is letter) within LOOK_BLOCK_BOUND of Python's on
 * average (measured at most 0.070, the magenta-on-navy colours with
 * Helvetica), where no text at all is past it and at least twice as far off
 * (the teeth, every case).
 */
const LOOK_MEAN_BOUND = 48
const LOOK_FAR_BOUND = 0.3
const LOOK_BLOCK_BOUND = 0.075
const lookLine = (n: ReturnType<typeof lookNumbers>) => `${n.mean.toFixed(2)}, ${(100 * n.far).toFixed(2)}%`
function expectLooks(n: ReturnType<typeof lookNumbers>, what: string): void {
  expect(n.mean, `${what}: mean difference`).toBeLessThanOrEqual(LOOK_MEAN_BOUND)
  expect(n.far, `${what}: pixels far apart`).toBeLessThanOrEqual(LOOK_FAR_BOUND)
}

/** Each 4 × 4 block's ink coverage (0: background, 1: ink) of an rgb24 crop of width w over a plain background. */
function blockCoverage(a: Uint8Array, w: number, bg: readonly number[], ink: readonly number[]): Float64Array {
  const h = a.length / 3 / w
  let k = 0
  for (let c = 1; c < 3; c++) if (Math.abs(ink[c]! - bg[c]!) > Math.abs(ink[k]! - bg[k]!)) k = c
  const span = ink[k]! - bg[k]!
  const bw = Math.ceil(w / 4)
  const bh = Math.ceil(h / 4)
  const out = new Float64Array(bw * bh)
  const n = new Float64Array(bw * bh)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = (y >> 2) * bw + (x >> 2)
      out[b] += span ? Math.min(1, Math.max(0, (a[(y * w + x) * 3 + k]! - bg[k]!) / span)) : 0
      n[b]++
    }
  }
  for (let b = 0; b < out.length; b++) out[b] /= n[b]!
  return out
}
const meanAbs = (a: Float64Array, b: Float64Array) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length

describe('Text clip through its plan: every frame the one frame, the count, no preview', () => {
  for (const c of TEXTS.filter(r => r.font === 'system' && /defaults|left top|empty/.test(r.name))) {
    it(c.name, LONG, async () => {
      await requireMediaTools()
      useFonts(c)
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const id = c.node_id
      const before = PROCS.pids.length
      const one = await textFrame(c.widgets)
      for (const reader of [trimOf(id), saveFrames(id)]) {
        const got = await runVfxNode(h, { [id]: made('TextClip', c.widgets), r: reader }, id, {}, { runId, families: ON })
        const v = got.values[0] as Extract<RunnerValue, { kind: 'frames' }>
        expect({ count: v.count, w: v.w, h: v.h }).toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h })
        const bytes = await batchBytes(h, runId, v)
        const per = v.w * v.h * 3
        for (let j = 0; j < v.count; j++) expect(sha256(bytes.subarray(j * per, (j + 1) * per)), `frame ${j}`).toBe(sha256(one))
        expect(got.ui).toBeNull()
      }
      for (const pid of PROCS.pids.slice(before)) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    })
  }
})

// ── Caption track: exact timing, text in Python's place ──────────────────────

/** Python's ui as the runner writes it locally (its previews in their own temp subfolder). */
const localUi = (c: TextRun) => ({ ...c.ui, images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: LOCAL_LIVE_PREVIEW_SUBFOLDER, type: im.type })) })

describe('Caption track through its plan: the frames with a caption are Python’s, the rest Python’s bytes; the text in Python’s place', () => {
  const figures: string[] = []
  afterAll(() => figuresOut(`[caption] box edges off Python's (most) | mean difference, pixels > 32 apart around the text | the same with no text drawn:\n${figures.join('\n')}`))
  for (const c of CAPS) {
    it(c.name, LONG, async () => {
      await requireMediaTools()
      useFonts(c)
      const [T, W, H] = c.clip!
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const x = gradClip(T, W, H)
      const values: Record<string, Record<number, RunnerValue>> = { g: { 0: await keptBatch(h, runId, x) } }
      const id = c.node_id
      const before = PROCS.pids.length
      const got = await runVfxNode(h, { ...sources(), [id]: captioned(c.widgets), r: trimOf(id) }, id, values, { runId, families: ON })
      const v = got.values[0] as Extract<RunnerValue, { kind: 'frames' }>
      expect({ count: v.count, w: v.w, h: v.h }).toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h })
      const bytes = await batchBytes(h, runId, v)
      const per = W * H * 3
      const m = marginOf(c.widgets.font_size as number) + (c.widgets.outline_width as number)
      let most = 0
      let wrapped = 0
      const looks: string[] = []
      for (let j = 0; j < T; j++) {
        const f = bytes.subarray(j * per, (j + 1) * per)
        const want = c.frames![j]!
        const box = inkBox(f, x.frames[j]!, W)
        // Timing (EXACT): a caption where Python drew one, none where it didn't (and then Python's very bytes).
        expect(box === null, `frame ${j}: captioned`).toBe(want.ink === null)
        if (!want.ink) { expect(sha256(f), `frame ${j}: unchanged`).toBe(want.sha256); continue }
        // Live-check fix: a caption wider than the frame less its side margins is wrapped (Python's one line ran
        // off the frame): its ink inside the frame, not Python's box. Those that fit are Python's, as before.
        const shown = captionAt(captionSegments(c.widgets.captions), j)!
        const face = faceAt(textFont(false)!.font, c.widgets.font_size as number)
        const wide = textBbox(face, shown)[2] - textBbox(face, shown)[0] > captionMaxWidth(W)
        if (wide) {
          wrapped++
          expect(box![0], `frame ${j}: inside the frame`).toBeGreaterThanOrEqual(0)
          expect(box![2], `frame ${j}: inside the frame`).toBeLessThanOrEqual(W)
          expect(wrapCaption(face, shown, captionMaxWidth(W)).length, `frame ${j}: wrapped`).toBeGreaterThan(1)
          continue
        }
        expectPlaced(box, want.ink, m, `frame ${j}`)
        most = Math.max(most, ...box!.map((b, k) => Math.abs(b - want.ink![k]!)))
        if (want.u8z) {
          const py = unz(want.u8z)
          const n = lookNumbers(crop(f, W, want.crop!), py)
          const none = lookNumbers(crop(x.frames[j]!, W, want.crop!), py)
          looks.push(`${lookLine(n)} (no text: ${lookLine(none)})`)
          expectLooks(n, `frame ${j}, around the text`)
          if (/defaults \[|outline_width max|font_size max|accented|middle/.test(c.name) && looks.length === 1) {
            const pyFull = new Uint8Array(f)
            const cw = want.crop![2] - want.crop![0]
            for (let y = want.crop![1]; y < want.crop![3]; y++) pyFull.set(py.subarray((y - want.crop![1]) * cw * 3, (y - want.crop![1] + 1) * cw * 3), (y * W + want.crop![0]) * 3)
            await sideBySide(`caption ${c.name} frame ${j}`, pyFull, new Uint8Array(f), W, H)
          }
        }
      }
      figures.push(`  ${c.name}: ${most} | ${looks.join('; ') || '(no caption)'}${wrapped ? ` | ${wrapped} frame(s) wrapped` : ''}`)
      expect(got.ui).toEqual(localUi(c))
      const pv = await previewPixels(h, (got.ui as { images: OutputFile[] }).images[0]!)
      const mid = Math.floor(T / 2)
      expect(sha256(pv.px), 'preview: frame T // 2').toBe(sha256(bytes.subarray(mid * per, (mid + 1) * per)))
      for (const pid of PROCS.pids.slice(before)) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    })
  }

  it('read only by an encoder (kept trunc-8), the frames are the same', LONG, async () => {
    await requireMediaTools()
    const c = CAPS.find(r => r.font === 'system' && r.name.startsWith('overlapping'))!
    useFonts(c)
    const [T, W, H] = c.clip!
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const values: Record<string, Record<number, RunnerValue>> = { g: { 0: await keptBatch(h, runId, gradClip(T, W, H)) } }
    const a = await runVfxNode(h, { ...sources(), e: captioned(c.widgets), r: trimOf('e') }, 'e', values, { runId, families: ON })
    const b = await runVfxNode(h, { ...sources(), e: captioned(c.widgets), r: saveFrames('e') }, 'e', values, { runId, families: ON })
    expect(sha256(await batchBytes(h, runId, b.values[0] as Extract<RunnerValue, { kind: 'frames' }>)))
      .toBe(sha256(await batchBytes(h, runId, a.values[0] as Extract<RunnerValue, { kind: 'frames' }>)))
  })
})

// ── The text is never markup ─────────────────────────────────────────────────

describe('the text is the person’s content, never markup or a path', () => {
  it('only numbers and the font’s path data reach the SVG', async () => {
    __setTextFontsForTests(null)
    const face = faceAt(textFont(false)!.font, 44)
    const hostile = '</g><image href="/etc/passwd"/>&amp;<script>x</script> "\' /tmp/x.png'
    const s = textSvgs(face, [captionPlace(face, hostile, { position: 'bottom', y_inset: 0.08 }, 1920, 1080)], 1920, 1080, 2)!
    for (const svg of [s.fill, s.line!]) {
      expect(svg).not.toContain('image')
      expect(svg).not.toContain('passwd')
      expect(svg).not.toContain('script')
      expect(svg).not.toContain('&')
      // Our own tags only.
      expect(svg.match(/<\/?([a-z]+)/g)!.every(t => ['<svg', '<g', '<path', '</g', '</svg'].includes(t))).toBe(true)
    }
    const p = paramsOf('TextClip', { ...TEXTS[0]!.widgets, text: hostile, width: 640, height: 360 })
    const mask = new Uint8Array(await textClipMask(p, false))
    expect(mask.some(v => v > 0)).toBe(true)
  })

  it('a wrapped word longer than the line stays on its own line (Python’s: a line always takes its first word)', () => {
    __setTextFontsForTests(null)
    const face = faceAt(textFont(false)!.font, 72)
    expect(wrapText(face, 'a Supercalifragilisticexpialidocious b', 100)).toEqual(['a', 'Supercalifragilisticexpialidocious', 'b'])
    expect(wrapText(face, '', 100)).toEqual([''])
    expect(wrapText(face, 'x\n\ny', 1000)).toEqual(['x', '', 'y'])
  })
})

// ── The family, rule 12, the limits ──────────────────────────────────────────

describe('the family', () => {
  it('rows: Text clip a local render with no frames in (not an output node); Caption track reads a frame batch and is one', () => {
    const rows = mediaEffectRows()
    for (const cls of ['TextClip', 'CaptionTrack']) {
      expect(MEDIA_EFFECTS_PORTED).toContain(cls)
      expect(mediaEffectSwitchedClasses()[cls]).toBe('video-text')
      expect(FRAMES_OUTPUTS.map(x => x.join(':'))).toContain(`${cls}:0`)
      expect(rows[cls]).toMatchObject({ family: 'video-text', local: 'render' })
    }
    expect(MEDIA_EFFECT_OUTPUT_NODES).toContain('CaptionTrack')
    expect(MEDIA_EFFECT_OUTPUT_NODES).not.toContain('TextClip')
    expect(rows.TextClip!.mustLink).toBeUndefined()
    expect(rows.CaptionTrack).toMatchObject({ mustLink: ['frames'], valueInputs: { frames: ['frames'] }, inputCheck: ['effect-preview-name'] })
    expect(VIDEO_EFFECTS.TextClip!.reads).toBe('generator')
    expect(VIDEO_EFFECTS.CaptionTrack!.reads).toBe('stream')
  })

  it('with video-text off, a workflow with either is left to the engine and the node named', () => {
    const graphs: ApiPrompt[] = [
      { e: made('TextClip', TEXTS[0]!.widgets), c: createVideo('e'), s: saveVideo('c') },
      { ...sources(), e: captioned(CAPS[0]!.widgets), c: createVideo('e'), s: saveVideo('c') },
    ]
    for (const p of graphs) {
      expect(runnerTakesWorkflow(p, new Set<RunnerFamily>([...ON, 'media-video']))).toBe(true)
      for (const fam of [OFF, new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['video-text', 'media-video'])]) {
        expect(runnerTakesWorkflow(p, fam)).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id })).toContain('e')
      }
    }
    // Its frames into Preview image are saved one file per frame (R11.9a, row 15, ruling (q)); a still picture into
    // Caption track leaves the workflow to the engine (ruling (k)).
    expect(runnerTakesWorkflow({ e: made('TextClip', TEXTS[0]!.widgets), p: { class_type: 'PreviewImage', inputs: { images: ['e', 0] } } }, ON)).toBe(true)
    expect(runnerTakesWorkflow({ i: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, e: captioned(CAPS[0]!.widgets, 'i'), c: createVideo('e'), s: saveVideo('c') }, ON)).toBe(false)
  })

  it('rule 12 over the synthetic graphs: with the family off, or on with the tools missing or its media family off, every answer is the pinned one', () => {
    const pin = rule12Pin()
    for (const cls of ['TextClip', 'CaptionTrack']) {
      const g = pin.graphs[`synthetic ${cls}`]!
      expect(g).toBeDefined()
      for (const [set, fam] of Object.entries(pin.sets)) expect(hash16(invariantAnswers(g.prompt, new Set(fam as RunnerFamily[]))), `${cls} ${set}`).toBe(g.answers[set])
      const on = new Set<RunnerFamily>([...pin.sets['every family before R6']! as RunnerFamily[], 'video-text'])
      expect(hash16(invariantAnswers(g.prompt, on))).not.toBe(g.answers['every family before R6'])
      expect(Object.hasOwn(PICTURE_OUTPUTS, cls)).toBe(false)
    }
    expect(PICTURE_OUTPUTS).toEqual(pin.pictureOutputs)
  })

  it('the limits: the batch caps from the widgets, the text’s length, and the font', async () => {
    const at = (p: ApiPrompt, hosted: boolean) => mediaEffectStartProblems(p, ON, { hosted, shapes: new Map() })
    const clip = (w: Record<string, unknown>): ApiPrompt => ({ e: made('TextClip', { ...TEXTS[0]!.widgets, ...w }), c: createVideo('e'), s: saveVideo('c') })
    expect(await at(clip({ width: 1920, height: 1080, frame_count: 300 }), true)).toBeNull()
    expect(await at(clip({ width: 4096, height: 4096, frame_count: 10_000 }), true)).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_WORDS.tooManyFrames })
    expect(await at(clip({ text: 'x'.repeat(TEXT_MAX_CHARS + 1) }), false)).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_EFFECT_WORDS.textTooLong })
    const shapes = new Map([['g:0', { count: 300, w: 1920, h: 1080, exact: true }]])
    const cap = (w: Record<string, unknown>): ApiPrompt => ({ ...sources(), e: captioned({ ...CAPS[0]!.widgets, ...w }), c: createVideo('e'), s: saveVideo('c') })
    expect(await mediaEffectStartProblems(cap({}), ON, { hosted: true, shapes })).toBeNull()
    expect(await mediaEffectStartProblems(cap({ captions: `0 1 ${'x'.repeat(CAPTIONS_MAX_CHARS)}` }), ON, { hosted: true, shapes })).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_EFFECT_WORDS.textTooLong })
    // With no bundled font the classes go to the engine (never reached with the file in place).
    __setTextFontsForTests({ bundled: '/nowhere/DejaVuSans-Bold.ttf' })
    try { expect(await at(clip({}), false)).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_EFFECT_WORDS.textFontMissing }) }
    finally { __setTextFontsForTests(null) }
    // Held bytes stay inside the hosted cap at 4096².
    expect(VIDEO_EFFECTS.TextClip!.heldBytes(paramsOf('TextClip', { ...TEXTS[0]!.widgets, width: 4096, height: 4096 }), [])).toBeLessThan(MEDIA_CAPS.hosted.heldFrameBytes)
  })
})

// ── Stop, and an early leave ─────────────────────────────────────────────────

describe('Stop mid-run, and an early leave', () => {
  let h: VfxHarness
  beforeAll(() => { h = vfxHarness(scratch) })

  it('stopped mid-caption and mid-clip: no tool process left within a second, nothing kept', LONG, async () => {
    await requireMediaTools()
    __setTextFontsForTests(null)
    for (const which of ['caption', 'clip'] as const) {
      const runId = vfxRunId(++runs)
      const values: Record<string, Record<number, RunnerValue>> = { g: { 0: await keptBatch(h, runId, gradClip(60, 320, 180)) } }
      const input = (values.g![0] as Extract<RunnerValue, { kind: 'frames' }>).file.filename
      const before = PROCS.pids.length
      const ctl = new AbortController()
      Object.assign(HOOK, { puts: 0, at: 20, mode: 'stop', ctl })
      const prompt: ApiPrompt = which === 'caption'
        ? { ...sources(), e: captioned({ ...CAPS[0]!.widgets, captions: '0 60 A long caption over every frame' }), r: trimOf('e') }
        : { e: made('TextClip', { ...TEXTS[0]!.widgets, width: 320, height: 180, frame_count: 60 }), r: trimOf('e') }
      try {
        await expect(runVfxNode(h, prompt, 'e', values, { runId, families: ON, signal: ctl.signal })).rejects.toThrow(MEDIA_WORDS.stopped)
        expect(Date.now() - HOOK.firedAt).toBeLessThan(1000)
      }
      finally { Object.assign(HOOK, { at: 0, ctl: null }) }
      const pids = PROCS.pids.slice(before)
      expect(pids.length, which).toBeGreaterThanOrEqual(which === 'caption' ? 2 : 1)
      for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
      expect(readdirSync(join(h.root, 'kept', runId)), which).toEqual([input])
    }
  })

  it('a writer failing mid-run (an early leave), for each: no ffmpeg left, nothing kept', LONG, async () => {
    await requireMediaTools()
    __setTextFontsForTests(null)
    const runId = vfxRunId(++runs)
    const values: Record<string, Record<number, RunnerValue>> = { g: { 0: await keptBatch(h, runId, gradClip(30, 320, 180)) } }
    const input = (values.g![0] as Extract<RunnerValue, { kind: 'frames' }>).file.filename
    const before = PROCS.pids.length
    for (const prompt of [
      { ...sources(), e: captioned({ ...CAPS[0]!.widgets, captions: '0 30 Every frame' }), r: trimOf('e') },
      { e: made('TextClip', { ...TEXTS[0]!.widgets, width: 320, height: 180, frame_count: 30 }), r: trimOf('e') },
    ] as ApiPrompt[]) {
      Object.assign(HOOK, { puts: 0, at: 5, mode: 'fail', ctl: null })
      try { await expect(runVfxNode(h, prompt, 'e', values, { runId, families: ON })).rejects.toThrow('the writer failed (test)') }
      finally { Object.assign(HOOK, { at: 0 }) }
    }
    const pids = PROCS.pids.slice(before)
    expect(pids.length).toBeGreaterThanOrEqual(3)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input])
  })
})

// ── The core in the worker (es2019, from its source text) ────────────────────

describe('the worker builds the text core from its source text', () => {
  it('txt composes into the worker script after vx and look', () => {
    const script = workerScript(compositorCore)
    const at = (name: string) => script.indexOf(`built[${JSON.stringify(name)}] =`)
    expect(at('txt')).toBeGreaterThan(0)
    expect(at('vx')).toBeLessThan(at('txt'))
    expect(at('look')).toBeLessThan(at('txt'))
  })
})

// ── The work figure, measured ────────────────────────────────────────────────

describe('the work figure', () => {
  it('48 frames of 1280 × 720 of each through the real plan: the figure a second, against the slowest pilot’s 2.2 × 10⁷', LONG, async () => {
    await requireMediaTools()
    __setTextFontsForTests(null)
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const lines: string[] = []
    const values: Record<string, Record<number, RunnerValue>> = { g: { 0: await keptBatch(h, runId, gradClip(48, 1280, 720)) } }
    const captions = Array.from({ length: 24 }, (_, i) => `${2 * i} ${2 * i + 2} Caption number ${i} with an outline`).join('\n')
    for (const [cls, prompt, w] of [
      ['TextClip', { e: made('TextClip', { ...TEXTS[0]!.widgets, frame_count: 48, text: 'A text clip over 48 frames' }), r: trimOf('e') }, paramsOf('TextClip', { ...TEXTS[0]!.widgets, frame_count: 48 })],
      ['CaptionTrack', { ...sources(), e: captioned({ ...CAPS[0]!.widgets, captions, outline_width: 12, font_size: 64 }), r: trimOf('e') }, paramsOf('CaptionTrack', { ...CAPS[0]!.widgets, captions, outline_width: 12, font_size: 64 })],
    ] as const) {
      const spec = VIDEO_EFFECTS[cls]!
      const ins = cls === 'CaptionTrack' ? [{ count: 48, w: 1280, h: 720, exact: true }] : []
      const work = spec.work(w, ins, spec.shape(w, ins))
      const t0 = Date.now()
      await runVfxNode(h, prompt as ApiPrompt, 'e', values, { runId, families: ON })
      const s = (Date.now() - t0) / 1000
      lines.push(`${cls}: ${s.toFixed(2)} s, ${(work / s).toExponential(2)} work units a second`)
      expect(work / s, cls).toBeGreaterThan(2.2e7)
    }
    figuresOut(`[work] 48 frames of 1280 × 720: ${lines.join('; ')}`)
  })
})

// ── R8.3: captions wired in (Auto subtitle's Whisper → Caption track) ────────

describe('R8.3: Caption track takes its captions by wire', () => {
  const WHISPER_ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>([...ON, 'media-sound', 'whisper-captions'])
  const whisper = () => ({ class_type: 'WhisperTranscribe', inputs: { audio: ['g', 1] as Link, model_size: 'base', language: 'auto', fps: ['g', 2] as Link } })
  const wiredGraph = (widgets: Record<string, unknown>): ApiPrompt => ({ ...sources(), n: whisper(), e: captioned({ ...widgets, captions: ['n', 0] }), c: createVideo('e'), s: saveVideo('c') })

  it('the row takes a text wire on captions (Whisper, a Text card), and nothing else there', () => {
    expect(mediaEffectRows().CaptionTrack!.valueInputs).toEqual({ frames: ['frames'], captions: ['text'] })
    expect(runnerTakesWorkflow(wiredGraph(CAPS[0]!.widgets), WHISPER_ON)).toBe(true)
    const card: ApiPrompt = { ...sources(), t: { class_type: 'Text', inputs: { text: '0 5 Hello' } }, e: captioned({ ...CAPS[0]!.widgets, captions: ['t', 0] }), c: createVideo('e'), s: saveVideo('c') }
    expect(runnerTakesWorkflow(card, ON)).toBe(true)
    // A frame batch on captions is not text.
    expect(runnerTakesWorkflow({ ...sources(), e: captioned({ ...CAPS[0]!.widgets, captions: ['g', 0] }), c: createVideo('e'), s: saveVideo('c') }, ON)).toBe(false)
  })

  it('with video-text off, the workflow is left to the engine as before, Caption track named', () => {
    const p = wiredGraph(CAPS[0]!.widgets)
    for (const fam of [new Set<RunnerFamily>([...WHISPER_ON].filter(f => f !== 'video-text')), new Set<RunnerFamily>(['cards', 'media-video', 'media-sound'])]) {
      expect(runnerTakesWorkflow(p, fam)).toBe(false)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id })).toContain('e')
    }
  })

  it('Whisper\'s captions by wire give the same batch, byte for byte, as the same text typed in', LONG, async () => {
    await requireMediaTools()
    const c = CAPS.find(r => r.font === 'system' && r.name.startsWith('overlapping'))!
    useFonts(c)
    const [T, W, H] = c.clip!
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const values: Record<string, Record<number, RunnerValue>> = { g: { 0: await keptBatch(h, runId, gradClip(T, W, H)) }, n: { 0: { kind: 'text', text: c.widgets.captions as string } } }
    const typed = await runVfxNode(h, { ...sources(), e: captioned(c.widgets), r: trimOf('e') }, 'e', values, { runId, families: WHISPER_ON })
    // The node's turn as the engine reads it: the wire replaced by Whisper's text.
    const wired = withWiredValues({ ...sources(), n: whisper(), e: captioned({ ...c.widgets, captions: ['n', 0] }), r: trimOf('e') }, 'e', l => values[l[0]]?.[l[1]]).prompt
    expect(wired.e!.inputs!.captions).toBe(c.widgets.captions)
    const got = await runVfxNode(h, wired, 'e', values, { runId, families: WHISPER_ON })
    expect(sha256(await batchBytes(h, runId, got.values[0] as Extract<RunnerValue, { kind: 'frames' }>)))
      .toBe(sha256(await batchBytes(h, runId, typed.values[0] as Extract<RunnerValue, { kind: 'frames' }>)))
  })

  it('a caption longer than the frame holds: only the lines and letters that can land are laid out, and the pixels are the same as with every letter', LONG, async () => {
    __setTextFontsForTests(null)
    const W = 320
    const H = 180
    const long = 'Every letter of this caption is laid out once, but only those that can reach the frame are drawn. '.repeat(40).trim()
    for (const [position, outline] of [['bottom', 3], ['top', 0], ['middle', 8]] as const) {
      const p = paramsOf('CaptionTrack', { ...CAPS[0]!.widgets, captions: `0 2 ${long}`, position, outline_width: outline, font_size: 24 })
      const face = faceAt(textFont(false)!.font, 24)
      const laid = captionLaid(face, long, p, W, H, outline)
      const every = captionLaid(face, long, p, W, H, outline, { every: true })
      expect(long.length).toBeGreaterThan(3000)
      expect(every.lines.length, 'wrapped to many lines').toBeGreaterThan(50)
      expect(laid.lines.length, 'about a frame\'s height of lines').toBeLessThan(15)
      const ref = laidSvgs(face, every.lines, W, H, outline, every.box)
      const cutSvg = laidSvgs(face, laid.lines, W, H, outline, laid.box)
      expect({ x: cutSvg!.x, y: cutSvg!.y, w: cutSvg!.w, h: cutSvg!.h }).toEqual({ x: ref!.x, y: ref!.y, w: ref!.w, h: ref!.h })
      const it = captionFeed(p, false, W, H)[Symbol.asyncIterator]()
      const cut = (await it.next()).value._cap as { fill: Uint8Array; line: Uint8Array | null; x: number; y: number; w: number; h: number }
      const px = async (svg: string) => new Uint8Array((await sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().extractChannel(3).raw().toBuffer()))
      expect(sha256(cut.fill), `${position}: the letters`).toBe(sha256(await px(ref!.fill)))
      expect(cut.line ? sha256(cut.line) : null, `${position}: the outline`).toBe(ref!.line ? sha256(await px(ref!.line)) : null)
      await it.return?.()
    }
  })

  it('live-check fix: a long caption at 640 px wraps between words, every line\'s ink inside the frame, the block kept at its place', LONG, async () => {
    for (const fonts of [null, { system: [] as string[] }]) {
      __setTextFontsForTests(fonts)
      const W = 640
      const H = 360
      const text = 'This is my voice and my lips are moving, and this sentence is far too long for one line.'
      const face = faceAt(textFont(false)!.font, 40)
      expect(textBbox(face, text)[2] - textBbox(face, text)[0]).toBeGreaterThan(W)
      const maxW = W - 2 * Math.trunc(W * 0.05)
      let lastTop = -1
      for (const position of ['bottom', 'middle', 'top'] as const) {
        const p = paramsOf('CaptionTrack', { ...CAPS[0]!.widgets, captions: `0 2 ${text}`, position, outline_width: 3, font_size: 40, y_inset: 0.08 })
        const laid = captionLaid(face, text, p, W, H, 3)
        expect(laid.lines.length, position).toBeGreaterThan(1)
        // Breaks between words only: the words, in order.
        const rows = wrapCaption(face, text, maxW)
        expect(rows.join(' ')).toBe(text)
        for (const r of rows) expect(textBbox(face, r)[2] - textBbox(face, r)[0], r).toBeLessThanOrEqual(maxW)
        // Every line's ink inside the frame (with the side margins).
        const box = laid.box!
        expect(box.l).toBeGreaterThanOrEqual(W * 0.05 - 1)
        expect(box.r).toBeLessThanOrEqual(W - W * 0.05 + 1)
        expect(box.t).toBeGreaterThanOrEqual(0)
        expect(box.b).toBeLessThanOrEqual(H)
        // Bottom grows upward from H − H·inset; top starts at H·inset; middle centred.
        if (position === 'bottom') expect(box.b).toBeGreaterThan(H - H * 0.08 - 12)
        if (position === 'bottom') expect(box.b).toBeLessThanOrEqual(H - H * 0.08 + 12)
        if (position === 'top') expect(box.t).toBeGreaterThan(H * 0.08 - 12)
        if (position === 'middle') expect(Math.abs((box.t + box.b) / 2 - H / 2)).toBeLessThan(12)
        // Each line centred.
        for (const l of laid.lines) {
          const ink = l.glyphs.map(({ g, x }) => [l.x + x + g.bbox.minX * face.s, l.x + x + g.bbox.maxX * face.s])
          const left = Math.min(...ink.map(v => v[0]!))
          const right = Math.max(...ink.map(v => v[1]!))
          expect(Math.abs(left + right - W), 'centred').toBeLessThan(8)
        }
        if (position === 'bottom') lastTop = box.t
      }
      expect(lastTop).toBeGreaterThan(0)
      // A word wider than a line on its own is broken between letters, each piece within the line.
      const word = 'Supercalifragilisticexpialidocious'.repeat(3)
      const pieces = wrapCaption(face, `a ${word} b`, maxW)
      expect(pieces.join('').replace(/ /g, '')).toBe(`a${word}b`)
      for (const r of pieces) expect(textBbox(face, r)[2] - textBbox(face, r)[0], r).toBeLessThanOrEqual(maxW)
    }
    __setTextFontsForTests(null)
    // The sample frame, as the feed draws it over a grey frame.
    const W = 640
    const H = 360
    const p = paramsOf('CaptionTrack', { ...CAPS[0]!.widgets, captions: '0 2 This is my voice and my lips are moving, and this sentence is far too long for one line.', position: 'bottom', outline_width: 3, font_size: 40, y_inset: 0.08 })
    const m = (await captionFeed(p, false, W, H)[Symbol.asyncIterator]().next()).value._cap as { x: number; y: number; w: number; h: number; fill: Uint8Array; line: Uint8Array | null }
    const out = new Uint8Array(W * H * 3).fill(90)
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const k = y * m.w + x
        const o = ((m.y + y) * W + m.x + x) * 3
        const lo = (m.line?.[k] ?? 0) / 255
        const fi = m.fill[k]! / 255
        for (let c = 0; c < 3; c++) out[o + c] = Math.round((out[o + c]! * (1 - lo)) * (1 - fi) + 255 * fi)
      }
    }
    const dir = process.env.R8LOOK_DIR
    if (dir) {
      mkdirSync(dir, { recursive: true })
      await sharp(Buffer.from(out), { raw: { width: W, height: H, channels: 3 } }).png().toFile(join(dir, 'caption_wrapped.png'))
    }
  })

  it('a short caption is laid out whole, its SVG the same as before', () => {
    __setTextFontsForTests(null)
    const p = paramsOf('CaptionTrack', { ...CAPS[0]!.widgets, captions: '0 2 Hello there', outline_width: 3 })
    const face = faceAt(textFont(false)!.font, 44)
    const laid = captionLaid(face, 'Hello there', p, 640, 360, 3)
    expect(laid.lines).toHaveLength(1)
    expect(laidSvgs(face, laid.lines, 640, 360, 3, laid.box)).toEqual(textSvgs(face, [captionPlace(face, 'Hello there', p, 640, 360)], 640, 360, 3))
  })

  it('the start pass\'s bound for wired captions holds for 0, 1 and T captions, and needs no character cap', async () => {
    __setTextFontsForTests(null)
    const spec = VIDEO_EFFECTS.CaptionTrack!
    const T = 600
    const ins = [{ count: T, w: 1920, h: 1080, exact: true }]
    const widgets = { ...CAPS[0]!.widgets, font_size: 96, outline_width: 20 }
    const wired = mediaEffectParams(MEDIA_EFFECT_SCHEMAS.CaptionTrack, { frames: ['g', 0], ...widgets, captions: ['n', 0] })
    expect(wired.captions).toBeUndefined()
    const out = spec.shape(wired, ins)
    const bound = spec.work(wired, ins, out)
    const typedWork = (captions: string) => spec.work(paramsOf('CaptionTrack', { ...widgets, captions }), ins, out)
    const many = Array.from({ length: T }, (_, i) => `${i} ${i + 1} Caption ${i} ${'w'.repeat(i % 50)}`).join('\n')
    for (const captions of ['', '0 600 One caption over every frame', many]) expect(typedWork(captions)).toBeLessThanOrEqual(bound)
    // Typed ones wrapped to several lines too (a long one each frame).
    const longMany = Array.from({ length: T }, (_, i) => `${i} ${i + 1} ${'A long caption wrapped to several lines '.repeat(6)}${i}`).join('\n')
    expect(typedWork(longMany)).toBeGreaterThan(typedWork(many))
    expect(typedWork(longMany)).toBeLessThanOrEqual(bound)
    // Only the font check in the limits for wired captions; at the node's turn, no character cap either.
    expect(spec.limits!(wired, ins).every(f => f.value <= f.limit)).toBe(true)
    const huge = paramsOf('CaptionTrack', { ...widgets, captions: `0 600 ${'x'.repeat(CAPTIONS_MAX_CHARS + 10)}` })
    expect(spec.limits!(huge, ins).some(f => f.value > f.limit), 'typed, at the start: as before').toBe(true)
    expect(spec.limits!(huge, ins, { turn: true }).every(f => f.value <= f.limit), 'at the turn: no character cap').toBe(true)
    // Live-check fix 2: each caption drawn once and its band composited on every frame that shows it, priced as
    // measured. A whole hosted batch (600 frames) with wired captions at the app's default size fits at 360p, 720p
    // and 1080p; past the cap it is refused before the hold (never started and then failed).
    for (const [w, h] of [[640, 360], [1280, 720], [1920, 1080]] as const) {
      const shapes = new Map([['g:0', { count: T, w, h, exact: true }]])
      expect(await mediaEffectStartProblems(wiredGraph({ ...CAPS[0]!.widgets, font_size: 44, outline_width: 3 }), WHISPER_ON, { hosted: true, shapes }), `${w}`).toBeNull()
    }
    const tiny = new Map([['g:0', { count: T, w: 1920, h: 1080, exact: true }]])
    expect(await mediaEffectStartProblems(wiredGraph({ ...CAPS[0]!.widgets, font_size: 8, outline_width: 12 }), WHISPER_ON, { hosted: true, shapes: tiny }))
      .toMatchObject({ nodeId: 'e', message: MEDIA_EFFECT_WORDS.tooMuchWork })
  })

  it('live-check fix 2: one raster per caption shown, the band reused on every frame that shows it', LONG, async () => {
    __setTextFontsForTests(null)
    const p = paramsOf('CaptionTrack', { ...CAPS[0]!.widgets, captions: '0 5 First caption\n5 8 Second caption\n8 12 First caption', outline_width: 3 })
    const svg = vi.spyOn(sharp.prototype, 'toBuffer')
    try {
      const it = captionFeed(p, false, 320, 180)[Symbol.asyncIterator]()
      const caps: unknown[] = []
      for (let i = 0; i < 12; i++) caps.push((await it.next()).value._cap)
      await it.return?.()
      // Three runs, each drawn once (fill and outline: two rasters each), none redrawn a frame.
      expect(svg.mock.calls.length).toBe(6)
      expect(caps.every(Boolean)).toBe(true)
    }
    finally { svg.mockRestore() }
  })

  it('the feed\'s sweep shows the same caption as Python\'s loop on every frame (fix round 1), in one pass over the captions', () => {
    let seed = 7
    const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7FFFFFFF; return seed % n }
    const sets: string[] = CAPS.map(c => c.widgets.captions as string)
    for (let k = 0; k < 200; k++) {
      // Overlaps, repeats, empty and reversed ranges, negative starts, the same text in several captions.
      const n = rnd(40)
      sets.push(Array.from({ length: n }, () => {
        const s0 = rnd(120) - 10
        return `${s0} ${s0 + rnd(30) - 5} T${rnd(6)}`
      }).join('\n'))
    }
    for (const captions of sets) {
      const segs = captionSegments(captions)
      const at = captionSweep(segs)
      for (let i = 0; i < 140; i++) expect(at(i), `${captions.slice(0, 40)} frame ${i}`).toBe(captionAt(segs, i))
    }
    // Asked out of order, it says so rather than answer wrongly.
    const at = captionSweep(captionSegments('0 5 a'))
    at(3)
    expect(() => at(2)).toThrow()
    // A wired text at the value cap's scale: 40,000 captions over 600 frames in well under a second.
    const many = captionSegments(Array.from({ length: 40_000 }, (_, i) => `${i % 600} ${(i % 600) + 3} c${i}`).join('\n'))
    const t0 = Date.now()
    const sweep = captionSweep(many)
    for (let i = 0; i < 600; i++) sweep(i)
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(captionSweep(many)(0)).toBe(captionAt(many, 0))
  })

  it('every caption drawn fits the band the bound counts: at most the frame wide, the font\'s box plus the outline\'s pad high', LONG, async () => {
    for (const fonts of [null, { system: [] as string[] }]) {
      __setTextFontsForTests(fonts)
      const W = 640
      const H = 360
      for (const [fs, ow] of [[20, 0], [44, 3], [96, 12]] as const) {
        const text = 'ÀÉÎÕÜ gjpqy |[]{} Ÿ Å ÇŞ ½ — ‰ ∫ √ ¶ §'
        const p = paramsOf('CaptionTrack', { ...CAPS[0]!.widgets, captions: `0 1 ${text}`, font_size: fs, outline_width: ow, position: 'middle' })
        const m = (await captionFeed(p, false, W, H)[Symbol.asyncIterator]().next()).value._cap as { w: number; h: number }
        expect(m.w).toBeLessThanOrEqual(W)
        const em = captionFontBoxEm() * fs
        const lines = captionLinesAtMost(`0 1 ${text}`, fs, W, ow)
        expect(m.h, `${fs}/${ow}`).toBeLessThanOrEqual(Math.min(H, Math.ceil(em + (lines - 1) * (em * 1.15 + ow)) + 2 * (ow + 2) + 2))
      }
    }
    __setTextFontsForTests(null)
  })
})
