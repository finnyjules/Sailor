/**
 * The saved-provider-schema check (helpers/providerSchema.ts) and the
 * snapshot script's parsing (scripts/snapshot_provider_schemas.mjs), on saved
 * sample responses — no network.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkPayload, type ProviderSchemaFixture } from './helpers/providerSchema'
import {
  falPricingText, falSnapshot, fixtureFileName, reachableSchemas, replicateSnapshot,
} from '../../scripts/snapshot_provider_schemas.mjs'

const sample = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/provider-schema-samples/${name}`, import.meta.url)), 'utf8')

/** A fixture whose input schema is `input`, with `schemas` as its components. */
function fx(input: Record<string, unknown>, schemas: Record<string, unknown> = {}): ProviderSchemaFixture {
  return { endpoint: 'test/endpoint', fetchedAt: '2026-09-24', input, output: {}, components: { schemas } }
}

const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', properties, ...extra })

describe('checkPayload', () => {
  it('passes a payload that fits', () => {
    const f = fx(obj({ prompt: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 4 } }, { required: ['prompt'] }))
    expect(checkPayload(f, { prompt: 'a fox', n: 2 })).toEqual([])
  })

  it('fails a key the schema does not declare (fal accepts it on submit and fails later)', () => {
    const f = fx(obj({ prompt: { type: 'string' } }))
    expect(checkPayload(f, { prompt: 'p', promt: 'typo' })).toEqual(['promt: not in the schema'])
  })

  it('fails an undeclared key inside a nested object too', () => {
    const f = fx(obj({ size: obj({ width: { type: 'integer' } }) }))
    expect(checkPayload(f, { size: { width: 1, height: 2 } })).toEqual(['size.height: not in the schema'])
  })

  it('checks keys of a map against additionalProperties when it is a schema', () => {
    const f = fx({ type: 'object', additionalProperties: { type: 'number' } })
    expect(checkPayload(f, { a: 1, b: 2.5 })).toEqual([])
    expect(checkPayload(f, { a: 'x' })).toEqual(['a: expected number, got string'])
  })

  describe('type', () => {
    it('string, boolean, array, object, null', () => {
      const f = fx(obj({ s: { type: 'string' }, b: { type: 'boolean' }, a: { type: 'array' }, o: { type: 'object' }, z: { type: 'null' } }))
      expect(checkPayload(f, { s: 'x', b: false, a: [], o: {}, z: null })).toEqual([])
      expect(checkPayload(f, { s: 1 })).toEqual(['s: expected string, got number'])
      expect(checkPayload(f, { b: 'true' })).toEqual(['b: expected boolean, got string'])
      expect(checkPayload(f, { a: {} })).toEqual(['a: expected array, got object'])
      expect(checkPayload(f, { o: [] })).toEqual(['o: expected object, got array'])
      expect(checkPayload(f, { z: 0 })).toEqual(['z: expected null, got number'])
    })

    it('integer refuses a fraction and a numeric string; number takes both whole and fractional', () => {
      const f = fx(obj({ i: { type: 'integer' }, n: { type: 'number' } }))
      expect(checkPayload(f, { i: 3, n: 3 })).toEqual([])
      expect(checkPayload(f, { n: 0.5 })).toEqual([])
      expect(checkPayload(f, { i: 2.5 })).toEqual(['i: expected integer, got number'])
      expect(checkPayload(f, { i: '3' })).toEqual(['i: expected integer, got string'])
    })

    it('a list of types takes any of them', () => {
      const f = fx(obj({ v: { type: ['string', 'integer'] } }))
      expect(checkPayload(f, { v: 'a' })).toEqual([])
      expect(checkPayload(f, { v: 1 })).toEqual([])
      expect(checkPayload(f, { v: true })).toEqual(['v: expected string or integer, got boolean'])
    })

    it('nullable lets null through (Replicate)', () => {
      const f = fx(obj({ seed: { type: 'integer', nullable: true }, n: { type: 'integer' } }))
      expect(checkPayload(f, { seed: null })).toEqual([])
      expect(checkPayload(f, { n: null })).toEqual(['n: expected integer, got null'])
    })
  })

  it('enum', () => {
    const f = fx(obj({ fmt: { type: 'string', enum: ['jpeg', 'png'] } }))
    expect(checkPayload(f, { fmt: 'png' })).toEqual([])
    expect(checkPayload(f, { fmt: 'webp' })).toEqual(['fmt: "webp" is not one of "jpeg", "png"'])
  })

  it('minimum, maximum, exclusiveMinimum, exclusiveMaximum', () => {
    const f = fx(obj({ n: { type: 'integer', minimum: 1, maximum: 4 }, g: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 } }))
    expect(checkPayload(f, { n: 1, g: 0.5 })).toEqual([])
    expect(checkPayload(f, { n: 4 })).toEqual([])
    expect(checkPayload(f, { n: 0 })).toEqual(['n: 0 is below the minimum 1'])
    expect(checkPayload(f, { n: 5 })).toEqual(['n: 5 is above the maximum 4'])
    expect(checkPayload(f, { g: 0 })).toEqual(['g: 0 must be above 0'])
    expect(checkPayload(f, { g: 1 })).toEqual(['g: 1 must be below 1'])
  })

  it('minLength, maxLength and pattern on strings', () => {
    const f = fx(obj({ s: { type: 'string', minLength: 1, maxLength: 3, pattern: '\\S' } }))
    expect(checkPayload(f, { s: 'ab' })).toEqual([])
    expect(checkPayload(f, { s: '' })).toEqual(['s: shorter than 1', 's: does not match /\\S/'])
    expect(checkPayload(f, { s: 'abcd' })).toEqual(['s: longer than 3'])
  })

  it('required', () => {
    const f = fx(obj({ prompt: { type: 'string' }, image_url: { type: 'string' } }, { required: ['prompt', 'image_url'] }))
    expect(checkPayload(f, { prompt: 'p' })).toEqual(['image_url: required but missing'])
  })

  it('items, minItems and maxItems', () => {
    const f = fx(obj({ urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 } }))
    expect(checkPayload(f, { urls: ['a', 'b'] })).toEqual([])
    expect(checkPayload(f, { urls: ['a', 3] })).toEqual(['urls[1]: expected string, got number'])
    expect(checkPayload(f, { urls: [] })).toEqual(['urls: fewer than 1 items'])
    expect(checkPayload(f, { urls: ['a', 'b', 'c'] })).toEqual(['urls: more than 2 items'])
  })

  it('anyOf passes when one branch fits and fails when none does', () => {
    const f = fx(obj({ size: { anyOf: [{ type: 'string', enum: ['square_hd', 'landscape_4_3'] }, obj({ width: { type: 'integer' } })] } }))
    expect(checkPayload(f, { size: 'square_hd' })).toEqual([])
    expect(checkPayload(f, { size: { width: 512 } })).toEqual([])
    const errs = checkPayload(f, { size: 'huge' })
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatch(/^size: fits none of anyOf/)
    expect(errs[0]).toContain('"huge" is not one of "square_hd", "landscape_4_3"')
  })

  it('allOf needs every branch (Replicate wraps each enum as allOf[$ref])', () => {
    const f = fx(obj({ fmt: { allOf: [{ $ref: '#/components/schemas/output_format' }], default: 'webp' } }), {
      output_format: { type: 'string', enum: ['webp', 'jpg', 'png'] },
    })
    expect(checkPayload(f, { fmt: 'jpg' })).toEqual([])
    expect(checkPayload(f, { fmt: 'jpeg' })).toEqual(['fmt: "jpeg" is not one of "webp", "jpg", "png"'])
  })

  it('$ref resolves into the fixture\'s own components', () => {
    const f = fx({ $ref: '#/components/schemas/Input' }, {
      Input: obj({ size: { $ref: '#/components/schemas/Size' } }, { required: ['size'] }),
      Size: obj({ w: { type: 'integer', minimum: 64 } }),
    })
    expect(checkPayload(f, { size: { w: 64 } })).toEqual([])
    expect(checkPayload(f, { size: { w: 1 } })).toEqual(['size.w: 1 is below the minimum 64'])
    expect(checkPayload(f, {})).toEqual(['size: required but missing'])
  })

  it('a $ref to a schema the fixture does not hold is an error, not a pass', () => {
    const f = fx(obj({ a: { $ref: '#/components/schemas/Gone' } }))
    expect(() => checkPayload(f, { a: 1 })).toThrow('Gone')
  })

  it('an unsupported validation keyword throws instead of passing quietly', () => {
    const f = fx(obj({ a: { type: 'string', oneOf: [{ type: 'string' }] } }))
    expect(() => checkPayload(f, { a: 'x' })).toThrow('oneOf')
  })

  it('checks what JSON sends: an undefined value is left out, like the request body', () => {
    const f = fx(obj({ prompt: { type: 'string' } }, { required: ['prompt'] }))
    expect(checkPayload(f, { prompt: 'p', extra: undefined })).toEqual([])
  })

  it('takes a real saved fixture: fal flux/schnell refuses webp (the enum that silently fell over)', () => {
    const f = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/provider-schemas/fal/fal-ai__flux__schnell.json', import.meta.url)), 'utf8'))
    expect(checkPayload(f, { prompt: 'p', image_size: 'square_hd', output_format: 'png', num_images: 1 })).toEqual([])
    expect(checkPayload(f, { prompt: 'p', output_format: 'webp' })).toEqual(['output_format: "webp" is not one of "jpeg", "png"'])
  })
})

describe('snapshot_provider_schemas.mjs parsing (saved sample responses)', () => {
  const openapi = JSON.parse(sample('fal-flux-schnell.openapi.json'))
  const llms = sample('fal-flux-schnell.llms.txt')
  const model = JSON.parse(sample('replicate-flux-dev.model.json'))

  it('names the file after the endpoint, / → __', () => {
    expect(fixtureFileName('fal-ai/nano-banana-2/edit')).toBe('fal-ai__nano-banana-2__edit.json')
    expect(fixtureFileName('google/nano-banana-2')).toBe('google__nano-banana-2.json')
  })

  it('fal: keeps the submit body and the result schemas, with every schema they reach', () => {
    const snap = falSnapshot('fal-ai/flux/schnell', openapi, llms, '2026-09-24')
    expect(snap.endpoint).toBe('fal-ai/flux/schnell')
    expect(snap.fetchedAt).toBe('2026-09-24')
    expect(snap.sources).toEqual({
      schema: 'https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux/schnell',
      pricing: 'https://fal.ai/models/fal-ai/flux/schnell/llms.txt',
    })
    expect(snap.input).toEqual({ $ref: '#/components/schemas/FluxSchnellInput' })
    expect(snap.output).toEqual({ $ref: '#/components/schemas/FluxSchnellOutput' })
    expect(Object.keys(snap.components.schemas).sort()).toEqual(['FluxSchnellInput', 'FluxSchnellOutput', 'Image', 'ImageSize'])
    expect(snap).not.toHaveProperty('versionId')
  })

  it('fal: keeps the pricing text', () => {
    expect(falSnapshot('fal-ai/flux/schnell', openapi, llms, 'd').pricingText).toContain('$0.003 per megapixels')
    expect(falPricingText('# X\n\n## Pricing\n\n- **Price**: $1 per video\n\n## API\nrest')).toBe('- **Price**: $1 per video')
    expect(falPricingText('# X\n## Pricing\n$2 per image')).toBe('$2 per image')
    expect(falPricingText('# X\n## API\nno price')).toBeNull()
    expect(falPricingText(null)).toBeNull()
    expect(falSnapshot('fal-ai/flux/schnell', openapi, null, 'd')).not.toHaveProperty('pricingText')
  })

  it('fal: refuses unless x-fal-metadata.endpointId is exactly the id asked for', () => {
    expect(() => falSnapshot('fal-ai/flux-schnell', openapi, llms, 'd')).toThrow('fal endpoint id mismatch')
    expect(() => falSnapshot('flux/schnell', openapi, llms, 'd')).toThrow('fal endpoint id mismatch')
    expect(() => falSnapshot('fal-ai/flux/schnell', null, llms, 'd')).toThrow('fal endpoint id mismatch')
  })

  it('replicate: keeps the latest version id and the Input/Output schemas with what they reach', () => {
    const snap = replicateSnapshot('black-forest-labs/flux-dev', model, '2026-09-24')
    expect(snap.versionId).toBe(model.latest_version.id)
    expect(snap.sources).toEqual({ schema: 'https://api.replicate.com/v1/models/black-forest-labs/flux-dev' })
    expect(snap.input).toEqual({ $ref: '#/components/schemas/Input' })
    expect(snap.output).toEqual({ $ref: '#/components/schemas/Output' })
    expect(Object.keys(snap.components.schemas).sort()).toEqual(['Input', 'Output', 'aspect_ratio', 'megapixels', 'output_format'])
    expect(snap).not.toHaveProperty('pricingText')
  })

  it('replicate: refuses a response for another model or with no version', () => {
    expect(() => replicateSnapshot('black-forest-labs/flux-pro', model, 'd')).toThrow('Replicate model mismatch')
    expect(() => replicateSnapshot('black-forest-labs/flux-dev', { ...model, latest_version: null }, 'd')).toThrow('no latest version')
  })

  it('a parsed sample checks a payload end to end', () => {
    const snap = replicateSnapshot('black-forest-labs/flux-dev', model, 'd')
    expect(checkPayload(snap, { prompt: 'p', aspect_ratio: '1:1', output_format: 'png', num_outputs: 1 })).toEqual([])
    expect(checkPayload(snap, { prompt: 'p', aspect_ratio: '7:3' })[0]).toMatch(/^aspect_ratio: "7:3" is not one of/)
  })

  it('reachableSchemas follows $ref transitively and refuses a missing one', () => {
    const all = { A: { $ref: '#/components/schemas/B' }, B: { type: 'string' }, C: { type: 'integer' } }
    expect(Object.keys(reachableSchemas([{ $ref: '#/components/schemas/A' }], all)).sort()).toEqual(['A', 'B'])
    expect(() => reachableSchemas([{ $ref: '#/components/schemas/Z' }], all)).toThrow('missing schema: Z')
  })
})
