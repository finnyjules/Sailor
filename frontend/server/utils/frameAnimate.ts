/**
 * Pure, h3-free helpers for the Frame Animate route
 * (server/api/frame/animate.post.ts). Kept in their own module so they can
 * be unit-tested under plain vitest: the route itself calls
 * defineEventHandler/createError/readBody at module scope (Nitro
 * auto-imports absent under vitest) and pulls in runFal/
 * uploadToFalStorage, which touch the ledger, moderation and env at import
 * time — importing the route module directly would drag all of that in.
 * These two functions have none of that.
 *
 * Errors thrown here are PLAIN Error objects carrying a `statusCode`
 * property — not h3 errors (no `__h3_error__` marker), so they are NOT
 * `isError()`-recognized by h3. The route must catch and re-wrap them via
 * `createError({ statusCode: e.statusCode, message: e.message })` at the
 * call site so the client still sees the specific status + message instead
 * of Nitro's generic "unhandled" 500 body (h3/Nitro still uses
 * `error.statusCode` for the actual HTTP status even when unhandled, but
 * replaces the JSON `message` with "Server Error" — see
 * nitropack/dist/runtime/internal/error/prod.mjs's `isSensitive` branch).
 */

/** 12 MB — the decoded-image size cap for the Animate route. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function validationError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode })
}

/**
 * Decode a strict `data:image/png;base64,` URL: exact PNG data-URL prefix
 * (400 otherwise), decoded size within MAX_IMAGE_BYTES (413 otherwise), and
 * a real PNG magic-byte header (400 otherwise, catches a mislabeled or
 * truncated payload the prefix check alone would miss).
 */
export function dataUrlBytes(dataUrl: string): Buffer {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) throw validationError('image must be a PNG data URL', 400)

  const bytes = Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64')
  if (bytes.length > MAX_IMAGE_BYTES) throw validationError('image is too large (12 MB max)', 413)

  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) throw validationError('image must be a PNG data URL', 400)
  }
  return bytes
}
