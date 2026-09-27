import { describe, expect, it, vi } from 'vitest'
import {
  castToScore, withFaceScores, faceScoreChip, shotStudioForTake, takeVideoUrl,
  latestShotTakeScores, scoreTakeFrames,
} from '~/lib/shotdirector/takeScores'
import type { TakeFaceScore } from '#shared/characters/types'

const studio = (id: string, targetId: string | undefined, cast: any[] = [{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }]) => ({
  id,
  data: { nodeType: 'ShotDirector', properties: { sailor_shotDirector: { cast }, sailor_shotDirectorTargetId: targetId } },
})
const node = (id: string, nodeType: string, extra: any = {}) => ({ id, data: { nodeType, ...extra } })
const edge = (source: string, target: string) => ({ source, target })

describe('castToScore', () => {
  it('returns slug + stateId per cast member', () => {
    const s = studio('1', '2', [
      { slug: 'reva', name: 'Reva', via: 'picker', stateId: null },
      { slug: 'cal', name: 'Cal', via: 'wire', stateId: 'wet' },
    ])
    expect(castToScore(s.data)).toEqual([{ slug: 'reva', stateId: null }, { slug: 'cal', stateId: 'wet' }])
  })
  it('is empty with no sheet or no cast', () => {
    expect(castToScore(undefined)).toEqual([])
    expect(castToScore({ properties: {} })).toEqual([])
    expect(castToScore(studio('1', '2', []).data)).toEqual([])
  })
})

describe('withFaceScores', () => {
  const scores: TakeFaceScore[] = [{ slug: 'reva', name: 'Reva', best: 96, verdict: 'match' }]
  const data = { takes: [{ id: 'a', createdAt: 1, promptId: 'p1' }, { id: 'b', createdAt: 2, promptId: 'p2' }], activeTakeId: 'b' }

  it('sets scores on the named take only', () => {
    const next = withFaceScores(data, 'b', scores)
    expect(next.takes![1]!.faceScores).toEqual(scores)
    expect(next.takes![0]).toBe(data.takes[0])
    expect(next.activeTakeId).toBe('b')
    expect((data.takes[1] as any).faceScores).toBeUndefined() // input untouched
  })
  it('leaves a take that already has scores alone', () => {
    const scored = withFaceScores(data, 'b', scores)
    const again = withFaceScores(scored, 'b', [{ slug: 'reva', name: 'Reva', best: 10, verdict: 'different' }])
    expect(again).toBe(scored)
  })
  it('is a no-op for an unknown take', () => {
    expect(withFaceScores(data, 'zzz', scores)).toBe(data)
  })
})

describe('faceScoreChip', () => {
  it('numeric match is plain', () => {
    expect(faceScoreChip({ slug: 'reva', name: 'Reva', best: 96.4, verdict: 'match' }))
      .toEqual({ text: 'Reva 96', tone: 'plain', tip: 'Looks like Reva' })
  })
  it('unsure and different are amber', () => {
    expect(faceScoreChip({ slug: 'reva', name: 'Reva', best: 58, verdict: 'unsure' }))
      .toEqual({ text: 'Reva 58', tone: 'amber', tip: 'May not be Reva' })
    expect(faceScoreChip({ slug: 'reva', name: 'Reva', best: 12, verdict: 'different' }))
      .toEqual({ text: 'Reva 12', tone: 'amber', tip: "Doesn't look like Reva" })
  })
  it('no face', () => {
    expect(faceScoreChip({ slug: 'reva', name: 'Reva', best: null, verdict: 'no-face' }))
      .toEqual({ text: 'Reva: no face', tone: 'plain', tip: 'No face found' })
  })
  it('anime: no number, verdict in the tone and tip, note appended', () => {
    expect(faceScoreChip({ slug: 'reva', name: 'Reva', best: null, verdict: 'match' }))
      .toEqual({ text: 'Reva', tone: 'plain', tip: 'Looks like Reva' })
    expect(faceScoreChip({ slug: 'reva', name: 'Reva', best: null, verdict: 'unsure', note: 'hair is shorter' }))
      .toEqual({ text: 'Reva', tone: 'amber', tip: 'May not be Reva: hair is shorter' })
  })
})

describe('shotStudioForTake', () => {
  const nodes = [studio('1', '2'), node('2', 'FilmShotNode'), node('3', 'Video'), node('4', 'Video'), node('5', 'FilmShotNode')]
  const edges = [edge('1', '2'), edge('2', '3'), edge('5', '4')]

  it('finds the studio whose target feeds the executed Video card', () => {
    expect(shotStudioForTake(nodes, edges, '3')?.id).toBe('1')
  })
  it('finds the studio when the target itself executed', () => {
    expect(shotStudioForTake(nodes, edges, '2')?.id).toBe('1')
  })
  it('null for a card fed by a film node no studio targets', () => {
    expect(shotStudioForTake(nodes, edges, '4')).toBeNull()
  })
  it('null for unrelated nodes', () => {
    expect(shotStudioForTake(nodes, edges, '1')).toBeNull()
    expect(shotStudioForTake(nodes, edges, '99')).toBeNull()
  })
})

describe('takeVideoUrl', () => {
  it('reads videos first, then a video file among images', () => {
    expect(takeVideoUrl({ videos: ['/v.mp4'] } as any)).toBe('/v.mp4')
    expect(takeVideoUrl({ images: ['/view?filename=clip_0001.mp4&type=output&t=1'] } as any))
      .toBe('/view?filename=clip_0001.mp4&type=output&t=1')
  })
  it('null for pictures', () => {
    expect(takeVideoUrl({ images: ['/view?filename=a.png&type=output'] } as any)).toBeNull()
    expect(takeVideoUrl({} as any)).toBeNull()
  })
})

describe('latestShotTakeScores', () => {
  const scores: TakeFaceScore[] = [{ slug: 'reva', name: 'Reva', best: 96, verdict: 'match' }]
  it('shows the latest video take on the cards fed by the target', () => {
    const nodes = [
      studio('1', '2'), node('2', 'FilmShotNode'),
      node('3', 'Video', { takes: [
        { id: 'a', createdAt: 1, promptId: 'p', images: ['/view?filename=a.mp4'], faceScores: [{ ...scores[0], best: 40, verdict: 'different' }] },
        { id: 'b', createdAt: 5, promptId: 'q', images: ['/view?filename=b.mp4'], faceScores: scores },
      ] }),
    ]
    expect(latestShotTakeScores(nodes, [edge('2', '3')], '1')).toEqual(scores)
  })
  it('empty when the latest take has no scores yet', () => {
    const nodes = [studio('1', '2'), node('2', 'FilmShotNode'), node('3', 'Video', { takes: [
      { id: 'a', createdAt: 1, promptId: 'p', images: ['/view?filename=a.mp4'], faceScores: scores },
      { id: 'b', createdAt: 5, promptId: 'q', images: ['/view?filename=b.mp4'] },
    ] })]
    expect(latestShotTakeScores(nodes, [edge('2', '3')], '1')).toEqual([])
    expect(latestShotTakeScores(nodes, [], '1')).toEqual([])
  })
})

describe('scoreTakeFrames', () => {
  const cast = [{ slug: 'reva', stateId: null }, { slug: 'cal', stateId: 'wet' }]
  it('posts every cast member with the frames and keeps the answers', async () => {
    const post = vi.fn(async (body: any) => ({ status: 200, body: { slug: body.slug, name: body.slug.toUpperCase(), scores: [90], best: 90, verdict: 'match' } }))
    const out = await scoreTakeFrames('/v.mp4', cast, { sample: async () => ['data:image/jpeg;base64,AA'], post })
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1]![0]).toEqual({ slug: 'cal', stateId: 'wet', frames: ['data:image/jpeg;base64,AA'] })
    expect(out).toEqual([
      { slug: 'reva', name: 'REVA', best: 90, verdict: 'match' },
      { slug: 'cal', name: 'CAL', best: 90, verdict: 'match' },
    ])
  })
  it('keeps a note, and a 501 is silent and scores nothing for that member', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const post = vi.fn(async (body: any) => body.slug === 'reva'
      ? { status: 501, body: {} }
      : { status: 200, body: { slug: 'cal', name: 'Cal', scores: [], best: null, verdict: 'unsure', note: 'hair' } })
    const out = await scoreTakeFrames('/v.mp4', cast, { sample: async () => ['x'], post })
    expect(out).toEqual([{ slug: 'cal', name: 'Cal', best: null, verdict: 'unsure', note: 'hair' }])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
  it('other failures warn and score nothing for that member', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const post = vi.fn(async () => ({ status: 409, body: { message: 'no face' } }))
    expect(await scoreTakeFrames('/v.mp4', cast, { sample: async () => ['x'], post })).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
  it('no frames → no calls', async () => {
    const post = vi.fn()
    expect(await scoreTakeFrames('/v.mp4', cast, { sample: async () => [], post })).toEqual([])
    expect(post).not.toHaveBeenCalled()
  })
})
