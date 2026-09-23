import { fmtSec, elapsedSince } from '~/lib/canvas/elapsed'
import type { ControlSpec } from '~/lib/spacetype/effect'

// The one line of text under a capsule's name. It does double duty: settings
// when the node is idle, status when it is not. That is what lets a capsule
// stay closed through an entire run-fail-retry cycle instead of forcing you to
// expand it to find out what happened after pressing play.
//
// The governing rule is DEGRADE TO SILENCE: a node with no declared rule shows
// its name and nothing else. Never guess, never dump raw widget values. That
// way partial coverage looks deliberate rather than broken, and read-out rules
// can land node type by node type without ever shipping a wrong-looking chip.

export const READOUT_SEPARATOR = ' · '
export const MAX_SUMMARY_PARTS = 2
const MAX_ERROR_CHARS = 60

/** One value pulled from a Comfy node's positional widget array, by name. */
export type ReadoutPart = {
  name: string
  prefix?: string
  suffix?: string
  /**
   * Optional display mapping for a raw widget value — e.g. a model id like
   * `flux-2-pro` to the label the card shows, `Flux 2 Pro`. Lives on the rule
   * rather than in here so this module keeps no data imports. Return null to
   * drop the part.
   */
  format?: (raw: unknown) => string | null
}

export type ReadoutRule =
  /** Comfy nodes: no schema, so the widget names are declared as data. */
  | { from: 'widgets'; parts: ReadoutPart[] }
  /** Studio nodes: derived from ControlSpec entries carrying `summary`. */
  | { from: 'controls' }
  /** Prompt-ish nodes: one long string, truncated. */
  | { from: 'text'; property: string; max: number }
  | { from: 'none' }

export interface WidgetDef { name: string; type?: string; hidden?: boolean }

export interface ReadoutInput {
  rule?: ReadoutRule
  /** Index-aligned with widgetsValues — see useVueNodes.ts:103-148. */
  widgetDefs?: WidgetDef[]
  widgetsValues?: unknown[]
  /** node.data.properties */
  properties?: Record<string, unknown>
  /** Run state, straight off node.data. */
  running?: boolean
  runningSince?: number | null
  /** Runner: place in the provider's queue while waiting (null once started). */
  queuePosition?: number | null
  /** Runner: the provider's own percentage, when it reports one. */
  progress?: number | null
  errorMessage?: string | null
  /** Injected for testability; defaults to the wall clock. */
  now?: number
  /** Studio nodes: the surface's declared control list. */
  controls?: ControlSpec[]
  /** Studio nodes: the current config blob (properties.sailor_<studio>). */
  config?: Record<string, unknown>
}

/** Render a raw value for display, or null if it has nothing to say. */
export function formatReadoutValue(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    // Two decimals max, trailing zeros stripped: 3.5 → "3.5", 2.0 → "2".
    return String(Math.round(v * 100) / 100)
  }
  if (typeof v === 'string') {
    const t = v.trim()
    return t.length ? t : null
  }
  return null
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

function fromWidgets(parts: ReadoutPart[], defs: WidgetDef[], values: unknown[]): string[] {
  const out: string[] = []
  for (const part of parts) {
    if (out.length >= MAX_SUMMARY_PARTS) break
    // Resolve by NAME, not position. getWidgetDefs injects a hidden
    // "<name>_control" placeholder after seed widgets purely to keep the two
    // arrays aligned, so any positional assumption here is wrong by one.
    const idx = defs.findIndex(d => d.name === part.name)
    if (idx < 0) continue
    const shown = part.format ? part.format(values[idx]) : formatReadoutValue(values[idx])
    if (shown === null) continue
    out.push(`${part.prefix ?? ''}${shown}${part.suffix ?? ''}`)
  }
  return out
}

function fromControls(controls: ControlSpec[], config: Record<string, unknown>): string[] {
  const ranked = controls
    .filter(c => typeof (c as { summary?: number }).summary === 'number')
    .sort((a, b) => (a as { summary: number }).summary - (b as { summary: number }).summary)

  const out: string[] = []
  for (const c of ranked) {
    if (out.length >= MAX_SUMMARY_PARTS) break
    const raw = c.key in config ? config[c.key] : c.default
    const shown = formatReadoutValue(raw)
    if (shown === null) continue
    // A select or text value names itself ("aurora"); a bare number does not,
    // so it carries its label ("grain 0.18").
    const selfDescribing = c.kind === 'select' || c.kind === 'text' || c.kind === 'font'
    out.push(selfDescribing ? shown : `${c.label.toLowerCase()} ${shown}`)
  }
  return out
}

/** 1 → "1st in line", 3 → "3rd in line", 12 → "12th in line". */
export function inLineLabel(position: number): string {
  const n = Math.max(1, Math.floor(position))
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suffix} in line`
}

export function resolveReadout(input: ReadoutInput): string | null {
  // 1. Failure wins. It is the only thing you need to know.
  if (input.errorMessage) {
    const msg = collapse(String(input.errorMessage))
    if (msg) return truncate(msg, MAX_ERROR_CHARS)
  }

  // 2. Running. Waiting in the provider's queue first, then live progress.
  if (input.running) {
    if (typeof input.queuePosition === 'number' && input.queuePosition > 0) return inLineLabel(input.queuePosition)
    const started = input.runningSince
    const pct = typeof input.progress === 'number' && input.progress > 0 && input.progress < 100
      ? `${READOUT_SEPARATOR}${Math.round(input.progress)}%` : ''
    if (!started) return `rendering${pct}`
    const now = input.now ?? Date.now()
    return `rendering${pct}${READOUT_SEPARATOR}${fmtSec(elapsedSince(started, now))}`
  }

  // 3. The declared rule.
  const rule = input.rule
  if (!rule) return null

  if (rule.from === 'widgets') {
    const parts = fromWidgets(rule.parts ?? [], input.widgetDefs ?? [], input.widgetsValues ?? [])
    return parts.length ? parts.join(READOUT_SEPARATOR) : null
  }

  if (rule.from === 'text') {
    const raw = input.properties?.[rule.property]
    const shown = formatReadoutValue(raw)
    if (shown === null) return null
    return truncate(collapse(shown), rule.max)
  }

  if (rule.from === 'controls') {
    const parts = fromControls(input.controls ?? [], input.config ?? {})
    return parts.length ? parts.join(READOUT_SEPARATOR) : null
  }

  // 'none' and anything unrecognised fall through to silence rather than
  // throwing.
  return null
}
