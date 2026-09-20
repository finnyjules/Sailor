/**
 * DEV-ONLY sink for writing a canvas render to the local scratchpad.
 *
 * Exists so a browser-side investigation can hand a PNG back for a human to
 * look at — the tool bridge caps output well below the size of a real render,
 * so base64 cannot come back the way it went out.
 *
 * Refuses outright unless this is a local dev server: `import.meta.dev` is false
 * in any built server, and `deployMode()` is checked as well so a hosted deploy
 * that somehow ran a dev build still gets a 404. It is on the proxy allowlist
 * because the reachability guard requires every route file to be — the gate is
 * the handler, not the routing table.
 */
import { createError, defineEventHandler, readBody } from 'h3'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { deployMode } from '../utils/deployMode'

/** The one directory this may write to. */
const ROOT = '/private/tmp/claude-501'

export default defineEventHandler(async (event) => {
  if (!import.meta.dev || deployMode() !== 'local') {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  const body = await readBody(event)
  const path = typeof body?.path === 'string' ? body.path : ''
  const data = typeof body?.data === 'string' ? body.data : ''
  if (!path || !data) throw createError({ statusCode: 400, statusMessage: 'path and data are required' })

  // Resolve, then confirm containment — never trust the string itself.
  const full = resolve(path)
  if (!full.startsWith(`${ROOT}/`)) {
    throw createError({ statusCode: 400, statusMessage: 'path must be inside the scratchpad root' })
  }
  const bytes = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64')
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, bytes)
  return { ok: true, path: full, bytes: bytes.length }
})
