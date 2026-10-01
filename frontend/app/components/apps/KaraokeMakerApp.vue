<script setup lang="ts">
/**
 * Karaoke Maker app — drop a song, get vocals + instrumental stems back.
 * Pipeline: LoadAudio → VocalSeparator → 2× SaveAudioMP3, on the Sailor
 * runner with its price shown before the run and a Stop button (step 3,
 * R8.2; lib/runner/karaokeApp.ts).
 */
import { ArrowRight, Download, Loader2, Music, RefreshCcw, Square } from 'lucide-vue-next'
import TakesStrip from '~/components/vue-canvas/TakesStrip.vue'
import { useKaraokeRun } from '~/lib/runner/karaokeApp'

interface UploadedFile { file: File; filename: string; previewUrl: string }

const song = ref<UploadedFile | null>(null)
// Each separation stacks as a take holding both stems [vocals, instrumental];
// the displayed pair is the active take.
const { takes, activeTakeId, activeTake, addTake, selectTake, pinTake, discardTake, reset: resetTakes } = useAppTakes()
const vocalsUrl = computed<string | null>(() => activeTake.value?.audios?.[0] ?? null)
const instrumentalUrl = computed<string | null>(() => activeTake.value?.audios?.[1] ?? null)

const hosted = useRuntimeConfig().public?.hostedMode === true
const karaoke = useKaraokeRun({ song, addTake, hosted })
const { status, errorMessage, priceText, blocked, canRun, canStop, quoting, stopError } = karaoke
const run = karaoke.run
const stop = karaoke.stop

// The price is worked out once the song is uploaded.
watch(() => song.value?.filename ?? null, () => { void karaoke.quote() }, { immediate: true })

function reset() {
  song.value = null
  resetTakes()
  karaoke.reset()
}

function download(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
</script>

<template>
  <div class="h-full overflow-y-auto bg-[#0a0a0a]">
    <div class="max-w-[920px] mx-auto px-10 py-12">
      <div class="mb-14">
        <div class="text-[11px] uppercase tracking-[0.16em] text-white/35 font-medium mb-3">
          App · Audio
        </div>
        <h1 class="text-[44px] font-medium text-white tracking-tight leading-[1.05] mb-4">
          Karaoke Maker
        </h1>
        <p class="text-[15px] text-white/60 max-w-[560px] leading-relaxed">
          Drop a song and get two separated tracks back — the instrumental for sing-alongs
          and the isolated vocals for remixing.
        </p>
      </div>

      <div class="max-w-[420px] mb-8">
        <AppsAppFileSlot
          v-model="song"
          label="Song"
          step="Step 1"
          accept="audio/*"
          kind="audio"
          hint="Drop your song"
        />
      </div>

      <div class="flex items-center justify-between mb-12">
        <p v-if="status === 'running'" class="text-[12px] text-white/55 flex items-center gap-2">
          <Loader2 class="size-3.5 animate-spin" />
          <span>Separating the vocals…</span>
        </p>
        <p v-else-if="errorMessage || stopError" class="text-[12px] text-rose-400 max-w-md">
          {{ stopError || errorMessage }}
        </p>
        <p v-else-if="song && blocked" class="text-[12px] text-rose-400 max-w-md">
          {{ blocked }}
        </p>
        <span v-else class="text-[12px] text-white/35">
          {{ song ? 'Ready to separate.' : 'Add a song above to start.' }}
        </span>
        <div class="flex items-center gap-3">
          <span v-if="status !== 'running' && song && (quoting || priceText)" class="text-[12px] text-white/55 tabular-nums" title="The most this run can cost">
            {{ quoting ? '…' : priceText }}
          </span>
          <button
            v-if="canStop"
            class="inline-flex items-center gap-2 h-10 px-5 rounded-full bg-white/[0.08] text-white font-medium text-[13px] hover:bg-white/[0.14] transition-colors cursor-pointer"
            @click="stop"
          >
            <Square class="size-3.5" />
            <span>Stop</span>
          </button>
          <button
            v-else
            class="inline-flex items-center gap-2 h-10 px-5 rounded-full bg-white text-[#0a0a0a] font-medium text-[13px] hover:bg-white/90 transition-colors cursor-pointer disabled:bg-white/15 disabled:text-white/40 disabled:cursor-not-allowed"
            :disabled="!canRun"
            @click="run"
          >
            <span>{{ status === 'running' ? 'Separating…' : 'Separate' }}</span>
            <ArrowRight v-if="status !== 'running'" class="size-4" />
            <Loader2 v-else class="size-4 animate-spin" />
          </button>
        </div>
      </div>

      <div v-if="vocalsUrl || instrumentalUrl || status === 'running'" class="border-t border-white/[0.06] pt-10">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-[20px] font-medium text-white tracking-tight">Stems</h2>
          <button
            v-if="vocalsUrl && instrumentalUrl"
            class="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-[12px] text-white/80 hover:text-white transition-colors cursor-pointer"
            @click="reset"
          >
            <RefreshCcw class="size-3.5" />
            Start over
          </button>
        </div>

        <div v-if="vocalsUrl && instrumentalUrl" class="grid grid-cols-2 gap-4">
          <div class="rounded-xl bg-gradient-to-br from-white/10 to-white/[0.04] border border-white/20 p-5">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <div class="size-8 rounded-full bg-white/20 flex items-center justify-center">
                  <Music class="size-4 text-white/70" :stroke-width="1.75" />
                </div>
                <div>
                  <div class="text-[13px] font-medium text-white">Vocals</div>
                  <div class="text-[11px] text-white/40">A cappella</div>
                </div>
              </div>
              <button
                class="size-8 rounded-full bg-white/[0.08] hover:bg-white/[0.15] flex items-center justify-center text-white/70 hover:text-white transition-colors cursor-pointer"
                @click="download(vocalsUrl!, 'karaoke_vocals.mp3')"
              >
                <Download class="size-3.5" />
              </button>
            </div>
            <audio :src="vocalsUrl" controls preload="metadata" class="w-full" />
          </div>

          <div class="rounded-xl bg-gradient-to-br from-white/10 to-white/[0.04] border border-white/20 p-5">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <div class="size-8 rounded-full bg-white/20 flex items-center justify-center">
                  <Music class="size-4 text-white/70" :stroke-width="1.75" />
                </div>
                <div>
                  <div class="text-[13px] font-medium text-white">Instrumental</div>
                  <div class="text-[11px] text-white/40">Karaoke backing</div>
                </div>
              </div>
              <button
                class="size-8 rounded-full bg-white/[0.08] hover:bg-white/[0.15] flex items-center justify-center text-white/70 hover:text-white transition-colors cursor-pointer"
                @click="download(instrumentalUrl!, 'karaoke_instrumental.mp3')"
              >
                <Download class="size-3.5" />
              </button>
            </div>
            <audio :src="instrumentalUrl" controls preload="metadata" class="w-full" />
          </div>
        </div>

        <div v-else class="rounded-xl bg-black border border-white/[0.06] min-h-[200px] flex items-center justify-center">
          <div class="flex flex-col items-center gap-3 py-12">
            <Loader2 class="size-6 text-white/30 animate-spin" />
            <div class="text-[12px] text-white/40">Separating the vocals…</div>
          </div>
        </div>

        <TakesStrip
          v-if="takes.length >= 1"
          :takes="takes"
          :active-take-id="activeTakeId"
          class="mt-4 rounded-lg bg-black/40 border border-white/10"
          @select="selectTake"
          @pin="pinTake"
          @discard="discardTake"
        />
      </div>
    </div>
  </div>
</template>
