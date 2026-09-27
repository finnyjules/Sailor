import { describe, expect, it } from 'vitest'
import { judgeSameCharacter, parseJudgement } from '~~/server/utils/faceCheck/vision'

describe('parseJudgement', () => {
  it('reads a verdict and note', () => {
    expect(parseJudgement('{"verdict":"different","note":"hair is blue, not black"}'))
      .toEqual({ verdict: 'different', note: 'hair is blue, not black' })
  })
  it('finds the JSON inside extra text and drops an empty note', () => {
    expect(parseJudgement('Here you go: {"verdict":"match","note":""} done')).toEqual({ verdict: 'match' })
  })
  it('maps no-character to no-face', () => {
    expect(parseJudgement('{"verdict":"no-character"}')).toEqual({ verdict: 'no-face' })
  })
  it('never lets a broken answer pass', () => {
    expect(parseJudgement('I think they look alike')).toEqual({ verdict: 'unsure', note: 'Could not read the check' })
    expect(parseJudgement('{"verdict":"yes"}')).toEqual({ verdict: 'unsure', note: 'Could not read the check' })
  })
})

function fakeFetch(status: number, body: unknown) {
  const calls: any[] = []
  const f = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('judgeSameCharacter', () => {
  const img = Buffer.from('jpeg-bytes')
  it('sends both images and the prompt to claude-fable-5 without a thinking field', async () => {
    const { f, calls } = fakeFetch(200, { content: [{ type: 'text', text: '{"verdict":"match"}' }] })
    expect(await judgeSameCharacter(f, 'k', img, img)).toEqual({ verdict: 'match' })
    const body = calls[0].body
    expect(body.model).toBe('claude-fable-5')
    expect(body.thinking).toBeUndefined()
    expect(body.messages[0].content.filter((c: any) => c.type === 'image')).toHaveLength(2)
    expect(body.messages[0].content[0].source.media_type).toBe('image/jpeg')
  })
  it('throws a FaceCheckError on an API error or a refusal', async () => {
    await expect(judgeSameCharacter(fakeFetch(500, { error: { message: 'x' } }).f, 'k', img, img)).rejects.toMatchObject({ code: 'aws' })
    await expect(judgeSameCharacter(fakeFetch(200, { stop_reason: 'refusal', content: [] }).f, 'k', img, img)).rejects.toMatchObject({ code: 'aws' })
  })
})
