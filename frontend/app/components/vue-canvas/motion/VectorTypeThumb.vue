<script setup lang="ts">
/**
 * A preset tile that draws REAL GLYPH OUTLINES.
 *
 * `PresetThumb` draws a rounded card with "Aa" on it and is right to: for Slide
 * and Fade the motion is the whole story. For a variable-AXIS preset the card
 * says nothing — "Weight In" as a card that grows is indistinguishable from
 * "Grow", and the thing being advertised (the letterforms themselves being
 * re-cut, thicker or wider or graded) has no card equivalent. So this tile runs
 * the studio's own renderer on the user's own word.
 *
 * Three things it is careful about:
 *
 *  1. **It registers with `thumbClock` and adds NO rAF of its own.** One loop
 *     drives ~30 tiles and an `IntersectionObserver` pauses the scrolled-off
 *     ones; a second loop would double the cost and defeat the pausing. The only
 *     scheduling this component does is a frame-rate gate INSIDE the shared
 *     clock's callback (see `MIN_FRAME`) — outline shaping is far dearer than
 *     the card drawing `PresetThumb` does, and a gallery of these at 60fps would
 *     re-shape the run 60 times a second per tile for no visible gain.
 *
 *  2. **It never blocks the gallery on a font fetch.** The font is a network
 *     round trip through `/api/fonts/variable`; until it lands (or if it never
 *     does) the tile paints the same word in a system face, dimmed, so the
 *     gallery opens instantly at its final layout. `loadVectorFont` caches the
 *     PROMISE per id, so twenty tiles asking for the same family share one fetch
 *     — which is the normal case here, since every axis tile is about the font
 *     the studio currently has open.
 *
 *  3. **It draws through `drawVectorType`**, the one canvas path (`canvas.ts`),
 *     rather than a tile-shaped copy of it. A thumbnail that renders the preset
 *     differently from the surface is the "Smart Layout render parity" failure
 *     in its most damaging position: the picture the user chooses BY.
 *
 * Task 9 mounts this; it does not mount itself anywhere.
 */
import type { Paint } from '~/lib/compositor/paint'
import { registerThumb } from '~/lib/motion/thumbClock'
import { drawVectorTypeToCanvas } from '~/lib/vectortype/canvas'
import type { VtPresetSlot } from '~/lib/vectortype/config'
import { loadVectorFont, type VtFont } from '~/lib/vectortype/font'
import {
  VT_THUMB_CYCLE,
  VT_THUMB_H,
  VT_THUMB_PAD,
  VT_THUMB_W,
  vtThumbConfig,
  vtThumbSize,
  vtThumbWord,
} from '~/lib/vectortype/thumbPreview'

const props = defineProps<{
  /** The preset this tile advertises. */
  presetId: string
  slotKind: VtPresetSlot
  /** Catalog font id — the family the studio has open. Used to load the font
   *  when `font` is not supplied. */
  fontId: string
  /** The studio's live text. Truncated to a word; falls back to "Type". */
  text?: string
  /** Where the user has parked the axes (`config.axes`). A preset is a delta on
   *  this, so passing it keeps the tile honest about what the user will see. */
  axes?: Record<string, number> | null
  /** An already-loaded font. Pass it when the mounting surface has one (it
   *  will) — the tile then paints on its first frame with no fetch at all. */
  font?: VtFont | null
  /** The preset cannot run on this font (`vtAxisOffer.available === false`).
   *  The tile shows the word AT REST — the user's own text, not animating —
   *  and leaves the shared clock alone rather than burning frames on a preset
   *  that emits nothing. */
  disabled?: boolean
  /** Glyph paint — the studio's own `config.fill`, which is a `Paint` and not a
   *  colour. Handed straight to `vtThumbConfig`. Defaults to white-on-dark. */
  fill?: Paint
}>()

const W = VT_THUMB_W, H = VT_THUMB_H
/** Seconds between redraws. ~24fps: enough for a 1.5s loop to read as smooth,
 *  and it cuts the shaping cost of a full gallery by more than half. */
const MIN_FRAME = 1 / 24

const canvasEl = ref<HTMLCanvasElement | null>(null)
let unregister: (() => void) | null = null
let lastAt = -Infinity
let restingPainted = false

// ── the font ────────────────────────────────────────────────────────────────
// shallowRef + markRaw, never a plain ref: Vue's deep reactive proxy over a
// fontkit font throws on its non-configurable `parent` the moment a glyph
// outline is read (the same note VectorTypeNode/Surface carry).
const loaded = shallowRef<VtFont | null>(null)
const font = computed<VtFont | null>(() => props.font ?? loaded.value)

watch(
  () => [props.fontId, props.font] as const,
  () => {
    // A font handed down needs no fetch — that is the whole point of the prop.
    if (props.font) return
    const id = props.fontId
    if (!id || loaded.value?.id === id) return
    void loadVectorFont(id)
      .then((f) => { if (props.fontId === id) loaded.value = markRaw(f) })
      // A failed or slow font is a RESTING TILE, never a thrown gallery: the
      // picker still opens, still shows the word, still lets the user pick.
      // `loadVectorFont` evicts a rejected promise itself, so a later mount
      // retries rather than inheriting the failure.
      .catch(() => { if (props.fontId === id) loaded.value = null })
  },
  { immediate: true },
)

// ── what gets drawn ─────────────────────────────────────────────────────────

const word = computed(() => vtThumbWord(props.text))

/** The config plus the size that fits it, resolved together and only when
 *  something they depend on changes — the fit samples the animation, so doing
 *  it per frame would both cost real time and CANCEL the growth the tile
 *  exists to show (see `thumbPreview.ts`). */
const drawCfg = computed(() => {
  const f = font.value
  if (!f) return null
  const base = vtThumbConfig({
    // A disabled tile carries no preset at all, so it renders the resting word.
    presetId: props.disabled ? '' : props.presetId,
    slot: props.slotKind,
    fontId: props.fontId,
    text: props.text,
    axes: props.axes,
    fill: props.fill,
  })
  return { ...base, size: vtThumbSize(f, base, { width: W, height: H, padding: VT_THUMB_PAD }) }
})

function renderAt(t: number): void {
  const el = canvasEl.value
  const f = font.value
  const cfg = drawCfg.value
  if (!el || !f || !cfg) return
  drawVectorTypeToCanvas(el, f, cfg, t, {
    width: W,
    height: H,
    padding: VT_THUMB_PAD,
    // Transparent: the tile's own CSS background shows through, so a Vector Type
    // tile and a PresetThumb sit on the same surface.
    background: null,
    pixelRatio: typeof devicePixelRatio === 'number' && devicePixelRatio > 0
      ? Math.min(3, devicePixelRatio)
      : 1,
  })
}

/** The pre-font tile: the same word, in a system face, dimmed. Not a spinner —
 *  the gallery's layout is final from the first paint and only the letterforms
 *  sharpen when the font lands. */
function paintResting(): void {
  const el = canvasEl.value
  if (!el) return
  const k = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? Math.min(3, devicePixelRatio) : 1
  const w = Math.round(W * k), h = Math.round(H * k)
  if (el.width !== w) el.width = w
  if (el.height !== h) el.height = h
  const c = el.getContext('2d')
  if (!c) return
  c.setTransform(k, 0, 0, k, 0, 0)
  c.clearRect(0, 0, W, H)
  c.fillStyle = 'rgba(255,255,255,0.28)'
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  // Sized off the word so a six-letter word does not spill where "Aa" would fit.
  const px = Math.max(7, Math.min(16, Math.round((W - VT_THUMB_PAD * 2) / Math.max(1, word.value.length) * 1.5)))
  c.font = `600 ${px}px Inter, system-ui, sans-serif`
  c.fillText(word.value, W / 2, H / 2)
  c.setTransform(1, 0, 0, 1, 0, 0)
  restingPainted = true
}

/** The shared clock's callback. Draws nothing until a font exists, and at most
 *  `MIN_FRAME` apart — no timer, no rAF, no scheduling of its own. */
function draw(clockSec: number): void {
  if (!font.value || !drawCfg.value) {
    if (!restingPainted) paintResting()
    return
  }
  if (clockSec - lastAt < MIN_FRAME) return
  lastAt = clockSec
  renderAt(clockSec % VT_THUMB_CYCLE[props.slotKind])
}

// ── the shared clock ────────────────────────────────────────────────────────

function sync(): void {
  if (!canvasEl.value) return
  if (props.disabled) {
    // Nothing to animate: an unavailable preset emits no delta, so a registered
    // tile would redraw an identical frame forever.
    unregister?.()
    unregister = null
    if (font.value && drawCfg.value) renderAt(0)
    else if (!restingPainted) paintResting()
    return
  }
  // Paint the resting word NOW rather than on the clock's first tick, so the
  // gallery is never briefly a grid of empty rectangles.
  if (!font.value || !drawCfg.value) paintResting()
  if (!unregister) unregister = registerThumb(canvasEl.value, draw)
}

onMounted(sync)
onBeforeUnmount(() => { unregister?.(); unregister = null })
watch(() => props.disabled, sync)
// A new word, a new font or a new preset invalidates whatever is on the canvas.
watch([font, drawCfg], () => {
  restingPainted = false
  lastAt = -Infinity
  if (props.disabled) sync()
  else if (!font.value) paintResting()
})
</script>

<template>
  <canvas
    ref="canvasEl"
    :width="W"
    :height="H"
    class="w-full h-auto rounded bg-white/[0.02]"
    :class="disabled ? 'opacity-45' : ''"
  />
</template>
