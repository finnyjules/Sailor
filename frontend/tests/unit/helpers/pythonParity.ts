/**
 * Python parity after Task S1b.
 *
 * The runner's request builders were ported from Python and the parity
 * fixtures (runner-builders.json, runner-families.json) hold what Python
 * sends. Since S1b the builders follow each provider's published schema (the
 * saved copies in fixtures/provider-schemas/) instead, wherever Python breaks
 * it. The fixtures are kept, unchanged, for every field where Python and the
 * schema agree; the runner deliberately differs only:
 *
 *  1. on a field whose Python value the schema refuses (a seed where the
 *     schema has none, an option outside its list, a number outside its
 *     range) — there the runner sends a value the schema takes, or nothing;
 *  2. on the few fields that carry a Python setting under the schema's own
 *     name (RUNNER_SCHEMA_FIELDS below), because Python sends it under a
 *     name the schema doesn't have.
 *
 * `expectPythonParity` compares the two payloads on every other field, and
 * checks the runner's payload itself breaks nothing Python didn't already
 * break (runner-provider-schemas.unit.spec.ts checks it against the schema in
 * full, with its short list of known gaps).
 */
import { expect } from 'vitest'
import { checkPayload, loadProviderSchema, type ProviderSchemaFixture } from './providerSchema'

type Provider = 'fal' | 'replicate'

/**
 * Fields the runner sends where Python sends a field the schema doesn't
 * have, by `<provider> <endpoint>`. Each names the schema's own field for
 * the same setting.
 */
export const RUNNER_SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // `quality` / `generate_audio_switch` for Python's resolution / generate_audio.
  'replicate pixverse/pixverse-v6': ['quality', 'generate_audio_switch'],
  // `duration` for Python's num_frames (2.7) or nothing (2.5).
  'replicate wan-video/wan-2.7-t2v': ['duration'],
  'replicate wan-video/wan-2.5-i2v-fast': ['duration'],
  // `cfg` / `steps` for Python's guidance_scale / num_inference_steps.
  'replicate lightricks/ltx-video': ['cfg', 'steps'],
  // width × height with aspect_ratio "custom" for Python's resolution label.
  'replicate black-forest-labs/flux-2-dev': ['aspect_ratio', 'width', 'height'],
  // `seconds` for Python's duration.
  'replicate openai/sora-2': ['seconds'],
  'replicate openai/sora-2-pro': ['seconds'],
}

const schemas = new Map<string, ProviderSchemaFixture>()
function schemaOf(provider: Provider, endpoint: string): ProviderSchemaFixture {
  const key = `${provider} ${endpoint}`
  if (!schemas.has(key)) schemas.set(key, loadProviderSchema(provider, endpoint))
  return schemas.get(key)!
}

/** The top-level field a checkPayload message is about ("image_urls[0]: …" → image_urls). */
const fieldOf = (message: string) => message.slice(0, message.indexOf(':')).split(/[.[]/)[0]!

/** The fields on which the runner deliberately differs from Python for this pair of payloads. */
export function schemaDifferences(provider: Provider, endpoint: string, runner: Record<string, unknown>, python: Record<string, unknown>): Set<string> {
  const schema = schemaOf(provider, endpoint)
  const runnerBad = new Set(checkPayload(schema, runner).map(fieldOf))
  const skip = new Set(RUNNER_SCHEMA_FIELDS[`${provider} ${endpoint}`] ?? [])
  for (const f of checkPayload(schema, python).map(fieldOf)) if (!runnerBad.has(f)) skip.add(f)
  return skip
}

/**
 * The runner's payload equals Python's on every field except where Python
 * breaks the provider's schema and the runner doesn't (see the header).
 */
export function expectPythonParity(provider: Provider, endpoint: string, runner: Record<string, unknown>, python: Record<string, unknown>, label = ''): void {
  const skip = schemaDifferences(provider, endpoint, runner, python)
  const keep = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !skip.has(k)))
  expect(keep(runner), `${label} (fields differing by schema: ${[...skip].join(', ') || 'none'})`).toEqual(keep(python))
  // The runner never breaks the schema where Python kept to it.
  const pythonBad = new Set(checkPayload(schemaOf(provider, endpoint), python).map(fieldOf))
  const worse = checkPayload(schemaOf(provider, endpoint), runner).filter(m => !pythonBad.has(fieldOf(m)))
  expect(worse, label).toEqual([])
}

/**
 * Python's payload without the top-level fields the provider's schema doesn't
 * define — what the runner sends for a Python fixture whose only schema
 * breaks are stray fields (a seed Kling or Seedream 5 doesn't take). Any other
 * difference still shows when it is compared with the runner's payload.
 */
export function withoutUnknownFields(provider: Provider, endpoint: string, python: Record<string, unknown>): Record<string, unknown> {
  const unknown = new Set(checkPayload(schemaOf(provider, endpoint), python)
    .filter(m => m.endsWith('not in the schema'))
    .map(m => m.slice(0, m.indexOf(':')))
    .filter(f => !/[.[]/.test(f)))
  return Object.fromEntries(Object.entries(python).filter(([k]) => !unknown.has(k)))
}
