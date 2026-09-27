/**
 * The Anime character checker (spec: Checks). Face matching is trained on
 * real faces, so for drawn characters Claude judges "same character design?"
 * against a checklist. Fictional drawn characters only — never used for
 * Photo characters (identifying real people is outside the usage policy).
 * Transport copies server/api/wardrobe/describe.post.ts.
 */
import type { CheckVerdict } from '#shared/characters/types'
import { extractModelText } from '../../lib/modelText'
import { FaceCheckError } from './rekognition'

export const SAME_CHARACTER_PROMPT = [
  'Image 1 is the approved design of a fictional drawn (anime-style) character. Image 2 is a new picture.',
  'Is the character in image 2 the same character design as image 1?',
  'Compare only: face shape, eye style and colour, hair style and colour, distinctive marks, body proportions.',
  'Ignore pose, expression, camera angle, lighting, background and clothing.',
  'Reply with JSON only: {"verdict":"match"|"unsure"|"different"|"no-character","note":"<the main difference in under 10 words, or empty>"}',
].join('\n')

const VERDICTS: Record<string, CheckVerdict> = { match: 'match', unsure: 'unsure', different: 'different', 'no-character': 'no-face' }
const UNREADABLE = { verdict: 'unsure' as const, note: 'Could not read the check' }

export function parseJudgement(text: string): { verdict: CheckVerdict; note?: string } {
  const m = /\{[\s\S]*?\}/.exec(text)
  if (!m) return UNREADABLE
  let o: any
  try { o = JSON.parse(m[0]) } catch { return UNREADABLE }
  const verdict = VERDICTS[o?.verdict]
  if (!verdict) return UNREADABLE
  const note = typeof o.note === 'string' ? o.note.trim().slice(0, 80) : ''
  return note ? { verdict, note } : { verdict }
}

export async function judgeSameCharacter(fetchImpl: typeof fetch, apiKey: string, source: Buffer, target: Buffer): Promise<{ verdict: CheckVerdict; note?: string }> {
  const img = (b: Buffer) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b.toString('base64') } })
  let res: Response
  try {
    res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-fable-5', // thinking is always on for Fable — do NOT send a `thinking` field
        max_tokens: 256,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: [img(source), img(target), { type: 'text', text: SAME_CHARACTER_PROMPT }] }],
      }),
    })
  } catch (e: any) {
    throw new FaceCheckError('aws', `Character check failed: ${e?.message ?? 'network error'}`)
  }
  if (!res.ok) throw new FaceCheckError('aws', `Character check failed (${res.status})`)
  const data = await res.json() as { stop_reason?: string }
  if (data.stop_reason === 'refusal') throw new FaceCheckError('aws', 'Character check was declined')
  let text: string
  try { text = extractModelText(data) } catch { return UNREADABLE }
  return parseJudgement(text)
}
