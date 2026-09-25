/**
 * useLayoutAgent — drives the in-product agent for a Smart Layout template
 * (the last-mile of F1; see docs/agentic-north-star.md).
 *
 *   ask(phrase) → describe → POST /api/agent-plan → parse → build a per-change
 *   proposal applied live to the template; the user accepts/rejects/re-rolls
 *   each change, then keeps or reverts.
 *
 * Decoupled from the editor: it takes the template ref + an api-key getter, so
 * it stays portable to other surfaces. Display strings come from the surface's
 * summarizeSmartLayoutChange; the proposal is a list the AgentProposal renders.
 */
import { computed, ref, type Ref } from 'vue'
import { $fetch } from 'ofetch'
import type { BrandKit, Region, TemplateV3 } from '~~/shared/template-grid/types'
import type { Command } from '~/lib/agent/commandSurface'
import { applySmartLayoutCommand, describeSmartLayout, summarizeSmartLayoutChange } from '~/lib/agent/surfaces/smartLayout'
import { buildAgentPrompt, buildCommandSchema, buildReviewPrompt, buildReviewSchema, parseAgentResponse, parseReviewResponse } from '~/lib/agent/protocol'
import { verifySmartLayout, type LayoutIssue } from '~/lib/agent/verify'

/** Ops with a meaningful "different version" — these get the ↻ re-roll. */
const REROLLABLE_OPS = new Set(['setText', 'setTextColor', 'setElementStyle', 'setBrand', 'setBackground', 'applyArchetype'])

export interface ProposedChange {
  command: Command
  label: string
  /** The same row for text the model reads (may name internal types); the UI shows `label`. */
  modelLabel?: string
  before: string
  after: string
  rationale: string
  rerollable: boolean
  accepted: boolean
  /** Added by the visual self-review pass (a designer's-eye correction). */
  fromReview?: boolean
}

export interface VisualReview { assessment: string; issues: string[] }

const clone = (t: TemplateV3): TemplateV3 => JSON.parse(JSON.stringify(t)) as TemplateV3

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',')
  const mime = /:(.*?);/.exec(head ?? '')?.[1] ?? 'image/png'
  const bin = atob(b64 ?? '')
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(blob)
  })
}

/** Upload a data URL to the canvas backend, returning a stable /view URL that an
 *  image element's `content` can point at (survives reload). */
async function uploadDataUrl(dataUrl: string): Promise<string> {
  const name = `agent_gen_${Date.now()}.png`
  const fd = new FormData()
  fd.append('image', dataUrlToBlob(dataUrl), name)
  fd.append('overwrite', 'true')
  const up = await $fetch<{ name?: string }>('/upload/image', { method: 'POST', body: fd })
  return `/view?filename=${encodeURIComponent(up?.name ?? name)}&type=input`
}

/** Generate an image from a prompt (FLUX Schnell) → uploaded /view URL. */
async function generateImageUrl(prompt: string, aspectRatio?: string): Promise<string> {
  const gen = await $fetch<{ images?: string[] }>('/api/inpaint/text2img', {
    method: 'POST', body: { prompt, aspect_ratio: aspectRatio ?? '1:1' },
  })
  const dataUrl = gen.images?.[0]
  if (!dataUrl) throw new Error('no image returned')
  return uploadDataUrl(dataUrl)
}

export function useLayoutAgent(opts: {
  template: Ref<TemplateV3>
  apiKey: () => string
  tier?: string
  /** Sample data so the visual-review render resolves {{ props.* }} / brand. */
  sampleProps?: () => Record<string, unknown>
  sampleBrand?: () => BrandKit
  /** The caller's EFFECTIVE brand context (active kit palette merged with the
   *  template's own overrides) — threaded into every agent snapshot so the
   *  model sees the palette.* tokens actually available to bind to. */
  effectiveBrand?: () => Record<string, unknown>
}) {
  const busy = ref(false)
  const error = ref('')
  /** A neutral reply from the agent: an answer, a clarification, or an honest
   *  "I can't do that" — shown when the request yields no applied changes. */
  const notice = ref('')
  /** The agent's thinking, streamed live while it works (shown in the panel). */
  const reasoning = ref('')
  /** Postcondition warnings on the previewed result (legibility, off-canvas, …). */
  const issues = ref<LayoutIssue[]>([])
  /** The visual self-review: a designer's-eye critique of the rendered result. */
  const review = ref<VisualReview | null>(null)
  const reviewing = ref(false)
  const lastPhrase = ref('')
  const changes = ref<ProposedChange[]>([])
  /** Index the user is hovering — the host highlights that section on canvas. */
  const hovered = ref<number | null>(null)

  let original: TemplateV3 | null = null
  /** The current in-flight model request — aborted whenever a new one starts so
   *  a stuck/abandoned stream can never hold a browser socket and block the next
   *  request (the root cause of the "stuck at ask →" hangs). */
  const hasProposal = computed(() => changes.value.length > 0)

  /** Ask the model for a plan (single request, strict JSON). Surfaces the model's
   *  `reasoning` for display. Non-streaming on purpose — see agent-plan.post.ts. */
  async function callModel(prompt: string) {
    const snapshot = describeSmartLayout(opts.template.value, opts.effectiveBrand?.())
    const schema = buildCommandSchema(snapshot.commands)
    const key = opts.apiKey()
    const res = await $fetch<{ text: string }>('/api/agent-plan', {
      method: 'POST',
      body: { apiKey: key, tier: opts.tier ?? 'plan', prompt, schema },
      timeout: 60_000,
    })
    const parsed = parseAgentResponse(res.text)
    if (parsed.parseFailed) throw new Error('The model reply could not be read — please try again.')
    reasoning.value = parsed.reasoning
    return parsed
  }

  /** Re-derive the live preview: apply the accepted changes from the snapshot. */
  function recompute() {
    if (!original) return
    let t = clone(original)
    for (const ch of changes.value) {
      if (!ch.accepted) continue
      const r = applySmartLayoutCommand(t, ch.command)
      if (r.ok) t = r.template
    }
    opts.template.value = t
    issues.value = verifySmartLayout(t) // flag legibility/off-canvas/etc. on the preview
  }

  function buildChange(probe: TemplateV3, cmd: Command, rationale: string): ProposedChange | null {
    if (!applySmartLayoutCommand(probe, cmd).ok) return null
    const s = summarizeSmartLayoutChange(probe, cmd) ?? { label: cmd.op, before: '', after: '' }
    return { command: cmd, label: s.label, before: s.before, after: s.after, rationale, rerollable: REROLLABLE_OPS.has(cmd.op), accepted: true }
  }

  function imageElement(id?: string) {
    const t = opts.template.value
    const el = t.elements.find(e => e.id === id) ?? t.sections.flatMap(s => s.children).find(e => e.id === id)
    return el?.type === 'image' ? (el as { content?: string }) : null
  }

  /** Resolve an image element's current content to a data URL the edit tools can
   *  ingest. Returns null for a {{variable}} placeholder or an unreachable src. */
  async function imageElementDataUrl(id?: string): Promise<string | null> {
    const el = imageElement(id)
    const content = el?.content
    if (!content || content.includes('{{')) return null // a variable/brand token — no bytes to edit
    try {
      const res = await fetch(content)
      if (!res.ok) return null
      return await blobToDataUrl(await res.blob())
    } catch { return null }
  }

  /** Turn media commands (generate / remove-bg / edit) into concrete template
   *  commands — the only async step (it actually calls the canvas tools and
   *  uploads results). Everything else passes through unchanged. */
  async function resolveGenerative(commands: Command[], rationales: string[]): Promise<{ resolved: { cmd: Command; rationale: string }[]; genFailed: boolean }> {
    const resolved: { cmd: Command; rationale: string }[] = []
    let genFailed = false
    const fill = (target: string, url: string, rationale: string) =>
      resolved.push({ cmd: { op: 'setElementProps', target, args: { patch: { content: url } } }, rationale })

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!
      const rat = rationales[i] ?? ''
      try {
        if (cmd.op === 'generateImage') {
          const prompt = String(cmd.args?.prompt ?? '').trim()
          if (!prompt) { genFailed = true; continue }
          const url = await generateImageUrl(prompt, cmd.args?.aspectRatio as string | undefined)
          if (cmd.target === 'background') resolved.push({ cmd: { op: 'setBackground', args: { image: url } }, rationale: rat || `Generated background: ${prompt}` })
          else if (cmd.target && imageElement(cmd.target)) fill(cmd.target, url, rat || `Generated: ${prompt}`)
          else resolved.push({ cmd: { op: 'addElement', args: { element: { id: `img_${Date.now()}_${i}`, type: 'image', content: url, priority: 5, region: (cmd.args?.region as Region) ?? { col: 1, colSpan: 6, row: 1, rowSpan: 4 } } } }, rationale: rat || `Generated: ${prompt}` })
        } else if (cmd.op === 'removeImageBackground') {
          const src = await imageElementDataUrl(cmd.target)
          if (!src || !cmd.target) { genFailed = true; continue }
          const out = (await $fetch<{ image?: string }>('/api/inpaint/remove-bg', { method: 'POST', body: { image: src } })).image
          if (!out) { genFailed = true; continue }
          fill(cmd.target, await uploadDataUrl(out), rat || 'Removed background')
        } else if (cmd.op === 'editImage') {
          const instruction = String(cmd.args?.instruction ?? cmd.args?.prompt ?? '').trim()
          const src = await imageElementDataUrl(cmd.target)
          if (!src || !cmd.target || !instruction) { genFailed = true; continue }
          const out = (await $fetch<{ images?: string[] }>('/api/inpaint/kontext', { method: 'POST', body: { image: src, prompt: instruction } })).images?.[0]
          if (!out) { genFailed = true; continue }
          fill(cmd.target, await uploadDataUrl(out), rat || `Edited: ${instruction}`)
        } else {
          resolved.push({ cmd, rationale: rat })
        }
      } catch { genFailed = true }
    }
    return { resolved, genFailed }
  }

  /** Render the current preview to a PNG data URL (best-effort; null on failure). */
  async function renderPreview(): Promise<string | null> {
    try {
      const t = opts.template.value
      const res = await fetch('/api/render-template', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template: t, aspect: t.master, props: opts.sampleProps?.() ?? {}, brand: opts.sampleBrand?.() ?? t.brand ?? {} }),
      })
      if (!res.ok) return null
      return await blobToDataUrl(await res.blob())
    } catch { return null }
  }

  /** Visual self-review: render the result, let a multimodal model critique the
   *  actual composition, surface its findings and append any fix commands as
   *  additional (self-correcting) proposed changes. Best-effort — never throws. */
  async function runVisualReview(intent: string) {
    reviewing.value = true
    try {
      const image = await renderPreview()
      if (!image) return
      const snapshot = describeSmartLayout(opts.template.value, opts.effectiveBrand?.())
      const schema = buildReviewSchema(snapshot.commands)
      const res = await $fetch<{ text: string }>('/api/agent-review', {
        method: 'POST',
        body: { apiKey: opts.apiKey(), tier: opts.tier ?? 'plan', prompt: buildReviewPrompt(snapshot, intent), schema, image },
        timeout: 60_000,
      })
      const parsed = parseReviewResponse(res.text)
      if (parsed.parseFailed) throw new Error('The model reply could not be read — please try again.')
      const { assessment, issues: found, fixes, fixRationales } = parsed
      review.value = { assessment, issues: found }
      if (fixes.length && original) {
        let probe = clone(opts.template.value) // current preview (original + accepted changes)
        fixes.forEach((cmd, i) => {
          const ch = buildChange(probe, cmd, fixRationales[i] || 'Visual review fix')
          if (!ch) return
          ch.fromReview = true
          changes.value = [...changes.value, ch]
          const r = applySmartLayoutCommand(probe, cmd)
          if (r.ok) probe = r.template
        })
        recompute()
      }
    } catch { /* review is best-effort */ }
    finally { reviewing.value = false }
  }

  async function ask(phrase: string) {
    const p = phrase.trim()
    if (!p || busy.value) return
    busy.value = true; error.value = ''; notice.value = ''; reasoning.value = ''; issues.value = []; review.value = null; lastPhrase.value = p
    try {
      original = clone(opts.template.value)
      const { commands, changeRationales, message } = await callModel(buildAgentPrompt(describeSmartLayout(opts.template.value, opts.effectiveBrand?.()), p))
      const { resolved, genFailed } = await resolveGenerative(commands, changeRationales)
      const built: ProposedChange[] = []
      let probe = clone(original)
      for (const { cmd, rationale } of resolved) {
        const ch = buildChange(probe, cmd, rationale)
        if (!ch) continue
        built.push(ch)
        const r = applySmartLayoutCommand(probe, cmd)
        if (r.ok) probe = r.template
      }
      changes.value = built
      if (!built.length) {
        if (message) notice.value = message
        else if (genFailed) error.value = 'Couldn’t complete that image operation — make sure the image isn’t a {{variable}} placeholder and your API keys are set in Settings.'
        else error.value = commands.length ? 'The agent proposed changes, but none applied to this layout.' : 'No changes proposed for that request.'
      } else if (message) {
        notice.value = message
      }
      recompute()
      if (built.length) void runVisualReview(p) // fire-and-forget: proposal shows now, review catches up
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      console.error('[agent] ask failed', e)
      if (original) opts.template.value = original
    } finally {
      busy.value = false
    }
  }

  function acceptChange(i: number) { const c = changes.value[i]; if (c) { c.accepted = true; recompute() } }
  function rejectChange(i: number) { const c = changes.value[i]; if (c) { c.accepted = false; recompute() } }

  async function reroll(i: number) {
    const ch = changes.value[i]
    if (!ch || !ch.rerollable || !original || busy.value) return
    busy.value = true; error.value = ''; reasoning.value = ''
    try {
      const nonce = Math.random().toString(36).slice(2, 7)
      // Wrap in the full surface prompt (objects + current values + hints) — a bare
      // prompt gives the model no context and it returns the same default every time.
      // Thread the ORIGINAL request so a re-roll stays on-intent (a different *blue*,
      // not a different colour) while still varying from the current value.
      const intent = lastPhrase.value ? `The user's original request was: "${lastPhrase.value}". ` : ''
      const phrase = `${intent}Re-roll ONLY the "${ch.label}" change — its current value is "${ch.after}". Propose a DIFFERENT option that STILL satisfies the original request (e.g. a different shade or variation of the same idea), but NOT "${ch.after}" and not a near-duplicate. Use the same action (op "${ch.command.op}"${ch.command.target ? ` on "${ch.command.target}"` : ''}) and change nothing else. (variation seed ${nonce})`
      const { commands, changeRationales } = await callModel(buildAgentPrompt(describeSmartLayout(opts.template.value, opts.effectiveBrand?.()), phrase))
      const idx = commands.findIndex(c => c.op === ch.command.op && (c.target ?? '') === (ch.command.target ?? ''))
      const next = idx >= 0 ? commands[idx] : commands[0]
      if (next) {
        const rebuilt = buildChange(clone(original), next, (idx >= 0 ? changeRationales[idx] : changeRationales[0]) ?? ch.rationale)
        if (rebuilt) { rebuilt.accepted = ch.accepted; changes.value.splice(i, 1, rebuilt) }
      }
      recompute()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      busy.value = false
    }
  }

  function keep() { changes.value = []; original = null; notice.value = ''; issues.value = []; review.value = null } // accepted edits already live via recompute()
  function revert() { if (original) opts.template.value = original; changes.value = []; original = null; notice.value = ''; issues.value = []; review.value = null }
  async function tryAgain() { const p = lastPhrase.value; revert(); if (p) await ask(p) }

  return { busy, error, notice, reasoning, issues, review, reviewing, changes, hasProposal, hovered, ask, acceptChange, rejectChange, reroll, keep, revert, tryAgain }
}
