/**
 * Check a request payload against a provider schema saved by
 * scripts/snapshot_provider_schemas.mjs (tests/unit/fixtures/provider-schemas/).
 *
 * A small JSON-Schema subset, enough for fal's and Replicate's published
 * formats: type (with OpenAPI `nullable`), enum, minimum / maximum /
 * exclusiveMinimum / exclusiveMaximum, minLength / maxLength / pattern,
 * required, properties, additionalProperties (as a schema), items /
 * minItems / maxItems, anyOf, allOf and `$ref` into the fixture's own
 * components.
 *
 * Stricter than the providers on purpose: a key the schema doesn't declare
 * fails, because fal accepts unknown keys on submit and fails (or ignores
 * them) later. A validation keyword outside the subset throws, so a schema
 * the checker can't fully read never passes quietly.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface ProviderSchemaFixture {
  endpoint: string
  fetchedAt: string
  sources?: { schema: string; pricing?: string }
  versionId?: string
  input: Schema
  output: Schema
  components: { schemas: Record<string, unknown> }
  pricingText?: string
}

type Schema = Record<string, unknown>

/** Keywords that describe and never constrain. */
const ANNOTATIONS = new Set([
  'title', 'description', 'default', 'examples', 'example', 'format', 'deprecated',
  'readOnly', 'writeOnly', 'nullable', '_fal_ui_field',
])
/** Keywords this checker applies. */
const VALIDATORS = new Set([
  '$ref', 'type', 'enum', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'pattern', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'anyOf', 'allOf',
])

const REF_PREFIX = '#/components/schemas/'

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function fitsType(v: unknown, t: string): boolean {
  switch (t) {
    case 'integer': return typeof v === 'number' && Number.isInteger(v)
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'string': return typeof v === 'string'
    case 'boolean': return typeof v === 'boolean'
    case 'null': return v === null
    case 'array': return Array.isArray(v)
    case 'object': return typeOf(v) === 'object'
    default: throw new Error(`Unsupported type "${t}"`)
  }
}

const show = (v: unknown) => JSON.stringify(v)
const at = (path: string) => path || '(payload)'

function resolve(fixture: ProviderSchemaFixture, ref: unknown): Schema {
  if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) throw new Error(`Unsupported $ref: ${String(ref)}`)
  const name = ref.slice(REF_PREFIX.length)
  const schemas = fixture.components?.schemas ?? {}
  if (!has(schemas, name)) throw new Error(`$ref to a schema the fixture does not hold: ${name}`)
  return schemas[name] as Schema
}

function check(fixture: ProviderSchemaFixture, schema: Schema, v: unknown, path: string, errs: string[]): void {
  for (const k of Object.keys(schema)) {
    if (!VALIDATORS.has(k) && !ANNOTATIONS.has(k) && !k.startsWith('x-')) {
      throw new Error(`Unsupported schema keyword "${k}" at ${at(path)} (${fixture.endpoint})`)
    }
  }

  if (has(schema, '$ref')) check(fixture, resolve(fixture, schema.$ref), v, path, errs)

  if (has(schema, 'allOf')) {
    for (const sub of schema.allOf as Schema[]) check(fixture, sub, v, path, errs)
  }

  if (has(schema, 'anyOf')) {
    const branches = (schema.anyOf as Schema[]).map((sub) => {
      const e: string[] = []
      check(fixture, sub, v, path, e)
      return e
    })
    if (!branches.some(e => e.length === 0)) {
      errs.push(`${at(path)}: fits none of anyOf (${branches.map(e => e.join('; ')).join(' | ')})`)
    }
  }

  if (has(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string]
    const ok = types.some(t => fitsType(v, t)) || (v === null && schema.nullable === true)
    if (!ok) {
      errs.push(`${at(path)}: expected ${types.join(' or ')}, got ${typeOf(v)}`)
      return
    }
  }

  if (has(schema, 'enum')) {
    const options = schema.enum as unknown[]
    if (!options.some(o => show(o) === show(v)) && !(v === null && schema.nullable === true)) {
      errs.push(`${at(path)}: ${show(v)} is not one of ${options.map(show).join(', ')}`)
    }
  }

  if (typeof v === 'number') {
    if (typeof schema.minimum === 'number' && v < schema.minimum) errs.push(`${at(path)}: ${v} is below the minimum ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && v > schema.maximum) errs.push(`${at(path)}: ${v} is above the maximum ${schema.maximum}`)
    if (typeof schema.exclusiveMinimum === 'number' && v <= schema.exclusiveMinimum) errs.push(`${at(path)}: ${v} must be above ${schema.exclusiveMinimum}`)
    if (typeof schema.exclusiveMaximum === 'number' && v >= schema.exclusiveMaximum) errs.push(`${at(path)}: ${v} must be below ${schema.exclusiveMaximum}`)
    for (const k of ['exclusiveMinimum', 'exclusiveMaximum']) {
      if (has(schema, k) && typeof schema[k] !== 'number') throw new Error(`Unsupported boolean ${k} at ${at(path)}`)
    }
  }

  if (typeof v === 'string') {
    const len = [...v].length
    if (typeof schema.minLength === 'number' && len < schema.minLength) errs.push(`${at(path)}: shorter than ${schema.minLength}`)
    if (typeof schema.maxLength === 'number' && len > schema.maxLength) errs.push(`${at(path)}: longer than ${schema.maxLength}`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(v)) errs.push(`${at(path)}: does not match /${schema.pattern}/`)
  }

  if (Array.isArray(v)) {
    if (typeof schema.minItems === 'number' && v.length < schema.minItems) errs.push(`${at(path)}: fewer than ${schema.minItems} items`)
    if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) errs.push(`${at(path)}: more than ${schema.maxItems} items`)
    if (has(schema, 'items')) {
      if (Array.isArray(schema.items)) throw new Error(`Unsupported tuple items at ${at(path)}`)
      v.forEach((item, i) => check(fixture, schema.items as Schema, item, `${path}[${i}]`, errs))
    }
  }

  if (typeOf(v) === 'object' && (has(schema, 'properties') || has(schema, 'additionalProperties') || has(schema, 'required') || schema.type === 'object')) {
    const o = v as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, Schema>
    const extra = schema.additionalProperties
    for (const [k, val] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k
      if (has(props, k)) check(fixture, props[k]!, val, p, errs)
      else if (extra && typeof extra === 'object') check(fixture, extra as Schema, val, p, errs)
      else errs.push(`${p}: not in the schema`)
    }
    for (const k of (schema.required ?? []) as string[]) {
      if (!has(o, k)) errs.push(`${path ? `${path}.${k}` : k}: required but missing`)
    }
  }
}

/**
 * Every way `payload` breaks the fixture's input schema; empty when it fits.
 * The payload is read as the request body sends it (a JSON round trip).
 */
export function checkPayload(fixture: ProviderSchemaFixture, payload: unknown): string[] {
  const sent = JSON.parse(JSON.stringify(payload ?? null))
  const errs: string[] = []
  check(fixture, fixture.input, sent, '', errs)
  return errs
}

const FIXTURES = new URL('../fixtures/provider-schemas/', import.meta.url)

/** The saved schema of one endpoint (`fal` or `replicate`). */
export function loadProviderSchema(provider: 'fal' | 'replicate', endpoint: string): ProviderSchemaFixture {
  const file = new URL(`${provider}/${endpoint.replaceAll('/', '__')}.json`, FIXTURES)
  return JSON.parse(readFileSync(fileURLToPath(file), 'utf8')) as ProviderSchemaFixture
}
