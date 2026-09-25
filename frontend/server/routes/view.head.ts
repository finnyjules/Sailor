// HEAD /view answers exactly like GET /view (headers, status, no body — Node
// drops the body for HEAD). ComfyUI's aiohttp add_get served HEAD too, and
// callers rely on it to check a file exists (lib/coverBackfill,
// engine/webglPreviewRenderer). Without this route Nitro answered HEAD 404.
export { default } from './view.get'
