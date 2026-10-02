/**
 * Auto subtitle (step 3, R8.3): Load video → Get video components → Whisper
 * transcribe → Caption track (the captions wired in from Whisper) → Create
 * video (the sound put back) → Save video, run on the Sailor runner through
 * useAppRun. Karaoke's pattern (./karaokeApp.ts):
 *
 * - The price is quoted once the video is uploaded (Wizper is priced on the
 *   seconds of sound sent, bounded by the quote from the file's header;
 *   Caption track is free), and shown next to the run button.
 * - The captioned video is Save video's file, taken by node id (6).
 * - Stop ends the run (useAppRun.stop); closing the app stops it too.
 * - With the app's families off it says it is switched off, in both places
 *   (R10.1: nothing goes to the engine).
 * - R11.5 (ruling (h)): a sound longer than one Whisper call takes runs on
 *   the runner in pieces of at most 30 minutes; past the hard ceiling (three
 *   hours, beyond the video caps) it is refused plainly. In hosted the
 *   10-minute video cap refuses a longer video plainly, before any hold.
 * - A price check that failed (not a refusal) shows its words and leaves Run
 *   on: pressing it prices the exact prompt again before anything starts.
 */
import { computed, ref, type Ref } from 'vue'
import type { ApiPrompt } from '#shared/runner/graph'
import { AppRunCancelled, AppRunDeclined, useAppRun } from '~/composables/useAppRun'
import type { AppTakeInput } from '~/composables/useAppTakes'
import type { AwaitOutputsOptions, RunnerImage } from '~/lib/runner/awaitRunnerResult'

/** The node whose file is the captioned video. */
export const AUTO_SUBTITLE_OUT = '6'

export const AUTO_SUBTITLE_LANGUAGES = ['auto', 'en', 'fr', 'es', 'de', 'ja', 'zh', 'pt', 'it', 'ko'] as const
export type AutoSubtitleLanguage = typeof AUTO_SUBTITLE_LANGUAGES[number]
export type AutoSubtitlePosition = 'bottom' | 'middle' | 'top'
export interface AutoSubtitleSettings { language: AutoSubtitleLanguage, position: AutoSubtitlePosition, fontSize: number }

export function buildAutoSubtitlePrompt(filename: string, s: AutoSubtitleSettings): ApiPrompt {
  return {
    1: { class_type: 'LoadVideo', inputs: { file: filename } },
    2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    3: { class_type: 'WhisperTranscribe', inputs: { audio: ['2', 1], model_size: 'base', language: s.language, fps: ['2', 2] } },
    4: {
      class_type: 'CaptionTrack',
      inputs: {
        frames: ['2', 0],
        captions: ['3', 0],
        font_size: s.fontSize,
        color: '#ffffff',
        outline_color: '#000000',
        outline_width: 3,
        position: s.position,
        y_inset: 0.08,
      },
    },
    5: { class_type: 'CreateVideo', inputs: { images: ['4', 0], fps: ['2', 2], audio: ['2', 1] } },
    [AUTO_SUBTITLE_OUT]: { class_type: 'SaveVideo', inputs: { video: ['5', 0], filename_prefix: 'auto_subtitle', format: 'auto', codec: 'auto' } },
  }
}

export const AUTO_SUBTITLE_WORDS = {
  failed: 'Adding captions didn’t work. Try again.',
  empty: 'The video finished without its captions. Try again.',
  slow: 'Adding captions took too long, so it was stopped.',
} as const

/** A long run's wait: a 10-minute video can take a while. */
const WAIT_MS = 30 * 60_000

export function autoSubtitleViewUrl(f: RunnerImage, now = Date.now()): string {
  return `/view?${new URLSearchParams({
    filename: f.filename,
    type: f.type,
    ...(f.subfolder ? { subfolder: f.subfolder } : {}),
    t: String(now),
  })}`
}

export interface AutoSubtitleResult { promptId: string, video: RunnerImage }

export type AutoSubtitleStatus = 'idle' | 'running' | 'done' | 'error'

/** The app's run: price, Run, Stop, and the captioned video as a take. */
export function useAutoSubtitleRun(o: {
  video: Ref<{ filename: string } | null>
  settings: () => AutoSubtitleSettings
  addTake: (t: AppTakeInput) => unknown
  hosted?: boolean
  app?: ReturnType<typeof useAppRun>
  /** Passed to the runner wait (tests feed events through it). */
  wait?: Pick<AwaitOutputsOptions, 'target' | 'timeoutMs'>
}) {
  const hosted = o.hosted ?? false
  const app = o.app ?? useAppRun({ hosted })
  const status = ref<AutoSubtitleStatus>('idle')
  const errorMessage = ref<string | null>(null)
  /** What shows in place of a price: the refusal's or failed check's words, or "switched off". */
  const blocked = computed<string | null>(() => {
    if (app.declined.value) return new AppRunDeclined().message
    return app.refused.value
  })
  const priceText = app.priceText
  const running = computed(() => status.value === 'running')
  // A failed price check never leaves the button dead: Run asks for the price again (useAppRun.run).
  const canRun = computed(() => !!o.video.value && !running.value && !app.quoting.value
    && (app.quoteFailed.value || (!blocked.value && app.price.value !== null)))
  /** Stop is offered while a run is going. */
  const canStop = computed(() => running.value)

  const promptNow = (): ApiPrompt | null => (o.video.value ? buildAutoSubtitlePrompt(o.video.value.filename, o.settings()) : null)

  function quote(): Promise<void> {
    return app.quote(promptNow())
  }

  function land(r: AutoSubtitleResult): void {
    o.addTake({ videos: [autoSubtitleViewUrl(r.video)], promptId: r.promptId, sig: `${r.video.subfolder || ''}/${r.video.filename}` })
    status.value = 'done'
  }

  async function run(): Promise<void> {
    const prompt = promptNow()
    if (!canRun.value || !prompt) return
    errorMessage.value = null
    status.value = 'running'
    try {
      const { promptId, outputs } = await app.run(prompt, [AUTO_SUBTITLE_OUT], {
        timeoutMs: WAIT_MS, ...o.wait, words: { failed: AUTO_SUBTITLE_WORDS.failed, empty: AUTO_SUBTITLE_WORDS.empty, slow: AUTO_SUBTITLE_WORDS.slow },
      })
      const video = outputs[AUTO_SUBTITLE_OUT]?.videos[0]
      if (!video) throw new Error(AUTO_SUBTITLE_WORDS.empty)
      land({ promptId, video })
    }
    catch (e) {
      // The runner said no (AppRunDeclined): "switched off", in both places; a refusal: its own words.
      // R11.5: a long one runs in pieces; past the hard ceiling it is refused plainly.
      const name = e instanceof Error ? e.name : ''
      if (e instanceof AppRunCancelled || name === 'AppRunStopped') { status.value = 'idle'; return }
      errorMessage.value = e instanceof Error && e.message ? e.message : AUTO_SUBTITLE_WORDS.failed
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
