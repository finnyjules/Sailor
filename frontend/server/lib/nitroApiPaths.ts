/**
 * Which `/api/…` paths belong to NITRO rather than to the ComfyUI backend.
 *
 * `server/middleware/comfyui-proxy.ts` forwards everything under the proxy
 * prefixes to ComfyUI unless the path appears here, so a route file that is not
 * listed is answered 405 no matter how correct it is. Three of them shipped that
 * way — the see-first review and both halves of compose-and-pick — and were
 * unreachable in the real app from the day they landed.
 *
 * The lists live in their own module, free of Nitro's auto-imports, so the
 * reachability guard can import the REAL values instead of scraping the
 * middleware's source. A regex over source drifts silently the moment the
 * literal is reformatted, and a guard that can quietly stop seeing anything is
 * worse than no guard.
 */

/** Exact paths Nitro owns. */
export const NITRO_API_PATHS = [
  '/api/explain', '/api/pipeline-suggest', '/api/font-suggest', '/api/secrets',
  '/api/render-template', '/api/lora-preview', '/api/replicate-cover', '/api/google-fonts',
  '/api/loras-local', '/api/lora-cover', '/api/community-workflow', '/api/voices-local',
  '/api/voice-preview-file', '/api/vibe', '/api/vibe-review', '/api/vibe-recipes',
  '/api/vibe-pick', '/api/agent-plan', '/api/agent-review', '/api/image-search',
  '/api/image-fetch', '/api/copy-assist', '/api/ai-status', '/api/dataset-match',
  '/api/training-image', '/api/wallet',
  // Dev-only; the handler 404s unless this is a local dev server.
  '/api/dev-scratch', '/api/dev-looks',
]

/** Prefixes Nitro owns wholesale. */
export const NITRO_API_PREFIXES = [
  '/api/billing', '/api/webhooks', '/api/admin', '/api/templates', '/api/cloud-train',
  '/api/voice-clone', '/api/training-queue', '/api/krea', '/api/vector', '/api/inpaint',
  '/api/house-styles', '/api/brand-kits', '/api/frame-templates', '/api/template-fonts', '/api/library-font',
  '/api/characters-local', '/api/lipsync', '/api/meter', '/api/pool', '/api/scene3d',
  '/api/style-profile', '/api/fonts', '/api/depth', '/api/taste', '/api/moodboards',
  '/api/wardrobe', '/api/frame',
]

/** True when Nitro, not the proxy, should answer this path. */
export function isNitroApiPath(path: string): boolean {
  return NITRO_API_PATHS.includes(path)
    || NITRO_API_PREFIXES.some(p => path === p || path.startsWith(`${p}/`))
}
