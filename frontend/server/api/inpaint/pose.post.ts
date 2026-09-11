/**
 * POST /api/inpaint/pose
 *
 * Put a character into a new body pose. Feeds two images to Google Nano Banana 2
 * (Gemini image) on fal: the CHARACTER (identity to preserve) and a gray 3D
 * artist MANNEQUIN render (the target pose). The model redraws the same
 * character in the mannequin's pose. Spike-validated: identity holds well, pose
 * is adopted (naturalized, not joint-exact) — see project_pose_mannequin_node.
 *
 * Body:
 *   character  string  data URL (or http URL) of the character image
 *   pose       string  data URL of the mannequin pose render
 *   prompt     string  optional extra guidance ("dramatic lighting", outfit notes)
 *   count      number  variations (default 1, max 4)
 *
 * Returns: { images: string[] }  — data URLs (base64), to dodge CORS.
 */
import { assertRateLimit } from '../../lib/rateLimit'
import { poseInput } from '../../utils/inpaintFalInputs'

const APP = 'fal-ai/nano-banana-2/edit'

// The instruction that survived the de-risking spike. Image 1 = character
// (identity source), image 2 = mannequin (pose target). Keeping identity vs.
// adopting the pose is the whole job, so both halves are spelled out explicitly.
const BASE_PROMPT =
  'The first image is a character. The second image is a SURFACE-NORMAL render of a ' +
  'posed 3D mannequin: its colours encode the target body pose AND the exact 3D ' +
  'orientation — which way the body and each limb face. Redraw the EXACT SAME ' +
  'character from the first image — keep their face, hair, skin tone, body type, ' +
  'clothing and art style identical — but pose them to match the second image: limb ' +
  'positions, stance, head angle, AND the whole-body orientation/facing direction ' +
  '(front, three-quarter, side, or back). If the body is turned or facing away, turn ' +
  'the character the same way; do NOT default to a front-facing view. Full body, head ' +
  'to toe, plain neutral studio background, natural and photographic. Output only the ' +
  'character in that pose, never the normal-map render itself.'

interface Body { character?: string; pose?: string; prompt?: string; count?: number }

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'inpaint-pose', 30)
  const body = await readBody<Body>(event)

  if (!body?.character) throw createError({ statusCode: 400, message: 'character image is required' })
  if (!body?.pose) throw createError({ statusCode: 400, message: 'pose (mannequin render) is required' })

  const extra = (body.prompt ?? '').trim()
  const prompt = extra ? `${BASE_PROMPT} Additional direction: ${extra}.` : BASE_PROMPT
  const count = Math.max(1, Math.min(4, Math.round(body.count ?? 1)))

  const images = await Promise.all(
    Array.from({ length: count }, async () => {
      const out = await runFal(APP, poseInput(prompt, body.character as string, body.pose as string), { pollDeadlineMs: 120_000 })
      const url = firstFalImageUrl(out)
      if (!url) throw createError({ statusCode: 502, message: 'fal returned no image' })
      return fetchAsDataUrl(url)
    }),
  )

  return { images, model: APP }
})
