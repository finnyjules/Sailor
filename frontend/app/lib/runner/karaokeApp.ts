/**
 * Karaoke (step 3, R8.2, the pilot app): Load audio → Vocal separator →
 * Save audio (MP3) × 2, run on the Sailor runner through useAppRun.
 *
 * - The price is quoted once the song is uploaded (Demucs is priced on the
 *   seconds sent, measured by the quote), and shown next to the run button.
 * - The two stems are taken by node id (KARAOKE_STEMS), never by file name.
 * - Stop ends the run (useAppRun.stop); closing the app stops it too.
 * - With the app's families off it says it is switched off, in both places
 *   (R10.1: nothing goes to the engine).
 * - R11.5 (ruling (h)): a song over one call's longest (hosted 10 minutes,
 *   locally 20) runs on the runner in pieces of at most 10 minutes; past the
 *   hard ceiling (an hour; hosted, as long as the stems stay readable) it is
 *   refused plainly, before any hold.
 * - A price check that failed (not a refusal) shows its words and leaves Run
 *   on: pressing it prices the exact prompt again before anything starts.
 */
import { computed, ref, type Ref } from 'vue'
import type { ApiPrompt } from '#shared/runner/graph'
import { AppRunCancelled, AppRunDeclined, useAppRun } from '~/composables/useAppRun'
import type { AppTakeInput } from '~/composables/useAppTakes'
import type { AwaitOutputsOptions, RunnerImage } from '~/lib/runner/awaitRunnerResult'

/** The nodes whose files are the two stems. */
export const KARAOKE_STEMS = { vocals: '3', instrumental: '4' } as const

export function buildKaraokePrompt(filename: string): ApiPrompt {
  return {
    1: { class_type: 'LoadAudio', inputs: { audio: filename } },
    2: { class_type: 'VocalSeparator', inputs: { audio: ['1', 0], model: 'htdemucs', shifts: 1 } },
    [KARAOKE_STEMS.vocals]: { class_type: 'SaveAudioMP3', inputs: { audio: ['2', 0], filename_prefix: 'karaoke_vocals', quality: 'V0' } },
    [KARAOKE_STEMS.instrumental]: { class_type: 'SaveAudioMP3', inputs: { audio: ['2', 1], filename_prefix: 'karaoke_instrumental', quality: 'V0' } },
  }
}

export const KARAOKE_WORDS = {
  failed: 'The separation didn’t work. Try again.',
  empty: 'The separation finished without both tracks. Try again.',
  slow: 'The separation took too long, so it was stopped.',
} as const

/** A long run's wait: a 10-minute song can take a while at the service. */
const WAIT_MS = 20 * 60_000

export function karaokeViewUrl(f: RunnerImage, now = Date.now()): string {
  return `/view?${new URLSearchParams({
    filename: f.filename,
    type: f.type,
    ...(f.subfolder ? { subfolder: f.subfolder } : {}),
    t: String(now),
  })}`
}

export interface KaraokeStems { promptId: string, vocals: RunnerImage, instrumental: RunnerImage }

export type KaraokeStatus = 'idle' | 'running' | 'done' | 'error'

/**
 * The app's run: price, Run, Stop, and the result as one take holding both
 * stems [vocals, instrumental].
 */
export function useKaraokeRun(o: {
  song: Ref<{ filename: string } | null>
  addTake: (t: AppTakeInput) => unknown
  hosted?: boolean
  app?: ReturnType<typeof useAppRun>
  /** Passed to the runner wait (tests feed events through it). */
  wait?: Pick<AwaitOutputsOptions, 'target' | 'timeoutMs'>
}) {
  const hosted = o.hosted ?? false
  const app = o.app ?? useAppRun({ hosted })
  const status = ref<KaraokeStatus>('idle')
  const errorMessage = ref<string | null>(null)
  /** What shows in place of a price: the refusal's or failed check's words, or "switched off". */
  const blocked = computed<string | null>(() => {
    if (app.declined.value) return new AppRunDeclined().message
    return app.refused.value
  })
  const priceText = app.priceText
  const running = computed(() => status.value === 'running')
  // A failed price check never leaves the button dead: Run asks for the price again (useAppRun.run).
  const canRun = computed(() => !!o.song.value && !running.value && !app.quoting.value
    && (app.quoteFailed.value || (!blocked.value && app.price.value !== null)))
  /** Stop is offered while a run is going. */
  const canStop = computed(() => running.value)

  function quote(): Promise<void> {
    return app.quote(o.song.value ? buildKaraokePrompt(o.song.value.filename) : null)
  }

  function land(s: KaraokeStems): void {
    o.addTake({
      audios: [karaokeViewUrl(s.vocals), karaokeViewUrl(s.instrumental)],
      promptId: s.promptId,
      sig: `${s.vocals.subfolder || ''}/${s.vocals.filename}`,
    })
    status.value = 'done'
  }

  async function run(): Promise<void> {
    if (!canRun.value || !o.song.value) return
    const prompt = buildKaraokePrompt(o.song.value.filename)
    errorMessage.value = null
    status.value = 'running'
    try {
      const { promptId, outputs } = await app.run(prompt, [KARAOKE_STEMS.vocals, KARAOKE_STEMS.instrumental], {
        timeoutMs: WAIT_MS, ...o.wait, words: { failed: KARAOKE_WORDS.failed, empty: KARAOKE_WORDS.empty, slow: KARAOKE_WORDS.slow },
      })
      const vocals = outputs[KARAOKE_STEMS.vocals]?.audio[0]
      const instrumental = outputs[KARAOKE_STEMS.instrumental]?.audio[0]
      if (!vocals || !instrumental) throw new Error(KARAOKE_WORDS.empty)
      land({ promptId, vocals, instrumental })
    }
    catch (e) {
      // The runner said no (AppRunDeclined): "switched off", in both places; a refusal: its own words.
      // R11.5: a long one runs in pieces; past the hard ceiling it is refused plainly.
      const name = e instanceof Error ? e.name : ''
      if (e instanceof AppRunCancelled || name === 'AppRunStopped') { status.value = 'idle'; return }
      errorMessage.value = e instanceof Error && e.message ? e.message : KARAOKE_WORDS.failed
      status.value = 'error'
    }
  }

  function reset(): void {
    errorMessage.value = null
    status.value = 'idle'
  }

  return {
    status, errorMessage, priceText, blocked, canRun, canStop, running, quoting: app.quoting,
    stopError: app.stopError, quote, run, stop: app.stop, reset,
  }
}
