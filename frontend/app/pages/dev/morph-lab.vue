<script setup lang="ts">
// Morph lab — judgment rig for the medial-pinning engine (lib/vector/medial.ts).
// Dev-only, not linked in the app. Two questions, both answered by eye:
//   1. Centreline: does the pinned outline rebuild the original exactly, with a
//      correctly trimmed medial axis?
//   2. Morph: font → font, three ways side by side — today's Blend engine
//      (vector/morph.ts), structural pairing with straight slides, and the full
//      centreline morph (pole, radius and facing interpolated apart).
definePageMeta({ layout: false })
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { loadVectorFont } from '~/lib/vectortype/font'
import type { VtFont } from '~/lib/vectortype/font'
import { textOutlines } from '~/lib/vectortype/outline'
import { prepareBlend } from '~/lib/vector/morph'
import { evalGlyph, flattenCommands, pairGlyphs, pinGlyph, stemHalfWidth, unionRings } from '~/lib/vector/medial'
import type { ContourPair, P, PinnedGlyph } from '~/lib/vector/medial'

const FONT_OPTIONS = [
  'google:Permanent Marker@400', 'google:Archivo Black@400', 'google:Bebas Neue@400', 'google:Titan One@400',
  'google:Bungee@400', 'google:Anton@400', 'google:Pacifico@400', 'google:Lobster@400', 'google:Rubik Mono One@400',
  'google:Chango@400', 'inter', 'fraunces', 'unbounded', 'archivo',
]
const fontLabel = (t: string) => t.startsWith('google:') ? t.slice(7).replace(/@\d+$/, '') : t[0]!.toUpperCase() + t.slice(1)

const W = 1000
const CAP = 120
const ROW_H = 220
const BASE = 160

const text = ref('SLANG')
const seq = ref<string[]>(['google:Permanent Marker@400', 'google:Archivo Black@400', 'google:Bebas Neue@400', 'google:Titan One@400'])
const error = ref('')
const busy = ref(false)

// Centreline section
const spur = ref(1.5)
const pinTo = ref<'axis' | 'pole'>('axis')
const showPins = ref(false)
const showAxis = ref(true)

// Morph section
const pos = ref(0) // 0 … seq.length (loops)
const playing = ref(false)
const mode = ref<'flow' | 'hold'>('hold')
const onTwos = ref(true)
const secondsPerLook = ref(1.2)
const look = ref<'reference' | 'plain'>('reference')
const smoothing = ref(6)

const fonts = new Map<string, VtFont>()
const version = ref(0) // bumps when pinned data is (re)built

interface WordData { glyphs: PinnedGlyph[]; rings: P[][][]; zones: number[]; em: number; stem: number; restError: number; orphans: number; ms: number }
const words = shallowRef<Map<string, WordData>>(new Map())
const pairCache = new Map<string, { medial: ContourPair[][]; blend: ((t: number) => string)[] } | null>()

let paperMod: any = null

function buildWord(font: VtFont, str: string): WordData {
  const t0 = performance.now()
  const out = textOutlines(font, str)
  const cap = out.metrics.capHeight || out.unitsPerEm * 0.7
  const s = CAP / cap
  const ox = (W - out.width * s) / 2
  const glyphs: PinnedGlyph[] = []
  const rings: P[][][] = []
  let restError = 0, orphans = 0
  for (const g of out.glyphs) {
    if (!g.commands.length) continue
    const r = unionRings(paperMod, flattenCommands(g.commands, (x, y) => [ox + (g.x + x) * s, BASE - (g.y + y) * s]))
    if (!r.length) continue
    const pg = pinGlyph(r, { h: CAP / 70, spur: spur.value, pin: pinTo.value })
    glyphs.push(pg); rings.push(r)
    restError = Math.max(restError, pg.restError); orphans += pg.orphans
  }
  const zones = [BASE, BASE - out.metrics.capHeight * s, BASE - out.metrics.xHeight * s]
  return { glyphs, rings, zones, em: out.unitsPerEm * s, stem: stemHalfWidth(glyphs), restError, orphans, ms: performance.now() - t0 }
}

async function rebuild() {
  busy.value = true
  error.value = ''
  try {
    if (!paperMod) paperMod = ((await import('paper')) as any).default
    const next = new Map<string, WordData>()
    for (const tok of seq.value) {
      if (!fonts.has(tok)) fonts.set(tok, markRaw(await loadVectorFont(tok)))
      if (!next.has(tok)) next.set(tok, buildWord(fonts.get(tok)!, text.value))
    }
    words.value = next
    pairCache.clear()
    version.value++
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

const ringsToD = (rings: P[][]) => rings.map(r => 'M' + r.map(p => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' L') + ' Z').join(' ')

function pairFor(i: number) {
  const a = seq.value[i % seq.value.length]!, b = seq.value[(i + 1) % seq.value.length]!
  const key = `${a}→${b}`
  if (pairCache.has(key)) return pairCache.get(key)!
  const A = words.value.get(a), B = words.value.get(b)
  let v: { medial: ContourPair[][]; blend: ((t: number) => string)[] } | null = null
  if (A && B && A.glyphs.length === B.glyphs.length) {
    v = {
      medial: A.glyphs.map((g, k) => pairGlyphs(g, B.glyphs[k]!)),
      blend: A.rings.map((r, k) => prepareBlend(ringsToD(r), ringsToD(B.rings[k]!))),
    }
  }
  pairCache.set(key, v)
  return v
}

// ── Drawing ─────────────────────────────────────────────────────────────────

const PAL = {
  reference: { bg: '#e2d35c', face: '#f39be4', side: '#e8483f', depth: 9 },
  plain: { bg: '#141414', face: '#ededed', side: '', depth: 0 },
}

function setup(cv: HTMLCanvasElement | null, h: number) {
  if (!cv) return null
  const dpr = window.devicePixelRatio || 1
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = h * dpr }
  const ctx = cv.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

// Rows 2–3 fill nonzero, as fonts do: contours keep their winding through the
// morph, so a mid-morph self-overlap reads as ink, not a see-through hole.
function fillWord(ctx: CanvasRenderingContext2D, paths: Path2D[], rule: CanvasFillRule) {
  const p = PAL[look.value]
  if (p.depth) {
    ctx.fillStyle = p.side
    for (let d = p.depth; d > 0; d -= 1) {
      ctx.save(); ctx.translate(d * 0.8, d); for (const path of paths) ctx.fill(path, rule); ctx.restore()
    }
  }
  ctx.fillStyle = p.face
  for (const path of paths) ctx.fill(path, rule)
}

const ringsPath = (rings: P[][]) => {
  const path = new Path2D()
  for (const r of rings) {
    if (!r.length) continue
    path.moveTo(r[0]![0], r[0]![1])
    for (let i = 1; i < r.length; i++) path.lineTo(r[i]![0], r[i]![1])
    path.closePath()
  }
  return path
}

const centreCv = ref<HTMLCanvasElement | null>(null)
const morphCvs = ref<(HTMLCanvasElement | null)[]>([null, null, null])

function drawCentre() {
  const ctx = setup(centreCv.value, ROW_H * seq.value.length)
  if (!ctx) return
  ctx.fillStyle = '#141414'
  ctx.fillRect(0, 0, W, ROW_H * seq.value.length)
  seq.value.forEach((tok, row) => {
    const wd = words.value.get(tok)
    if (!wd) return
    ctx.save()
    ctx.translate(0, row * ROW_H)
    ctx.fillStyle = '#777'
    ctx.font = '12px ui-sans-serif, system-ui'
    ctx.fillText(fontLabel(tok), 12, 20)
    // Original outline, faint, for comparison.
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth = 1
    for (const r of wd.rings) ctx.stroke(ringsPath(r))
    // Deformed (pinned) outline.
    ctx.fillStyle = 'rgba(237,237,237,0.92)'
    for (const r of wd.rings) ctx.fill(ringsPath(r), 'evenodd')
    if (showAxis.value) {
      ctx.strokeStyle = '#ff3d9a'
      ctx.lineWidth = 1.6
      ctx.beginPath()
      for (const g of wd.glyphs) for (const e of g.axis) {
        ctx.moveTo(e.a[0], e.a[1]); ctx.lineTo(e.b[0], e.b[1])
      }
      ctx.stroke()
    }
    if (showPins.value) {
      ctx.strokeStyle = 'rgba(80,200,255,0.55)'
      ctx.lineWidth = 0.7
      ctx.beginPath()
      for (const g of wd.glyphs) for (const c of g.contours) {
        for (let i = 0; i < c.pts.length; i += 4) { ctx.moveTo(c.pts[i]![0], c.pts[i]![1]); ctx.lineTo(c.m[i]![0], c.m[i]![1]) }
      }
      ctx.stroke()
    }
    ctx.restore()
  })
}

const segment = computed(() => {
  const n = seq.value.length
  const p = ((pos.value % n) + n) % n
  const i = Math.floor(p)
  const local = p - i
  let t: number
  const ease = (x: number) => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
  if (mode.value === 'flow') t = ease(local)
  else { const hold = 0.6; t = local < hold ? 0 : ease((local - hold) / (1 - hold)) }
  return { i, t, from: seq.value[i]!, to: seq.value[(i + 1) % n]! }
})

const COLS = ['Today’s Blend', 'Paired by centreline, straight slide', 'Centreline morph'] as const

function drawMorph() {
  const { i, t } = segment.value
  const pr = pairFor(i)
  COLS.forEach((_, col) => {
    const ctx = setup(morphCvs.value[col] ?? null, ROW_H)
    if (!ctx) return
    ctx.fillStyle = PAL[look.value].bg
    ctx.fillRect(0, 0, W, ROW_H)
    if (!pr) return
    let paths: Path2D[]
    if (col === 0) paths = pr.blend.map(f => new Path2D(f(t)))
    else paths = pr.medial.map(pairs => ringsPath(evalGlyph(pairs, t, col === 1 ? 'linear' : 'medial', smoothing.value)))
    fillWord(ctx, paths, col === 0 ? 'evenodd' : 'nonzero')
  })
}

function drawAll() { drawCentre(); drawMorph() }

// ── Playback ────────────────────────────────────────────────────────────────

let raf = 0
let last = 0
let acc = 0
function tick(now: number) {
  if (!playing.value) return
  const dt = last ? (now - last) / 1000 : 0
  last = now
  acc += dt
  const step = onTwos.value ? 1 / 12 : 0
  if (acc >= step) {
    pos.value = (pos.value + acc / secondsPerLook.value) % seq.value.length
    acc = 0
  }
  raf = requestAnimationFrame(tick)
}
watch(playing, (p) => { if (p) { last = 0; acc = 0; raf = requestAnimationFrame(tick) } else cancelAnimationFrame(raf) })

watch([showPins, showAxis], drawCentre)
watch([pos, mode, look, smoothing], drawMorph)
watch(version, () => requestAnimationFrame(drawAll))
watch([spur, pinTo], () => rebuild())

let textTimer: ReturnType<typeof setTimeout> | undefined
watch(text, () => { clearTimeout(textTimer); textTimer = setTimeout(rebuild, 350) })
watch(seq, rebuild, { deep: true })

onMounted(rebuild)
onBeforeUnmount(() => cancelAnimationFrame(raf))

const stats = computed(() => {
  void version.value
  return seq.value.map(tok => {
    const w = words.value.get(tok)
    return w ? { tok, err: w.restError, orphans: w.orphans, ms: w.ms } : { tok, err: NaN, orphans: 0, ms: 0 }
  })
})
const mismatch = computed(() => { void version.value; return !pairFor(segment.value.i) && words.value.size > 0 })
</script>

<template>
  <div class="lab">
    <header>
      <h1>Morph lab</h1>
      <p class="sub">Every outline point is pinned to the letter’s centreline, which pairs letters for the morph and measures stroke width. Thickness moves the font’s own edges in parallel.</p>
      <div class="row">
        <label>Text <input v-model="text" class="txt"></label>
        <span class="quick">
          <button v-for="q in ['SLANG', 'Slang', 'ag', 'SLANGag']" :key="q" @click="text = q">{{ q }}</button>
        </span>
        <span v-if="busy" class="muted">Working…</span>
        <span v-if="error" class="err">{{ error }}</span>
      </div>
      <div class="row">
        <label v-for="(_, k) in seq" :key="k">Look {{ k + 1 }}
          <select v-model="seq[k]">
            <option v-for="f in FONT_OPTIONS" :key="f" :value="f">{{ fontLabel(f) }}</option>
          </select>
        </label>
      </div>
    </header>

    <section>
      <h2>Morph</h2>
      <div class="row">
        <button class="play" @click="playing = !playing">{{ playing ? 'Pause' : 'Play' }}</button>
        <input v-model.number="pos" type="range" min="0" :max="seq.length" step="0.001" class="scrub">
        <span class="muted">{{ fontLabel(segment.from) }} → {{ fontLabel(segment.to) }} · {{ Math.round(segment.t * 100) }}%</span>
      </div>
      <div class="row">
        <label>Timing
          <select v-model="mode"><option value="hold">Hold, then morph</option><option value="flow">Continuous</option></select>
        </label>
        <label><input v-model="onTwos" type="checkbox"> On twos (12 fps)</label>
        <label>Seconds per look <input v-model.number="secondsPerLook" type="range" min="0.3" max="3" step="0.1"> {{ secondsPerLook.toFixed(1) }}</label>
        <label>Smoothing (row 3) <input v-model.number="smoothing" type="range" min="0" max="16" step="1"> {{ smoothing }}</label>
        <label>Look
          <select v-model="look"><option value="reference">Reference colours</option><option value="plain">Plain</option></select>
        </label>
      </div>
      <p v-if="mismatch" class="err">These two fonts shape the text into different glyph counts (a ligature?), so this step can’t morph.</p>
      <div v-for="(label, col) in COLS" :key="label" class="morph">
        <div class="cap">{{ col + 1 }}. {{ label }}</div>
        <canvas :ref="(el) => { morphCvs[col] = el as HTMLCanvasElement | null }" :style="{ width: W + 'px', height: ROW_H + 'px' }" />
      </div>
    </section>

    <section>
      <h2>Centreline</h2>
      <div class="row">
        <label>Trim corner branches <input v-model.number="spur" type="range" min="0" max="2.5" step="0.05"> {{ spur.toFixed(2) }}</label>
        <label>Pin to
          <select v-model="pinTo"><option value="axis">Trimmed centreline</option><option value="pole">Nearest disk (untrimmed)</option></select>
        </label>
        <label><input v-model="showAxis" type="checkbox"> Centreline</label>
        <label><input v-model="showPins" type="checkbox"> Pins</label>
      </div>
      <canvas ref="centreCv" :style="{ width: W + 'px', height: ROW_H * seq.length + 'px' }" />
      <table class="stats">
        <thead><tr><th>Font</th><th>Largest rest error</th><th>Unpinned points</th><th>Pinning time</th></tr></thead>
        <tbody><tr v-for="s in stats" :key="s.tok">
          <td>{{ fontLabel(s.tok) }}</td><td>{{ s.err.toExponential(1) }} px</td><td>{{ s.orphans }}</td><td>{{ s.ms.toFixed(0) }} ms</td>
        </tr></tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.lab { background: #0c0c0c; color: #ddd; min-height: 100vh; padding: 20px 24px 60px; font: 13px ui-sans-serif, system-ui, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 8px; }
.sub { color: #999; margin: 0 0 12px; }
.row { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin: 8px 0; }
label { display: inline-flex; gap: 6px; align-items: center; }
.txt { width: 160px; }
input, select, button { background: #1d1d1d; color: #eee; border: 1px solid #333; border-radius: 4px; padding: 3px 6px; font: inherit; }
button { cursor: pointer; }
.quick { display: inline-flex; gap: 4px; }
.play { min-width: 64px; }
.scrub { width: 420px; }
.muted { color: #888; }
.err { color: #ff7a7a; }
.morph { margin: 10px 0; }
.cap { color: #aaa; margin-bottom: 4px; }
canvas { display: block; border-radius: 6px; max-width: 100%; }
.stats { margin-top: 10px; border-collapse: collapse; }
.stats td, .stats th { padding: 3px 12px 3px 0; text-align: left; color: #aaa; font-weight: normal; }
</style>
