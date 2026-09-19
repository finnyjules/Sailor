<script setup lang="ts">
/** Previewing behaviour gallery (Slice 4). Grouped In / Loop / Out / Gradient tiles,
 *  filtered to what the selected layer supports; each tile plays a small looping CSS
 *  preview of the move. Clicking a tile emits `add` with the catalog move, which the
 *  modal turns into a live behaviour via addBehaviour(kind, params). */
import { movesForLayer, groupedMoves, type GalleryMove, type LayerCaps, type PreviewKind } from '~/lib/motionx/gallery'

const props = defineProps<{ caps: LayerCaps }>()
defineEmits<{ add: [move: GalleryMove]; close: [] }>()

const groups = computed(() => groupedMoves(movesForLayer(props.caps)))

const isLettersPreview = (p: PreviewKind) =>
  p === 'letters-cascade' || p === 'letters-typewriter' || p === 'letters-mask' || p === 'letters-scramble'
</script>

<template>
  <div data-testid="motion-gallery" class="p-3">
    <div class="mb-1.5 flex items-center justify-between">
      <span class="text-[11px] font-medium text-white/60">Add behaviour</span>
      <button type="button" class="text-white/40 hover:text-white/80 cursor-pointer text-[11px]" @click="$emit('close')">Done</button>
    </div>
    <div v-for="g in groups" :key="g.group" class="mb-2 last:mb-0">
      <div class="mb-1 text-[10px] uppercase tracking-wide text-white/35">{{ g.group }}</div>
      <div class="grid grid-cols-3 gap-1.5">
        <button v-for="m in g.moves" :key="m.id" type="button"
          :data-testid="'gallery-move-' + m.id"
          class="group flex flex-col items-stretch gap-1 rounded-md border border-white/10 bg-white/[0.03] p-1.5 text-left hover:border-white/25 hover:bg-white/[0.06] cursor-pointer transition-colors"
          :title="m.label" @click="$emit('add', m)">
          <div class="relative h-9 overflow-hidden rounded bg-[#0a0a0c]">
            <!-- letter previews: the word "Type" split into four spans, staggered by move -->
            <span v-if="isLettersPreview(m.preview)"
              class="letters-prev absolute inset-0 flex items-center justify-center gap-[1px] font-medium text-[11px] text-[#7c9cff]"
              :class="m.preview">
              <span v-for="(ch, i) in ['T', 'y', 'p', 'e']" :key="i" class="letter-piece" :style="{ '--i': i }">
                <span class="letter-inner">{{ ch }}</span>
              </span>
            </span>
            <!-- transform/opacity previews: a small mark that plays the move on loop -->
            <span v-else-if="m.preview !== 'scroll' && m.preview !== 'morph'"
              class="prev-mark absolute left-1/2 top-1/2 w-3 h-3 -ml-1.5 -mt-1.5 rounded-sm bg-[#7c9cff]"
              :class="'prev-' + m.preview" />
            <!-- gradient previews: the fill itself animates -->
            <span v-else-if="m.preview === 'scroll'" class="prev-scroll absolute inset-0" />
            <span v-else class="prev-morph absolute inset-0" />
          </div>
          <span class="truncate text-[10px] text-white/70 group-hover:text-white/90">{{ m.label }}</span>
        </button>
      </div>
    </div>
    <p v-if="groups.length === 0" class="text-[11px] text-white/35">No behaviours available for this layer.</p>
  </div>
</template>

<style scoped>
.prev-mark { will-change: transform, opacity; }
.prev-fade { animation: prevFade 1.8s ease-in-out infinite; }
.prev-slide-up { animation: prevUp 1.6s ease-in-out infinite; }
.prev-slide-down { animation: prevDown 1.6s ease-in-out infinite; }
.prev-slide-left { animation: prevLeft 1.6s ease-in-out infinite; }
.prev-slide-right { animation: prevRight 1.6s ease-in-out infinite; }
.prev-grow { animation: prevGrow 1.8s ease-out infinite; }
.prev-shrink { animation: prevShrink 1.8s ease-in infinite; }
.prev-spin { animation: prevSpin 1.8s linear infinite; }
.prev-pulse { animation: prevPulse 1.4s ease-in-out infinite; }
.prev-sway { animation: prevSway 1.8s ease-in-out infinite; transform-origin: 50% 100%; }
.prev-float { animation: prevFloat 2s ease-in-out infinite; }
.prev-scroll {
  background: linear-gradient(90deg, #1436ff, #ff2d2d, #ffd21f, #1436ff);
  background-size: 200% 100%;
  animation: prevScroll 2.4s linear infinite;
}
.prev-morph {
  background: linear-gradient(90deg, #1436ff, #ff2d2d);
  animation: prevMorph 2.6s ease-in-out infinite alternate;
}
@keyframes prevFade { 0%,100% { opacity: 0.15 } 50% { opacity: 1 } }
@keyframes prevUp { 0% { transform: translateY(8px); opacity: 0 } 40%,100% { transform: translateY(0); opacity: 1 } }
@keyframes prevDown { 0% { transform: translateY(-8px); opacity: 0 } 40%,100% { transform: translateY(0); opacity: 1 } }
@keyframes prevLeft { 0% { transform: translateX(8px); opacity: 0 } 40%,100% { transform: translateX(0); opacity: 1 } }
@keyframes prevRight { 0% { transform: translateX(-8px); opacity: 0 } 40%,100% { transform: translateX(0); opacity: 1 } }
@keyframes prevGrow { 0% { transform: scale(0); opacity: 0 } 45%,100% { transform: scale(1); opacity: 1 } }
@keyframes prevShrink { 0% { transform: scale(1); opacity: 1 } 55%,100% { transform: scale(0); opacity: 0 } }
@keyframes prevSpin { 0% { transform: rotate(0) } 100% { transform: rotate(360deg) } }
@keyframes prevPulse { 0%,100% { transform: scale(0.85) } 50% { transform: scale(1.15) } }
@keyframes prevSway { 0%,100% { transform: rotate(-14deg) } 50% { transform: rotate(14deg) } }
@keyframes prevFloat { 0%,100% { transform: translateY(5px) } 50% { transform: translateY(-5px) } }
@keyframes prevScroll { 0% { background-position: 0% 0 } 100% { background-position: 200% 0 } }
@keyframes prevMorph { 0% { filter: hue-rotate(0deg) } 100% { filter: hue-rotate(90deg) } }

/* Letters previews — the word "Type" as four spans, staggered per letter via --i. */
.letter-piece { position: relative; display: inline-block; }
.letter-inner { display: inline-block; will-change: transform, opacity; }

.letters-cascade .letter-inner {
  animation: prevLettersCascade 2s ease-in-out infinite;
  animation-delay: calc(var(--i) * 0.15s);
}
@keyframes prevLettersCascade {
  0%, 8% { transform: translateY(60%); opacity: 0; }
  35%, 70% { transform: translateY(0); opacity: 1; }
  100% { transform: translateY(60%); opacity: 0; }
}

.letters-typewriter .letter-inner {
  opacity: 0;
  animation: prevTypewriter 2.2s steps(1) infinite;
  animation-delay: calc(var(--i) * 0.3s);
}
@keyframes prevTypewriter {
  0%, 4% { opacity: 0; }
  6%, 82% { opacity: 1; }
  92%, 100% { opacity: 0; }
}
.letters-typewriter::after {
  content: '';
  display: inline-block;
  width: 1px;
  height: 11px;
  margin-left: 1px;
  background: currentColor;
  animation: prevCursorBlink 0.9s steps(1) infinite;
}
@keyframes prevCursorBlink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }

.letters-mask .letter-piece { overflow: hidden; }
.letters-mask .letter-inner {
  transform: translateY(100%);
  animation: prevMaskSlide 2s ease-in-out infinite;
  animation-delay: calc(var(--i) * 0.12s);
}
@keyframes prevMaskSlide {
  0%, 8% { transform: translateY(100%); }
  35%, 78% { transform: translateY(0); }
  100% { transform: translateY(100%); }
}

.letters-scramble .letter-inner { animation: prevScramble1 1.6s steps(1) infinite; }
.letters-scramble .letter-piece:nth-child(1) .letter-inner { animation-name: prevScramble1; }
.letters-scramble .letter-piece:nth-child(2) .letter-inner { animation-name: prevScramble2; }
.letters-scramble .letter-piece:nth-child(3) .letter-inner { animation-name: prevScramble3; }
.letters-scramble .letter-piece:nth-child(4) .letter-inner { animation-name: prevScramble4; }
@keyframes prevScramble1 { 0%, 100% { transform: translate(0, 0); } 25% { transform: translate(4px, -3px); } 50% { transform: translate(-3px, 2px); } 75% { transform: translate(2px, 3px); } }
@keyframes prevScramble2 { 0%, 100% { transform: translate(0, 0); } 25% { transform: translate(-4px, 2px); } 50% { transform: translate(3px, -3px); } 75% { transform: translate(-2px, -2px); } }
@keyframes prevScramble3 { 0%, 100% { transform: translate(0, 0); } 25% { transform: translate(3px, 3px); } 50% { transform: translate(-4px, -1px); } 75% { transform: translate(1px, -3px); } }
@keyframes prevScramble4 { 0%, 100% { transform: translate(0, 0); } 25% { transform: translate(-3px, -3px); } 50% { transform: translate(2px, 3px); } 75% { transform: translate(-1px, 2px); } }

@media (prefers-reduced-motion: reduce) {
  .prev-mark, .prev-scroll, .prev-morph { animation: none; opacity: 1; }
  .letter-inner { animation: none; opacity: 1; transform: none; }
  .letters-typewriter::after { animation: none; opacity: 1; }
}
</style>
