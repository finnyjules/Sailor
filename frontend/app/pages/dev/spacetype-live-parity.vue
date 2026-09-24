<script setup lang="ts">
/**
 * Test-only page: does the live embed player draw what the editor draws? (Task 4 of the Frame
 * live-wired plan.) Driven by tests/spacetype-live-parity.spec.ts through `window.__parityHarness`;
 * every measurement is also kept on `window.__parity`.
 *
 * A — the editor's picture: the node's wired renderer (createWiredSpaceTypeRenderer, the one code
 *     path a wired Space Type layer and its pre-rendered frames come from), in THIS document, with
 *     the app's fonts and the Google catalog loaded first so it never draws a fallback face.
 * B — the live player: the per-effect embed bundle the export inlines (`/embed/<bundle>.js`, built
 *     from the same adapter as the app registry's default export), mounted in its OWN blank
 *     document (a same-origin iframe) with the config spaceTypeWiredEmbed builds. Its own document
 *     holds only the face the config inlines, exactly like an exported file. In this page's
 *     document the app's Google and @nuxt/fonts faces for the same family would stand in for any
 *     glyph the subset lacks, so the accent check below would prove nothing.
 *
 * Both are drawn at 480 wide, the source's aspect, on whole frames (t01 = i / total frames), so
 * the editor's frame-snapped time and the player's continuous time name the same moment.
 */
import { onMounted } from 'vue'
import { SPACE_TYPE_EFFECTS, getEffect } from '~/lib/spacetype/effects'
import { defaultsFromControls } from '~/lib/spacetype/effect'
import { defaultSpaceTypeState, dimsFromState, ensureSpaceTypeFont, type SpaceTypeState } from '~/lib/spacetype/state'
import { applySceneToState } from '~/lib/spacetype/scene'
import { loadSpaceDefaults, spaceDefaultFor } from '~/composables/useSpaceDefaults'
import { createWiredSpaceTypeRenderer } from '~/lib/spacetype/wiredRenderer'
import {
  LIVE_VERIFIED_EFFECTS, liveEmbedBlocker, spaceTypeEmbedFace, spaceTypeEmbedFont, spaceTypeSubsetText, spaceTypeWiredEmbed,
} from '~/lib/spacetype/embedConfig'
import { loadGoogleCatalog } from '~/data/google-fonts'
import { gradientFx } from '~/lib/gradientfx/renderer'
import { defaultConfig as gradientDefaultConfig } from '~/lib/gradientfx/randomize'
import { makeGradientFrameSource } from '~/lib/gradientfx/frameSource'
import type { EmbedHandle, EmbedSurface } from '~/lib/embed/contract'
import type { StudioEmbed } from '~/lib/studio/frameSource'

definePageMeta({ layout: false })

const WIDTH = 480
/** Frame positions sampled, as fractions of the loop; each is snapped to a whole frame. */
const AT = [0, 0.37, 0.71]
/** A channel differing by more than this many levels counts the pixel as different. */
const OVER = 24

/** `content`: the share of the EDITOR's pixels that differ from its own top-left pixel by more
 *  than OVER — how much of the picture is not background. */
interface TimeResult { frame: number; totalFrames: number; t01: number; mean: number; over: number; content: number }
interface ParityResult {
  id: string
  /** 'measured' | 'blocked' (a "cannot carry" reason) | 'empty' (the editor drew only
   *  background at every moment, so equal pixels would prove nothing) | 'error'. */
  status: 'measured' | 'blocked' | 'empty' | 'error'
  reason?: string
  width?: number
  height?: number
  times?: TimeResult[]
  pass?: boolean
  /** The face the player carries: "Family weight (N KB inlined)", or "none (system family)". */
  font?: string
  images?: { a: string[]; b: string[] }
}

function pixelsOf(src: HTMLCanvasElement, w: number, h: number): Uint8ClampedArray {
  if (src.width !== w || src.height !== h) throw new Error(`canvas is ${src.width}×${src.height}, expected ${w}×${h}`)
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(src, 0, 0)
  return g.getImageData(0, 0, w, h).data
}

function pngOf(px: Uint8ClampedArray, w: number, h: number): string {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0)
  return c.toDataURL('image/png')
}

/** Mean absolute difference per colour channel (R, G, B; 0–255), and the share of pixels any of
 *  whose channels (alpha included) differs by more than OVER. */
function compare(a: Uint8ClampedArray, b: Uint8ClampedArray): { mean: number; over: number; content: number } {
  let sum = 0, over = 0, content = 0
  const n = a.length / 4
  for (let p = 0; p < a.length; p += 4) {
    const dr = Math.abs(a[p]! - b[p]!), dg = Math.abs(a[p + 1]! - b[p + 1]!), db = Math.abs(a[p + 2]! - b[p + 2]!)
    const da = Math.abs(a[p + 3]! - b[p + 3]!)
    sum += dr + dg + db
    if (dr > OVER || dg > OVER || db > OVER || da > OVER) over++
    if (Math.abs(a[p]! - a[0]!) > OVER || Math.abs(a[p + 1]! - a[1]!) > OVER || Math.abs(a[p + 2]! - a[2]!) > OVER
      || Math.abs(a[p + 3]! - a[3]!) > OVER) content++
  }
  return { mean: sum / (3 * n), over: over / n, content: content / n }
}

/** Under this share of non-background pixels at every moment, the editor drew nothing to check. */
const MIN_CONTENT = 0.001

function statusOf(times: TimeResult[]): 'measured' | 'empty' {
  return times.some(t => t.content >= MIN_CONTENT) ? 'measured' : 'empty'
}

const passes = (times: TimeResult[]) => statusOf(times) === 'measured' && times.every(t => t.mean < 2 && t.over < 0.005)

/** Whole-frame sample times over `totalFrames`: frame i ↔ t01 = i / totalFrames. */
function sampleFrames(totalFrames: number): { frame: number; t01: number }[] {
  return AT.map((f) => {
    const frame = Math.round(f * totalFrames) % totalFrames
    return { frame, t01: frame / totalFrames }
  })
}

// ── B: a built embed bundle in its own blank document ───────────────────────────────────────────
const bundleCode = new Map<string, string>()

async function openPlayer(bundle: string, w: number, h: number): Promise<{ surface: EmbedSurface; container: HTMLElement; close: () => void }> {
  let code = bundleCode.get(bundle)
  if (!code) {
    const res = await fetch(`/embed/${bundle}.js`)
    if (!res.ok) throw new Error(`/embed/${bundle}.js: HTTP ${res.status}`)
    code = await res.text()
    bundleCode.set(bundle, code)
  }
  const frame = document.createElement('iframe')
  frame.style.cssText = `width:${w}px;height:${h}px;border:0;display:block`
  document.getElementById('players')!.appendChild(frame)
  const doc = frame.contentDocument!
  doc.open()
  doc.write(`<!doctype html><html><head></head><body style="margin:0"><div id="c" style="width:${w}px;height:${h}px"></div></body></html>`)
  doc.close()
  const script = doc.createElement('script')
  script.textContent = code
  doc.head.appendChild(script)
  const surface = (frame.contentWindow as unknown as { __SAILOR_SURFACE__?: EmbedSurface }).__SAILOR_SURFACE__
  if (!surface) { frame.remove(); throw new Error(`${bundle}.js did not define a surface`) }
  return { surface, container: doc.getElementById('c')!, close: () => frame.remove() }
}

/** Mounts `embed` in its own document and returns its pixels at each t01. */
async function playerPixels(embed: StudioEmbed, w: number, h: number, t01s: number[]): Promise<Uint8ClampedArray[]> {
  const { surface, container, close } = await openPlayer(embed.bundle, w, h)
  let handle: EmbedHandle | null = null
  try {
    handle = await surface.mount(container, embed.config)
    handle.setSize(w, h)
    const out: Uint8ClampedArray[] = []
    for (const t of t01s) {
      handle.setTime(t)
      // Read in the same task as the draw: the player's canvas does not keep its buffer.
      out.push(pixelsOf(container.querySelector('canvas') as HTMLCanvasElement, w, h))
    }
    return out
  } finally {
    handle?.destroy()
    close()
  }
}

// ── A: the editor's wired renderer, fonts settled first ─────────────────────────────────────────
async function settleEditorFont(state: SpaceTypeState): Promise<void> {
  // The catalog first: before it lands, the family's stylesheet link asks for 400 only, and the
  // weight pinning of static families reads it (texOptsFromState).
  await loadGoogleCatalog()
  await ensureSpaceTypeFont(String(state.params.font ?? ''))
  const { family, weight } = spaceTypeEmbedFace(state)
  // ensureSpaceTypeFont adds the family's stylesheet and asks for the face at once — before the
  // stylesheet has arrived there is no @font-face to load, so that ask resolves with nothing and
  // a render right after draws the fallback. Wait for the stylesheet itself, then load.
  const link = document.querySelector(`link[data-stg-font="${family.replace(/[^a-zA-Z0-9]/g, '_')}"]`) as HTMLLinkElement | null
  if (link && !link.sheet) {
    await new Promise<void>((resolve) => {
      link.addEventListener('load', () => resolve(), { once: true })
      link.addEventListener('error', () => resolve(), { once: true })
      setTimeout(resolve, 15_000)
    })
  }
  const text = spaceTypeSubsetText(state)
  // 400 as well: effects that draw their own glyphs with no weight draw at 400.
  for (const wt of new Set([400, weight])) {
    try { await document.fonts.load(`${wt} 32px "${family}"`, text) } catch { /* checked below */ }
  }
  await document.fonts.ready
  if (!document.fonts.check(`${weight} 32px "${family}"`, text)) {
    throw new Error(`the editor's face ${family} ${weight} did not load`)
  }
}

const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()))

async function editorPixels(state: SpaceTypeState, w: number, h: number, t01s: number[]): Promise<Uint8ClampedArray[]> {
  await settleEditorFont(state)
  // One renderer per state (no carried-over build). A warm-up pull lets anything the build
  // starts on its own (the renderer's font priming marks it dirty when it lands) settle; the
  // measured pulls then rebuild once, fonts ready — the picture a wired layer shows.
  const wired = createWiredSpaceTypeRenderer()
  try {
    await wired.render(state, 0, w, h)
    await document.fonts.ready
    await nextFrame(); await nextFrame()
    wired.markDirty()
    const out: Uint8ClampedArray[] = []
    for (const t of t01s) {
      const canvas = await wired.render(state, t, w, h)
      if (!canvas) throw new Error('the wired renderer drew nothing (no WebGL?)')
      out.push(pixelsOf(canvas, w, h))
    }
    return out
  } finally {
    wired.dispose()
  }
}

// ── The measurements ────────────────────────────────────────────────────────────────────────────
function defaultState(id: string): SpaceTypeState {
  const effect = getEffect(id)
  // A fresh node: defaultSpaceTypeState() with this effect's own control defaults, then the
  // effect's saved default scene applied as SpaceTypeNode's fresh-node path applies one.
  const base: SpaceTypeState = { ...defaultSpaceTypeState(), effectId: effect.id, params: defaultsFromControls(effect.controls) }
  const scene = spaceDefaultFor(effect.id)
  return scene ? applySceneToState(base, scene) : base
}

async function measureSpaceType(
  state: SpaceTypeState,
  opts: { images?: boolean; label?: string; fontFrom?: SpaceTypeState; dropFont?: boolean; buildAtDrawnSize?: boolean } = {},
): Promise<ParityResult> {
  const id = opts.label ?? getEffect(state.effectId).id
  const effectId = getEffect(state.effectId).id
  try {
    // Only the "cannot carry" reasons: the effect itself counts as verified here.
    const blocker = liveEmbedBlocker(state, new Set([effectId]))
    if (blocker) return { id, status: 'blocked', reason: blocker }
    const [cw, ch] = dimsFromState(state)
    const w = WIDTH, h = Math.max(1, Math.round(WIDTH * ch / cw))
    const embed = await spaceTypeWiredEmbed(state, { width: cw, height: ch }, {
      verified: new Set([effectId]),
      // The negative control swaps in the face built for another state (a narrower subset).
      ...(opts.fontFrom ? { loadFont: () => spaceTypeEmbedFont(opts.fontFrom!) } : {}),
    })
    if (!embed) return { id, status: 'blocked', reason: 'its font could not be inlined' }
    // The other negative control: the player with no face inlined at all (it then draws the
    // browser's fallback). If this still matched, A would be drawing a fallback too.
    if (opts.dropFont) embed.config = { ...(embed.config as object), font: null }
    // Diagnostic only: the player builds at its config's size (the source's native size) and is
    // then resized; the editor's renderer builds at the size it is pulled at. This makes the
    // player build at the drawn size too, to tell a build-size difference from a drawing one.
    if (opts.buildAtDrawnSize) {
      const c = embed.config as { opts: Record<string, unknown> }
      embed.config = { ...c, opts: { ...c.opts, width: w, height: h } }
    }
    const loops = Number((embed.config as { loops?: number }).loops) >= 1 ? Number((embed.config as { loops?: number }).loops) : 1
    const totalFrames = Math.max(1, Math.round(state.fps * state.loopDuration)) * loops
    const samples = sampleFrames(totalFrames)
    const t01s = samples.map(s => s.t01)
    const a = await editorPixels(state, w, h, t01s)
    const b = await playerPixels(embed, w, h, t01s)
    const times = samples.map((s, k) => ({ ...s, totalFrames, ...compare(a[k]!, b[k]!) }))
    const font = (embed.config as { font?: { family: string; weight: number; dataUrl: string } | null }).font
    const result: ParityResult = {
      id, status: statusOf(times), width: w, height: h, times, pass: passes(times),
      font: font ? `${font.family} ${font.weight} (${Math.round(font.dataUrl.length * 3 / 4 / 1024)} KB inlined)` : 'none (system family)',
    }
    if (opts.images) result.images = { a: a.map(px => pngOf(px, w, h)), b: b.map(px => pngOf(px, w, h)) }
    return result
  } catch (e) {
    return { id, status: 'error', reason: e instanceof Error ? e.message : String(e) }
  }
}

/** The Gradient fixture Task 2's end-to-end case uses: the studio's defaults plus a full hue sweep
 *  over 4 s, at 16:9. */
function gradientFixture(): any {
  const cfg = gradientDefaultConfig('live-parity-gradient')
  cfg.motion = {
    tracks: [{ path: 'layers.0.color.hueRotate', from: 0, to: 360, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 }],
    duration: 4, fps: 30, size: 1080,
  }
  cfg.canvas = { ...cfg.canvas, aspect: '16:9' }
  return cfg
}

async function measureGradient(opts: { images?: boolean } = {}): Promise<ParityResult> {
  const id = 'gradient'
  try {
    const cfg = gradientFixture()
    // The node's frame source (GradientStudioNode.vue's deps) — both the A render and the
    // config its embed() hands a Frame export.
    const source = makeGradientFrameSource({ getConfig: () => cfg, render: (c, w, h, t) => gradientFx.render(c, w, h, t) })
    const embed = await source.embed!()
    if (!embed) return { id, status: 'blocked', reason: 'embed() returned null' }
    const w = WIDTH, h = Math.max(1, Math.round(WIDTH * source.height / source.width))
    const duration = source.duration
    const totalFrames = Math.max(1, Math.round(source.fps * duration))
    const samples = sampleFrames(totalFrames)
    // A: exactly what the node renders for a pull (renderer.render(cfg, w, h, t01 × duration)).
    const a = samples.map(s => pixelsOf(gradientFx.render(cfg, w, h, s.t01 * duration) as HTMLCanvasElement, w, h))
    const b = await playerPixels(embed, w, h, samples.map(s => s.t01))
    const times = samples.map((s, k) => ({ ...s, totalFrames, ...compare(a[k]!, b[k]!) }))
    const result: ParityResult = { id, status: statusOf(times), width: w, height: h, times, pass: passes(times) }
    if (opts.images) result.images = { a: a.map(px => pngOf(px, w, h)), b: b.map(px => pngOf(px, w, h)) }
    return result
  } catch (e) {
    return { id, status: 'error', reason: e instanceof Error ? e.message : String(e) }
  }
}

onMounted(async () => {
  await loadSpaceDefaults()
  await loadGoogleCatalog()
  const results: Record<string, ParityResult> = {}
  ;(window as any).__parity = results
  ;(window as any).__parityHarness = {
    effectIds: () => SPACE_TYPE_EFFECTS.map(e => e.id),
    verified: () => [...LIVE_VERIFIED_EFFECTS],
    defaultState,
    async measure(id: string, opts: { images?: boolean } = {}) {
      const r = await measureSpaceType(defaultState(id), opts)
      results[r.id] = r
      return r
    },
    async measureState(state: SpaceTypeState, opts: { images?: boolean; label?: string; fontFrom?: SpaceTypeState; dropFont?: boolean; buildAtDrawnSize?: boolean } = {}) {
      const r = await measureSpaceType(state, opts)
      results[r.id] = r
      return r
    },
    async measureGradient(opts: { images?: boolean } = {}) {
      const r = await measureGradient(opts)
      results[r.id] = r
      return r
    },
  }
  ;(window as any).__parityHarnessReady = true
})
</script>

<template>
  <div class="p-4 space-y-4">
    <h1 class="text-sm opacity-60">Space Type live parity (test only)</h1>
    <div id="players" />
  </div>
</template>
