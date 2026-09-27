import { ref, reactive, watch } from 'vue'
import type { PaintStroke } from '~/lib/compositor/brushStamp'
import { TIPS, TIP_IDS, defaultSettings, REF_W, SIZE_MIN, SIZE_MAX, type TipId } from '~/lib/brushTips/tips'
import { encodePts, type Sample, type TipStroke } from '~/lib/brushTips/record'
import { isMaterialId, type MaterialId } from '~/lib/brushTips/materials'
import { DEFAULT_BRUSH_EFFECT } from '~/lib/brushTips/effects'
import { STEADY_DEFAULTS, sanitizeSteady, type SteadySettings } from '~/lib/brushTips/steady'
import { effectStackOf, type StackHost } from '~/lib/compositor/effectStack'
import { isFill, type Paint } from '~/lib/compositor/paint'
import { fillIsShader } from '~/lib/spacetype/fillTile'

export type BrushMode = 'paint' | 'effect' | 'mask'
const BRUSH_MODES: readonly BrushMode[] = ['paint', 'effect', 'mask']
function isBrushMode(v: unknown): v is BrushMode { return typeof v === 'string' && (BRUSH_MODES as readonly string[]).includes(v) }

const STORE_KEY = 'sailor.brushTips.v1'
function loadTips() {
  const settings = Object.fromEntries(TIP_IDS.map(t => [t, defaultSettings(t)])) as Record<TipId, Record<string, number>>
  const size = Object.fromEntries(TIP_IDS.map(t => [t, TIPS[t].defaultSize])) as Record<TipId, number>
  let tip: TipId = 'spray'
  let material: MaterialId | null = null
  let mode: BrushMode = 'paint'
  let effect: string = DEFAULT_BRUSH_EFFECT
  let shaderPaint: string | null = null
  let steady: SteadySettings = STEADY_DEFAULTS
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (raw && typeof raw === 'object') {
      if (TIP_IDS.includes(raw.tip)) tip = raw.tip
      if (isMaterialId(raw.material)) material = raw.material
      if (isBrushMode(raw.mode)) mode = raw.mode
      if (typeof raw.effect === 'string' && raw.effect.length > 0) effect = raw.effect
      if (typeof raw.shaderPaint === 'string' && raw.shaderPaint.length > 0) shaderPaint = raw.shaderPaint
      steady = sanitizeSteady(raw.steady)
      for (const t of TIP_IDS) {
        for (const k of Object.keys(settings[t])) { const v = raw.settings?.[t]?.[k]; if (typeof v === 'number' && Number.isFinite(v)) settings[t][k] = v }
        const sz = raw.size?.[t]; if (typeof sz === 'number' && Number.isFinite(sz)) size[t] = Math.min(SIZE_MAX, Math.max(SIZE_MIN, sz))
      }
    }
  } catch { steady = STEADY_DEFAULTS }
  return { tip, settings, size, material, mode, effect, shaderPaint, steady }
}

/** True when a brush layer's material and the toolbar's paint choice would draw the same look:
 * both Colour (no material), or the same material id. */
export function paintMatchesLayer(layerMaterial: { id: MaterialId } | undefined, toolbar: MaterialId | null): boolean {
  const layerId = layerMaterial?.id ?? null
  return layerId === toolbar
}

/** True when `layer` is a painted-effect layer (paint hidden) whose visible backdrop_shader
 *  targets `effectId`. */
export function effectLayerMatches(layer: (StackHost & { showPaint?: boolean }) | undefined, effectId: string): boolean {
  if (!layer || layer.showPaint !== false) return false
  return effectStackOf(layer).some(e => e.type === 'backdrop_shader' && e.visible !== false && (e as { effectId?: string }).effectId === effectId)
}

/** True when `fill` is a shader fill whose effect matches `shaderId` (never for `shaderId: null`). */
export function shaderPaintMatches(fill: unknown, shaderId: string | null): boolean {
  if (shaderId === null) return false
  const f = fill as Paint | undefined
  return isFill(f) && fillIsShader(f) && f.shader.effectId === shaderId
}

/** The Frame target rule for Paint mode: an effect layer never matches; a shaderPaint choice
 *  requires no material and a matching shader fill; otherwise fall back to `paintMatchesLayer`. */
export function paintTargetMatches(
  layer: { material?: { id: MaterialId }; fill?: unknown; showPaint?: boolean } | undefined,
  toolbar: { material: MaterialId | null; shaderPaint: string | null },
): boolean {
  if (layer?.showPaint === false) return false
  if (toolbar.shaderPaint !== null) return !layer?.material && shaderPaintMatches(layer?.fill, toolbar.shaderPaint)
  return paintMatchesLayer(layer?.material, toolbar.material)
}

export function useBrushPaint() {
  const saved = loadTips()
  const active = ref(false)
  const mode = ref<BrushMode>(saved.mode)
  const sizePx = ref(40)          // brush DIAMETER, display px
  const color = ref('#3b82f6')
  const opacity = ref(1)          // 0..1
  const hardness = ref(1)         // 1 hard … 0 soft
  const smoothing = ref(true)
  const eraser = ref(false)
  const cursor = ref<{ x: number; y: number } | null>(null) // width-normalized, for the ring

  let live: PaintStroke | null = null
  const hasLiveStroke = ref(false)

  function radiusNorm(baseW: number): number {
    return Math.max(0.0005, sizePx.value / 2 / Math.max(1, baseW))
  }
  function setActive(v: boolean) { active.value = v; if (!v) { live = null; hasLiveStroke.value = false } }

  function beginStroke(nx: number, ny: number, baseW: number) {
    live = { points: [{ x: nx, y: ny }], radius: radiusNorm(baseW), hardness: hardness.value, opacity: opacity.value, erase: eraser.value }
    hasLiveStroke.value = true
  }
  function extendStroke(nx: number, ny: number) {
    if (!live) return
    // Drop micro-moves so smoothing has clean input.
    const last = live.points[live.points.length - 1]!
    if (Math.hypot(nx - last.x, ny - last.y) < 0.0008) return
    live.points.push({ x: nx, y: ny })
  }
  function endStroke(): PaintStroke | null {
    const s = live
    live = null; hasLiveStroke.value = false
    return s && s.points.length ? s : null
  }
  const liveStroke = () => live

  const tip = ref<TipId>(saved.tip)
  const tipSettings = reactive(saved.settings)
  const tipSize = reactive(saved.size)
  const material = ref<MaterialId | null>(saved.material)
  const effect = ref<string>(saved.effect)
  const shaderPaint = ref<string | null>(saved.shaderPaint)
  function chooseMaterial(id: MaterialId | null) { material.value = id; shaderPaint.value = null }
  function chooseShaderPaint(id: string | null) { shaderPaint.value = id; if (id !== null) material.value = null }
  const steady = reactive<SteadySettings>({ ...saved.steady })
  function resetSteady() { Object.assign(steady, STEADY_DEFAULTS) }
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  watch([tip, tipSettings, tipSize, material, mode, effect, shaderPaint, steady], () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify({
      tip: tip.value, settings: tipSettings, size: tipSize, material: material.value,
      mode: mode.value, effect: effect.value, shaderPaint: shaderPaint.value, steady,
    })) } catch { /* ignore */ } }, 150)
  }, { deep: true })
  function resetTipSettings(t: TipId) { Object.assign(tipSettings[t], defaultSettings(t)) }

  let liveTip: TipStroke | null = null
  let tipSamples: Sample[] = []
  let t0 = 0
  function beginTipStroke(x: number, y: number, tMs: number) {
    t0 = tMs
    tipSamples = [{ x, y, t: 0 }]
    const rec: TipStroke = { tip: tip.value, v: 1, size: tipSize[tip.value] / REF_W, settings: { ...tipSettings[tip.value] }, seed: (Math.random() * 0xffffffff) >>> 0, pts: encodePts(tipSamples) }
    if (eraser.value) rec.erase = true
    liveTip = rec
  }
  function pushTipSample(x: number, y: number, tMs: number) {
    if (!liveTip) return
    const t = Math.max(tipSamples[tipSamples.length - 1]!.t, tMs - t0)
    const last = tipSamples[tipSamples.length - 1]!
    if (last.x === x && last.y === y && last.t === t) return
    tipSamples.push({ x, y, t })
    // Append just this sample (same rounding as encodePts) — re-encoding the whole stroke per
    // sample made a long stroke quadratic. The array is the live record replay reads.
    liveTip.pts.push(...encodePts([{ x, y, t }]))
  }
  const extendTipStroke = (x: number, y: number, tMs: number) => pushTipSample(x, y, tMs)
  function holdTipStroke(tMs: number) { const l = tipSamples[tipSamples.length - 1]; if (l) pushTipSample(l.x, l.y, tMs) }
  const liveTipStroke = () => liveTip
  function endTipStroke(): TipStroke | null { const s = liveTip; liveTip = null; tipSamples = []; if (s) s.pts = s.pts.slice(); return s }
  function replaceTipSamples(samples: Sample[]) {
    if (!liveTip || !samples.length) return
    tipSamples = samples.map(p => ({ ...p }))
    // A FRESH record, not an in-place rewrite: per-stroke caches (tipStrokeBox, replay memo)
    // key on the object and assume append-only, so a replaced stroke must be a new object.
    // Callers re-read liveTipStroke().
    liveTip = { ...liveTip, pts: encodePts(tipSamples) }
  }

  return {
    active, mode, sizePx, color, opacity, hardness, smoothing, eraser, cursor, hasLiveStroke,
    setActive, radiusNorm, beginStroke, extendStroke, endStroke, liveStroke,
    tip, tipSettings, tipSize, material, effect, shaderPaint, chooseMaterial, chooseShaderPaint, resetTipSettings,
    steady, resetSteady,
    beginTipStroke, extendTipStroke, holdTipStroke, liveTipStroke, endTipStroke, replaceTipSamples,
  }
}
