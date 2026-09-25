// Which worker runs a routed request in a studio (AI in Sailor spec §4; stage 4
// plan rulings 1–4). Every studio keeps its own agent; this only decides whether
// the request goes to it or gets a plain message. Pure.
import type { RouterKind } from '~~/shared/promptRouter/router'
import { DISPATCH_MESSAGES } from '~/lib/prompt/canvasDispatch'

export type StudioPromptPlace = 'studio' | 'frame' | 'template' | 'scene3d'
/** `effect`: a new effect (stage 5) — the studio's effect-takes session runs it, not its agent. */
export type StudioDispatch = { worker: 'ask'; text: string } | { worker: 'effect'; text: string } | { worker: 'message'; message: string }

export const VARY_REQUEST = 'Three different directions'

export const STUDIO_MESSAGES = {
  newEffect: DISPATCH_MESSAGES.newEffect,
  copyInFrame: 'Copy is written in Frame. Open a Frame to write or rewrite its words.',
  layoutInFrame: 'Layouts are arranged in Frame. Open a Frame to try other layouts.',
  noWorker3d: '3D can’t take instructions yet. Use the tools below, or the inspector.',
  nothingToVary: 'Type what to change, or pick an action in the inspector.',
} as const

export function studioDispatch(
  kind: RouterKind,
  text: string,
  /** `hasEffectTarget`: the studio can show new effects on something (the Shader studio's
   *  layer, Frame's background). Elsewhere a new effect points to where it can be made. */
  o: { place: StudioPromptPlace; hasWorker: boolean; canTakes: boolean; fromMenu?: boolean; hasEffectTarget?: boolean },
): StudioDispatch {
  const t = text.trim()
  if (!o.hasWorker) return { worker: 'message', message: STUDIO_MESSAGES.noWorker3d }
  if (kind === 'new-effect') return o.hasEffectTarget ? { worker: 'effect', text: t } : { worker: 'message', message: STUDIO_MESSAGES.newEffect }
  if ((kind === 'copy' || kind === 'layout') && o.place === 'studio')
    return { worker: 'message', message: kind === 'copy' ? STUDIO_MESSAGES.copyInFrame : STUDIO_MESSAGES.layoutInFrame }
  if (!t) {
    if (kind === 'tweak' && o.fromMenu && o.canTakes) return { worker: 'ask', text: VARY_REQUEST }
    return { worker: 'message', message: STUDIO_MESSAGES.nothingToVary }
  }
  return { worker: 'ask', text: t }
}

const LABEL_MAX = 24
const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s)

/** The user's own words for a chip or head: whitespace collapsed, cut to 24
 *  characters (the `…` included). '' when there are none. One rule for every
 *  prompt chip (spec §2.1a: chip style is identical everywhere). */
export function cutWords(text: string | null | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1).trimEnd()}…` : t
}
/** The chip form of the user's words: quoted, so they read as content, not a
 *  name. '' when there are none. */
export function quoteWords(text: string | null | undefined): string {
  const c = cutWords(text)
  return c ? `“${c}”` : ''
}

/** Frame's prompt chip (plan ruling 19): the layer's own words, never a guessed role.
 *  The template editor uses it too (its elements are text, image or shape layers). */
export function frameSelectionLabel(layers: { kind: string; text?: string | null; name?: string | null }[]): string | null {
  if (!layers.length) return null
  if (layers.length > 1) return `${layers.length} layers`
  const l = layers[0]!
  const quoted = l.kind === 'text' ? quoteWords(l.text) : ''
  if (quoted) return `${quoted} · text`
  const name = (l.name ?? '').trim()
  return name || sentence(l.kind)
}
