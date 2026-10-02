/**
 * The browser gave up on a Shader effect bake (step 3, R11.9c fix round 1,
 * I2): Stop, or a failure partway. Body: { folder: 'shader_bake/<32 hex>' }.
 * Its frames are deleted unless a run has claimed them, and, in hosted,
 * only when every frame in it is the caller's (server/runner/shaderBakeFiles.ts).
 * Unclaimed bakes nobody abandons are swept by age; this call sweeps too.
 */
import { createError, defineEventHandler, readBody } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { abandonShaderBake, bakeFolderOf, sweepShaderBakes } from '../../runner/shaderBakeFiles'
import { canonicalUploadKey, engineDirForType, uploadOwner } from '../../utils/inputUploads'
import { isHosted } from '../../utils/deployMode'
import { assertRateLimit } from '../../lib/rateLimit'

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  assertRateLimit(event, 'shader-bake-abandon', 60)
  const body = (await readBody(event).catch(() => null)) as Record<string, unknown> | null
  const folder = typeof body?.folder === 'string' ? bakeFolderOf(body.folder) : null
  if (!folder) throw createError({ statusCode: 400, message: 'Not a shader bake' })
  const root = engineDirForType('input')
  if (!root) return { removed: false }
  const userId = (event.context.userId as string | undefined) ?? null
  const hosted = isHosted()
  if (hosted && !userId) throw createError({ statusCode: 401, message: 'Sign in required' })
  const owns = async (filename: string) => !hosted || (await uploadOwner(canonicalUploadKey('input', folder, filename))) === userId
  const removed = await abandonShaderBake(root, folder, owns)
  void sweepShaderBakes(root).catch(() => {})
  return { removed }
})
