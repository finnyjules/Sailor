/**
 * Where the Frame painter's assets come from, when something other than the app wants to say.
 *
 * The painter builds five kinds of asset URL — image layers, clip frames, image fills, shader
 * textures and outline fonts — and loads them by URL into its own caches. The app's URLs point at
 * the server (`/view?…`, `/sailor/…`, `/api/…`). A Frame web export must never reach a server, so
 * its adapter registers a resolver here that answers from the snapshot's inlined data URLs.
 *
 * A CHAIN, not a single slot, and registered for the embed's whole life rather than scoped to one
 * call: clip frames resolve inside an async loader, after an await, so a synchronous scope would
 * not cover them; and two exported Frames can sit on one page. Most recent first; a resolver that
 * does not know a key returns null and the next one is asked; nothing registered ⇒ the fallback,
 * so the app is byte-identical when no export is running.
 *
 * No imports, no DOM, no network — this module travels into the embed bundle.
 */
export type FrameAssetKind = 'image' | 'clipFrame' | 'fillImage' | 'shaderTexture' | 'outlineFont'
export type FrameAssetResolver = (kind: FrameAssetKind, key: string) => string | null | undefined

const resolvers: FrameAssetResolver[] = []

export function registerAssetResolver(r: FrameAssetResolver): () => void {
  resolvers.push(r)
  return () => {
    const i = resolvers.indexOf(r)
    if (i >= 0) resolvers.splice(i, 1)
  }
}

export function resolveAssetUrl(kind: FrameAssetKind, key: string, fallback: string): string {
  for (let i = resolvers.length - 1; i >= 0; i--) {
    const hit = resolvers[i]!(kind, key)
    if (hit) return hit
  }
  return fallback
}

/** Test seam — forget every registered resolver. */
export function __resetAssetResolversForTest(): void {
  resolvers.length = 0
}
