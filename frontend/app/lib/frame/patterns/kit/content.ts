import type { LocalLayer, TextLayer } from '~/composables/useCompositorLayers'
import type { FrameElements } from '../types'
import { isNumberish } from '../hierarchy'

// ═══════════════════════ the content model (Stage 4) ═══════════════════════
// What each of the Frame's lines IS, beyond the four text levels and the action: a review
// (rating, quote, by), a list, a comparison (them + the list's rows), a stat (and its line), a
// second image. Read in three steps (ruling R1): the user's tags win over everything; then the
// Stage 1–3 roles (size inference and the stored roles, already in `inferred`); then the
// conservative recognition of ruling R2 on the lines that are not the title (or the action).
// Pure: no Vue, no DOM.

export type ContentRole = 'title' | 'details' | 'date' | 'caption' | 'action' | 'quote' | 'by' | 'rating' | 'list' | 'stat' | 'statline' | 'them' | 'image2'
/** A tag the user put on a layer in the Layout tab (`sailor_posterState.tags`). */
export type ContentTag = ContentRole | 'unused'
export type ContentTags = Record<string, ContentTag>

export interface ReadContent {
  /** Which layer holds which role (layer ids). */
  roles: Partial<Record<ContentRole, string>>
  review?: { stars?: number; quote: string; by?: string }
  list?: string[]
  compare?: { them: string; rows: { label: string; us: boolean; them: boolean }[] }
  stat?: { value: string; line?: string }
}

/** The Stage 1–3 text roles (the ones `FrameElements` holds). */
export const BASE_ROLES = ['title', 'details', 'date', 'caption', 'action'] as const
/** The Stage 4 roles a text layer can hold. */
export const NEW_TEXT_ROLES = ['quote', 'by', 'rating', 'list', 'stat', 'statline', 'them'] as const
/** Every role a tag can name (the Layout tab's Content section). */
export const CONTENT_ROLES: readonly ContentRole[] = [...BASE_ROLES, ...NEW_TEXT_ROLES, 'image2']

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean)

// ── R2 recognition ──────────────────────────────────────────────────────────

const RATING_NUM_RE = /^\s*([0-5](?:[.,]\d)?)\s*(?:★|stars?|\/\s*5|out of 5)\s*$/i
const RATING_BARE_RE = /^\s*([0-5](?:[.,]\d)?)\s*$/
const RATING_STARS_RE = /^\s*(★{1,5})☆*\s*$/

/** A rating (R2, fix round 2): "4.7 ★", "5/5", "4,5 out of 5", "4 stars", or 1–5 ★ followed by
 *  ☆s — always with an explicit marker; a bare "3" is not a rating. Its value: the number, or the
 *  ★ count. `bare`: also read a bare 0–5 (a line the user TAGGED as the rating). Undefined when
 *  the text is not a rating. */
export function ratingOf(s: string | undefined, bare = false): number | undefined {
  if (!s) return undefined
  const stars = RATING_STARS_RE.exec(s)
  if (stars) return stars[1]!.length
  const n = RATING_NUM_RE.exec(s) ?? (bare ? RATING_BARE_RE.exec(s) : null)
  return n ? Number(n[1]!.replace(',', '.')) : undefined
}

/** A quote (R2): opens with “, " or „ and is at least three words. */
export const isQuoteText = (s: string | undefined): boolean =>
  !!s && /^\s*[“"„]/.test(s) && words(s).length >= 3

/** The reviewer (R2): opens with —, – or "- " and is at most eight words. Not a number-like line
 *  ("–30%" is a discount, not a name). */
export const isByText = (s: string | undefined): boolean =>
  !!s && /^\s*(?:—|–|- )/.test(s) && words(s).length <= 8 && !isNumberish(s)

const THEM_RE = /^\s*(?:vs\.?|versus)\s+(\S.*)$/i
/** The other side of a comparison (R2): "vs a typical trail shoe" → "a typical trail shoe". */
export function themOf(s: string | undefined): string | undefined {
  const m = s ? THEM_RE.exec(s.replace(/\n/g, ' ')) : null
  return m ? m[1]!.trim() : undefined
}

const UNIT_RE = /\d\s*(?:[A-Za-zµ]{1,4}|×)\.?\s*$/
/** A date or a time, for the stat rule: "19.09.", "4/10", "12 Oct", "18:30", a range "18–23h". */
const DATEISH_RE = /\d{1,2}[./-]\d{1,2}|\d{1,2}:\d{2}|\d\s*[–—-]\s*\d|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d|\d\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$/i
/** A stat (R2): number-like, ending in a short unit ("198 g", "5000 mAh", "3×"), with no percent,
 *  no currency sign and no date or time. */
export const isStatText = (s: string | undefined): boolean =>
  !!s && isNumberish(s) && UNIT_RE.test(s.trim()) && !/[%€$£¥₹]/.test(s) && !DATEISH_RE.test(s)

const MARKER_RE = /^\s*(?:[•·-]|\d+[.)])\s*/
const linesOf = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean)
/** A list (R2): every line opens with a marker (•, -, ·, "1." or "1)") and there are at least two;
 *  or at least three lines of at most eight words each. (Two short unmarked lines are an address
 *  or a caption, "Kunstraum Lenz / Lenzgasse 14, 4056 Basel" — ruling R1: only when unambiguous.) */
export function isListText(s: string | undefined): boolean {
  if (!s) return false
  const ls = linesOf(s)
  if (ls.length < 2) return false
  if (ls.every(l => MARKER_RE.test(l))) return true
  return ls.length >= 3 && ls.every(l => words(l).length <= 8)
}
/** The list's items, markers stripped (the user's text keeps them). */
export const listItems = (s: string): string[] => linesOf(s).map(l => l.replace(MARKER_RE, '').trim()).filter(Boolean)

/** A comparison row's "both" marker: " ✓✓" or " (both)" at the end of the line. The one copy
 *  (Us vs them strips it from the row's label too). */
export const BOTH_RE = /\s+(?:✓✓|\(both\))\s*$/
/** A comparison's rows from the list's items: ours ✓ and theirs ✕, unless the line ends in " ✓✓"
 *  or " (both)" — then both (the suffix is stripped from the label). */
export const compareRows = (items: string[]): { label: string; us: boolean; them: boolean }[] =>
  items.map(l => BOTH_RE.test(l) ? { label: l.replace(BOTH_RE, ''), us: true, them: true } : { label: l, us: true, them: false })

/** The R2 rules, in the order a line is tried. */
const RULES: [ContentRole, (s: string) => boolean][] = [
  ['rating', s => ratingOf(s) != null],
  ['quote', isQuoteText],
  ['by', isByText],
  ['them', s => themOf(s) != null],
  ['stat', isStatText],
  ['list', isListText],
]

// ── readContent ─────────────────────────────────────────────────────────────

const textOf = (l: LocalLayer | undefined): string | undefined => {
  if (!l || l.kind !== 'text') return undefined
  const t = (l as TextLayer).text ?? ''
  return t.trim() ? t : undefined
}

export interface ReadOpts {
  /** Ruling C2. `'content'` (default): the view Stage 4 layouts (`needsContent`) read — lines
   *  claimed as new content leave their Stage 1–3 roles. `'base'`: the Stage 1–3 view every other
   *  layout reads — only base-role tags and `'unused'` apply, nothing is recognised, so with no such
   *  tags the roles are exactly `inferred`'s. */
  view?: 'base' | 'content'
  /** Content view: the Stage 1–3 reading of the Frame without the given layers (the lines claimed
   *  as new content). When given, the base roles are re-inferred from the remaining lines; without
   *  it a claimed line's base role is simply left empty. */
  reinfer?: (claimed: Set<string>) => FrameElements
}

/** Tests only: turn R2 recognition off (tags still apply), to compare a plan against one that
 *  never recognised anything. Returns the undo. */
let recognise = true
export function __setRecognitionForTest(on: boolean): () => void {
  const was = recognise
  recognise = on
  return () => { recognise = was }
}

const isBaseRole = (r: string): boolean => (BASE_ROLES as readonly string[]).includes(r)

/** Read the Frame's content: tags first, then stored roles (Stage 1–3 rules), then R2 recognition.
 *  `inferred` is the Stage 1–3 reading (size inference with the stored roles applied). A Frame with
 *  no tags and none of the new content reads exactly as `inferred`. `'unused'` removes a layer from
 *  every role. Each role is held by at most one layer; in the content view a line claimed as new
 *  content leaves the Stage 1–3 role it held and the base roles are re-inferred from the remaining
 *  lines (`opts.reinfer`; the title and the action are never re-read as content). */
export function readContent(userLayers: LocalLayer[], inferred: FrameElements, tags: ContentTags | undefined, opts: ReadOpts = {}): ReadContent {
  const base = opts.view === 'base'
  const byId = new Map(userLayers.map(l => [l.id, l]))
  const roles: Partial<Record<ContentRole, string>> = {}
  const taken = new Set<string>()   // layers whose role is settled (tagged, or unused)
  const taggedRoles = new Set<ContentRole>()

  // 1. Tags win over everything. A tag must fit its layer: image2 on an image, the rest on text.
  //    The base view takes only base-role tags and 'unused' (ruling C2).
  for (const [id, tag] of Object.entries(tags ?? {})) {
    const l = byId.get(id)
    if (!l) continue
    if (tag === 'unused') { taken.add(id); continue }
    if (!CONTENT_ROLES.includes(tag)) continue
    if (base && !isBaseRole(tag)) continue
    if (tag === 'image2' ? l.kind !== 'image' : textOf(l) == null) continue
    if (roles[tag] != null) continue   // the first tag of a role (in tag order) holds it
    roles[tag] = id
    taken.add(id)
    taggedRoles.add(tag)
  }

  // 2. The Stage 1–3 roles, on the layers no tag settled, for the roles no tag claimed.
  for (const r of BASE_ROLES) {
    const id = inferred[r]?.id
    if (!id || roles[r] != null || taken.has(id) || textOf(byId.get(id)) == null) continue
    roles[r] = id
  }

  if (base) return { roles }

  // 3. R2 recognition on every other text line (a layer is considered only if it is not the
  //    title — and not the action, ruling S3). The first line in document order that fits a role
  //    holds it; a later one keeps what it had.
  const held = (id: string) => (Object.keys(roles) as ContentRole[]).find(r => roles[r] === id)
  /** The base role a recognised line held before (so it can go back if no shape uses it). */
  const before = new Map<string, ContentRole>()
  if (recognise) for (const l of userLayers) {
    const t = textOf(l)
    if (t == null || taken.has(l.id)) continue
    const cur = held(l.id)
    if (cur === 'title' || cur === 'action') continue
    const hit = RULES.find(([r, test]) => roles[r] == null && test(t))
    if (!hit) continue
    if (cur) { delete roles[cur]; before.set(l.id, cur) }
    roles[hit[0]] = l.id
  }

  // A stat's line (R2): the next-smaller text layer that is not otherwise claimed (a Stage 1–3
  // details / date / caption can become it; a title, action, tagged or new-content line cannot).
  if (roles.stat && roles.statline == null) {
    const size = (id: string) => ((byId.get(id) as TextLayer | undefined)?.fontSize ?? 0)
    const statSize = size(roles.stat)
    const claimed = (id: string) => {
      if (taken.has(id)) return true
      const r = held(id)
      return r != null && !(r === 'details' || r === 'date' || r === 'caption')
    }
    const cands = userLayers.filter(l => textOf(l) != null && !claimed(l.id) && size(l.id) < statSize)
    let best: LocalLayer | undefined
    for (const l of cands) if (!best || size(l.id) > size(best.id)) best = l
    if (best) {
      const cur = held(best.id)
      if (cur) { delete roles[cur]; before.set(best.id, cur) }
      roles.statline = best.id
    }
  }

  // Fix round 2: a line claimed by a new role whose content shape does not form (a rating or a
  // reviewer with no quote, a comparison's other side with no list, a stat's line with no stat) is
  // not content: it goes back to its base role. A role the user TAGGED is kept, shaped or not.
  const unshaped: ContentRole[] = [
    ...(roles.quote ? [] : ['rating', 'by'] as const),
    ...(roles.list ? [] : ['them'] as const),
    ...(roles.stat ? [] : ['statline'] as const),
  ]
  for (const r of unshaped) {
    const id = roles[r]
    if (!id || taggedRoles.has(r)) continue
    delete roles[r]
    const prev = before.get(id)
    if (prev && roles[prev] == null) roles[prev] = id
  }

  // Ruling C2: the lines claimed as new content leave their base roles, and the base roles no tag
  // claimed are re-inferred from the remaining lines.
  const claimed = new Set(NEW_TEXT_ROLES.map(r => roles[r]).filter((id): id is string => !!id))
  if (opts.reinfer && claimed.size) {
    const re = opts.reinfer(claimed)
    for (const r of BASE_ROLES) {
      if (taggedRoles.has(r)) continue
      delete roles[r]
      const id = re[r]?.id
      if (id && !taken.has(id) && !claimed.has(id) && textOf(byId.get(id)) != null) roles[r] = id
    }
  }

  return finish(roles, byId, taken)
}

/** The second image, then the content shapes, from the roles read. */
function finish(roles: Partial<Record<ContentRole, string>>, byId: Map<string, LocalLayer>, taken: Set<string>): ReadContent {
  const userLayers = [...byId.values()]
  // The second image (document order), when no tag named one. `'unused'` images do not count.
  if (roles.image2 == null) {
    const images = userLayers.filter(l => l.kind === 'image' && !taken.has(l.id))
    if (images.length >= 2) roles.image2 = images[1]!.id
  }

  // Content shapes.
  const txt = (r: ContentRole) => roles[r] ? textOf(byId.get(roles[r]!)) : undefined
  const out: ReadContent = { roles }
  const quote = txt('quote')
  if (quote) {
    const stars = ratingOf(txt('rating'), true)
    const by = txt('by')
    out.review = { ...(stars != null ? { stars } : {}), quote, ...(by ? { by } : {}) }
  }
  const list = txt('list')
  if (list) {
    out.list = listItems(list)
    const themLine = txt('them')
    if (themLine) out.compare = { them: themOf(themLine) ?? themLine.trim(), rows: compareRows(out.list) }
  }
  const stat = txt('stat')
  if (stat) {
    const line = txt('statline')
    out.stat = { value: stat, ...(line ? { line } : {}) }
  }
  return out
}

/** The Stage 1–3 elements a `ReadContent` leaves: each base role on the layer `roles` names (its
 *  current text), images and shapes as inferred. With no tags and no new content this deep-equals
 *  `inferred`. */
export function elementsOf(read: ReadContent, inferred: FrameElements, userLayers: LocalLayer[]): FrameElements {
  const out: FrameElements = { images: inferred.images, shapes: inferred.shapes, shapeMode: inferred.shapeMode, imageMode: inferred.imageMode }
  for (const r of BASE_ROLES) {
    const id = read.roles[r]
    if (!id) continue
    if (inferred[r]?.id === id) { out[r] = inferred[r]; continue }
    const t = textOf(userLayers.find(l => l.id === id)) ?? ''
    out[r] = { role: r, id, text: t, words: words(t) }
  }
  return out
}

// ── R9 content hints ────────────────────────────────────────────────────────
// Shown under the Layout tab's Content section (Task 6); never enforced — the checker never
// refuses on them. Pure functions of what `readContent` already read, plus the layers it read
// the roles from (a `ReadContent` holds ids, not text).

const HINT_RATING_5 = 'Ratings between 4.0 and 4.8 tend to read as more believable than a perfect 5.'
const HINT_PERCENT_OR_AMOUNT = 'For prices under 100, a percentage reads bigger; above it, an amount does.'
const HINT_PARTIAL_MARKERS = "Some lines start with a number and some don't."

/** Whether the list's own lines carry a marker (a number or a bullet) on some but not all of them
 *  (Reasons why then draws no owned numbers of its own — the user's markers lead, ruling R5). */
function hasPartialMarkers(s: string): boolean {
  const ls = linesOf(s)
  const marked = ls.map(l => MARKER_RE.test(l))
  return marked.some(Boolean) && marked.some(m => !m)
}

// A price: the currency mark before the number ("$120") or after it ("149 €", "19,50 €") — one
// capture group per side, so `pricesIn` knows which one matched. Fix round 1: a non-global sibling
// (`PRICE_TEST`) for `.test` — a global regex's `lastIndex` state does not survive a `some`/`||`
// short-circuit, and a stray leftover index silently misses a later match.
const NUM_RE_SRC = '\\d+(?:[.,]\\d+)?'
const PRICE_RE = new RegExp(`[€$£]\\s?(${NUM_RE_SRC})|(${NUM_RE_SRC})\\s?[€$£]`, 'g')
const PRICE_TEST = new RegExp(`[€$£]\\s?${NUM_RE_SRC}|${NUM_RE_SRC}\\s?[€$£]`)

/** A matched number ("1,299", "19,50", "149") to its value: a separator (`,` or `.`) followed by
 *  exactly three digits is a thousands mark (dropped); by one or two digits, a decimal point. Only
 *  one separator is recognised (a single price, not a fully-punctuated "1.234.567,89"). */
function amountOf(raw: string): number {
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(raw)
  if (!m) return Number(raw)
  const [, whole, frac] = m
  if (!frac) return Number(whole)
  return frac.length === 3 ? Number(whole + frac) : Number(whole + '.' + frac)
}

/** Every price named in `s` ("$120", "€19,50", "149 €", "$1,299"), as numbers. */
function pricesIn(s: string): number[] {
  return [...s.matchAll(PRICE_RE)].map(m => amountOf((m[1] ?? m[2])!))
}

/** R9: the two research hints, verbatim, when they apply.
 *  - A rating of exactly 5.0 (whatever role holds it, tagged or recognised, shaped into a review
 *    or not) reads as less believable than one a little short of perfect.
 *  - The offer (the `date` role — Stage 1–3's discount/offer line) written as a percentage while a
 *    price of 100 or more appears elsewhere in the Frame's content, or written as a currency
 *    amount while a price under 100 appears elsewhere: research says the other form reads bigger. */
export function contentHints(read: ReadContent, userLayers: LocalLayer[]): string[] {
  const byId = new Map(userLayers.map(l => [l.id, l]))
  const textOfRole = (r: ContentRole): string | undefined => {
    const id = read.roles[r]
    return id ? textOf(byId.get(id)) : undefined
  }
  const hints: string[] = []

  if (ratingOf(textOfRole('rating'), true) === 5) hints.push(HINT_RATING_5)

  const list = textOfRole('list')
  if (list && hasPartialMarkers(list)) hints.push(HINT_PARTIAL_MARKERS)

  const offer = textOfRole('date')
  if (offer) {
    const isPercent = offer.includes('%')
    const isAmount = !isPercent && PRICE_TEST.test(offer)
    if (isPercent || isAmount) {
      const elsewhere = (CONTENT_ROLES as readonly ContentRole[])
        .filter(r => r !== 'date' && r !== 'image2')
        .flatMap(r => pricesIn(textOfRole(r) ?? ''))
      if (isPercent ? elsewhere.some(p => p >= 100) : elsewhere.some(p => p < 100)) {
        hints.push(HINT_PERCENT_OR_AMOUNT)
      }
    }
  }

  return hints
}
