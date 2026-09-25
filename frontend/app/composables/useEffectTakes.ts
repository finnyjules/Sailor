/**
 * One shader-generation session (AI in Sailor spec §3.1, §7.2–§7.5; stage 5
 * plan). Three takes are written in parallel; each one that passes the checks
 * is registered as a DRAFT EffectDef and lands on the next pending tile of a
 * stage 3 TakesSession, so PromptTakes shows it at once. Hover previews it on
 * the target; Keep saves a My effect (or a new version of the one being
 * remixed) and applies it; × and Stop restore the target and drop the drafts.
 * A lost graphics context drops the take that was on screen.
 */
import { computed, getCurrentScope, onScopeDispose, readonly, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import { ContextLostError, generateTakes, isAbortError, type EngineDeps, type EngineTake, type TakeRenderer } from '~/lib/shadergen/engine'
import { createBrowserTakeRenderer } from '~/lib/shadergen/browserRenderer'
import { makeCallModel } from '~/lib/shadergen/client'
import { toEffectDef } from '~/lib/shadergen/effectDef'
import { imageForModel, placeholderSource, productEngineInput } from '~/lib/shadergen/productRequest'
import { effectIdForVersion, myEffectIdOf, valuesForVersion } from '~/lib/myEffects/defs'
import { registerEffects, unregisterEffects } from '~/lib/shaderfx/catalog'
import { shaderFx } from '~/lib/shaderfx/renderer'
import { useMyEffects } from '~/composables/useMyEffects'
import { MY_EFFECTS_ERRORS } from '~/lib/myEffects/client'
import { chooseTile, CURRENT, failPending, hoverTile, openTakes, shownTakeId, type TakesSession } from '~/lib/prompt/takesSession'
import type { EffectDef, ParamValue } from '~/lib/shaderfx/types'

export interface EffectTarget {
  /** Stable key for the thing the takes land on (a node id, 'shader-studio', 'frame-background'). */
  key: string
  /** Its own name, for the strip ("Water ripple", "Background"). */
  label: string
  /** The effect being remixed; null makes a new one. A version def resolves to its My effect. */
  base: EffectDef | null
  /** The picture under the effect; null → a neutral placeholder (and no image to the model). */
  image: () => CanvasImageSource | null
  /** Show a take (a registered draft id) on the target; null restores what was there. */
  preview: (effectId: string | null) => void
  /** Keep: point the target at a saved effect with these dial values. */
  apply: (effectId: string, values: Record<string, ParamValue>) => void
}

const PLAIN_SAVE_ERRORS = new Set<string>(Object.values(MY_EFFECTS_ERRORS))

export const EFFECT_MESSAGES = {
  contextLost: 'The graphics card stopped responding while the new effects were being tested. Nothing was changed.',
  droppedTake: 'That take stopped the graphics card, so it was dropped.',
  failed: 'Sailor couldn’t write new effects just now. Try again in a moment.',
  noCredits: 'You don’t have enough credits to write new effects. Add credits, then try again.',
  /** My effects' own plain sentences pass through; anything else (a validation or network
   *  detail) becomes one plain sentence — raw error text never reaches the screen. */
  saveFailed: (why: string) => (PLAIN_SAVE_ERRORS.has(why) ? why : `${MY_EFFECTS_ERRORS.save} Try again in a moment.`),
  savedNew: (name: string) => `Saved to My effects as “${name}”.`,
  savedVersion: (label: string, name: string) => `Saved as ${label} of “${name}”. Earlier versions are kept.`,
}

type Library = Pick<ReturnType<typeof useMyEffects>, 'saveTake' | 'addCodeVersion'>

export interface EffectTakesDeps {
  generate?: typeof generateTakes
  callModel?: EngineDeps['callModel']
  renderer?: (src: CanvasImageSource) => TakeRenderer
  input?: typeof productEngineInput
  library?: Library
  register?: typeof registerEffects
  unregister?: typeof unregisterEffects
  onContextChange?: (fn: (s: 'lost' | 'restored') => void) => () => void
}

export interface EffectTakes {
  session: ShallowRef<TakesSession | null>
  target: ShallowRef<EffectTarget | null>
  request: Ref<string>
  working: ComputedRef<boolean>
  error: Ref<string>
  notice: Ref<string>
  /** A Keep is saving: further Keeps are ignored until it settles (a host can disable its button). */
  saving: Readonly<Ref<boolean>>
  start(request: string, target: EffectTarget): Promise<void>
  preview(id: string | null): void
  choose(id: string): void
  keep(id: string): Promise<boolean>
  close(): void
  more(): Promise<void>
  stop(): void
  clearMessages(): void
}

/** A refusal for want of credits (HTTP 402, or the hosted meter's "credits" wording), as the
 *  error itself or as the engine's failure log line. */
const CREDITS_RE = /\b402\b|credits/i
function isCreditsRefusal(e: unknown): boolean {
  const x = e as { statusCode?: unknown; status?: unknown; message?: unknown } | null
  return x?.statusCode === 402 || x?.status === 402 || CREDITS_RE.test(String(x?.message ?? e ?? ''))
}
/** The plain sentence for a run that failed for a reason other than Stop or a lost graphics card. */
const failureMessage = (e: unknown): string => (isCreditsRefusal(e) ? EFFECT_MESSAGES.noCredits : EFFECT_MESSAGES.failed)

/** The My effect a remix adds a version to: its own id, or (an old-version def) the effect it belongs to. */
function mineIdOf(base: EffectDef | null): string | null {
  if (!base || base.draft) return null
  if (base.versionOf) return base.versionOf
  return base.mine ? (myEffectIdOf(base.id) ?? base.id) : null
}

// Draft ids are unique across every session on the page (two targets can hold drafts at once).
let runs = 0

export function useEffectTakes(deps: EffectTakesDeps = {}): EffectTakes {
  const generate = deps.generate ?? generateTakes
  const register = deps.register ?? registerEffects
  const unregister = deps.unregister ?? unregisterEffects
  const buildInput = deps.input ?? productEngineInput
  // Built on first Keep, so a host that never saves (and its unit specs) needn't provide the library.
  let lib: Library | null = deps.library ?? null
  const library = (): Library => (lib ??= useMyEffects())
  const apiKey = () => useLocalSettings().getLocalSetting('Sailor.AI.AnthropicApiKey') ?? ''
  const callModel: EngineDeps['callModel'] = deps.callModel ?? ((p, i, s) => makeCallModel(apiKey(), 'shader')(p, i, s))
  const makeRenderer = deps.renderer ?? ((src: CanvasImageSource) => createBrowserTakeRenderer(src as HTMLImageElement | HTMLCanvasElement))

  const session = shallowRef<TakesSession | null>(null)
  const target = shallowRef<EffectTarget | null>(null)
  const request = ref('')
  const running = ref(false)
  const error = ref('')
  const notice = ref('')
  const saving = ref(false)
  const taken = new Map<string, EngineTake>() // draft id → take
  let ctrl: AbortController | null = null
  let seq = 0
  // The running set's take renderer. Released synchronously whenever the set is replaced, stopped,
  // closed or kept, so two never overlap; the run's own `finally` is the backstop.
  let liveRenderer: TakeRenderer | null = null
  const releaseRenderer = () => { liveRenderer?.dispose?.(); liveRenderer = null }

  const working = computed(() => running.value)
  const show = () => { const s = session.value; if (s) target.value?.preview(shownTakeId(s)) }
  function dropDrafts() { if (taken.size) unregister([...taken.keys()]); taken.clear() }
  function end() { target.value?.preview(null); dropDrafts(); session.value = null; running.value = false }
  const clearMessages = () => { error.value = ''; notice.value = '' }

  async function start(text: string, t: EffectTarget) {
    ctrl?.abort()
    releaseRenderer()
    if (session.value) end()
    clearMessages()
    const run = ++seq
    const runId = ++runs
    const c = ctrl = new AbortController()
    target.value = t
    request.value = text.trim()
    session.value = { ...openTakes({ nodeId: t.key, nodeLabel: t.label, request: request.value, takes: [] }), loopDone: false }
    running.value = true
    let renderer: TakeRenderer | null = null
    try {
      const src = t.image()
      const input = await buildInput({ request: request.value, base: t.base, image: imageForModel(src), signal: c.signal })
      if (run !== seq) return
      renderer = liveRenderer = makeRenderer(src ?? placeholderSource())
      const result = await generate(input, {
        callModel,
        renderer,
        onTake: (et, slot) => {
          const s = session.value
          if (run !== seq || !s) return
          const i = s.tiles.findIndex(x => x.state === 'pending')
          if (i < 0) return
          const id = `draft_${runId}_${slot}`
          taken.set(id, et)
          register([{ ...toEffectDef(et.take, id), draft: true }])
          const tiles = s.tiles.slice()
          tiles[i] = { state: 'ready', takeId: id, promptId: null, thumb: et.thumbnail }
          session.value = { ...s, tiles }
        },
        // A slot gave up: a tile shows failed at once rather than waiting for the set to end. The
        // last pending one, so takes still arriving keep filling the strip from the left.
        onFailure: () => {
          const s = session.value
          if (run !== seq || !s) return
          const i = s.tiles.map(x => x.state).lastIndexOf('pending')
          if (i < 0) return
          const tiles = s.tiles.slice()
          tiles[i] = { ...tiles[i]!, state: 'failed' }
          session.value = { ...s, tiles }
        },
      })
      if (run !== seq || !session.value) return
      session.value = { ...failPending(session.value), loopDone: true }
      // Nothing came back because the model couldn't be reached (not because the takes failed
      // their checks, which the strip already says): say why, plainly.
      const modelErrors = result.failures.flatMap(f => f.log).filter(l => l.startsWith('model error'))
      if (!result.takes.length && modelErrors.length) error.value = failureMessage(modelErrors.find(l => CREDITS_RE.test(l)) ?? modelErrors[0])
    } catch (e) {
      if (run !== seq || isAbortError(e)) return // Stop / × / a newer start already ended this one
      c.abort() // the other slots' model calls stop here rather than run on (and be billed)
      error.value = e instanceof ContextLostError ? EFFECT_MESSAGES.contextLost : failureMessage(e)
      end()
    } finally {
      // The take renderer is only needed while the set is written: its context goes as soon as the
      // set settles, is replaced, stopped, closed or kept (each aborts the run, which lands here).
      renderer?.dispose?.()
      if (liveRenderer === renderer) liveRenderer = null
      if (run === seq) running.value = false
    }
  }

  function preview(id: string | null) { const s = session.value; if (!s) return; session.value = hoverTile(s, id); show() }
  function choose(id: string) { const s = session.value; if (!s) return; session.value = chooseTile(s, id); show() }

  async function keep(id: string): Promise<boolean> {
    const s = session.value, t = target.value, et = taken.get(id)
    if (!s || !t || !et || id === CURRENT || saving.value) return false
    saving.value = true
    const base = t.base
    const mineId = mineIdOf(base)
    error.value = ''
    const run = seq
    try {
      const rec = mineId
        ? await library().addCodeVersion(mineId, et.take, request.value)
        : await library().saveTake(et.take, { request: request.value, from: base && !base.draft ? base.name : null })
      const last = rec.versions.length - 1
      // Closed (or restarted) while saving: it is saved, but the target has moved on — leave it be.
      if (run === seq) {
        // Drafts go first, then apply: the target swaps the draft it was previewing for the saved id.
        ctrl?.abort(); ctrl = null; seq++
        releaseRenderer()
        dropDrafts()
        session.value = null
        running.value = false
        t.apply(effectIdForVersion(rec, last), valuesForVersion(rec, last))
      }
      notice.value = mineId ? EFFECT_MESSAGES.savedVersion(rec.versions[last]!.label, rec.name) : EFFECT_MESSAGES.savedNew(rec.name)
      return true
    } catch (e) {
      error.value = EFFECT_MESSAGES.saveFailed(String((e as Error)?.message ?? ''))
      return false
    } finally {
      saving.value = false
    }
  }

  function close() { ctrl?.abort(); ctrl = null; seq++; releaseRenderer(); end() }
  const stop = close
  async function more() {
    const s = session.value, t = target.value
    if (!s || !t || !s.loopDone) return
    const text = request.value
    close()
    await start(text, t)
  }

  // Spec §7.5: a take that hangs the GPU while previewed is dropped, and the target restored.
  const offCtx = (deps.onContextChange ?? (fn => shaderFx.onContextChange(fn)))((state) => {
    const s = session.value
    if (state !== 'lost' || !s) return
    const shown = shownTakeId(s)
    if (!shown) return
    target.value?.preview(null)
    unregister([shown]); taken.delete(shown)
    session.value = {
      ...s, hovered: null, chosen: null,
      tiles: s.tiles.map(x => (x.takeId === shown ? { ...x, state: 'failed' as const, takeId: null, thumb: null } : x)),
    }
    notice.value = EFFECT_MESSAGES.droppedTake
  })
  // Released with the owning scope: a component's unmount, or an effectScope/store being stopped.
  if (getCurrentScope()) onScopeDispose(() => { offCtx(); if (session.value || running.value) close() })

  return { session, target, request, working, error, notice, saving: readonly(saving), start, preview, choose, keep, close, more, stop, clearMessages }
}
