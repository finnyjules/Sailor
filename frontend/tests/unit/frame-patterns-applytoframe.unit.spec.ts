import { describe, it, expect, vi } from 'vitest'
import { applyPatternToFrame } from '~/lib/frame/patterns/applyToFrame'

function frameProps() {
  return { sailor_localLayers: [
    { id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2, x: 0.5, y: 0.5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color: '#000', align: 'center', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 },
  ] }
}
const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }

describe('applyPatternToFrame', () => {
  it('records history once and commits once with the title moved', () => {
    const editor = { recordHistory: vi.fn(), commit: vi.fn() }
    const out = applyPatternToFrame({ props: frameProps(), frameW: 800, frameH: 1000, patternId: 'runoff', seed: 7, palette, titleFace: 'Inter', titleWeight: 700, editor })
    expect(out.ok).toBe(true)
    expect(editor.recordHistory).toHaveBeenCalledTimes(1)
    expect(editor.commit).toHaveBeenCalledTimes(1)
    const committed = editor.commit.mock.calls[0][0]
    expect(committed[0].id).toBe('t')
    expect(committed[0].fontFamily).toBe('Inter')       // face untouched
    expect(committed[0].x !== 0.5 || committed[0].y !== 0.5).toBe(true)  // runOff moves it off-centre
    expect(committed[0].fontSize).not.toBe(0.2)          // runOff re-sizes to fit
    expect(out.posterState).toEqual({ patternId: 'runoff', seed: 7 })
  })
  it('is a no-op for an unknown pattern id', () => {
    const editor = { recordHistory: vi.fn(), commit: vi.fn() }
    const out = applyPatternToFrame({ props: frameProps(), frameW: 800, frameH: 1000, patternId: 'nope', seed: 1, palette, titleFace: 'Inter', titleWeight: 700, editor })
    expect(out.ok).toBe(false)
    expect(editor.recordHistory).not.toHaveBeenCalled()
    expect(editor.commit).not.toHaveBeenCalled()
  })
})
