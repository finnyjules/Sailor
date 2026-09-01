<script setup lang="ts">
// Stretch lab — Phase A judgment rig for typographic stretch. Dev-only, not
// linked in the app. Three columns per render: naive (k = 0 through the SAME
// engine — |tangent·s|^0 = 1 everywhere, which IS uniform scaling), the smart
// flex remap, and (fonts with wdth) the real axis alone. If naive and smart
// ever look identical on a stem-heavy string, the flex path silently didn't
// run — that is a bug, not a coincidence.
definePageMeta({ layout: false })
import { computed, markRaw, onMounted, shallowRef, watch } from 'vue'
import { loadVariableFont } from '~/lib/vectortype/font'
import type { VtFont } from '~/lib/vectortype/font'
import { textOutlines } from '~/lib/vectortype/outline'
import type { TextOutlines } from '~/lib/vectortype/outline'
import { glyphFlexFor, planStretch, stretchOutlines, weightCompensation } from '~/lib/vectortype/stretch'

const LAB_FONTS = ['inter', 'roboto-flex', 'archivo', 'fraunces', 'source-serif', 'unbounded']
const TORTURE = ['Sailor', 'OQCGS', 'AVWXY', 'MNH', 'aegs', 'gjpqy', 'STRETCH the word']

const fontId = ref(LAB_FONTS[0]!)
const text = ref('Sailor')
const S = ref(1.6)
const SY = ref(1)
const k = ref(2)
const overlay = ref(false)
const weightComp = ref(false)
const ready = ref(false)
const error = ref('')

const fonts = new Map<string, VtFont>()
const font = shallowRef<VtFont | null>(null)

async function pickFont(id: string) {
  try {
    if (!fonts.has(id)) fonts.set(id, await loadVariableFont(id))
    font.value = markRaw(fonts.get(id)!)
    error.value = ''
  } catch (e) {
    error.value = String(e)
  }
}

const hasWdth = computed(() => !!font.value?.axes.some(a => a.tag === 'wdth'))

const naiveCanvas = ref<HTMLCanvasElement | null>(null)
const smartCanvas = ref<HTMLCanvasElement | null>(null)
const axisCanvas = ref<HTMLCanvasElement | null>(null)

function drawCommands(ctx: CanvasRenderingContext2D, o: TextOutlines) {
  const path = new Path2D()
  for (const g of o.glyphs) {
    for (const c of g.commands) {
      const a = c.args
      if (c.command === 'moveTo') path.moveTo(g.x + a[0]!, g.y + a[1]!)
      else if (c.command === 'lineTo') path.lineTo(g.x + a[0]!, g.y + a[1]!)
      else if (c.command === 'quadraticCurveTo') path.quadraticCurveTo(g.x + a[0]!, g.y + a[1]!, g.x + a[2]!, g.y + a[3]!)
      else if (c.command === 'bezierCurveTo') path.bezierCurveTo(g.x + a[0]!, g.y + a[1]!, g.x + a[2]!, g.y + a[3]!, g.x + a[4]!, g.y + a[5]!)
      else if (c.command === 'closePath') path.closePath()
    }
  }
  ctx.fill(path)
}

function render(canvas: HTMLCanvasElement | null, o: TextOutlines | null, withOverlay: boolean) {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const W = 900, H = 260
  canvas.width = W * dpr
  canvas.height = H * dpr
  canvas.style.width = `${W}px`
  canvas.style.height = `${H}px`
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  if (!o || !o.glyphs.length) return
  const pad = 20
  const bw = Math.max(1, o.bbox.maxX - o.bbox.minX)
  const bh = Math.max(1, o.bbox.maxY - o.bbox.minY)
  const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)
  ctx.save()
  // Font space is y-up; canvas is y-down.
  ctx.translate(pad - o.bbox.minX * scale, H - pad + o.bbox.minY * scale)
  ctx.scale(scale, -scale)
  ctx.fillStyle = '#e8e8ec'
  drawCommands(ctx, o)
  if (withOverlay) {
    // Two-channel flex tint (after Pagurek): red = horizontally rigid,
    // blue = vertically rigid. Strong tint = the remap holds that slice.
    for (const g of o.glyphs) {
      const flex = glyphFlexFor(g, { k: k.value })
      const { start, binSize, flex: fx } = flex.x
      for (let i = 0; i < fx.length; i++) {
        const a = (1 - fx[i]!) * 0.35
        if (a < 0.02) continue
        ctx.fillStyle = `rgba(255,60,60,${a})`
        ctx.fillRect(g.x + start + i * binSize, g.bbox.minY, binSize, g.bbox.maxY - g.bbox.minY)
      }
      const fy = flex.y
      for (let i = 0; i < fy.flex.length; i++) {
        const a = (1 - fy.flex[i]!) * 0.35
        if (a < 0.02) continue
        ctx.fillStyle = `rgba(60,120,255,${a})`
        ctx.fillRect(g.x + g.bbox.minX, fy.start + i * fy.binSize, g.bbox.maxX - g.bbox.minX, fy.binSize)
      }
    }
  }
  ctx.restore()
}

function rerender() {
  const f = font.value
  if (!f) return
  const baseAxes: Record<string, number> = {}
  // Naive column: identical pipeline at k = 0 — uniform scaling by
  // construction, so any visible difference against smart is the flex doing
  // its job (and no difference on stem-heavy text means it is NOT running).
  const naiveBase = textOutlines(f, text.value, baseAxes)
  render(naiveCanvas.value, stretchOutlines(naiveBase, S.value, SY.value, { k: 0 }), false)

  const plan = planStretch(f, text.value, baseAxes, S.value)
  const smartAxes = weightComp.value
    ? weightCompensation(f, plan.coords, S.value, SY.value)
    : plan.coords
  const smartBase = textOutlines(f, text.value, smartAxes)
  render(smartCanvas.value, stretchOutlines(smartBase, plan.residual, SY.value, { k: k.value }), overlay.value)

  if (hasWdth.value) {
    render(axisCanvas.value, textOutlines(f, text.value, plan.coords), false)
  } else {
    render(axisCanvas.value, null, false)
  }
}

watch([font, text, S, SY, k, overlay, weightComp], rerender)
watch(fontId, id => { void pickFont(id!) })

onMounted(async () => {
  await pickFont(fontId.value!)
  rerender()
  ready.value = true
})
</script>

<template>
  <div class="min-h-screen bg-neutral-950 p-6 text-neutral-200" :data-ready="ready ? 'true' : undefined">
    <h1 class="mb-4 font-mono text-sm text-neutral-400">stretch lab — Phase A judgment rig</h1>
    <p v-if="error" class="mb-4 text-sm text-red-400">{{ error }}</p>

    <div class="mb-4 flex flex-wrap items-center gap-4 text-sm">
      <label class="flex items-center gap-2">
        Font
        <select v-model="fontId" class="rounded bg-neutral-800 px-2 py-1" data-test="font">
          <option v-for="id in LAB_FONTS" :key="id" :value="id">{{ id }}</option>
        </select>
      </label>
      <input v-model="text" class="w-64 rounded bg-neutral-800 px-2 py-1" data-test="text" />
      <div class="flex gap-1">
        <button
          v-for="t in TORTURE" :key="t"
          class="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
          @click="text = t"
        >{{ t }}</button>
      </div>
    </div>

    <div class="mb-6 flex flex-wrap items-center gap-6 text-sm">
      <label class="flex items-center gap-2">
        Stretch {{ S.toFixed(2) }}×
        <input v-model.number="S" type="range" min="0.5" max="2.5" step="0.01" class="w-48" data-test="stretch-x" />
      </label>
      <label class="flex items-center gap-2">
        Height {{ SY.toFixed(2) }}×
        <input v-model.number="SY" type="range" min="0.5" max="2.5" step="0.01" class="w-48" data-test="stretch-y" />
      </label>
      <label class="flex items-center gap-2">
        k {{ k.toFixed(1) }}
        <input v-model.number="k" type="range" min="0" max="8" step="0.1" class="w-32" data-test="k" />
      </label>
      <label class="flex items-center gap-2">
        <input v-model="overlay" type="checkbox" data-test="overlay" /> flex overlay
      </label>
      <label class="flex items-center gap-2">
        <input v-model="weightComp" type="checkbox" data-test="weight-comp" /> weight comp
      </label>
    </div>

    <div class="space-y-6">
      <div>
        <div class="mb-1 font-mono text-xs text-neutral-500">naive (k = 0 — the control to beat)</div>
        <canvas ref="naiveCanvas" class="rounded bg-neutral-900" data-test="canvas-naive" />
      </div>
      <div>
        <div class="mb-1 font-mono text-xs text-neutral-500">smart (flex remap<span v-if="hasWdth"> after wdth cascade</span>)</div>
        <canvas ref="smartCanvas" class="rounded bg-neutral-900" data-test="canvas-smart" />
      </div>
      <div v-if="hasWdth">
        <div class="mb-1 font-mono text-xs text-neutral-500">axis only (real wdth, no remap)</div>
        <canvas ref="axisCanvas" class="rounded bg-neutral-900" data-test="canvas-axis" />
      </div>
    </div>
  </div>
</template>
