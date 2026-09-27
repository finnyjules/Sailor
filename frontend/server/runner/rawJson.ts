/**
 * The body text a provider answered with, kept beside the object parsed from
 * it (R3.1). JSON.parse loses what Python's json.loads keeps (an int past
 * 2^53, `1.0` as a float, a repeated key's place), so a node whose output is
 * the answer's JSON re-reads the text with #shared/runner/pyJson.ts. The
 * queue clients read every body as text, parse it and remember the text here,
 * keyed by the parsed object (a WeakMap: nothing is kept once the answer is
 * dropped).
 */

const raws = new WeakMap<object, string>()

export function rememberRaw(parsed: object, text: string): void {
  raws.set(parsed, text)
}

/** The body text `result` was parsed from, or null (not an answer from a queue client, or not an object). */
export function rawTextOf(result: unknown): string | null {
  return result !== null && typeof result === 'object' ? raws.get(result) ?? null : null
}

/** JSON.parse, remembering the text for an object or array (as `Response.json()` did before, it throws a SyntaxError on a garbled body). */
export function parseRemembered<T = unknown>(text: string): T {
  const v = JSON.parse(text) as unknown
  if (v !== null && typeof v === 'object') rememberRaw(v, text)
  return v as T
}
