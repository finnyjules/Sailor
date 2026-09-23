import { describe, expect, it } from 'vitest'
import { initialTicks, continueLabel, viewUrl, isVideoFile } from '~/lib/runner/gateChoices'

describe('Gate choices', () => {
  it('one picture is ticked for you; several start unticked', () => {
    expect(initialTicks([{ take: 0, files: [] }], [0])).toEqual([0])
    expect(initialTicks([{ take: 0, files: [] }, { take: 1, files: [] }], [])).toEqual([])
    expect(initialTicks(null, null)).toEqual([])
    expect(initialTicks([{ take: 2, files: [] }], [5])).toEqual([])
  })
  it('names the Continue button by how many are ticked', () => {
    expect(continueLabel(1, 1)).toBe('Continue')
    expect(continueLabel(4, 2)).toBe('Continue with 2')
    expect(continueLabel(4, 0)).toBe('Tick to continue')
  })
  it('builds viewer links', () => {
    expect(viewUrl({ filename: 'a b.png', subfolder: 'u_1', type: 'output' })).toBe('/view?filename=a+b.png&type=output&subfolder=u_1')
    expect(viewUrl({ filename: 'a.png', subfolder: '', type: 'output' })).toBe('/view?filename=a.png&type=output')
    expect(isVideoFile('x.MP4')).toBe(true)
    expect(isVideoFile('x.png')).toBe(false)
  })
})
