import { describe, it, expect } from 'vitest'
import { formatPrintSize } from '~/lib/canvas/printSize'

describe('formatPrintSize', () => {
  it('reduces the ratio and shows the pixel size', () => {
    expect(formatPrintSize(1080, 1350)).toBe('4:5 · 1080 × 1350')
    expect(formatPrintSize(1920, 1080)).toBe('16:9 · 1920 × 1080')
    expect(formatPrintSize(1000, 1000)).toBe('1:1 · 1000 × 1000')
  })
  it('falls back to a decimal ratio when the whole numbers are unwieldy', () => {
    expect(formatPrintSize(1200, 628)).toBe('1.91:1 · 1200 × 628')
    expect(formatPrintSize(628, 1200)).toBe('1:1.91 · 628 × 1200')
  })
  it('says when a Frame is responsive, and how long it loops', () => {
    expect(formatPrintSize(1024, 1024, { responsive: true })).toBe('Responsive')
    expect(formatPrintSize(1024, 1024, { responsive: true, loopSec: 6 })).toBe('Responsive · loops 6s')
    expect(formatPrintSize(1080, 1350, { loopSec: 6.4 })).toBe('4:5 · 1080 × 1350 · loops 6s')
  })
  it('shows the live viewing size while a responsive card is being reshaped', () => {
    expect(formatPrintSize(1024, 1024, { responsive: true, viewing: { w: 1440.4, h: 899.6 } })).toBe('Responsive · 1440 × 900')
    expect(formatPrintSize(1024, 1024, { responsive: true, viewing: { w: 1440, h: 900 }, loopSec: 6 })).toBe('Responsive · 1440 × 900 · loops 6s')
    expect(formatPrintSize(1024, 1024, { responsive: true, viewing: undefined })).toBe('Responsive')
    // A fixed Frame ignores a viewing size.
    expect(formatPrintSize(1080, 1350, { viewing: { w: 1440, h: 900 } })).toBe('4:5 · 1080 × 1350')
  })
  it('asks for a size when there is none', () => {
    expect(formatPrintSize(0, 0)).toBe('Set size')
  })
})
