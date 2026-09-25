#!/usr/bin/env node
/**
 * Save a provider's published request format into the repo, so the runner's
 * request builders are checked against it (tests/unit/helpers/providerSchema.ts).
 *
 *   node scripts/snapshot_provider_schemas.mjs fal <endpoint id>…
 *   node scripts/snapshot_provider_schemas.mjs replicate <owner/name>…
 *
 * Every call is a free, read-only GET — never a prediction:
 *   fal        https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>
 *              https://fal.ai/models/<id>/llms.txt  (the pricing text)
 *   Replicate  GET https://api.replicate.com/v1/models/{owner}/{name}
 *              (NUXT_REPLICATE_TOKEN or REPLICATE_API_TOKEN, from the env or frontend/.env)
 *
 * Writes tests/unit/fixtures/provider-schemas/<provider>/<endpoint, / → __>.json:
 *   { endpoint, fetchedAt, sources, versionId?, input, output, components, pricingText? }
 * `components.schemas` holds every schema `input` and `output` reach by `$ref`,
 * so the fixture resolves its own references.
 *
 * fal accepts a wrong endpoint id or an out-of-enum value on submit and only
 * fails at the result, so the fal snapshot refuses unless the document's
 * `x-fal-metadata.endpointId` is exactly the id asked for.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const FIXTURE_DIR = fileURLToPath(new URL('../tests/unit/fixtures/provider-schemas/', import.meta.url))

export const falSchemaUrl = id => `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${id}`
export const falLlmsUrl = id => `https://fal.ai/models/${id}/llms.txt`
export const replicateModelUrl = slug => `https://api.replicate.com/v1/models/${slug}`

export function fixtureFileName(endpoint) {
  return `${endpoint.replaceAll('/', '__')}.json`
}

const REF_PREFIX = '#/components/schemas/'

function refName(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) throw new Error(`Unsupported $ref: ${ref}`)
  return ref.slice(REF_PREFIX.length)
}

/** Every component schema reachable from `roots` through `$ref`, by name. */
export function reachableSchemas(roots, all) {
  const out = {}
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref') {
        const name = refName(v)
        if (Object.prototype.hasOwnProperty.call(out, name)) continue
        if (!Object.prototype.hasOwnProperty.call(all, name)) throw new Error(`$ref to a missing schema: ${name}`)
        out[name] = all[name]
        walk(all[name])
      }
      else {
        walk(v)
      }
    }
  }
  walk(roots)
  return out
}

/** The `## Pricing` section of a fal llms.txt, trimmed, or null when it has none. */
export function falPricingText(llms) {
  if (typeof llms !== 'string') return null
  const m = /^## Pricing[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(llms)
  const text = m?.[1]?.trim()
  return text || null
}

function jsonSchemaOf(content, where) {
  const schema = content?.['application/json']?.schema
  if (!schema) throw new Error(`${where} has no application/json schema`)
  return schema
}

/**
 * Build a fal fixture from the queue OpenAPI document and the llms.txt text.
 * @returns {any} a ProviderSchemaFixture (tests/unit/helpers/providerSchema.ts)
 */
export function falSnapshot(endpoint, openapi, llmsText, fetchedAt) {
  const got = openapi?.info?.['x-fal-metadata']?.endpointId
  if (got !== endpoint) throw new Error(`fal endpoint id mismatch: asked for ${endpoint}, the schema says ${String(got)}`)
  const paths = openapi.paths ?? {}
  const submit = paths[`/${endpoint}`]?.post
  if (!submit) throw new Error(`fal schema for ${endpoint} has no POST /${endpoint}`)
  const result = paths[`/${endpoint}/requests/{request_id}`]?.get
  if (!result) throw new Error(`fal schema for ${endpoint} has no result path`)
  const input = jsonSchemaOf(submit.requestBody?.content, 'the submit body')
  const output = jsonSchemaOf(result.responses?.['200']?.content, 'the result')
  const all = openapi.components?.schemas ?? {}
  const snap = {
    endpoint,
    fetchedAt,
    sources: { schema: falSchemaUrl(endpoint), pricing: falLlmsUrl(endpoint) },
    input,
    output,
    components: { schemas: reachableSchemas([input, output], all) },
  }
  const pricingText = falPricingText(llmsText)
  if (pricingText) snap.pricingText = pricingText
  return snap
}

/**
 * Build a Replicate fixture from GET /v1/models/{owner}/{name}.
 * @returns {any} a ProviderSchemaFixture (tests/unit/helpers/providerSchema.ts)
 */
export function replicateSnapshot(endpoint, model, fetchedAt) {
  const slug = `${model?.owner}/${model?.name}`
  if (slug !== endpoint) throw new Error(`Replicate model mismatch: asked for ${endpoint}, got ${slug}`)
  const version = model.latest_version
  if (!version?.id) throw new Error(`Replicate model ${endpoint} has no latest version`)
  const all = version.openapi_schema?.components?.schemas ?? {}
  if (!all.Input || !all.Output) throw new Error(`Replicate model ${endpoint} has no Input/Output schema`)
  const input = { $ref: `${REF_PREFIX}Input` }
  const output = { $ref: `${REF_PREFIX}Output` }
  return {
    endpoint,
    fetchedAt,
    sources: { schema: replicateModelUrl(endpoint) },
    versionId: version.id,
    input,
    output,
    components: { schemas: reachableSchemas([input, output], all) },
  }
}

function replicateToken() {
  const env = process.env.NUXT_REPLICATE_TOKEN || process.env.REPLICATE_API_TOKEN
  if (env) return env
  try {
    const text = readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8')
    for (const line of text.split('\n')) {
      const m = /^\s*(NUXT_REPLICATE_TOKEN|REPLICATE_API_TOKEN)\s*=\s*(.*?)\s*$/.exec(line)
      if (m?.[2]) return m[2].replace(/^["']|["']$/g, '')
    }
  }
  catch { /* no .env */ }
  return null
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { method: 'GET', headers })
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`)
  return res.json()
}

async function getText(url) {
  const res = await fetch(url, { method: 'GET' })
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`)
  return res.text()
}

async function main(argv) {
  const [provider, ...endpoints] = argv
  if (!['fal', 'replicate'].includes(provider) || !endpoints.length) {
    console.error('usage: snapshot_provider_schemas.mjs fal|replicate <endpoint>…')
    process.exit(1)
  }
  const token = provider === 'replicate' ? replicateToken() : null
  if (provider === 'replicate' && !token) {
    console.error('Replicate needs NUXT_REPLICATE_TOKEN (env or frontend/.env)')
    process.exit(1)
  }
  const dir = `${FIXTURE_DIR}${provider}/`
  mkdirSync(dir, { recursive: true })
  let failed = 0
  for (const endpoint of endpoints) {
    const fetchedAt = new Date().toISOString().slice(0, 10)
    try {
      const snap = provider === 'fal'
        ? falSnapshot(endpoint, await getJson(falSchemaUrl(endpoint)), await getText(falLlmsUrl(endpoint)).catch(() => null), fetchedAt)
        : replicateSnapshot(endpoint, await getJson(replicateModelUrl(endpoint), { Authorization: `Bearer ${token}` }), fetchedAt)
      writeFileSync(`${dir}${fixtureFileName(endpoint)}`, `${JSON.stringify(snap, null, 2)}\n`)
      console.log(`saved ${provider} ${endpoint}${snap.pricingText ? '' : provider === 'fal' ? ' (no pricing text)' : ''}`)
    }
    catch (e) {
      failed++
      console.error(`FAILED ${provider} ${endpoint}: ${e.message}`)
    }
  }
  if (failed) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
