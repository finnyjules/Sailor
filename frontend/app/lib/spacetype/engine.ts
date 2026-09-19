import * as THREE from 'three'
import type { Params, SpaceTypeEffect } from './effect'
import type { TextTextureOptions } from './textTexture'
import { makeTextTexture } from './textTexture'
import { PostChain, DEFAULT_POST, postEnabled, type PostSettings } from './post'
import { stripAlpha } from '~/lib/color/convert'
import { refreshLiveShaderFills, withShaderFillContext, clearShaderFillOwner, updateLiveScreenSize } from './fills'
import { registerWebGLContext, type WebGLContextHandle } from '~/lib/webgl/contextRegistry'

export interface EngineOptions {
  effect: SpaceTypeEffect
  width: number
  height: number
  fps: number
  loopDuration: number
  alpha: boolean
  bgColor: string
  projection?: 'perspective' | 'isometric'
  /** Off-centre framing, in fractions of half the frame (−1…1). Screen-space, so it pans the
   *  composition regardless of projection or scene rotation. */
  panX?: number
  panY?: number
  /** Keep the WebGL drawing buffer after a render so `drawImage`/`toDataURL` is safe
   *  ACROSS an async boundary (default false — the on-screen preview disables it for
   *  perf and never reads back). The off-screen frame-source engine sets this true:
   *  its canvas is drawImage'd into a consumer canvas after an `await`, by which point
   *  a non-preserved buffer has been cleared to transparent black. */
  preserveDrawingBuffer?: boolean
}

// Half-height the perspective camera sees at z=14 (FOV 45°) — the ortho frustum matches it
// so Scale reads the same across projections. Isometric = ORTHOGRAPHIC looking STRAIGHT down
// the axis (parallel projection, no perspective convergence); the axonometric extrude look
// comes from the effect's own tilt (scene rotate / boost tumble), not a tilted camera.
const ORTHO_HALF_H = Math.tan((45 / 2) * Math.PI / 180) * 14
const ISO_EYE = new THREE.Vector3(0, 0, 20)

/** Resident built scene roots. Bounds GPU memory when a timeline holds many
 *  distinct Space Type clips; a miss costs one buildScene(), not correctness. */
export const ROOT_CACHE_LIMIT = 8

/** Source of each engine's stable `id` — see the `id` field below and fills.ts's
 *  ShaderFillBuildContext doc for why a stable per-instance id matters (scoping the shader
 *  field cache/live-field ceiling to the engine that actually owns each fill). */
let _nextEngineId = 1

export class SpaceTypeEngine {
  readonly renderer: THREE.WebGLRenderer
  private readonly ctxHandle: WebGLContextHandle
  readonly scene: THREE.Scene
  /** Stable per-instance id, never reused. Threads through fills.ts's owner-scoped shader
   *  field cache (withShaderFillContext / refreshLiveShaderFills / clearShaderFillOwner) so
   *  this engine's shader fills are never pooled with, starved by, or re-rendered on behalf
   *  of another open Space Type engine. */
  readonly id: string = `st${_nextEngineId++}`
  private perspCam: THREE.PerspectiveCamera
  private orthoCam: THREE.OrthographicCamera
  private effect: SpaceTypeEffect
  private root: THREE.Object3D | null = null
  /** key → built root. Insertion order is LRU order (re-inserted on hit). */
  private rootCache = new Map<string, THREE.Object3D>()
  private activeKey: string | null = null
  private textTex: THREE.Texture | null = null
  private opts: EngineOptions
  private post: PostSettings = DEFAULT_POST
  private postChain: PostChain | null = null
  /** Preloaded image textures keyed by ContentItem.src, threaded into BuildEnv for
   *  tile layouts (e.g. the ring effect). See BuildEnv.imageTextures in effect.ts. */
  private imageTextures: Map<string, THREE.Texture> = new Map()
  private _lastError: string | null = null
  /** Last build/render error (null when the most recent frame succeeded). */
  get lastError(): string | null { return this._lastError }
  private _loggedError = false
  private _frozenFieldCount = 0
  /** Non-zero when one or more shader-fill fields exceeded LIVE_FIELD_CEILING on the last
   *  rendered frame and are showing a frozen (t=0) snapshot instead of animating. The design
   *  forbids silently capping — a surface embedding this engine must show a visible hint when
   *  this is non-zero (see refreshLiveShaderFills in ./fills and beginFieldFrame's doc in
   *  ~/lib/shaderfill/field.ts). */
  get frozenFieldCount(): number { return this._frozenFieldCount }
  /** True while this engine is producing FINAL export output (a bake), as opposed to an
   *  interactive live preview. Threaded into shader-fill field requests so they render at
   *  the engine's actual output size, unclamped, instead of the live-preview
   *  LIVE_FIELD_PX ceiling — the preview/bake split `~/lib/shaderfill/field.ts` documents.
   *  Toggle around a bake render call (see SpaceTypeSurface.vue's Render/Export buttons and
   *  spaceTypeClipRenderer.ts's `bake` param); false is the correct default for the
   *  interactive preview loop, which never sets it. */
  private _bake = false
  setBake(bake: boolean): void { this._bake = bake }

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions) {
    this.opts = opts
    this.effect = opts.effect
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false })
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.setSize(opts.width, opts.height, false)
    this.scene = new THREE.Scene()
    this.perspCam = new THREE.PerspectiveCamera(45, opts.width / opts.height, 0.1, 100)
    this.perspCam.position.set(0, 0, 14)
    const a = opts.width / opts.height
    this.orthoCam = new THREE.OrthographicCamera(-ORTHO_HALF_H * a, ORTHO_HALF_H * a, ORTHO_HALF_H, -ORTHO_HALF_H, 0.1, 200)
    this.orthoCam.position.copy(ISO_EYE)
    this.orthoCam.up.set(0, 1, 0)
    this.orthoCam.lookAt(0, 0, 0)
    this.applyBackground()
    this.ctxHandle = registerWebGLContext('SpaceType')
  }

  private get activeCam(): THREE.Camera {
    return this.opts.projection === 'isometric' ? this.orthoCam : this.perspCam
  }

  /** Switch projection live (perspective ↔ isometric/orthographic). */
  setProjection(mode: 'perspective' | 'isometric'): void {
    this.opts.projection = mode
  }

  /** Off-centre the framing live (−1…1 = half-frame each way). */
  setPan(panX: number, panY: number): void {
    this.opts.panX = panX
    this.opts.panY = panY
  }

  /** Apply (or clear) the screen-space pan as a camera view-offset. Called per frame after the
   *  projection is set up; positive X pans the composition right, positive Y pans it up. */
  private applyPan(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
    const px = this.opts.panX ?? 0, py = this.opts.panY ?? 0
    const w = this.opts.width, h = this.opts.height
    if (px === 0 && py === 0) { cam.clearViewOffset(); return }
    // view-offset X right shifts content left; Y down shifts content up — negate X to match.
    cam.setViewOffset(w, h, -px * w * 0.5, py * h * 0.5, w, h)
  }

  /** Apply opaque-bg vs transparent based on opts.alpha. Renderer is always
   *  constructed with alpha:true; transparency is a render-time clear setting. */
  private applyBackground(): void {
    if (this.opts.alpha) {
      this.scene.background = null
      this.renderer.setClearColor(0x000000, 0)
    } else {
      const c = new THREE.Color(stripAlpha(this.opts.bgColor))
      this.scene.background = c
      this.renderer.setClearColor(c, 1)
    }
  }

  /** Resize the render target + camera aspect (e.g. when output dimensions change). */
  setSize(width: number, height: number): void {
    this.opts.width = width
    this.opts.height = height
    this.renderer.setSize(width, height, false)
    const a = width / height
    this.perspCam.aspect = a
    this.perspCam.updateProjectionMatrix()
    this.orthoCam.left = -ORTHO_HALF_H * a
    this.orthoCam.right = ORTHO_HALF_H * a
    this.orthoCam.top = ORTHO_HALF_H
    this.orthoCam.bottom = -ORTHO_HALF_H
    this.orthoCam.updateProjectionMatrix()
    this.postChain?.setSize(width, height)
  }

  /** Toggle transparency / background color live without rebuilding the renderer. */
  setBackground(alpha: boolean, bgColor: string): void {
    this.opts.alpha = alpha
    this.opts.bgColor = bgColor
    this.applyBackground()
  }

  /** Update loop length so frameCount reflects edits made after construction. */
  setLoopDuration(loopDuration: number): void {
    this.opts.loopDuration = loopDuration
  }

  /** Update fps so frameCount (used by renderFrame/bake) reflects fps edits. */
  setFps(fps: number): void {
    this.opts.fps = fps
  }

  /** Switch the active effect (call rebuild/build afterwards). */
  setEffect(effect: SpaceTypeEffect): void {
    this.effect = effect
  }

  /** Update shared post-processing (bloom / colour / chroma / lens blur). Lazily builds the
   *  composer on first use; when everything is off, renderFrame bypasses it entirely. */
  setPost(post: PostSettings): void {
    this.post = post
    if (!postEnabled(post)) return
    if (!this.postChain) {
      this.postChain = new PostChain(this.renderer, this.scene, this.activeCam, this.opts.width, this.opts.height)
    }
    this.postChain.setSettings(post)
  }

  /** Set the preloaded image textures made available to buildScene via BuildEnv.imageTextures.
   *  Caller must load images (and populate this map) BEFORE calling build/buildKeyed — the
   *  build path is synchronous, so there's no await inside it to wait on late-arriving images.
   *  Disposes every OUTGOING texture that isn't carried over into the new map (by identity) —
   *  the cache in SpaceTypeSurface.vue reloads all srcs into fresh THREE.Texture objects on any
   *  content change, so without this the previous set is orphaned on the GPU every time
   *  (unbounded leak over an editing session). A texture kept at the same identity in both maps
   *  is left alone. There's a one-microtask window where `this.imageTextures` holds textures not
   *  yet consumed by a build — acceptable here because every caller (see rebuildWithRing in
   *  SpaceTypeSurface.vue) calls build() immediately after this, synchronously. */
  setImageTextures(map: Map<string, THREE.Texture>): void {
    const keep = new Set(map.values())
    for (const tex of this.imageTextures.values()) {
      if (!keep.has(tex)) tex.dispose()
    }
    this.imageTextures = map
  }

  private disposeRoot(): void {
    if (!this.root) return
    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.isMesh || (obj as any).isLineSegments) {
        mesh.geometry?.dispose()
        const mat = mesh.material
        if (Array.isArray(mat)) mat.forEach(m => m.dispose())
        else mat?.dispose()
      }
      // Lights (e.g. the shadow-casting DirectionalLight) own a shadow-map render
      // target that leaks unless disposed; Light subclasses' dispose() frees it.
      const light = obj as THREE.Light & { dispose?: () => void }
      if (light.isLight && typeof light.dispose === 'function') light.dispose()
      const tex = obj.userData?.tex as THREE.Texture | undefined
      if (tex && typeof tex.dispose === 'function') tex.dispose()
    })
    this.scene.remove(this.root)
    this.root = null
    const grad = this.textTex?.userData?.gradient as THREE.Texture | undefined
    grad?.dispose?.()
    this.textTex?.dispose()
    this.textTex = null
  }

  /** (Re)build the scene from params; call when structural params change. */
  build(params: Params, texOpts: TextTextureOptions): void {
    try {
      this.disposeRoot()
      const tex = makeTextTexture(texOpts)
      this.textTex = tex
      // Scope any shader fill this build resolves (fillShaderTexture/fillTexture, called deep
      // inside buildScene by whichever effect module) to THIS engine instance — see
      // withShaderFillContext's doc in fills.ts. This MUST stay synchronous (no `await`
      // anywhere in this method or in any effect's buildScene) — withShaderFillContext's
      // re-entrancy guard throws if two builds ever overlap, which is exactly what an
      // `async build()` would risk.
      this.root = withShaderFillContext(
        { ownerId: this.id, w: this.opts.width, h: this.opts.height, bake: this._bake },
        () => this.effect.buildScene(THREE, params, tex, { width: this.opts.width, height: this.opts.height, axes: texOpts.axes, imageTextures: this.imageTextures, loopDuration: this.opts.loopDuration }),
      )
      this.scene.add(this.root)
      this._lastError = null
      this._loggedError = false
    } catch (e) {
      this._lastError = e instanceof Error ? e.message : String(e)
      console.error('[space-type] build failed', e)
    }
  }

  /** Test/debug observability for the pooling invariant. */
  get cachedRootCount(): number { return this.rootCache.size }

  /** Make the root for `key` the active one, building it only on a miss.
   *  Unlike build(), previously built roots are retained and swapped in, so
   *  alternating between clips costs a scene-graph swap rather than a rebuild. */
  buildKeyed(key: string, effect: SpaceTypeEffect, params: Params, texOpts: TextTextureOptions): void {
    if (this.activeKey === key && this.rootCache.has(key)) {
      this.effect = effect
      return
    }

    // Detach whatever is currently mounted; it stays alive in the cache. Also invalidate
    // activeKey right away: build() below swallows exceptions internally, and if it fails
    // this.root stays null, so activeKey must not keep naming a key whose root we just
    // detached — otherwise a later buildKeyed() for that same (still-cached) key would
    // hit the fast path above and return without ever re-mounting anything.
    if (this.root) {
      this.scene.remove(this.root)
      this.activeKey = null
    }

    const hit = this.rootCache.get(key)
    if (hit) {
      this.rootCache.delete(key)   // re-insert to move to MRU position
      this.rootCache.set(key, hit)
      this.effect = effect
      this.root = hit
      this.scene.add(hit)
      this.activeKey = key
      return
    }

    this.effect = effect
    this.root = null              // build() must not dispose a cached root
    this.build(params, texOpts)
    if (this.root) {
      this.rootCache.set(key, this.root)
      this.activeKey = key
      this.evictRoots()
    }
  }

  private evictRoots(): void {
    while (this.rootCache.size > ROOT_CACHE_LIMIT) {
      const oldest = this.rootCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      const obj = this.rootCache.get(oldest)!
      this.rootCache.delete(oldest)
      if (obj === this.root) continue          // never evict the mounted root
      this.scene.remove(obj)
      disposeObject3D(obj)
    }
  }

  /** Drop every cached root, including the mounted one. Fully disposes GPU resources —
   *  callers do not need to follow this with dispose() or disposeRoot() to avoid a leak;
   *  disposeRoot() is idempotent (no-ops once this.root is null), so dispose() calling
   *  both in sequence stays safe rather than double-disposing. */
  clearRootCache(): void {
    for (const [, obj] of this.rootCache) {
      if (obj === this.root) continue   // disposed below, via disposeRoot()
      this.scene.remove(obj)
      disposeObject3D(obj)
    }
    this.rootCache.clear()
    this.activeKey = null
    this.disposeRoot()
  }

  /** Total frames in one loop. */
  get frameCount(): number { return Math.max(1, Math.round(this.opts.fps * this.opts.loopDuration)) }

  /** Render the scene at integer frame index (wraps to one loop). */
  renderFrame(index: number, params: Params): void {
    this.renderFrameAt((index % this.frameCount) / this.frameCount, params)
  }

  /** Render at a normalized loop-time t01 (may exceed 1 — used by the multi-loop seamless export,
   *  where motions must keep their per-loop rate across k loops). At an integer t01 this equals
   *  renderFrame. */
  renderFrameAt(t01: number, params: Params): void {
    try {
      const scale = Number(params.scale ?? 1) || 1
      this.scene.rotation.set(Number(params.rotateX ?? 0), Number(params.rotateY ?? 0), Number(params.rotateZ ?? 0))
      if (this.opts.projection === 'isometric') {
        this.orthoCam.zoom = scale
        this.orthoCam.updateProjectionMatrix()
        this.applyPan(this.orthoCam)
      } else {
        this.perspCam.position.z = 14 / scale
        this.applyPan(this.perspCam)
      }
      this.effect.update(t01, params, this.root ?? undefined)
      // Important 4 (final review): keep a frame-anchored fill's uFillScreen tracking the
      // LIVE render size — setSize() below resizes without a rebuild, so without this the
      // uniform stayed pinned to whatever size the field was built at (see fillScreenVec's
      // doc). Cheap no-op for an owner with no frame-anchored fill.
      updateLiveScreenSize(this.id, this.opts.width, this.opts.height)
      // Advance every live shader-fill field to this frame's time BEFORE the render call reads
      // their textures. t01 * loopDuration gives real elapsed seconds within one loop, matching
      // at a given normalized position between preview and bake (same t01 -> same shader time),
      // consistent with resolveField's own preview/bake parity. Independent of the glyph motion
      // (t01) driving `this.effect.update` above — the field animates on its own clock.
      this._frozenFieldCount = refreshLiveShaderFills(
        this.id, t01 * this.opts.loopDuration, this.opts.fps, this.opts.width, this.opts.height, this._bake,
      ).frozenCount
      if (postEnabled(this.post) && this.postChain) this.postChain.render(this.scene, this.activeCam)
      else this.renderer.render(this.scene, this.activeCam)
      this._lastError = null
      this._loggedError = false
    } catch (e) {
      this._lastError = e instanceof Error ? e.message : String(e)
      // Log once per error transition, not every frame.
      if (!this._loggedError) { console.error('[space-type] render failed', e); this._loggedError = true }
    }
  }

  /** Read the current canvas back as a PNG blob. Forces a fresh render first so this
   *  works without preserveDrawingBuffer (the preview renderer disables it for perf).
   *  If targetW/targetH are smaller than the render size, the caller rendered at a higher
   *  resolution (supersampling/SSAA) — downscale to the target with high-quality smoothing,
   *  which removes the edge aliasing that MSAA alone leaves on texture/text interiors. */
  async frameToBlob(targetW?: number, targetH?: number): Promise<Blob> {
    if (postEnabled(this.post) && this.postChain) this.postChain.render(this.scene, this.activeCam)
    else this.renderer.render(this.scene, this.activeCam)
    const src = this.renderer.domElement
    if (targetW && targetH && (targetW < src.width || targetH < src.height)) {
      const out = document.createElement('canvas')
      out.width = targetW; out.height = targetH
      const ctx = out.getContext('2d')!
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(src, 0, 0, targetW, targetH)
      const blob = await new Promise<Blob | null>(r => out.toBlob(r, 'image/png'))
      if (!blob) throw new Error('space type: frame produced no blob')
      return blob
    }
    const blob = await new Promise<Blob | null>(r => src.toBlob(r, 'image/png'))
    if (!blob) throw new Error('space type: frame produced no blob')
    return blob
  }

  dispose(): void {
    this.clearRootCache()
    this.disposeRoot()
    // Preloaded ring image textures (see setImageTextures) aren't reachable from the scene
    // graph disposed above — they're only read out of this.imageTextures by buildScene, not
    // attached anywhere disposeRoot()/clearRootCache() would find them. Dispose them here too,
    // or every image tile texture from this engine's lifetime leaks on close.
    for (const tex of this.imageTextures.values()) tex.dispose()
    this.imageTextures = new Map()
    this.postChain?.dispose()
    // Drop this engine's shader-fill textures too — every currently-pooled root is being
    // disposed above (clearRootCache), so nothing is left that could need a swap-back-in
    // refresh (see clearShaderFillOwner's doc for why this ISN'T also done on every rebuild).
    clearShaderFillOwner(this.id)
    // Free the underlying WebGL context promptly (renderer.dispose alone leaves it
    // alive until GC — with one context per node that hits the browser's ~16 cap).
    try { this.renderer.forceContextLoss() } catch { /* already lost */ }
    this.renderer.dispose()
    this.ctxHandle.release()
  }
}

/** Release GPU resources for an object graph that is no longer cached. */
function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach(m => m.dispose())
    else if (mat) mat.dispose()
  })
}
