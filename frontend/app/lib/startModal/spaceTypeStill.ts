// The Space Type ("expressive") start tile: a SpaceTypeEngine bound to an
// offscreen canvas at the tile's size, set up exactly as SpaceTypeNode sets up a
// FRESH node (default state + the effect's saved default scene, font ensured,
// Showcase images synced), then drawn into the tile. One engine per tile canvas
// is kept across hover frames; disposeSpaceTypeStill() frees them on close.
import type { SpaceTypeEngine } from '~/lib/spacetype/engine'
import type { SpaceTypeState } from '~/lib/spacetype/state'

interface Held { engine: SpaceTypeEngine; state: SpaceTypeState; w: number; h: number }
const held = new Map<HTMLCanvasElement, Promise<Held>>()

async function freshState(): Promise<SpaceTypeState> {
  const [{ defaultSpaceTypeState }, { loadSpaceDefaults, spaceDefaultFor }, { applySceneToState }] = await Promise.all([
    import('~/lib/spacetype/state'),
    import('~/composables/useSpaceDefaults'),
    import('~/lib/spacetype/scene'),
  ])
  await loadSpaceDefaults()
  const base = defaultSpaceTypeState()
  const scene = spaceDefaultFor(base.effectId)
  return scene ? applySceneToState(base, scene) : base
}

async function build(w: number, h: number): Promise<Held> {
  const { detectWebGL } = await import('~/lib/spacetype/webgl')
  if (!detectWebGL()) throw new Error('WebGL is unavailable')
  const [{ SpaceTypeEngine }, { getEffect }, { ensureSpaceTypeStateFont, texOptsFromState }, { DEFAULT_POST }, { syncImageTextures }] = await Promise.all([
    import('~/lib/spacetype/engine'),
    import('~/lib/spacetype/effects'),
    import('~/lib/spacetype/state'),
    import('~/lib/spacetype/post'),
    import('~/lib/spacetype/imageTextures'),
  ])
  const s = await freshState()
  const engine = new SpaceTypeEngine(document.createElement('canvas'), {
    effect: getEffect(s.effectId), width: w, height: h,
    fps: s.fps, loopDuration: s.loopDuration, alpha: s.transparent, bgColor: s.bgColor,
    projection: s.projection ?? 'perspective',
  })
  try {
    await ensureSpaceTypeStateFont(s)
    await syncImageTextures(engine, s.effectId, s.params)
    // Same order as SpaceTypeNode.rebuild().
    engine.setPost({ ...(s.post ?? DEFAULT_POST) })
    engine.setPan(s.panX ?? 0, s.panY ?? 0)
    engine.build(s.params, texOptsFromState(s))
  } catch (e) { engine.dispose(); throw e }
  return { engine, state: s, w, h }
}

/** Draw the Space Type still at `t` seconds into its loop. Throws on no WebGL or a failed render. */
export async function renderSpaceTypeStill(canvas: HTMLCanvasElement, t: number): Promise<void> {
  const w = Math.max(1, canvas.width), h = Math.max(1, canvas.height)
  let pending = held.get(canvas)
  const cur = pending ? await pending.catch(() => null) : null
  if (!cur || cur.w !== w || cur.h !== h) {
    cur?.engine.dispose()
    pending = build(w, h)
    held.set(canvas, pending)
    pending.catch(() => { if (held.get(canvas) === pending) held.delete(canvas) })
  }
  const { engine, state } = await pending!
  engine.renderFrameAt((t / Math.max(0.001, state.loopDuration)) % 1, state.params)
  if (engine.lastError) throw new Error(engine.lastError)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2D context on the tile canvas')
  ctx.clearRect(0, 0, w, h)
  engine.drawFrameInto(ctx, w, h)
}

/** Free every tile's engine (modal close). */
export function disposeSpaceTypeStill(): void {
  for (const p of held.values()) void p.then(h => h.engine.dispose(), () => {})
  held.clear()
}
