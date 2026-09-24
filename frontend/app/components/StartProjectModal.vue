<script setup lang="ts">
/**
 * The blank-project modal (spec 2026-09-23): "Make it with AI" and "Make it
 * by hand" as two equal halves, a real picture on every tile. Every choice —
 * including skipping — emits `start`; the canvas lands it in a Frame.
 * Studio tiles draw a still with the studio's own renderer (lib/startModal/
 * stills.ts) and play on hover when time-driven; AI tiles show shipped pictures.
 */
import { X } from 'lucide-vue-next'
import { START_AI, startHandTiles, type StartPickId, type StartTile } from '~/data/start-modal'
import { paintStill, stillRendererFor } from '~/lib/startModal/stills'
import { disposeSpaceTypeStill } from '~/lib/startModal/spaceTypeStill'
import { useStartTileHover } from '~/composables/useStartTileHover'

const emit = defineEmits<{ start: [pick: StartPickId | null] }>()

const hand = startHandTiles()
const AI_PICTURE: Record<string, string> = {
  gen: '/start-modal/ai-gen.webp', style: '/start-modal/ai-style.webp', edit: '/start-modal/ai-edit.webp',
  upscale: '/start-modal/ai-upscale.webp', video: '/start-modal/ai-video.webp',
}
const aiPictureOk = reactive<Record<string, boolean>>({})
const stillOk = reactive<Record<string, boolean>>({})
const canvases = new Map<StartPickId, HTMLCanvasElement>()
// Set by teardown. Paints still in flight when the modal closes can build a
// SpaceType engine after disposeSpaceTypeStill ran (the engine is only held once
// its dynamic imports resolve), so every late finisher disposes again.
let closed = false
const hover = useStartTileHover({ afterStop: () => disposeSpaceTypeStill() })

function setCanvas(id: StartPickId, el: Element | null) {
  if (el) canvases.set(id, el as HTMLCanvasElement)
}

onMounted(async () => {
  await nextTick()
  if (closed) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  await Promise.all([...canvases].map(async ([id, c]) => {
    if (closed) return
    const r = c.getBoundingClientRect()
    // A hidden or not-yet-laid-out box measures 0×0 — skip it rather than
    // drawing at a made-up fallback size that would look wrong once shown.
    if (r.width <= 0 || r.height <= 0) return
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr)
    stillOk[id] = await paintStill(id, c, 0)
  })).finally(() => { if (closed) disposeSpaceTypeStill() })
})

// Every exit path — a pick, skip, close or unmount — must stop the hover rAF
// loop and free the SpaceType WebGL engines, or they leak past the modal's life.
function teardown() {
  closed = true
  hover.stopAll()
  disposeSpaceTypeStill()
}

function pick(t: StartTile) { teardown(); emit('start', t.id) }
function skip() { teardown(); emit('start', null) }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') skip() }
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => { window.removeEventListener('keydown', onKey); teardown() })
</script>

<template>
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6" @click.self="skip">
    <div class="relative w-[900px] max-w-full max-h-[90vh] overflow-auto bg-[#161616] border border-white/10 rounded-2xl shadow-2xl px-7 pt-7 pb-4">
      <button
        data-testid="start-close"
        class="absolute top-3.5 right-3.5 size-7 rounded-md flex items-center justify-center text-white/40 hover:text-white/85 hover:bg-white/[0.06] transition-colors cursor-pointer"
        title="Start with an empty Frame" aria-label="Close" @click="skip"
      >
        <X class="size-4" />
      </button>
      <h2 class="text-[20px] font-medium text-white tracking-[0.1px] mb-1">What do you want to make?</h2>
      <p class="text-[13px] text-white/45 mb-5">Whatever you pick lands in a Frame, ready to lay out.</p>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-[22px]">
        <section v-for="half in [{ key: 'ai', title: 'Make it with AI', count: `${START_AI.length} ways`, tiles: START_AI }, { key: 'hand', title: 'Make it by hand', count: `${hand.length} studios`, tiles: hand }]" :key="half.key">
          <div class="flex items-baseline justify-between mb-2.5">
            <span class="text-[11px] font-medium uppercase tracking-[0.08em] text-white/45">{{ half.title }}</span>
            <span class="text-[11px] text-white/30">{{ half.count }}</span>
          </div>
          <div
            :data-testid="`start-${half.key}`"
            class="grid grid-cols-2 gap-2 md:h-[430px] auto-rows-[120px] md:auto-rows-auto"
            :class="half.key === 'ai' ? 'md:[grid-template-rows:1.25fr_1fr_1fr]' : 'md:[grid-template-rows:repeat(4,1fr)]'"
          >
            <button
              v-for="(t, i) in half.tiles" :key="t.id"
              :data-testid="`start-tile-${t.id}`"
              class="group/tile relative overflow-hidden rounded-xl border border-white/10 hover:border-white/25 bg-[#0c0c0d] text-left transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#4f8cff] focus-visible:outline-offset-2"
              :class="half.key === 'ai' && i === 0 ? 'col-span-2' : ''"
              @click="pick(t)"
              @pointerenter="!closed && canvases.get(t.id) && hover.enter(t.id, canvases.get(t.id)!)"
              @pointerleave="hover.leave(t.id)"
            >
              <img
                v-if="t.kind === 'ai' && aiPictureOk[t.id] !== false"
                :src="AI_PICTURE[t.id]" alt="" class="absolute inset-0 size-full object-cover"
                @error="aiPictureOk[t.id] = false"
              >
              <canvas
                v-else-if="stillRendererFor(t.id)"
                :ref="el => setCanvas(t.id, el as Element | null)"
                class="absolute inset-0 size-full" :class="stillOk[t.id] === false ? 'opacity-0' : ''" aria-hidden="true"
              />
              <span
                v-if="t.credits" data-testid="credits-dot" title="Uses credits"
                class="gen-pastel absolute top-2 right-2 size-[7px] rounded-full"
                style="--gen-pastel: linear-gradient(90deg, rgba(255,214,231,.85), rgba(207,232,255,.85), rgba(214,255,224,.85), rgba(255,244,204,.85), rgba(231,214,255,.85), rgba(255,214,231,.85));"
              />
              <span class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-px px-2.5 pb-2 pt-5 bg-gradient-to-t from-black/75 to-transparent">
                <span class="text-[12.5px] leading-tight text-white/90 truncate">{{ t.name }}</span>
                <span class="text-[10.5px] text-white/60 truncate">{{ t.line }}</span>
              </span>
            </button>
          </div>
        </section>
      </div>

      <div class="mt-4 flex items-center justify-between gap-3">
        <span class="flex items-center gap-1.5 text-[11.5px] text-white/35">
          <i class="gen-pastel inline-block size-[7px] rounded-full" style="--gen-pastel: linear-gradient(90deg, rgba(255,214,231,.85), rgba(207,232,255,.85), rgba(214,255,224,.85), rgba(255,244,204,.85), rgba(231,214,255,.85), rgba(255,214,231,.85));" />
          Uses credits
        </span>
        <button data-testid="start-empty-frame" class="text-[12.5px] text-white/50 hover:text-white/85 px-2.5 py-1.5 rounded-md hover:bg-white/[0.04] transition-colors cursor-pointer" @click="skip">
          Start with an empty Frame
        </button>
      </div>
    </div>
  </div>
</template>
