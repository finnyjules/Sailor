<script setup lang="ts">
import { useVueFlow } from '@vue-flow/core'

const props = defineProps<{
  running?: boolean
  /** Agent is planning — animate sparks travelling dot-to-dot. */
  thinking?: boolean
  gap?: number
  dotRadius?: number
  baseColor?: string
  glowColor?: string
}>()

const gap = computed(() => props.gap ?? 24)
const dotRadius = computed(() => props.dotRadius ?? 1.2)
const baseAlpha = 0.12
const glowAlpha = 0.6

const canvasRef = ref<HTMLCanvasElement | null>(null)
const { viewport } = useVueFlow()

let animFrame = 0
let sweepX = -0.3 // normalized 0-1 sweep position across viewport
let rainbowOffset = 0 // horizontal scroll offset for rainbow

// ── "Thinking" sparks: comet segments that wander dot-to-dot along the grid,
//    trailing a flowing rainbow-pastel tail. The trail is kept in world-grid
//    coords so it stays glued to the dots when the canvas pans/zooms. ──
interface Spark { gx: number; gy: number; dx: number; dy: number; p: number; speed: number; hueBase: number; fade: number; fadeRate: number; trail: { wx: number; wy: number }[] }
let sparks: Spark[] = []
let sparkHue = 0 // global flowing offset so the rainbow drifts over time
const TRAIL_LEN = 64 // points of history → a long comet
function spawnSpark(gxMin: number, gxMax: number, gyMin: number, gyMax: number): Spark {
  return {
    gx: gxMin + Math.floor(Math.random() * (gxMax - gxMin + 1)),
    gy: gyMin + Math.floor(Math.random() * (gyMax - gyMin + 1)),
    // All sparks travel LEFT → RIGHT only — reads as one calm directional
    // current instead of synapses firing every which way.
    dx: 1, dy: 0, p: Math.random(), speed: 0.13 + Math.random() * 0.1,
    // Each spark fades on its own clock: in fast, out at a randomized (faster)
    // rate so they wink out individually rather than the whole field dimming.
    hueBase: Math.random() * 360, fade: 0, fadeRate: 0.13 + Math.random() * 0.12, trail: [],
  }
}

// Draws only when something changed: a pan/zoom, a resize, or while the run sweep or the
// thinking sparks are moving. At rest the grid is a still picture, so nothing repaints and
// the glass nodes above it don't have to re-blur it every frame.
function schedule() {
  if (!animFrame) animFrame = requestAnimationFrame(draw)
}

function draw() {
  animFrame = 0
  const running = !!props.running
  const thinking = !!props.thinking
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight

  // Resize canvas for crisp rendering
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.scale(dpr, dpr)

  const vp = viewport.value
  const scale = vp.zoom
  const offsetX = vp.x
  const offsetY = vp.y
  const g = gap.value * scale

  if (g < 4) { ctx.setTransform(1, 0, 0, 1, 0, 0); return } // too zoomed out, skip

  // Calculate dot grid bounds in screen space
  const startX = ((offsetX % g) + g) % g
  const startY = ((offsetY % g) + g) % g

  const r = Math.max(0.5, dotRadius.value * Math.min(scale, 1.5))

  // Update sweep position when running
  if (running) {
    sweepX += 0.007
    if (sweepX > 1.3) {
      sweepX = -0.3
    }
    rainbowOffset += 0.003 // slow horizontal scroll for rainbow
  } else {
    // Fade sweep offscreen when stopped
    sweepX = -0.5
  }

  const glow: number[] = []
  const sweepScreenX = sweepX * w
  const sweepWidth = w * 0.25 // width of the glow band

  // Every resting dot goes into ONE path and one fill; only the glowing ones in the
  // sweep band are filled one by one, since each takes its own colour.
  ctx.beginPath()
  for (let x = startX; x < w; x += g) {
    for (let y = startY; y < h; y += g) {
      let alpha = baseAlpha

      if (running) {
        // Distance from sweep center, normalized to sweep width
        const dist = Math.abs(x - sweepScreenX) / sweepWidth
        if (dist < 1) {
          // Smooth falloff: cos curve for natural glow
          const intensity = 0.5 * (1 + Math.cos(dist * Math.PI))
          alpha = baseAlpha + (glowAlpha - baseAlpha) * intensity
        }
      }

      if (alpha > baseAlpha) {
        // Rainbow tint based on horizontal position + scrolling offset
        const t = (alpha - baseAlpha) / (glowAlpha - baseAlpha)
        const hue = ((x / w) + rainbowOffset) * 360 % 360
        glow.push(x, y, hue, alpha * t + baseAlpha * (1 - t))
      } else {
        ctx.moveTo(x + r, y)
        ctx.arc(x, y, r, 0, Math.PI * 2)
      }
    }
  }
  ctx.fillStyle = `rgba(255, 255, 255, ${baseAlpha})`
  ctx.fill()
  for (let i = 0; i < glow.length; i += 4) {
    ctx.beginPath()
    ctx.arc(glow[i]!, glow[i + 1]!, r, 0, Math.PI * 2)
    ctx.fillStyle = `hsla(${glow[i + 2]}, 80%, 75%, ${glow[i + 3]})`
    ctx.fill()
  }

  // Thinking sparks — little segments firing dot-to-dot like synapses. Each spark
  // carries its own `fade` (eased toward 0/1) so they wink in and out individually.
  const gxMin = Math.floor((0 - offsetX) / g) - 1
  const gxMax = Math.ceil((w - offsetX) / g) + 1
  const gyMin = Math.floor((0 - offsetY) / g) - 1
  const gyMax = Math.ceil((h - offsetY) / g) + 1
  if (thinking && !sparks.length) {
    // Toned down: roughly half the old population.
    const n = Math.min(12, Math.max(5, Math.round((gxMax - gxMin) / 8)))
    sparks = Array.from({ length: n }, () => spawnSpark(gxMin, gxMax, gyMin, gyMax))
  }
  if (sparks.length) {
    sparkHue = (sparkHue + 0.7) % 360
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of sparks) {
      // Per-spark fade: in fast while thinking, out at its own (faster) rate after.
      s.fade += ((thinking ? 1 : 0) - s.fade) * (thinking ? 0.18 : s.fadeRate)
      s.p += s.speed
      if (s.p >= 1) {
        // Keep going straight in the same direction (no swerving). Step to the
        // next dot; respawn only once we've travelled off-screen.
        s.gx += s.dx; s.gy += s.dy; s.p = 0
        if (thinking && (s.gx < gxMin - 3 || s.gx > gxMax + 3 || s.gy < gyMin - 3 || s.gy > gyMax + 3)) {
          Object.assign(s, spawnSpark(gxMin, gxMax, gyMin, gyMax)) // teleport → fresh (empty) trail
        }
      }
      // Record the head (world-grid coords; continuous across dots).
      s.trail.push({ wx: s.gx + s.dx * s.p, wy: s.gy + s.dy * s.p })
      if (s.trail.length > TRAIL_LEN) s.trail.shift()

      // Draw the comet: per-segment rainbow-pastel, fading + thinning toward the tail.
      for (let i = 1; i < s.trail.length; i++) {
        const a = s.trail[i - 1]!, b = s.trail[i]!
        const t = i / s.trail.length // 0 tail → 1 head
        const hue = (sparkHue + s.hueBase + i * 7) % 360
        // Steep (quadratic) falloff so the tail fades out fast behind the head;
        // × s.fade so this spark eases in/out on its own. Kept deliberately
        // faint — a background current, not a light show.
        ctx.strokeStyle = `hsla(${hue}, 60%, 82%, ${(0.5 * t * t * s.fade).toFixed(3)})`
        ctx.lineWidth = 0.4 + 1.8 * t * t
        ctx.beginPath()
        ctx.moveTo(offsetX + a.wx * g, offsetY + a.wy * g)
        ctx.lineTo(offsetX + b.wx * g, offsetY + b.wy * g)
        ctx.stroke()
      }
      // Bright head.
      const head = s.trail[s.trail.length - 1]!
      const headHue = (sparkHue + s.hueBase + s.trail.length * 7) % 360
      ctx.beginPath()
      ctx.arc(offsetX + head.wx * g, offsetY + head.wy * g, 1.7, 0, Math.PI * 2)
      ctx.fillStyle = `hsla(${headHue}, 65%, 88%, ${(0.6 * s.fade).toFixed(3)})`
      ctx.fill()
    }
    // Release sparks that have individually faded out (only once thinking stops).
    if (!thinking) sparks = sparks.filter(s => s.fade > 0.02)
  }

  // Reset transform for next frame
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  // Keep animating only while something on the grid moves by itself.
  if (running || thinking || sparks.length) schedule()
}

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  schedule()
  if (canvasRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => schedule())
    resizeObserver.observe(canvasRef.value)
  }
})

onUnmounted(() => {
  cancelAnimationFrame(animFrame)
  animFrame = 0
  resizeObserver?.disconnect()
})

// Redraw when viewport changes (pan/zoom) — at most once a frame.
watch(viewport, () => schedule(), { deep: true })

// Start the loop when the run sweep or the thinking sparks begin (and one last
// frame when they stop, so the sweep clears).
watch(() => props.running, (running) => {
  if (running) sweepX = -0.3
  schedule()
})
watch(() => props.thinking, () => schedule())
</script>

<template>
  <canvas
    ref="canvasRef"
    class="absolute inset-0 w-full h-full pointer-events-none"
    style="z-index: 0;"
  />
</template>
