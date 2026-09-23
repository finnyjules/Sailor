<script setup lang="ts">
/**
 * Test-only page for the Frame web export. Exposes `window.__frameEmbedHarness` so the E2E specs
 * drive the adapter's contract directly (mount / setTime / setSize / destroy), build real
 * snapshots through the planner and gatherer, and produce real exported files.
 *
 * Every fixture is synthetic — images and clip frames are drawn here and served to the gatherer
 * through an overridden `fetchBlob` — so no ComfyUI input file is needed.
 */
import { onMounted } from 'vue'
import { loadEmbedSurface } from '~/lib/embed/surfaces'
import { exportEmbedHtml } from '~/lib/embed/export'
import { fetchShaderFxCatalog } from '~/lib/shaderfx/catalog'
import { effectReadsInput } from '~/lib/shaderfx/catalogStore'
import { planFrameExport } from '~/lib/embed/frame/plan'
import { buildFrameSnapshot } from '~/lib/embed/frame/gather'
import { createAppFrameExportIO } from '~/lib/embed/frame/appIO'
import type { FrameExportIO } from '~/lib/embed/frame/gather'
import type { FrameFit, FrameSnapshot, FrameVariant } from '~/lib/embed/frame/types'
import type { EmbedHandle } from '~/lib/embed/contract'
import { createImageLayer, createRectLayer, createTextLayer } from '~/composables/useCompositorLayers'
import { DEFAULT_FILL } from '~/lib/spacetype/fillTile'
import { createEffect } from '~/lib/compositor/effectStack'
import { defaultPostEffect } from '~/lib/compositor/postEffects'
// The reference render (the studio's paint, for the parity spec) — deliberately NOT through the
// adapter: no surfaces/frame.ts, no stackItemsFor. It paints the way CompositorModal's
// renderStack does, with the app's own loaders.
import { ensureLayerFonts, ensureLayerImages, paintLayerStack, withWiredContent, type LocalLayer, type StackItem } from '~/composables/useCompositorLayers'
import { registerAssetResolver } from '~/lib/compositor/assetScope'
import { whenFieldEffectReady } from '~/lib/shaderfill/field'
import '~/lib/motion/paint' // the per-layer animation painter paintLayerStack relies on (the modal has it loaded)

definePageMeta({ layout: false })

type Slot = 'a' | 'b'
const handles: Partial<Record<Slot, EmbedHandle>> = {}
/** The image fill's source, as the app stores one: a server URL the gatherer fetches. */
const HARNESS_FILL_SRC = '/view?filename=harness-photo.png&type=input'
const FIXTURES = ['vector', 'image', 'backdrop', 'still', 'fill', 'bleed', 'bleed-post', 'standin']
/** The font the `font` mutation swaps in: another cut of the harness face (there is no
 *  ABCROM-BoldItalic in public/fonts — BlackItalic is the nearest italic). */
const MUTANT_FONT_URL = '/fonts/ABCROM-BlackItalic.otf'
/** The `shader` mutation's fragment: every pixel solid magenta. Same interface as the catalog's
 *  single-pass effects (GLSL ES 3.00, `v_texCoord` in, `fragColor0` out). */
const MAGENTA_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
void main() { fragColor0 = vec4(1.0, 0.0, 1.0, 1.0); }
`

// ── Synthetic assets ─────────────────────────────────────────────────────────────────────────
// Smooth on purpose: no noise, because lossy re-encoding of noise would swamp a pixel diff.
function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  return [c, c.getContext('2d')!]
}
function softDisc(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  const rg = g.createRadialGradient(x, y, 0, x, y, r)
  rg.addColorStop(0, color)
  rg.addColorStop(0.7, color)
  rg.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = rg
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill()
}
function drawPhoto(): string {
  const [c, g] = canvasOf(800, 600)
  const bg = g.createRadialGradient(400, 300, 20, 400, 300, 520)
  bg.addColorStop(0, '#fdf6e3'); bg.addColorStop(1, '#2f5d8a')
  g.fillStyle = bg; g.fillRect(0, 0, 800, 600)
  softDisc(g, 220, 200, 120, '#d9485f')
  softDisc(g, 560, 240, 140, '#3fb68b')
  softDisc(g, 400, 430, 110, '#f2b134')
  return c.toDataURL('image/png')
}
function drawClipFrame(i: number): string {
  const [c, g] = canvasOf(400, 400)
  g.fillStyle = '#1e1b2e'; g.fillRect(0, 0, 400, 400)
  const a = (i / 6) * Math.PI * 2
  softDisc(g, 200 + Math.cos(a) * 120, 200 + Math.sin(a) * 120, 70, '#ff7aa2')
  return c.toDataURL('image/png')
}

onMounted(async () => {
  const assets = new Map<string, string>()
  assets.set('harness-photo.png', drawPhoto())
  for (let i = 0; i < 6; i++) assets.set(`harness-clip/${i}`, drawClipFrame(i))
  assets.set('harness-rose.png', assets.get('harness-clip/0')!)

  // The mutant font's bytes, read once so `mutate` can stay synchronous.
  const mutantBlob = await (await fetch(MUTANT_FONT_URL)).blob()
  const mutantFont = await new Promise<string>((res, rej) => {
    const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(mutantBlob)
  })

  const cat = await fetchShaderFxCatalog()
  const catalogIds = new Set(cat.effects.map(e => e.id))
  // Same selection rule as embed-harness.vue: generative AND texture-free.
  const fillEffect = cat.effects.find(e => e.generative && !e.textures?.length)
    ?? cat.effects.find(e => !e.textures?.length)!
  const backdropEffect = cat.effects.find(e => effectReadsInput(e.id))!

  const real = createAppFrameExportIO({ uploaded: [], wiredStill: () => null, catalog: cat.effects })
  const io: FrameExportIO = {
    ...real,
    async fetchBlob(url: string) {
      const q = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
      const filename = q.get('filename') ?? ''
      let hit: string | undefined
      if (q.get('subfolder') === 'harness-clip') hit = assets.get(`harness-clip/${Number.parseInt(filename, 10)}`)
      else if (filename === 'harness-photo.png' || filename === 'harness-rose.png') hit = assets.get(filename)
      if (hit) return await (await fetch(hit)).blob()
      return await real.fetchBlob(url)
    },
    fontSource(family: string, weight: number) {
      if (family === 'Harness Font') return { url: '/fonts/ABCROM-Bold.otf', origin: 'uploaded', weight: 700 }
      return real.fontSource(family, weight)
    },
    wiredStill: () => null,
  }

  // ── Fixtures ────────────────────────────────────────────────────────────────────────────────
  function variantOf(width: number, height: number, layers: any[], extra: Partial<FrameVariant> = {}): FrameVariant {
    return {
      width, height, layers, stackOrder: layers.map(l => `l:${l.id}`), groups: [],
      background: '#000000', post: [], motion: null, wiredTreatments: {}, ...extra,
    }
  }

  function fixture(name: string): { variant: FrameVariant; hasMotion: boolean } {
    if (name === 'vector') {
      const rect = createRectLayer({ x: 0.3, y: 0.4, w: 0.3, h: 0.2 }) as any
      rect.fill = { ...DEFAULT_FILL, type: 'shader', shader: { effectId: fillEffect.id, params: {}, anchor: 'object', speed: 1, seed: 42, input: '#000000' } }
      const text = createTextLayer({ text: 'Decode me #1', fontFamily: 'Harness Font', fontWeight: 700, y: 0.75, fontSize: 0.07 })
      return {
        hasMotion: true,
        variant: variantOf(1000, 500, [rect, text], {
          background: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#1d3b8f' }, { offset: 1, color: '#f25c54' }] },
          motion: {
            fps: 30, duration: 4,
            motionx: [{ path: `layers.${rect.id}.x`, type: 'number', keyframes: [{ t: 0, value: 0.3, ease: 'linear' }, { t: 4, value: 0.7, ease: 'linear' }] }],
            behaviours: [{ id: 'b1', layerId: text.id, kind: 'text.decode', timing: { start: 0, duration: 3 }, params: { charset: 'symbols' } }],
          } as any,
        }),
      }
    }
    if (name === 'image') {
      const photo = createImageLayer('harness-photo.png', 4 / 3, { x: 0.3, y: 0.5, w: 0.5, h: 0.375, blend: 'multiply' } as any)
      const rose = createImageLayer('harness-rose.png', 1, { x: 0.75, y: 0.5, w: 0.3 }) as any
      rose.clip = { dir: 'harness-clip', frames: 6, fps: 6, speed: 1, prompt: '', model: '' }
      return { hasMotion: false, variant: variantOf(1000, 500, [photo, rose], { background: '#f0c040' }) }
    }
    if (name === 'backdrop') {
      const stripes = Array.from({ length: 8 }, (_, i) => createRectLayer({
        x: (i + 0.5) / 8, y: 0.5, w: 1 / 16, h: 0.5, radius: 0, fill: i % 2 ? '#e9e4d0' : '#3a7bd5',
      }))
      const glass = createRectLayer({ x: 0.35, y: 0.5, w: 0.25, h: 0.3, radius: 0.02, fill: 'rgba(255,255,255,0.15)' }) as any
      glass.effects = [{ ...createEffect('backdrop_shader'), effectId: backdropEffect.id, visible: true }]
      const shadowed = createRectLayer({ x: 0.7, y: 0.5, w: 0.15, h: 0.15, radius: 0, fill: '#f25c54' }) as any
      shadowed.effects = [{ ...createEffect('long_shadow'), visible: true }]
      return { hasMotion: false, variant: variantOf(1000, 500, [...stripes, glass, shadowed], { background: '#202020' }) }
    }
    if (name === 'fill') {
      // An image FILL: the one image kind the adapter does not pre-check, so the network spec's
      // teeth test can remove its inlined copy and watch the painter reach for the URL. Kept out
      // of 'image' on purpose: on Chrome's GPU canvas the first read-back of an image fill
      // differs from every later one by a few levels, which would break exact comparisons.
      const swatch = createRectLayer({ x: 0.5, y: 0.5, w: 0.4, h: 0.3, radius: 0 }) as any
      swatch.fill = { type: 'image', src: HARNESS_FILL_SRC, fit: 'cover' }
      return { hasMotion: false, variant: variantOf(1000, 500, [swatch], { background: '#f0c040' }) }
    }
    if (name === 'still') {
      const text = createTextLayer({ text: 'Still here', fontFamily: 'Harness Font', fontWeight: 700, fontSize: 0.1 })
      return { hasMotion: false, variant: variantOf(1000, 500, [text], { background: '#1b4d3e' }) }
    }
    if (name === 'standin') {
      // Three "photo goes here" stand-ins (standIn: true), one of each kind the export meets:
      //  - no file yet (the shape lib/frame/patterns/insert.ts creates) — nothing to load (R10);
      //  - a file that is not there (`harness-missing.png` 404s) — the editor draws the grey box,
      //    and so must the export: the gatherer stores `data:,` and does not block (R12);
      //  - a file that is there (lib/frame/looksSpike.ts's shape) — drawn as the photo (R12).
      // The network spec requires zero requests; the parity spec compares it with the editor.
      const bare = createImageLayer('', 4 / 3, { x: 0.18, y: 0.35, w: 0.28, h: 0.21, standIn: true } as any)
      const missing = createImageLayer('harness-missing.png', 4 / 3, { x: 0.5, y: 0.35, w: 0.28, h: 0.21, standIn: true } as any)
      const photo = createImageLayer('harness-photo.png', 4 / 3, { x: 0.82, y: 0.35, w: 0.28, h: 0.21, standIn: true } as any)
      const rect = createRectLayer({ x: 0.5, y: 0.85, w: 0.6, h: 0.08, radius: 0, fill: '#f25c54' })
      return { hasMotion: false, variant: variantOf(1000, 500, [bare, missing, photo, rect], { background: '#1b4d3e' }) }
    }
    if (name === 'bleed' || name === 'bleed-post') {
      // A rect half outside the artboard's right edge (artboard x 900..1100 of 1000): in a box
      // wider than the artboard, the part past x = 1000 must NOT paint into the bleed.
      // 'bleed-post' adds a doc-level Invert, which must reach the bleed too (no seam).
      const over = createRectLayer({ x: 1, y: 0.5, w: 0.2, h: 0.3, radius: 0, fill: '#ff0000' })
      const post = name === 'bleed-post' ? [defaultPostEffect('invert')] : []
      return { hasMotion: false, variant: variantOf(1000, 500, [over], { background: '#204080', post }) }
    }
    throw new Error(`harness: unknown fixture "${name}"`)
  }

  async function snapshot(name: string, over: { fit?: FrameFit } = {}): Promise<FrameSnapshot> {
    const { variant, hasMotion } = fixture(name)
    const plan = planFrameExport({
      variant, fit: over.fit ?? 'fit', wiredSlots: [], catalogIds, hasMotion, animatedFill: false,
    })
    return await buildFrameSnapshot(plan, variant, io)
  }

  // ── The reference: the studio's own paint ───────────────────────────────────────────────────
  // What the Frame editor draws for a fixture at t01, independent of the adapter: items from the
  // stack order (as CompositorModal.buildStackItems does), the painter called the way
  // renderStack calls it (motion, wired treatments, background, groups AND the post chain in the
  // painter itself, bake = true as an export would), at w × h in the editor's units (W = the
  // display width, dpr transform). Assets load the app's way: `ensureLayerImages` (the synthetic
  // files and clip frames answered with their ORIGINAL full-size PNGs by a resolver standing in
  // for /view), `ensureLayerFonts` over a harness @font-face for the full, unsubsetted
  // /fonts/ABCROM-Bold.otf, and the shaders' readiness.
  //
  // Caveat: the painter's clip-frame cache is keyed by folder, not URL. Call `reference` before
  // any adapter mount of the same fixture in this page (the parity spec does), or it would reuse
  // the adapter's (WebP) frames.
  async function reference(name: string, t01: number, w: number, h: number): Promise<string> {
    const { variant: v } = fixture(name)
    const layers = v.layers as LocalLayer[]
    const byId = new Map(layers.map(l => [l.id, l]))
    const items: StackItem[] = v.stackOrder
      .filter(k => k.startsWith('l:') && byId.has(k.slice(2)))
      .map(k => ({ type: 'local', key: k, layer: byId.get(k.slice(2))! }))
    // The Frame's clock, as the planner states it: its Motion duration, else 4 s.
    const duration = v.motion && v.motion.duration > 0 ? v.motion.duration : 4

    const unregister = registerAssetResolver((kind, key) => {
      if (kind === 'image') return assets.get(key) ?? null
      if (kind === 'clipFrame' && key.startsWith('harness-clip/')) return assets.get(key) ?? null
      return null
    })
    const face = document.createElement('style')
    face.textContent = "@font-face{font-family:'Harness Font';font-weight:700;font-style:normal;src:url('/fonts/ABCROM-Bold.otf')}"
    document.head.appendChild(face)
    try {
      await ensureLayerImages(layers)
      await ensureLayerFonts(layers, w)
      await document.fonts.load("700 16px 'Harness Font'")
      await document.fonts.ready
      await Promise.all([fillEffect.id, backdropEffect.id].map(id => whenFieldEffectReady(id)))

      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const [cv, ctx] = canvasOf(Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr)))
      const paint = () => {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)
        withWiredContent(() => null, () => paintLayerStack(ctx, w, h, items, layers, undefined,
          t01 * duration, v.motion ?? undefined, v.wiredTreatments, v.background ?? undefined,
          v.groups, v.post, true))
      }
      // Warm-up: paint and read once, discard (Task 7: Chrome's GPU canvas can return a
      // different first read-back), then paint again and read the one we compare.
      paint(); cv.toDataURL()
      paint()
      return cv.toDataURL()
    } finally {
      face.remove()
      unregister()
    }
  }

  // ── Mutations: one deliberate break each, for the parity spec's teeth ───────────────────────
  function mutate(snap: FrameSnapshot, kind: 'colour' | 'font' | 'shader'): FrameSnapshot {
    const out = structuredClone(snap)
    if (kind === 'colour') {
      const rect = out.variants[0]!.layers.find(l => l.kind === 'rect') as any
      if (!rect) throw new Error('mutate colour: the snapshot has no rect')
      rect.fill = '#00ff00'
    } else if (kind === 'font') {
      const f = out.assets.fonts[0]
      if (!f) throw new Error('mutate font: the snapshot has no font')
      f.dataUrl = mutantFont
    } else if (kind === 'shader') {
      const d = out.assets.shaders[0]
      if (!d) throw new Error('mutate shader: the snapshot has no shader')
      d.source = MAGENTA_FRAGMENT
    } else {
      throw new Error(`mutate: unknown kind "${kind}"`)
    }
    return out
  }

  const slotEl = (slot: Slot) => document.getElementById(`slot-${slot}`)!
  const canvasOfSlot = (slot: Slot) => slotEl(slot).querySelector('canvas') as HTMLCanvasElement | null

  ;(window as any).__frameEmbedHarness = {
    fixtures: FIXTURES,
    snapshot,
    async mount(slot: Slot, snap: FrameSnapshot): Promise<boolean> {
      const surface = await loadEmbedSurface('frame')
      if (!surface) return false
      handles[slot]?.destroy()
      delete handles[slot]
      try {
        handles[slot] = await surface.mount(slotEl(slot), snap)
        return true
      } catch (err) {
        console.warn('[frame-embed-harness] mount rejected:', err)
        return false
      }
    },
    setTime(slot: Slot, t01: number) { handles[slot]?.setTime(t01) },
    setSize(slot: Slot, w: number, h: number) { handles[slot]?.setSize(w, h) },
    destroy(slot: Slot) { handles[slot]?.destroy(); delete handles[slot] },
    pixels(slot: Slot): string { return canvasOfSlot(slot)?.toDataURL() ?? '' },
    canvasCount(slot: Slot): number { return slotEl(slot).querySelectorAll('canvas').length },
    reference,
    mutate,
    async exportHtml(snap: FrameSnapshot): Promise<string> {
      const v = snap.variants[0]!
      return await exportEmbedHtml({
        kind: 'frame', config: snap, duration: snap.duration, width: v.width, height: v.height,
        framing: 'box', posterFit: snap.fit === 'fill' ? 'cover' : 'contain', still: snap.still,
      })
    },
  }
  ;(window as any).__frameEmbedHarnessReady = true
})
</script>

<template>
  <div style="padding:16px;display:flex;flex-direction:column;gap:16px">
    <h1 style="font-size:12px;opacity:.6">Frame embed harness (test only)</h1>
    <div id="slot-a" style="width:600px;height:300px;background:#000" />
    <div id="slot-b" style="width:600px;height:300px;background:#000" />
  </div>
</template>
