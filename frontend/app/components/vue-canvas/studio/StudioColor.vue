<script setup lang="ts">
// Dark, in-theme color picker for the studios (replaces the OS <input type=color>).
// Swatch trigger + a Teleported popover (saturation/value pad, hue slider, hex field).
// Teleported to <body> + fixed-positioned so it escapes the section cards' overflow:hidden.
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { Pipette } from 'lucide-vue-next'
import { clampHex, isHex, isHexA, parseHexA, withAlpha, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, rgbToOklch, oklchToRgb } from './color'

const model = defineModel<string>({ required: true })

const open = ref(false)
const trigger = ref<HTMLElement | null>(null)
const popEl = ref<HTMLElement | null>(null)
const popStyle = ref<Record<string, string>>({})
const h = ref(0), s = ref(0), v = ref(0)
// Alpha rides alongside the hue/sat/val trio. The model may be 6-digit (opaque, the legacy
// form) or 8-digit; `base` is always the 6-digit part, because every colour-math helper below
// runs through clampHex, which rejects 8-digit and would silently return black.
const alpha = ref(1)
const base = computed(() => parseHexA(model.value).hex)
/** Write a 6-digit hex back to the model with the current alpha re-applied.
 *  withAlpha emits 6-digit when alpha is 1, so opaque colours stay byte-identical to before. */
function emit(hex6: string) { model.value = withAlpha(hex6, alpha.value) }

// A checkerboard behind any swatch, so a translucent colour reads as translucent.
// `background-clip: padding-box` matters: the swatch's border is translucent white, and
// with the default border-box clip the 8px checker painted UNDER it — alternating light and
// dark squares around the perimeter, which reads as a DASHED outline rather than a hairline.
const CHECKER = 'background-image:linear-gradient(45deg,#555 25%,transparent 25%),linear-gradient(-45deg,#555 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#555 75%),linear-gradient(-45deg,transparent 75%,#555 75%);background-size:8px 8px;background-position:0 0,0 4px,4px -4px,-4px 0px;background-color:#888;background-clip:padding-box'
const MODES = ['hex', 'rgb', 'oklch'] as const
const mode = ref<typeof MODES[number]>('hex')

const inputCls = 'w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-1 text-center font-mono text-xs text-white/85 outline-none focus-visible:ring-2 focus-visible:ring-white/20'

const hueColor = computed(() => { const [r, g, b] = hsvToRgb(h.value, 1, 1); return rgbToHex(r, g, b) })
function pushModel() { const [r, g, b] = hsvToRgb(h.value, s.value, v.value); emit(rgbToHex(r, g, b)) }
/** Sync the h/s/v/alpha refs from an EXPLICIT colour rather than re-reading the model.
 *  Callers that just wrote to `model` must use this: `model` is a defineModel, so reading it
 *  back in the same tick can still return the pre-assignment value, which would clobber the
 *  alpha that was just set. (Observed live: typing an 8-digit hex snapped alpha to 0.) */
function syncFrom(hex6: string, a: number) {
  alpha.value = a
  const [r, g, b] = hexToRgb(hex6); const [hh, ss, vv] = rgbToHsv(r, g, b); h.value = hh; s.value = ss; v.value = vv
}
function syncFromModel() { const { hex, alpha: a } = parseHexA(model.value); syncFrom(hex, a) }
/** 0–100 proxy for the alpha slider. Re-emits the current colour at the new alpha. */
const alphaPct = computed({
  get: () => Math.round(alpha.value * 100),
  set: (val: number) => { alpha.value = Math.min(1, Math.max(0, (Number(val) || 0) / 100)); emit(base.value) },
})

// The hex field is a DRAFT while you type. Committing per keystroke would run
// clampHex mid-entry, and clampHex turns anything incomplete into #000000 — so
// "#1a2b3c" was destroyed (and the colour blackened) at the first character.
// null means "not editing", and the field mirrors the model.
const hexDraft = ref<string | null>(null)
const hexValue = computed(() => hexDraft.value ?? model.value)
function onHexInput(e: Event) { hexDraft.value = (e.target as HTMLInputElement).value }
/** Blur/Enter: apply a complete hex, otherwise drop the draft and snap back to
 *  the model. Never writes a clamped partial value. */
function commitHex() {
  const draft = hexDraft.value
  hexDraft.value = null
  if (draft === null) return
  // 8-digit is accepted so alpha can be typed directly; it carries its own alpha, so it is
  // written through verbatim rather than having the slider's current alpha re-applied.
  if (isHexA(draft)) { const { hex, alpha: a } = parseHexA(draft); model.value = withAlpha(hex, a); syncFrom(hex, a) }
  else if (isHex(draft)) { const hex = clampHex(draft); emit(hex); syncFrom(hex, alpha.value) }
}

// RGB channel proxies (0–255).
function rgbChannel(i: number) {
  return computed({
    get: () => hexToRgb(base.value)[i]!,
    set: (val: number) => {
      const c = hexToRgb(base.value)
      c[i] = Math.min(255, Math.max(0, Math.round(Number(val) || 0)))
      const hex = rgbToHex(c[0], c[1], c[2]); emit(hex); syncFrom(hex, alpha.value)
    },
  })
}
const rCh = rgbChannel(0), gCh = rgbChannel(1), bCh = rgbChannel(2)

// OKLCH channel proxies (L 0–1, C 0–~0.4, H 0–360).
const round = (n: number, d: number) => { const p = 10 ** d; return Math.round(n * p) / p }
function oklchChannel(i: number, decimals: number) {
  return computed({
    get: () => round(rgbToOklch(...hexToRgb(base.value))[i]!, decimals),
    set: (val: number) => {
      const o = rgbToOklch(...hexToRgb(base.value))
      o[i] = Math.max(0, Number(val) || 0)
      const [r, g, b] = oklchToRgb(o[0], o[1], o[2])
      const hex = rgbToHex(r, g, b); emit(hex); syncFrom(hex, alpha.value)
    },
  })
}
const lCh = oklchChannel(0, 3), cCh = oklchChannel(1, 3), hCh = oklchChannel(2, 1)

const hasEyeDropper = ref(false)
onMounted(() => { hasEyeDropper.value = typeof window !== 'undefined' && 'EyeDropper' in window })
async function pickEye() {
  try {
    const res = await new (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper().open()
    if (res?.sRGBHex) { const hex = clampHex(res.sRGBHex); emit(hex); syncFrom(hex, alpha.value) }
  } catch { /* cancelled */ }
}

function reposition() {
  const el = trigger.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const M = 8
  // Measure the popover once it exists rather than assuming 220px — the old hard-coded W
  // under-clamped whenever the rendered popover was wider (it is cut off in the studio
  // fill editor, where the swatch sits at the panel's right edge). Falls back to 220 on
  // the very first frame before the Teleport mounts.
  const W = popEl.value?.offsetWidth || 220
  const H = popEl.value?.offsetHeight || 300
  // Prefer opening rightward from the swatch; if that runs off the right edge, flip so the
  // popover's RIGHT edge aligns with the swatch's — i.e. open leftward, like most pickers.
  let left = r.left
  if (left + W > window.innerWidth - M) left = r.right - W
  // Then hard-clamp to the viewport so it can never be cut on either side.
  left = Math.max(M, Math.min(left, window.innerWidth - W - M))
  const below = r.bottom + 6
  const top = below + H > window.innerHeight ? Math.max(M, r.top - H - 6) : below
  // Width stays fixed at 220 — the popover's saturation pad and bars are `w-full`, so the
  // box needs a width to resolve against. It is `min`'d to the viewport only as a last
  // resort on a viewport narrower than the popover itself.
  popStyle.value = { left: `${left}px`, top: `${top}px`, width: `${Math.min(220, window.innerWidth - 2 * M)}px` }
}
function openPicker() {
  hexDraft.value = null // never reopen showing a draft abandoned by an Escape
  syncFromModel(); open.value = true
  nextTick(reposition)
  window.addEventListener('scroll', reposition, true)
  window.addEventListener('resize', reposition)
  window.addEventListener('pointerdown', onOutside, true)
  // Capture phase: the shared StudioModalShell registers its own Escape→close keydown
  // on window (bubble) in onMounted, BEFORE this popover opens — so a bubble listener
  // here fires too late to stop it. Capturing lets us intercept Escape first.
  window.addEventListener('keydown', onKey, true)
}
function close() {
  open.value = false
  hexDraft.value = null // Escape unmounts the input without a blur, so drop the draft
  window.removeEventListener('scroll', reposition, true)
  window.removeEventListener('resize', reposition)
  window.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('keydown', onKey, true)
}
function onOutside(e: PointerEvent) {
  const t = e.target as Node
  if (trigger.value?.contains(t)) return
  if ((e.target as HTMLElement).closest?.('[data-studio-color-pop]')) return
  close()
}
// stopImmediatePropagation + preventDefault so the modal shell's Escape→close (a separate
// window keydown listener) does NOT also fire — Escape over an open popover closes only it.
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); close() } }
onBeforeUnmount(close)

function dragSv(e: PointerEvent) {
  const pad = (e.currentTarget as HTMLElement)
  const move = (ev: PointerEvent) => {
    const r = pad.getBoundingClientRect()
    s.value = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width))
    v.value = Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height))
    pushModel()
  }
  move(e)
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}
function dragHue(e: PointerEvent) {
  const bar = (e.currentTarget as HTMLElement)
  const move = (ev: PointerEvent) => {
    const r = bar.getBoundingClientRect()
    h.value = Math.min(360, Math.max(0, (ev.clientX - r.left) / r.width * 360))
    pushModel()
  }
  move(e)
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
}
</script>

<template>
  <button ref="trigger" type="button" @click="open ? close() : openPicker()"
          class="relative h-7 w-7 shrink-0 overflow-hidden rounded-[6px] border border-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
          :style="CHECKER" :aria-label="`Color ${model}`">
    <span class="absolute inset-0" :style="{ background: model }"></span>
  </button>

  <Teleport to="body">
    <div v-if="open" ref="popEl" data-studio-color-pop :style="popStyle"
         class="fixed z-[200] rounded-lg border border-white/10 bg-neutral-900 p-2.5 shadow-xl">
      <!-- Format first: which notation the value field at the bottom speaks. It sits up
           here as a header rather than in the action row, so that row keeps to its three
           actions (eyedropper, Clear, swatch) and nothing is crammed. -->
      <div class="mb-2 flex rounded-md bg-white/[0.05] p-0.5" role="tablist" aria-label="Colour format">
        <button v-for="mo in MODES" :key="mo" type="button" role="tab" @click="mode = mo"
                :aria-selected="mode === mo ? 'true' : 'false'"
                class="flex-1 rounded px-1 py-1 text-[10px] uppercase transition-colors"
                :class="mode === mo ? 'bg-white text-neutral-900' : 'text-white/55 hover:text-white/80'">{{ mo }}</button>
      </div>
      <div class="relative mb-2 h-32 w-full cursor-crosshair rounded-md"
           :style="{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hueColor}` }"
           @pointerdown="dragSv">
        <span class="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              :style="{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }"></span>
      </div>
      <div class="relative mb-2.5 h-3 w-full cursor-pointer rounded-full"
           style="background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)"
           @pointerdown="dragHue">
        <span class="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              :style="{ left: `${h / 360 * 100}%`, background: hueColor }"></span>
      </div>
      <!-- Alpha track: the colour ramped to fully transparent, over a checkerboard. -->
      <div class="relative mb-2.5 h-3 w-full rounded-full" :style="CHECKER">
        <div class="absolute inset-0 rounded-full"
             :style="{ background: `linear-gradient(to right, ${base}00, ${base})` }"></div>
        <input v-model.number="alphaPct" type="range" min="0" max="100" step="1"
               aria-label="Alpha"
               class="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent" />
        <span class="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              :style="{ left: `${alphaPct}%` }"></span>
      </div>
      <div class="mb-2 flex items-center gap-1.5">
        <button v-if="hasEyeDropper" type="button" @click="pickEye" aria-label="Pick color from screen"
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white/70 hover:text-white">
          <Pipette class="h-3.5 w-3.5" />
        </button>
        <button type="button" @click="alphaPct = 0" aria-label="Make transparent"
                class="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-1 text-[10px] text-white/55 hover:text-white">Clear</button>
        <span class="relative h-7 w-7 shrink-0 overflow-hidden rounded-md border border-white/10" :style="CHECKER">
          <span class="absolute inset-0" :style="{ background: model }"></span>
        </span>
      </div>
      <input v-if="mode === 'hex'" :value="hexValue" @input="onHexInput" @blur="commitHex"
             @keydown.enter.prevent="commitHex" spellcheck="false" :class="inputCls" />
      <div v-else-if="mode === 'rgb'" class="grid grid-cols-3 gap-1.5">
        <div><input v-model.number="rCh" type="number" min="0" max="255" :class="inputCls" /><div class="mt-0.5 text-center text-[10px] text-white/35">R</div></div>
        <div><input v-model.number="gCh" type="number" min="0" max="255" :class="inputCls" /><div class="mt-0.5 text-center text-[10px] text-white/35">G</div></div>
        <div><input v-model.number="bCh" type="number" min="0" max="255" :class="inputCls" /><div class="mt-0.5 text-center text-[10px] text-white/35">B</div></div>
      </div>
      <div v-else class="grid grid-cols-3 gap-1.5">
        <div><input v-model.number="lCh" type="number" min="0" max="1" step="0.001" :class="inputCls" /><div class="mt-0.5 text-center text-[10px] text-white/35">L</div></div>
        <div><input v-model.number="cCh" type="number" min="0" max="0.5" step="0.001" :class="inputCls" /><div class="mt-0.5 text-center text-[10px] text-white/35">C</div></div>
        <div><input v-model.number="hCh" type="number" min="0" max="360" step="0.1" :class="inputCls" /><div class="mt-0.5 text-center text-[10px] text-white/35">H</div></div>
      </div>
    </div>
  </Teleport>
</template>
