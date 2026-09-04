<template>
  <div class="wrap">
    <h1>Pattern Studio — motif gallery <span class="sub">GLSL render · CPU parity</span></h1>
    <p class="legend">
      Each swatch is a 2×2 repeat of one tile rendered by the shipping WebGL renderer.
      <b>Δ</b> = mean per-channel difference (0–255) vs the pure-TS sampler; near-0 means the
      GLSL branch mirrors <code>patternColor</code>/<code>shapeRegion</code>. (Anti-aliased motifs
      like <code>dots</code> naturally show a small Δ at edges.)
    </p>
    <template v-for="group in groups" :key="group.title">
      <h2>{{ group.title }}</h2>
      <div class="grid">
        <figure v-for="item in group.items" :key="item.key">
          <canvas :ref="(el) => registerCanvas(item, el as HTMLCanvasElement | null)" :width="DISP" :height="DISP" />
          <figcaption>
            <span class="name">{{ item.label }}</span>
            <span class="delta" :class="{ bad: item.delta > 8, warn: item.delta > 2 && item.delta <= 8 }">Δ {{ item.delta.toFixed(1) }}</span>
          </figcaption>
        </figure>
      </div>
    </template>
    <div class="summary">
      max Δ across all patterns: <b :class="{ bad: maxDelta > 8 }">{{ maxDelta.toFixed(1) }}</b>
      · errors: <b :class="{ bad: errors.length > 0 }">{{ errors.length }}</b>
      <span v-if="errors.length" class="errs">{{ errors.join(' | ') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { textureFx } from '~/lib/texturefx/renderer'
import { patternColor } from '~/lib/texturefx/pattern'
import { shapeRegion } from '~/lib/texturefx/shapes'
import { legacyColor, DEALTGRID_VOCAB_IDS } from '~/lib/texturefx/roles'
import { textureDefaults } from '~/lib/texturefx/controls'
import { applyGridTemplate } from '~/lib/texturefx/templates'
import { GRID_TEMPLATES } from '~/lib/frame/gridTemplates'
import { MOTIFS, TILE_FAMILIES, SHAPE_FAMILIES } from '~/lib/texturefx/types'
import type { Params } from '~/lib/spacetype/effect'

const TILE = 128        // tile render size
const DISP = TILE * 2   // 2×2 repeat display

interface Item { key: string; label: string; params: Params; kind: 'proc' | 'truchet' | 'shape' | 'chips' | 'dealt'; delta: number }

function mk(kind: Item['kind'], name: string, extra: Partial<Params>): Item {
  return { key: `${kind}:${name}`, label: name, kind, delta: 0, params: { ...textureDefaults(), cells: 8, ...extra } as Params }
}

const procItems = MOTIFS.map((m) => mk('proc', m, { mode: 'procedural', motif: m }))
const truchetItems = TILE_FAMILIES.map((f) => mk('truchet', f, { mode: 'truchet', tileFamily: f }))
const shapeItems = SHAPE_FAMILIES.map((f) => mk('shape', f, { mode: 'shapes', shapeFamily: f }))
// Chips is the one mode with no family list to enumerate — it has a single family
// and three sliders — so the parity row is the looks those sliders reach instead:
// the shipped defaults plus the three recipes the tuner's guidance names.
const CHIP_LOOKS: { name: string; params: Partial<Params> }[] = [
  { name: 'default', params: {} },
  { name: 'terrazzo', params: { chipCells: 12, chipGrout: 0.045, chipSizeVar: 0.8, jitter: 0.65 } },
  { name: 'mosaic', params: { chipCells: 18, chipGrout: 0.09, chipSizeVar: 0.2, jitter: 0.2 } },
  { name: 'pebbles', params: { chipCells: 7, chipGrout: 0.13, chipSizeVar: 0.9, jitter: 0.5 } },
  { name: 'sparse', params: { chipCells: 18, chipDensity: 0.35, chipGrout: 0, chipSizeVar: 0.6, jitter: 0.5 } },
  // The worst corner of the Density controls: 16 cells at the density floor AND
  // the widest grout, on a seed where exactly one cell survives — and survives on
  // its own hash, so the narrow "was it rescued?" exemption did NOT save it. This
  // tile was blank twice during review (once before chipKeepCell, once before the
  // grout exemption). The only chip on screen is that lone survivor, so this is
  // the GPU's proof it reads BOTH halves of u_chipKeep (.xy and the .z runner-up).
  { name: 'density floor', params: { chipCells: 4, seed: 20, chipDensity: 0.15, chipGrout: 0.25, chipSizeVar: 0.6 } },
  { name: 'no grout', params: { chipGrout: 0, jitter: 0 } },
  { name: 'big seed', params: { seed: 999983 } },   // float32 seed-precision check
]
const chipItems = CHIP_LOOKS.map((l) => mk('chips', l.name, { mode: 'chips', ...l.params }))
// Dealt grid — like chips, one family with sliders rather than a family list, so the
// parity row is the looks those three sliders reach: a flush rigid grid, size-variance
// gutters, sparse density (incl. the density floor where one force-kept cell survives),
// a fine grid, and a big seed (float32 seed-precision check).
const DEALT_LOOKS: { name: string; params: Partial<Params> }[] = [
  { name: 'default', params: {} },
  { name: 'flush', params: { dgCells: 10, dgDensity: 1, dgSizeVar: 0 } },
  { name: 'gutters', params: { dgCells: 8, dgDensity: 1, dgSizeVar: 0.6 } },
  { name: 'quilt', params: { dgCells: 6, dgDensity: 1, dgSizeVar: 0.9 } },
  { name: 'sparse', params: { dgCells: 12, dgDensity: 0.4, dgSizeVar: 0.3 } },
  { name: 'density floor', params: { dgCells: 4, seed: 20, dgDensity: 0.15, dgSizeVar: 0.6 } },
  { name: 'fine', params: { dgCells: 24, dgDensity: 0.85, dgSizeVar: 0.2 } },
  { name: 'big seed', params: { seed: 999983, dgCells: 10, dgSizeVar: 0.5 } },
]
const dealtItems = DEALT_LOOKS.map((l) => mk('dealt', l.name, { mode: 'dealtgrid', ...l.params }))
// Vocab parity — the SAME dealt look under each colour vocabulary. The per-cell
// layout is identical (vocab is colour-only), so this is the proof that adding a
// colour family keeps the TS↔GLSL twin in parity for EVERY vocab, not just brand.
const dealtVocabItems = DEALTGRID_VOCAB_IDS.map((v) =>
  mk('dealt', `vocab:${v}`, { mode: 'dealtgrid', dgCells: 8, dgDensity: 0.8, dgSizeVar: 0.4, dgVocab: v }))
// Template parity — each shared grid template applied one-click, then rendered at the
// cells/density/sizeVar + vocab it configured. Proves the picker's output is in parity.
const dealtTemplateItems = GRID_TEMPLATES.map((t) => ({
  key: `dealt:tmpl:${t.id}`, label: `template:${t.id}`, kind: 'dealt' as const, delta: 0,
  params: applyGridTemplate({ ...textureDefaults(), cells: 8, mode: 'dealtgrid' } as Params, t.id),
}))

const groups = reactive([
  { title: `Procedural motifs (${procItems.length})`, items: procItems },
  { title: `Truchet families (${truchetItems.length})`, items: truchetItems },
  { title: `Shape families (${shapeItems.length})`, items: shapeItems },
  { title: `Chips looks (${chipItems.length})`, items: chipItems },
  { title: `Dealt grid looks (${dealtItems.length})`, items: dealtItems },
  { title: `Dealt grid vocab (${dealtVocabItems.length})`, items: dealtVocabItems },
  { title: `Dealt grid templates (${dealtTemplateItems.length})`, items: dealtTemplateItems },
])

const maxDelta = ref(0)
const errors = ref<string[]>([])
const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Reference tile from the pure-TS samplers (same legacy colours the GLSL evalFill uses).
function cpuTile(item: Item): Uint8ClampedArray {
  const p = item.params
  const out = new Uint8ClampedArray(TILE * TILE * 4)
  // Only the shape branch below reads `fam` (chips and dealt grid each have a single
  // family and take the patternColor path, same as proc/truchet).
  const fam = String(item.kind === 'proc' ? p.motif : item.kind === 'truchet' ? p.tileFamily : p.shapeFamily)
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      // GPU canvas is top-origin when drawn to a 2D context, but v_uv.y points up,
      // so the displayed top row is v≈1. Flip y here so the reference aligns.
      const u = (x + 0.5) / TILE, v = 1 - (y + 0.5) / TILE
      let r = 0, g = 0, b = 0
      if (item.kind === 'shape') {
        const role = shapeRegion(fam, u, v, Math.round(Number(p.cells) || 8), p).role
        const rgb = hexRgb(role > 2 ? String(p.background) : legacyColor(p, fam, role))
        r = rgb[0]; g = rgb[1]; b = rgb[2]
      } else {
        const c = patternColor(p, u, v)
        r = Math.round(c[0] * 255); g = Math.round(c[1] * 255); b = Math.round(c[2] * 255)
      }
      const i = (y * TILE + x) * 4
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255
    }
  }
  return out
}

function renderItem(item: Item, canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return
  let gpu: HTMLCanvasElement
  try {
    gpu = textureFx.render(item.params, TILE, TILE, 0)
  } catch (e) {
    errors.value.push(`${item.key}: ${(e as Error).message}`)
    ctx.fillStyle = '#a00'; ctx.fillRect(0, 0, DISP, DISP)
    return
  }
  // 2×2 repeat so tiling is visible
  for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) ctx.drawImage(gpu, tx * TILE, ty * TILE)

  // Parity: compare one tile's GPU readback against the CPU reference.
  try {
    const gctx = gpu.getContext('2d') as CanvasRenderingContext2D | null
    // textureFx canvas is WebGL; read back via a scratch 2D canvas
    const scratch = document.createElement('canvas'); scratch.width = TILE; scratch.height = TILE
    const sctx = scratch.getContext('2d')!; sctx.drawImage(gpu, 0, 0)
    const gpuData = sctx.getImageData(0, 0, TILE, TILE).data
    const cpu = cpuTile(item)
    let sum = 0
    for (let i = 0; i < cpu.length; i += 4) {
      sum += Math.abs(cpu[i]! - gpuData[i]!) + Math.abs(cpu[i + 1]! - gpuData[i + 1]!) + Math.abs(cpu[i + 2]! - gpuData[i + 2]!)
    }
    item.delta = sum / (TILE * TILE * 3)
    if (item.delta > maxDelta.value) maxDelta.value = item.delta
    void gctx
  } catch (e) {
    errors.value.push(`${item.key} parity: ${(e as Error).message}`)
  }
}

const seen = new Set<string>()
function registerCanvas(item: Item, el: HTMLCanvasElement | null) {
  if (!el || seen.has(item.key)) return
  seen.add(item.key)
  requestAnimationFrame(() => renderItem(item, el))
}
</script>

<style scoped>
.wrap { padding: 20px; background: #0b0d10; color: #e8eef5; font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; min-height: 100vh; }
h1 { font-size: 18px; margin: 0 0 4px; }
.sub { font-size: 12px; color: #7a8699; font-weight: 400; }
.legend { color: #9aa5b8; max-width: 780px; margin: 0 0 16px; }
code { color: #cdd6e4; background: #171b21; padding: 1px 4px; border-radius: 3px; }
h2 { font-size: 14px; margin: 22px 0 10px; color: #b7c2d4; border-bottom: 1px solid #1b2027; padding-bottom: 6px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 14px; }
figure { margin: 0; }
canvas { width: 100%; aspect-ratio: 1; border-radius: 6px; border: 1px solid #1b2027; image-rendering: pixelated; background: #000; }
figcaption { display: flex; justify-content: space-between; align-items: baseline; margin-top: 5px; }
.name { color: #dbe3ee; }
.delta { font: 11px monospace; color: #4a8f5a; }
.delta.warn { color: #c9a227; }
.delta.bad { color: #d9524a; }
.summary { margin-top: 26px; padding-top: 12px; border-top: 1px solid #1b2027; color: #9aa5b8; }
.summary .bad { color: #d9524a; }
.errs { display: block; margin-top: 6px; color: #d9524a; font: 11px monospace; }
</style>
