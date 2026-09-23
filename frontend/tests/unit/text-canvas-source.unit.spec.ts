import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TextCanvasSource, staticTextCacheKey } from '../../app/lib/engine/sources/textCanvasSource'
import type { TextClip, TextSpec } from '../../shared/timeline/types'

// TextCanvasSource draws plain 'text' clips as a static card (drawPlainTextClip,
// plainTextClip.ts) rather than every frame — Critical finding: it cached that
// draw behind a bare boolean, so an edit to the clip's words/size/colour/
// alignment never redrew it. This fakes just enough of a 2D context (measureText,
// fillText, plus the no-op calls drawPlainTextClip makes) to drive getFrame()
// headlessly, the way spacetype-clip-render.unit.spec.ts fakes its canvas deps.
function makeFakeCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: (s: string) => ({ width: s.length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    font: '',
    fillStyle: '',
    textBaseline: 'alphabetic',
  }
}

type FakeCtx = ReturnType<typeof makeFakeCtx>

let ctx: FakeCtx

beforeEach(() => {
  ctx = makeFakeCtx()
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ctx,
    }),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function textSpec(overrides: Partial<TextSpec> = {}): TextSpec {
  return {
    text: 'hello world',
    font_size: 40,
    color: '#ffffff',
    bg_color: '#000000',
    align: 'center',
    v_align: 'middle',
    padding: 0.06,
    line_spacing: 1.2,
    ...overrides,
  }
}

function textClip(spec: TextSpec): TextClip {
  return {
    id: 'text-1',
    kind: 'text',
    start_frame: 0,
    in_frame: 0,
    length: 30,
    text: spec,
  }
}

describe('TextCanvasSource — plain text clips', () => {
  it('draws the words on the first frame', async () => {
    const clip = textClip(textSpec({ text: 'hello world' }))
    const source = new TextCanvasSource(clip, 200, 100, 30)

    await source.getFrame(0)

    expect(ctx.fillText).toHaveBeenCalled()
    const drawn = ctx.fillText.mock.calls.map(c => c[0]).join(' ')
    expect(drawn).toContain('hello world')
  })

  it('does not redraw the same clip on a later frame (static card, not per-frame)', async () => {
    const clip = textClip(textSpec({ text: 'hello world' }))
    const source = new TextCanvasSource(clip, 200, 100, 30)

    await source.getFrame(0)
    const callsAfterFirst = ctx.fillText.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    await source.getFrame(10)
    expect(ctx.fillText.mock.calls.length).toBe(callsAfterFirst)
  })

  // This is the fix under test: the timeline store's `update_clip` reducer
  // (shared/timeline/commands.ts) applies an edit via
  // `Object.assign(hit.clip, cmd.patch)` — the SAME clip object TextCanvasSource
  // was constructed with, just with a new `text` spec assigned onto it. Title/
  // lower_third clips already tolerate this because they redraw unconditionally
  // every getFrame() call; plain text clips need their cache key to notice.
  it('redraws with the new words after an edit mutates the clip in place', async () => {
    const clip = textClip(textSpec({ text: 'hello world' }))
    const source = new TextCanvasSource(clip, 200, 100, 30)

    await source.getFrame(0)
    const callsAfterFirst = ctx.fillText.mock.calls.length

    Object.assign(clip, { text: textSpec({ text: 'goodbye moon' }) })

    await source.getFrame(11)

    expect(ctx.fillText.mock.calls.length).toBeGreaterThan(callsAfterFirst)
    const drawnAfterEdit = ctx.fillText.mock.calls.slice(callsAfterFirst).map(c => c[0]).join(' ')
    expect(drawnAfterEdit).toContain('goodbye')
  })

  it('redraws when only size, colour, or alignment change (same words)', async () => {
    const clip = textClip(textSpec())
    const source = new TextCanvasSource(clip, 200, 100, 30)

    await source.getFrame(0)
    const callsAfterFirst = ctx.fillText.mock.calls.length

    Object.assign(clip, { text: textSpec({ color: '#ff0000', font_size: 60, align: 'left' }) })
    await source.getFrame(1)

    expect(ctx.fillText.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })
})

describe('staticTextCacheKey (pure cache key powering the redraw check above)', () => {
  it('is stable for an unchanged spec and canvas size', () => {
    const spec = textSpec()
    expect(staticTextCacheKey(spec, 200, 100)).toBe(staticTextCacheKey({ ...spec }, 200, 100))
  })

  it('changes when the text changes', () => {
    const a = staticTextCacheKey(textSpec(), 200, 100)
    const b = staticTextCacheKey(textSpec({ text: 'different words' }), 200, 100)
    expect(a).not.toBe(b)
  })

  it('changes when size, colour, or alignment change', () => {
    const base = textSpec()
    const baseKey = staticTextCacheKey(base, 200, 100)
    expect(staticTextCacheKey({ ...base, font_size: 80 }, 200, 100)).not.toBe(baseKey)
    expect(staticTextCacheKey({ ...base, color: '#ff0000' }, 200, 100)).not.toBe(baseKey)
    expect(staticTextCacheKey({ ...base, align: 'left' }, 200, 100)).not.toBe(baseKey)
  })

  it('changes when the target canvas size changes', () => {
    const spec = textSpec()
    expect(staticTextCacheKey(spec, 200, 100)).not.toBe(staticTextCacheKey(spec, 400, 100))
  })
})
