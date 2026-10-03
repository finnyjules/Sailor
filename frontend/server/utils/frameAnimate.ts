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

// ── LC10: what one Animate attempt may keep, judged before the paid call ─────

const MIB = 1024 * 1024
/** The model's clip, downloaded: far above any catalog model's few-MB output. */
export const ANIMATE_VIDEO_MAX_BYTES = 512 * MIB
/** The rate the room is planned for (every catalog model renders 24–30 fps). */
export const ANIMATE_PLANNED_FPS = 30
/** The most frames a clip may decode to, per second asked for (twice the plan: never hit by a catalog model). */
export const ANIMATE_MAX_FPS = 60
/** Pixels a model renders at, by its catalog resolution, with 10 % to spare for other aspects. */
const MODEL_PIXELS: Record<string, number> = { '720p': 1280 * 720, '768p': 1366 * 768, '1080p': 1920 * 1080 }

/** The most frames the keyer reads from an attempt of `seconds`. */
export function animateMaxFrames(seconds: number): number {
  return Math.ceil(seconds * ANIMATE_MAX_FPS) + 2
}

/**
 * The bytes an attempt keeps at most, as planned: every frame as raw RGBA
 * (a PNG of a keyed frame is far smaller) at the size the keyer writes
 * (the model's pixels, never above the still's longest edge squared), at
 * ANIMATE_PLANNED_FPS, plus the source clip and clip.json.
 */
export function animateKeptBound(resolution: string, seconds: number, still: { w: number; h: number }): number {
  const model = Math.ceil((MODEL_PIXELS[resolution] ?? 1920 * 1080) * 1.1)
  const edge = Math.max(still.w, still.h)
  const pixels = Math.min(model, edge * edge)
  const frames = Math.ceil(seconds * ANIMATE_PLANNED_FPS) + 2
  return frames * pixels * 4 + ANIMATE_VIDEO_MAX_BYTES + 64 * 1024
}
