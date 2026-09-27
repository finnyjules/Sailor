import { describe, expect, it } from 'vitest'
import { estimateShotUSD, formatShotUSD } from '~/lib/shotdirector/price'
import { createDefaultShotSheet } from '~/lib/shotdirector/types'
import { videoPriceUsd } from '#shared/pricing/videoRates'
import { SEEDANCE_MAX_INPUT_VIDEO_SECONDS } from '#shared/pricing/videoSettings'

describe('estimateShotUSD', () => {
  it('prices 720p by duration, against the shared Seedance rate card', () => {
    const sheet = createDefaultShotSheet()
    sheet.format.resolution = '720p'
    sheet.format.durationS = 5
    const expected = videoPriceUsd('seedance-2.0', { seconds: 5, resolution: '720p', audio: true, inputVideoSeconds: 0 })
    expect(expected).not.toBeNull()
    expect(estimateShotUSD(sheet)).toBeCloseTo(expected!)
  })

  it('prices 1080p higher', () => {
    const sheet = createDefaultShotSheet()
    sheet.format.resolution = '1080p'
    sheet.format.durationS = 5
    const expected = videoPriceUsd('seedance-2.0', { seconds: 5, resolution: '1080p', audio: true, inputVideoSeconds: 0 })
    expect(estimateShotUSD(sheet)).toBeCloseTo(expected!)
    expect(estimateShotUSD(sheet)).toBeGreaterThan(
      videoPriceUsd('seedance-2.0', { seconds: 5, resolution: '720p', audio: true, inputVideoSeconds: 0 })!,
    )
  })

  it('applies the video-reference uplift (Seedance bills input + output seconds together)', () => {
    const sheet = createDefaultShotSheet()
    sheet.format.resolution = '720p'
    sheet.format.durationS = 5
    sheet.references.push({ kind: 'video', slot: 1, src: 'data:video/mp4;base64,x', role: 'motion-transfer' })
    const expected = videoPriceUsd('seedance-2.0', {
      seconds: 5, resolution: '720p', audio: true, inputVideoSeconds: SEEDANCE_MAX_INPUT_VIDEO_SECONDS,
    })
    expect(estimateShotUSD(sheet)).toBeCloseTo(expected!)
    expect(estimateShotUSD(sheet)).toBeGreaterThan(
      videoPriceUsd('seedance-2.0', { seconds: 5, resolution: '720p', audio: true, inputVideoSeconds: 0 })!,
    )
  })

  it('formats with a tilde and two decimals', () => {
    const sheet = createDefaultShotSheet()
    sheet.format.resolution = '720p'
    sheet.format.durationS = 5
    const expected = videoPriceUsd('seedance-2.0', { seconds: 5, resolution: '720p', audio: true, inputVideoSeconds: 0 })!
    expect(formatShotUSD(sheet)).toBe(`~$${expected.toFixed(2)}`)
  })

  it('prices durationS -1 ("Auto") the same as the profile default duration dispatch would send', () => {
    const auto = createDefaultShotSheet()
    auto.format.resolution = '720p'
    auto.format.durationS = -1
    const five = createDefaultShotSheet()
    five.format.resolution = '720p'
    five.format.durationS = 5
    expect(estimateShotUSD(auto)).toBeCloseTo(estimateShotUSD(five))
  })

  it('follows the chosen model — Veo 3.1 at 8 s / 720p / audio matches videoPriceUsd directly', () => {
    const sheet = createDefaultShotSheet()
    sheet.format.resolution = '720p'
    sheet.format.durationS = 8
    sheet.audio.generate = true
    const expected = videoPriceUsd('veo-3.1', { seconds: 8, resolution: '720p', audio: true, inputVideoSeconds: 0 })
    expect(expected).not.toBeNull()
    expect(estimateShotUSD(sheet, 'veo-3.1')).toBeCloseTo(expected!)
  })

  it('clamps a length Veo cannot render (its profile only allows 8 s) before pricing it', () => {
    const sheet = createDefaultShotSheet()
    sheet.format.resolution = '720p'
    sheet.format.durationS = 100
    const expected = videoPriceUsd('veo-3.1', { seconds: 8, resolution: '720p', audio: true, inputVideoSeconds: 0 })
    expect(estimateShotUSD(sheet, 'veo-3.1')).toBeCloseTo(expected!)
  })

  it('falls back to the legacy flat Seedance table for an id with no shared rate card', () => {
    const sheet = createDefaultShotSheet()
    sheet.format.resolution = '720p'
    sheet.format.durationS = 5
    expect(videoPriceUsd('stub-basic', { seconds: 5, resolution: '720p', audio: true, inputVideoSeconds: 0 })).toBeNull()
    expect(estimateShotUSD(sheet, 'stub-basic')).toBeCloseTo(0.90)
  })
})
