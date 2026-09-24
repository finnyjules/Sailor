// The shared export renderer (spec Part 1). Everything that turns a saved scene into export
// pixels goes through here: the pre-rendered bake, the Frame's 3D source and 3D Studio's video
// export — so a fix to "what an exported frame looks like" lands everywhere at once.
//
// What an export frame is, compared with the editor's viewport:
//  - every asset the scene asked for has finished (or is named as failed);
//  - editor helpers are hidden — the floor grid and every gizmo (`isGizmoHelper`);
//  - AI restyle results are loaded (the editor keeps its own cache; a fresh or background engine
//    has none, so it loads them from `resultRef`);
//  - the shader-effect catalog is in hand before the first render when a shader fill or shader
//    relief needs it (`renderMotionFrame`'s `refreshShaderFields` heals the field on that render);
//  - film grain moves with the scene's own clock.
import * as THREE from 'three'
import { SceneEngine } from '~/lib/scene3d/engine'
import { type SceneDoc, sceneHasShaderFill } from '~/lib/scene3d/config'
import { collectEditorHelpers } from '~/lib/scene3d/passes'
import { applyMotionToDoc } from '~/lib/scene3d/motion/apply'
import { renderMotionFrame, sceneLoop } from '~/lib/scene3d/motion/render'
import { objectRestylePlan } from '~/lib/scene3d/treatments'
import { restyleViewUrl } from '~/lib/scene3d/restyleCache'
import { fetchShaderFxCatalog, getEffectSync } from '~/lib/shaderfx/catalog'
import { whenFieldEffectReady } from '~/lib/shaderfill/field'
import { type AssetFailure, beforeDeadline, REASON_DIDNT_FINISH } from '~/lib/scene3d/assetTracker'

/** The export's one deadline: restyle results, the shader catalog and every engine asset all
 *  have to arrive inside it (models can be large). */
export const EXPORT_TIMEOUT_MS = 60_000
/** The Frame preview's one deadline. A Frame pulls every animated slot together and skips ticks
 *  while a pull is out, so one stalled 3D slot must never hold the whole Frame longer than this:
 *  past it the preview draws what it has, and a late load shows on a later frame. */
export const PREVIEW_TIMEOUT_MS = 4000
/** How long a long-lived engine leaves a failed restyle load or catalog fetch before trying it
 *  again — not every frame, not never. */
export const RETRY_AFTER_MS = 10_000

/** Where an export gets what is not in the doc. The app loads over its own proxy (`appExportIO`);
 *  a test or another host can hand in its own. */
export interface ExportIO {
  loadRestyle(resultRef: string): Promise<THREE.Texture>
  /** Make the shader-effect catalog available. Optional: without it, a shader fill renders its
   *  fallback until something else loads the catalog. */
  loadShaderCatalog?(): Promise<void>
  /** Resolves true once a shader effect can draw everything it declares (its images loaded),
   *  false if that has not happened within `timeoutMs`. Optional: without it, an export does not
   *  wait for a shader effect's images. */
  shaderEffectReady?(effectId: string, timeoutMs: number): Promise<boolean>
  /** What a person calls a shader effect ("Liquid chrome"); the id when unknown. */
  shaderEffectLabel?(effectId: string): string
}

export const appExportIO: ExportIO = {
  loadRestyle: (name) => new Promise<THREE.Texture>((resolve, reject) => {
    new THREE.TextureLoader().load(restyleViewUrl(name), (tex) => {
      // Sampled raw by the projective material, like the editor's own restyle load
      // (Scene3DStudioSurface's runRestyle) — tagging it sRGB would darken the surface.
      tex.colorSpace = THREE.NoColorSpace
      resolve(tex)
    }, undefined, () => reject(new Error("couldn't load the restyle result")))
  }),
  // `async` so a synchronous throw (no Nuxt context) becomes a rejection. Cached per page load.
  loadShaderCatalog: async () => { await fetchShaderFxCatalog() },
  // Asked once the catalog is in hand: an effect the catalog does not have will never be ready,
  // so it is not waited for.
  shaderEffectReady: async (id, timeoutMs) => !!getEffectSync(id) && whenFieldEffectReady(id, timeoutMs),
  shaderEffectLabel: id => getEffectSync(id)?.name ?? id,
}

/** Every restyle result the scene draws, once each. Only an object's first ENABLED restyle
 *  counts — the one the engine projects (`objectRestylePlan`). */
export function restyleRefs(doc: SceneDoc): string[] {
  const out = new Set<string>()
  for (const o of doc.objects) {
    const ref = objectRestylePlan(o)?.resultRef
    if (ref) out.add(ref)
  }
  return [...out]
}

/** The engine keys restyle textures by OBJECT id: map each restyled object to its loaded result.
 *  An object whose result is not loaded is left out and draws plain. */
export function restyleTextureMap(doc: SceneDoc, byRef: ReadonlyMap<string, THREE.Texture>): Map<string, THREE.Texture> {
  const out = new Map<string, THREE.Texture>()
  for (const o of doc.objects) {
    const ref = objectRestylePlan(o)?.resultRef
    const tex = ref ? byRef.get(ref) : undefined
    if (tex) out.set(o.id, tex)
  }
  return out
}

function reasonOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "couldn't load"
}

/** Load each restyle result; every one that fails is named. With a `deadline` (epoch ms), a
 *  result still loading at it is named as "didn't finish loading" (and released if it lands). */
export async function loadRestyleTextures(
  refs: readonly string[], io: ExportIO, opts: { deadline?: number } = {},
): Promise<{ textures: Map<string, THREE.Texture>; failures: AssetFailure[] }> {
  const textures = new Map<string, THREE.Texture>()
  const failures: AssetFailure[] = []
  await Promise.all(refs.map(async (ref) => {
    try {
      const load = io.loadRestyle(ref)
      if (!(await beforeDeadline(load, opts.deadline))) {
        failures.push({ kind: 'restyle', name: ref, reason: REASON_DIDNT_FINISH })
        load.then((tex) => tex.dispose(), () => {})
        return
      }
      textures.set(ref, await load)
    } catch (err) { failures.push({ kind: 'restyle', name: ref, reason: reasonOf(err) }) }
  }))
  return { textures, failures }
}

const SHADER_CATALOG = 'Shader effects'
/** The last failed catalog fetch per io, for `retryAfterMs`. */
const catalogFailedAt = new WeakMap<ExportIO, { at: number; reason: string }>()
/** Every io whose catalog has loaded: the catalog is kept for the page's life, so a later call
 *  answers at once — even with no time left to wait (a stalled Frame preview's `timeoutMs: 0`). */
const catalogLoaded = new WeakSet<ExportIO>()

/** Load the shader-effect catalog when the scene needs it (a shader fill or shader relief).
 *  `deadline` (epoch ms): stop waiting at it (the fetch keeps going). `retryAfterMs`: a long-lived
 *  caller's back-off — within that long of a failed fetch, report the failure without fetching
 *  again. An export passes neither back-off nor skip: it always tries. */
export async function ensureShaderCatalog(
  doc: SceneDoc, io: ExportIO, opts: { deadline?: number; retryAfterMs?: number } = {},
): Promise<AssetFailure[]> {
  if (!io.loadShaderCatalog || !sceneHasShaderFill(doc)) return []
  if (catalogLoaded.has(io)) return []
  const last = catalogFailedAt.get(io)
  if (last && opts.retryAfterMs !== undefined && Date.now() - last.at < opts.retryAfterMs) {
    return [{ kind: 'shader', name: SHADER_CATALOG, reason: last.reason }]
  }
  try {
    const load = io.loadShaderCatalog()
    // A late fetch that later fails is still recorded, so the back-off sees it.
    load.catch((err) => { catalogFailedAt.set(io, { at: Date.now(), reason: reasonOf(err) }) })
    if (!(await beforeDeadline(load, opts.deadline))) return [{ kind: 'shader', name: SHADER_CATALOG, reason: REASON_DIDNT_FINISH }]
    catalogFailedAt.delete(io)
    catalogLoaded.add(io)
    return []
  } catch (err) {
    const reason = reasonOf(err)
    catalogFailedAt.set(io, { at: Date.now(), reason })
    return [{ kind: 'shader', name: SHADER_CATALOG, reason }]
  }
}

/** Every shader effect the scene draws — a shader fill's and a shader relief's — once each, by
 *  the same rules as `sceneHasShaderFill` (lights, groups, decals and un-overridden models draw
 *  no material of their own). */
export function sceneShaderEffectIds(doc: SceneDoc): string[] {
  const out = new Set<string>()
  for (const o of doc.objects) {
    if (o.kind === 'light' || o.kind === 'group' || o.kind === 'decal') continue
    if (o.kind === 'glb' && o.materialOverride !== true) continue
    const m = o.material
    if (m.type === 'shaderFill' && m.shader?.effectId) out.add(m.shader.effectId)
    if (m.relief?.source === 'shader' && m.relief.spec?.effectId) out.add(m.relief.spec.effectId)
  }
  return [...out]
}

/** Wait, until `deadline`, for each shader effect the scene draws to have its images (a shader
 *  effect with an image atlas draws a stand-in look until they land) — one that never does is
 *  named. Needs the io's `shaderEffectReady`; skipped without it. */
export async function waitShaderEffects(doc: SceneDoc, io: ExportIO, deadline: number): Promise<AssetFailure[]> {
  const ready = io.shaderEffectReady
  if (!ready) return []
  const ids = sceneShaderEffectIds(doc)
  const ok = await Promise.all(ids.map(id => ready(id, Math.max(0, deadline - Date.now())).catch(() => false)))
  return ids.filter((_, i) => !ok[i]).map(id => ({
    kind: 'shader' as const, name: io.shaderEffectLabel?.(id) ?? id, reason: REASON_DIDNT_FINISH,
  }))
}

/** Hide the floor grid and every visible gizmo helper. Returns what it hid so the caller can
 *  show it again (the editor's own engine keeps drawing its viewport after an export). */
export function hideEditorHelpers(engine: SceneEngine): THREE.Object3D[] {
  const hidden: THREE.Object3D[] = []
  if (engine.grid.visible) { engine.grid.visible = false; hidden.push(engine.grid) }
  for (const h of collectEditorHelpers(engine.scene)) { h.visible = false; hidden.push(h) }
  return hidden
}

/** A fresh engine for one export: restyle results and the shader catalog in hand, the scene
 *  synced at t=0 with both, the shader fields warmed, and every asset that sync started settled
 *  (or named in `failures`) — all inside one deadline (`EXPORT_TIMEOUT_MS`). The caller owns the
 *  engine and disposes it; if preparing it throws, it is disposed here. */
export async function prepareExportEngine(
  doc: SceneDoc, opts: { width: number; height: number; io: ExportIO },
): Promise<{ engine: SceneEngine; failures: AssetFailure[] }> {
  const deadline = Date.now() + EXPORT_TIMEOUT_MS
  const canvas = document.createElement('canvas')
  const engine = new SceneEngine(canvas, opts.width, opts.height)
  try {
    engine.renderer.setPixelRatio(1)              // export pixels are device pixels (spec)
    engine.setSize(opts.width, opts.height)
    // Restyle and the catalog FIRST: the material reads the restyle map at sync time, and a
    // shader fill resolves against the catalog — so the sync below builds the frame-0 materials
    // with both, and whatever that sync starts loading is inside the settle.
    const [restyle, catalogFailures] = await Promise.all([
      loadRestyleTextures(restyleRefs(doc), opts.io, { deadline }),
      ensureShaderCatalog(doc, opts.io, { deadline }),
    ])
    engine.setRestyleTextures(restyleTextureMap(doc, restyle.textures))
    engine.syncFromDoc(applyMotionToDoc(doc, 0).doc)
    // Warm the shader fields once, as `renderMotionFrame` does at t=0, so the images they start
    // (a shader relief's source) are loading before the settle, not after it.
    if (sceneHasShaderFill(doc)) engine.refreshShaderFields(0, false)
    // A fresh engine, so no stale failures from earlier syncs. A shader effect's images load
    // outside the engine (the field cache), so they are waited for beside the settle — only
    // once the catalog is in hand: without it every effect is "not ready", and the catalog is
    // already the one failure worth naming.
    const [assetFailures, effectFailures] = await Promise.all([
      engine.settleAllAssets({ timeoutMs: Math.max(0, deadline - Date.now()) }),
      catalogFailures.length ? [] : waitShaderEffects(doc, opts.io, deadline),
    ])
    return { engine, failures: [...assetFailures, ...restyle.failures, ...catalogFailures, ...effectFailures] }
  } catch (err) {
    engine.dispose()                              // no leaked WebGL context
    throw err
  }
}

/** The exact frame at `t01`, drawn once and synchronously: editor helpers hidden after the sync
 *  (which re-shows the grid) and shown again after the render, film grain on the scene clock. */
export function renderExportFrame(engine: SceneEngine, doc: SceneDoc, t01: number): HTMLCanvasElement {
  let hidden: THREE.Object3D[] = []
  try {
    return renderMotionFrame(engine, doc, t01, {
      beforeRender: (e) => { hidden = hideEditorHelpers(e) },
      elapsedSec: t01 * Math.max(0, sceneLoop(doc).duration),
    })
  } finally {
    for (const h of hidden) h.visible = true
  }
}

/** An export frame's own loads. `prepareExportEngine` settles what the scene needs at t=0, but
 *  a later frame's sync can start more (a decal on a text or mesh object is rebuilt when its
 *  target's geometry changes). Sync `doc` at `t01` and — only when that sync started a load, so
 *  a frame that started nothing pays nothing — wait for it on the export deadline. Returns what
 *  failed (every failure the engine has seen, like `settleAllAssets`); [] when nothing started. */
export async function settleFrameLoads(
  engine: SceneEngine, doc: SceneDoc, t01: number, timeoutMs = EXPORT_TIMEOUT_MS,
): Promise<AssetFailure[]> {
  engine.syncFromDoc(applyMotionToDoc(doc, t01).doc)
  if (!engine.hasPendingAssets()) return []
  return engine.settleAllAssets({ timeoutMs })
}

/** Thrown by an export session's `frame` when that frame's own loads failed (`settleFrameLoads`):
 *  the frame would show a hole where the asset belongs. `assetFailures` is read structurally by
 *  the Frame's 3D source, which names them for the Frame's sheet. */
export class SceneExportFailed extends Error {
  constructor(readonly assetFailures: AssetFailure[]) {
    super(`scene export: ${assetFailures.map(f => `${f.kind} ${f.name}`).join(', ')} couldn't load`)
    this.name = 'SceneExportFailed'
  }
}

/** An export session over a snapshot of `doc` on an engine of its own (`prepareExportEngine`),
 *  apart from any preview engine: `frame(t01)` waits for the loads that frame's sync starts
 *  (`settleFrameLoads`; one that fails rejects with `SceneExportFailed`), then is
 *  `renderExportFrame` on that engine; `close()` disposes it (once; a `frame` after it rejects).
 *  A later edit to `doc` does not reach the session. The Frame's 3D source hands this out as its
 *  `openExport`. */
export async function openSceneExport(
  doc: SceneDoc, size: { width: number; height: number }, io: ExportIO = appExportIO,
): Promise<{ failures: AssetFailure[]; frame(t01: number): Promise<HTMLCanvasElement>; close(): void }> {
  const snap = JSON.parse(JSON.stringify(doc)) as SceneDoc
  const width = Math.max(1, Math.round(size.width)), height = Math.max(1, Math.round(size.height))
  const { engine, failures } = await prepareExportEngine(snap, { width, height, io })
  let closed = false
  return {
    failures,
    async frame(t01) {
      if (closed) throw new Error('scene export session is closed')
      const late = await settleFrameLoads(engine, snap, t01)
      if (late.length) throw new SceneExportFailed(late)
      if (closed) throw new Error('scene export session is closed')
      return renderExportFrame(engine, snap, t01)
    },
    close() {
      if (closed) return
      closed = true
      engine.dispose()
    },
  }
}

/** A long-lived engine's memory that its last pull ran out of time (the Frame's 3D source keeps
 *  one per node). While `stalled`, pulls wait for nothing (`timeoutMs: 0`: render with what is in
 *  hand) — a hung request must cost ONE wait, not one per frame. */
export interface PreviewStall { stalled: boolean }

/** `renderExportFrame` for a long-lived engine drawing one frame per call (the Frame's 3D
 *  source). ONE deadline, `timeoutMs` from now, covers everything it waits for: the restyle
 *  results (`restyle`) and the shader catalog (`io`), then the frame's own assets after the
 *  sync. Past it, it renders with what is in hand — a restyle or catalog still loading shows on a
 *  later frame, as a placeholder always has. Failures are not returned — a preview draws what it
 *  has; a failed restyle or catalog is retried after `RETRY_AFTER_MS`, not every frame.
 *
 *  `stall`: a pull that missed the deadline marks it, and the pulls after it wait for nothing
 *  until a pull finds nothing still loading — then the full `timeoutMs` again. Without it, every
 *  pull waits up to `timeoutMs` while a load hangs, and a Frame pulling every animated slot
 *  together drops to one frame per `timeoutMs`. */
export async function renderExportFrameSettled(
  engine: SceneEngine, doc: SceneDoc, t01: number,
  opts: { timeoutMs: number; restyle?: RestyleLoader; io?: ExportIO; stall?: PreviewStall },
): Promise<HTMLCanvasElement> {
  const deadline = Date.now() + (opts.stall?.stalled ? 0 : opts.timeoutMs)
  const [restyleSettled, catalogFailures] = await Promise.all([
    opts.restyle ? opts.restyle.apply(engine, doc, { deadline }) : true,
    opts.io ? ensureShaderCatalog(doc, opts.io, { deadline, retryAfterMs: RETRY_AFTER_MS }) : [],
  ])
  engine.syncFromDoc(applyMotionToDoc(doc, t01).doc)
  const assetFailures = await engine.settleAllAssets({ timeoutMs: Math.max(0, deadline - Date.now()) })
  if (opts.stall) {
    const late = (f: AssetFailure) => f.reason === REASON_DIDNT_FINISH
    opts.stall.stalled = !restyleSettled || catalogFailures.some(late) || assetFailures.some(late)
  }
  return renderExportFrame(engine, doc, t01)
}

/** Restyle results for a long-lived engine: each result is loaded once and kept across frames
 *  (and across engine re-creation — a texture uploads to whichever renderer draws it); a result
 *  the scene no longer points at is released; a result that failed is tried again after
 *  `RETRY_AFTER_MS`, not every frame. `apply` waits for the scene's results until `deadline`
 *  (epoch ms; none = until they settle) and hands the engine every result in hand by then —
 *  resolving true when every result had settled (loaded or failed), false when the deadline cut
 *  the wait short. `onLate` is called when a result an `apply` stopped waiting for lands after
 *  all — a caller that draws once (a card thumbnail) redraws then. */
export interface RestyleLoader {
  apply(engine: SceneEngine, doc: SceneDoc, opts?: { deadline?: number }): Promise<boolean>
  dispose(): void
}

export function createRestyleLoader(io: ExportIO, opts: { onLate?: () => void } = {}): RestyleLoader {
  interface Entry { settled: Promise<unknown>; done: boolean; tex: THREE.Texture | null; failedAt: number | null; late: boolean }
  const byRef = new Map<string, Entry>()
  const load = (ref: string) => {
    const entry: Entry = { settled: Promise.resolve(), done: false, tex: null, failedAt: null, late: false }
    // Deferred a microtask so a load that throws synchronously is a failure, not a throw from apply.
    entry.settled = Promise.resolve().then(() => io.loadRestyle(ref)).then(
      (tex) => {
        entry.done = true
        if (byRef.get(ref) !== entry) { tex.dispose(); return }   // released meanwhile
        entry.tex = tex
        if (entry.late) opts.onLate?.()
      },
      () => { entry.done = true; entry.failedAt = Date.now() },
    )
    byRef.set(ref, entry)
  }
  const release = (ref: string) => {
    byRef.get(ref)?.tex?.dispose()
    byRef.delete(ref)
  }
  return {
    async apply(engine, doc, applyOpts = {}) {
      const refs = restyleRefs(doc)
      const wanted = new Set(refs)
      for (const ref of [...byRef.keys()]) if (!wanted.has(ref)) release(ref)
      for (const ref of refs) {
        const e = byRef.get(ref)
        if (!e || (e.failedAt !== null && Date.now() - e.failedAt >= RETRY_AFTER_MS)) load(ref)
      }
      // Nothing still loading: no wait at all — with no time left (`deadline` now) it would
      // otherwise read as a miss even though every result is in hand.
      const pending = refs.map((ref) => byRef.get(ref)!).filter((e) => !e.done)
      const settled = !pending.length || await beforeDeadline(Promise.all(pending.map((e) => e.settled)), applyOpts.deadline)
      if (!settled) for (const e of pending) if (!e.tex && e.failedAt === null) e.late = true
      const loaded = new Map<string, THREE.Texture>()
      for (const ref of refs) {
        const tex = byRef.get(ref)?.tex
        if (tex) loaded.set(ref, tex)
      }
      engine.setRestyleTextures(restyleTextureMap(doc, loaded))
      return settled
    },
    dispose() { for (const ref of [...byRef.keys()]) release(ref) },
  }
}
