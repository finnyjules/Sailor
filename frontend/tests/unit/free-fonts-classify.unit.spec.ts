import { describe, it, expect } from 'vitest'
import { classifySeedEntry } from '../../scripts/fetch-free-fonts.mjs'

describe('classifySeedEntry', () => {
  it('google source → google', () => {
    expect(classifySeedEntry({ name: 'Sora', source: 'google', googleFamily: 'Sora' })).toBe('google')
  })
  it('self-hosted with a direct font-file URL → download', () => {
    expect(classifySeedEntry({ name: 'BDO Grotesk', source: 'self-hosted', fileUrl: 'https://example.com/BDOGrotesk-Regular.ttf' })).toBe('download')
  })
  it('self-hosted without a file URL → manual', () => {
    expect(classifySeedEntry({ name: 'Cabinet Grotesk', source: 'self-hosted', sourceUrl: 'https://www.fontshare.com/fonts/cabinet-grotesk' })).toBe('manual')
  })
})
