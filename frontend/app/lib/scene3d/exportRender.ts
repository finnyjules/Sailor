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
import { fetchShaderFxCatalog } from '~/lib/shaderfx/catalog'
import type { AssetFailure } from '~/lib/scene3d/assetTracker'

/** Where an export gets what is not in the doc. The app loads over its own proxy (`appExportIO`);
 *  a test or another host can hand in its own. */
export interface ExportIO {
  loadRestyle(resultRef: string): Promise<THREE.Texture>
  /** Make the shader-effect catalog available. Optional: without it, a shader fill renders its
   *  fallback until something else loads the catalog. */
  loadShaderCatalog?(): Promise<void>
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

/** Load each restyle result; every one that fails is named. */
export async function loadRestyleTextures(
  refs: readonly string[], io: ExportIO,
): Promise<{ textures: Map<string, THREE.Texture>; failures: AssetFailure[] }> {
  const textures = new Map<string, THREE.Texture>()
  const failures: AssetFailure[] = []
  await Promise.all(refs.map(async (ref) => {
    try { textures.set(ref, await io.loadRestyle(ref)) }
    catch (err) { failures.push({ kind: 'restyle', name: ref, reason: reasonOf(err) }) }
  }))
  return { textures, failures }
}

/** Load the shader-effect catalog when the scene needs it (a shader fill or shader relief). */
export async function ensureShaderCatalog(doc: SceneDoc, io: ExportIO): Promise<AssetFailure[]> {
  if (!io.loadShaderCatalog || !sceneHasShaderFill(doc)) return []
  try { await io.loadShaderCatalog(); return [] }
  catch (err) { return [{ kind: 'texture', name: 'Shader effects', reason: reasonOf(err) }] }
}

/** Hide the floor grid and every visible gizmo helper. Returns what it hid so the caller can
 *  show it again (the editor's own engine keeps drawing its viewport after an export). */
export function hideEditorHelpers(engine: SceneEngine): THREE.Object3D[] {
  const hidden: THREE.Object3D[] = []
  if (engine.grid.visible) { engine.grid.visible = false; hidden.push(engine.grid) }
  for (const h of collectEditorHelpers(engine.scene)) { h.visible = false; hidden.push(h) }
  return hidden
}

/** A fresh engine for one export: the scene synced at t=0, restyle results loaded, the shader
 *  catalog in hand, and every asset settled (or named in `failures`). The caller owns the engine
 *  and disposes it. */
export async function prepareExportEngine(
  doc: SceneDoc, opts: { width: number; height: number; io: ExportIO },
): Promise<{ engine: SceneEngine; failures: AssetFailure[] }> {
  const canvas = document.createElement('canvas')
  const engine = new SceneEngine(canvas, opts.width, opts.height)
  engine.renderer.setPixelRatio(1)              // export pixels are device pixels (spec)
  engine.setSize(opts.width, opts.height)
  // Sync first so the engine's own loads start while the restyle results and catalog load.
  engine.syncFromDoc(applyMotionToDoc(doc, 0).doc)
  const [restyle, catalogFailures] = await Promise.all([
    loadRestyleTextures(restyleRefs(doc), opts.io),
    ensureShaderCatalog(doc, opts.io),
  ])
  // Restyle is applied by the material on the next sync (every export frame syncs).
  engine.setRestyleTextures(restyleTextureMap(doc, restyle.textures))
  // Models can be large: a long deadline. A fresh engine, so no stale failures from earlier syncs.
  const assetFailures = await engine.settleAllAssets({ timeoutMs: 60_000 })
  return { engine, failures: [...assetFailures, ...restyle.failures, ...catalogFailures] }
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

/** `renderExportFrame` for a long-lived engine drawing one frame per call (the Frame's 3D
 *  source): sync the frame's own pose, wait for its assets up to `timeoutMs`, then render.
 *  Failures are not returned — a preview draws what it has. */
export async function renderExportFrameSettled(
  engine: SceneEngine, doc: SceneDoc, t01: number, opts: { timeoutMs: number },
): Promise<HTMLCanvasElement> {
  engine.syncFromDoc(applyMotionToDoc(doc, t01).doc)
  await engine.settleAllAssets({ timeoutMs: opts.timeoutMs })
  return renderExportFrame(engine, doc, t01)
}

/** Restyle results for a long-lived engine: each result is loaded once and kept across frames
 *  (and across engine re-creation — a texture uploads to whichever renderer draws it); a result
 *  the scene no longer points at is released; a result that failed is not retried every frame. */
export interface RestyleLoader {
  apply(engine: SceneEngine, doc: SceneDoc): Promise<void>
  dispose(): void
}

export function createRestyleLoader(io: ExportIO): RestyleLoader {
  const byRef = new Map<string, Promise<THREE.Texture | null>>()
  const release = (ref: string) => {
    void byRef.get(ref)?.then((t) => t?.dispose())
    byRef.delete(ref)
  }
  return {
    async apply(engine, doc) {
      const refs = restyleRefs(doc)
      const wanted = new Set(refs)
      for (const ref of [...byRef.keys()]) if (!wanted.has(ref)) release(ref)
      for (const ref of refs) if (!byRef.has(ref)) byRef.set(ref, io.loadRestyle(ref).catch(() => null))
      const loaded = new Map<string, THREE.Texture>()
      await Promise.all(refs.map(async (ref) => {
        const tex = await byRef.get(ref)
        if (tex) loaded.set(ref, tex)
      }))
      engine.setRestyleTextures(restyleTextureMap(doc, loaded))
    },
    dispose() { for (const ref of [...byRef.keys()]) release(ref) },
  }
}
