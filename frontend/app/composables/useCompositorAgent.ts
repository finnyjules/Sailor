/**
 * useCompositorAgent — the in-product agent for the Compositor (Frame), the 2nd
 * Phase-2 surface. Same loop as useLayoutAgent (describe → /api/agent-plan →
 * parse → resolve media → per-change proposal → keep/revert), over a
 * CompositorState bridged to the local-layer editor via getState/setState.
 *
 * Reuses the surface-agnostic protocol (buildAgentPrompt/parseAgentResponse) and
 * the shared agent UI. Media ops (generate/edit/remove-bg) call the canvas tools
 * and rewrite into concrete addLayer/setImage commands.
 */
import { computed, ref } from 'vue'
import { $fetch } from 'ofetch'
import type { Command } from '~/lib/agent/commandSurface'
import type { ProposedChange, VisualReview } from '~/composables/useLayoutAgent'
import { applyCompositorCommand, describeCompositor, summarizeCompositorChange, verifyCompositor, type CompositorState } from '~/lib/agent/surfaces/compositor'
import { buildAgentPrompt, buildCommandSchema, buildReviewPrompt, buildReviewSchema, parseAgentResponse, parseReviewResponse } from '~/lib/agent/protocol'
import type { LayoutIssue } from '~/lib/agent/verify'
import { ensureLayerImages, paintLayerStack, type LocalLayer } from '~/composables/useCompositorLayers'
import { mergeCompositorState } from '~/lib/agent/mergeCompositorState'

const REROLLABLE = new Set(['setText', 'setTextStyle', 'setFill', 'setStroke', 'setBackground'])
const clone = (s: CompositorState): CompositorState => JSON.parse(JSON.stringify(s)) as CompositorState

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
/** Upload a data URL to the canvas input dir; returns the stored filename. */
async function uploadDataUrl(dataUrl: string): Promise<string> {
  const name = `agent_gen_${Date.now()}.png`
  const fd = new FormData()
  fd.append('image', dataUrlToBlob(dataUrl), name)
  fd.append('overwrite', 'true')
  const up = await $fetch<{ name?: string }>('/upload/image', { method: 'POST', body: fd })
  return up?.name ?? name
}

export function useCompositorAgent(opts: { getState: () => CompositorState; setState: (s: CompositorState) => void; apiKey: () => string; tier?: string; dims?: () => { w: number; h: number } }) {
  const busy = ref(false)
  const error = ref('')
  const notice = ref('')
  const reasoning = ref('')
  const lastPhrase = ref('')
  const changes = ref<ProposedChange[]>([])
  const issues = ref<LayoutIssue[]>([])
  /** The visual self-review: a designer's-eye critique of the rendered frame. */
  const review = ref<VisualReview | null>(null)
  const reviewing = ref(false)
  const hovered = ref<number | null>(null)
  let original: CompositorState | null = null
  // The agent's view of the doc as of its last push. Every push is a three-way merge against
  // it, so edits the user makes while a proposal is open survive accept / reject / revert.
  let lastPushed: CompositorState | null = null
  function push(next: CompositorState): CompositorState {
    const merged = mergeCompositorState(clone(opts.getState()), lastPushed ?? original ?? next, next)
    opts.setState(merged)
    lastPushed = clone(next)
    return merged
  }
  const hasProposal = computed(() => changes.value.length > 0)

  async function callModel(prompt: string) {
    const snapshot = describeCompositor(opts.getState())
    const schema = buildCommandSchema(snapshot.commands)
    const res = await $fetch<{ text: string }>('/api/agent-plan', {
      method: 'POST',
      body: { apiKey: opts.apiKey(), tier: opts.tier ?? 'plan', prompt, schema },
      timeout: 60_000,
    })
    const parsed = parseAgentResponse(res.text)
    if (parsed.parseFailed) throw new Error('The model reply could not be read — please try again.')
    reasoning.value = parsed.reasoning
    return parsed
  }

  function recompute() {
    if (!original) return
    let s = clone(original)
    for (const ch of changes.value) {
      if (!ch.accepted) continue
      const r = applyCompositorCommand(s, ch.command)
      if (r.ok) s = r.template
    }
    issues.value = verifyCompositor(push(s))
  }

  function buildChange(probe: CompositorState, cmd: Command, rationale: string): ProposedChange | null {
    if (!applyCompositorCommand(probe, cmd).ok) return null
    const sum = summarizeCompositorChange(probe, cmd) ?? { label: cmd.op, before: '', after: '' }
    return { command: cmd, label: sum.label, before: sum.before, after: sum.after, rationale, rerollable: REROLLABLE.has(cmd.op), accepted: true }
  }

  function imageLayer(id?: string) {
    const l = opts.getState().layers.find(x => x.id === id)
    return l?.kind === 'image' ? (l as { filename?: string }) : null
  }
  async function imageDataUrl(id?: string): Promise<string | null> {
    const el = imageLayer(id)
    if (!el?.filename) return null
    try {
      const res = await fetch(`/view?filename=${encodeURIComponent(el.filename)}&type=input`)
      if (!res.ok) return null
      return await blobToDataUrl(await res.blob())
    } catch { return null }
  }

  /** Resolve media commands (generate/edit/remove-bg) into concrete layer ops. */
  async function resolveMedia(commands: Command[], rationales: string[]): Promise<{ resolved: { cmd: Command; rationale: string }[]; genFailed: boolean }> {
    const resolved: { cmd: Command; rationale: string }[] = []
    let genFailed = false
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!
      const rat = rationales[i] ?? ''
      try {
        if (cmd.op === 'generateImage') {
          const prompt = String(cmd.args?.prompt ?? '').trim()
          if (!prompt) { genFailed = true; continue }
          const gen = await $fetch<{ images?: string[] }>('/api/inpaint/text2img', { method: 'POST', body: { prompt, aspect_ratio: cmd.args?.aspectRatio ?? '1:1' } })
          if (!gen.images?.[0]) { genFailed = true; continue }
          const filename = await uploadDataUrl(gen.images[0])
          resolved.push({ cmd: { op: 'addLayer', args: { layer: { id: `img_${Date.now()}_${i}`, kind: 'image', filename, x: 0.5, y: 0.5, w: 0.6, h: 0.6 } } }, rationale: rat || `Generated: ${prompt}` })
        } else if (cmd.op === 'removeImageBackground' || cmd.op === 'editImage') {
          const src = await imageDataUrl(cmd.target)
          if (!src || !cmd.target) { genFailed = true; continue }
          let out: string | undefined
          if (cmd.op === 'removeImageBackground') {
            out = (await $fetch<{ image?: string }>('/api/inpaint/remove-bg', { method: 'POST', body: { image: src } })).image
          } else {
            const instruction = String(cmd.args?.instruction ?? cmd.args?.prompt ?? '').trim()
            if (!instruction) { genFailed = true; continue }
            out = (await $fetch<{ images?: string[] }>('/api/inpaint/kontext', { method: 'POST', body: { image: src, prompt: instruction } })).images?.[0]
          }
          if (!out) { genFailed = true; continue }
          resolved.push({ cmd: { op: 'setImage', target: cmd.target, args: { filename: await uploadDataUrl(out) } }, rationale: rat || (cmd.op === 'removeImageBackground' ? 'Removed background' : 'Edited image') })
        } else {
          resolved.push({ cmd, rationale: rat })
        }
      } catch { genFailed = true }
    }
    return { resolved, genFailed }
  }

  /** Render the current frame (current state = original + accepted changes) to a
   *  PNG data URL on an offscreen canvas. Best-effort; null when unavailable. */
  async function renderFramePng(): Promise<string | null> {
    if (typeof document === 'undefined') return null
    try {
      const state = opts.getState()
      const aspect = (() => { const d = opts.dims?.(); return d && d.w > 0 && d.h > 0 ? d.w / d.h : 1 })()
      const W = aspect >= 1 ? 1024 : Math.round(1024 * aspect)
      const H = aspect >= 1 ? Math.round(1024 / aspect) : 1024
      await ensureLayerImages(state.layers as LocalLayer[])
      const canvas = document.createElement('canvas')
      canvas.width = W; canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      const items = (state.layers as LocalLayer[]).map(l => ({ type: 'local' as const, key: `l:${l.id}`, layer: l }))
      paintLayerStack(ctx, W, H, items, state.layers as LocalLayer[], undefined, undefined, undefined, undefined, state.background, undefined, state.postEffects)
      return canvas.toDataURL('image/png')
    } catch { return null }
  }

  /** Visual self-review: render the frame, let a multimodal model critique the
   *  actual composition, surface its findings and append any fix commands as
   *  additional (self-correcting) proposed changes. Best-effort — never throws. */
  async function runVisualReview(intent: string) {
    reviewing.value = true
    try {
      const image = await renderFramePng()
      if (!image || !original) return
      const snapshot = describeCompositor(opts.getState())
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
      if (fixes.length) {
        let probe = clone(opts.getState()) // current frame (original + accepted changes)
        fixes.forEach((cmd, i) => {
          const ch = buildChange(probe, cmd, fixRationales[i] || 'Visual review fix')
          if (!ch) return
          ch.fromReview = true
          changes.value = [...changes.value, ch]
          const r = applyCompositorCommand(probe, cmd)
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
      original = clone(opts.getState())
      lastPushed = clone(original)
      const { commands, changeRationales, message } = await callModel(buildAgentPrompt(describeCompositor(original), p))
      const { resolved, genFailed } = await resolveMedia(commands, changeRationales)
      const built: ProposedChange[] = []
      let probe = clone(original)
      for (const { cmd, rationale } of resolved) {
        const ch = buildChange(probe, cmd, rationale)
        if (!ch) continue
        built.push(ch)
        const r = applyCompositorCommand(probe, cmd)
        if (r.ok) probe = r.template
      }
      changes.value = built
      if (!built.length) {
        if (message) notice.value = message
        else if (genFailed) error.value = 'Couldn’t complete that image operation — check the layer/keys.'
        else error.value = commands.length ? 'The agent proposed changes, but none applied to this frame.' : 'No changes proposed for that request.'
      } else if (message) notice.value = message
      recompute()
      if (built.length) void runVisualReview(p) // fire-and-forget: proposal shows now, review catches up
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      if (original) push(original)
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
      const intent = lastPhrase.value ? `The user's original request was: "${lastPhrase.value}". ` : ''
      const phrase = `${intent}Re-roll ONLY the "${ch.label}" change (currently "${ch.after}"). Propose a DIFFERENT option that still satisfies the request — not "${ch.after}". Use the same action (op "${ch.command.op}"${ch.command.target ? ` on "${ch.command.target}"` : ''}) and change nothing else. (variation ${nonce})`
      const { commands, changeRationales } = await callModel(buildAgentPrompt(describeCompositor(opts.getState()), phrase))
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

  function keep() { changes.value = []; original = null; lastPushed = null; notice.value = ''; issues.value = []; review.value = null }
  function revert() { if (original) push(original); changes.value = []; original = null; lastPushed = null; notice.value = ''; issues.value = []; review.value = null }

  return { busy, error, notice, reasoning, changes, issues, review, reviewing, hasProposal, hovered, ask, acceptChange, rejectChange, reroll, keep, revert }
}
