/**
 * Parity with the Python itself for the small /sailor routes: ComfyUI's REAL
 * handlers and the native ones answer the same requests over the same temp
 * data root, and each side reads what the other wrote.
 *
 * Python left the repo in step 4, C7: the Python's answers, and the files it
 * wrote, were frozen then into fixtures/native-small-routes-python-answers.json
 * (the shader catalog as it stood then is in fixtures/native-small-routes-shader-effects/)
 * and are replayed by helpers/frozenOracle.ts. Nothing here runs Python.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as fontkit from 'fontkit'
import { catalogPayload, shaderEffectsRoute } from '../../server/native/shaderCatalog'
import {
  spaceDefaultSaveRoute,
  spaceDefaultsRoute,
  spaceThumbnailGetRoute,
  spaceThumbnailSaveRoute,
  spaceThumbnailsRoute,
} from '../../server/native/spacePresets'
import { fontSubsetRoute } from '../../server/native/fontSubset'
import { cleanupFramesRoute, clearDatasetRoute, saveCaptionsRoute } from '../../server/native/inputHousekeeping'
import { frozenOracle } from './helpers/frozenOracle'

const REPO = path.resolve(__dirname, '..', '..', '..')
const FROZEN = path.join(__dirname, 'fixtures', 'native-small-routes-python-answers.json')
const SHADER_EFFECTS_AT_C7 = path.join(__dirname, 'fixtures', 'native-small-routes-shader-effects')
const FONTS = path.join(REPO, 'Assets', 'Fonts', 'Free Fonts')


interface PyCall { handler: string, path?: string, match_info?: Record<string, string>, body?: string | null, body_b64?: string, file?: string, text?: string }
interface PyResult { status: number, content_type: string, body: any }

let root: string
let home: string
let input: string
let bridge: string

const oracle = frozenOracle(FROZEN)
function python(calls: PyCall[]): PyResult[] {
  return oracle(root, calls.map(c => ({ path: '/', ...c }))) as PyResult[]
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-small-parity-')))
  home = path.join(root, 'home')
  input = path.join(root, 'input')
  bridge = path.join(root, 'custom_nodes', 'sailor_bridge')
  for (const d of [home, input, path.join(root, 'models')]) fs.mkdirSync(d, { recursive: true })
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const json = (value: unknown) => async () => ({ ok: true as const, value })
const bytes = (b: Buffer) => async () => b

describe('shader_effects catalog', () => {
  it('the real catalog: identical payload (every effect, param, default, texture version and inlined source)', () => {
    // The catalog as it stood when the Python's answer was frozen (C7): its
    // manifest and shaders, and empty stand-ins for the textures, whose
    // versions come from their mtimes only.
    fs.cpSync(SHADER_EFFECTS_AT_C7, path.join(root, 'shader_effects'), { recursive: true })
    for (const f of fs.readdirSync(path.join(root, 'shader_effects', 'assets'))) {
      fs.utimesSync(path.join(root, 'shader_effects', 'assets', f), 1_790_000_000, 1_790_000_000)
    }
    // CRLF line endings in a shader: Python's text mode reads them as \n.
    const frag = path.join(root, 'shader_effects', 'noise_distortion.frag')
    fs.writeFileSync(frag, fs.readFileSync(frag, 'utf8').replace(/\n/g, '\r\n'))
    fs.utimesSync(path.join(root, 'shader_effects', 'assets', 'blue_noise.png'), 1_790_000_000.9, 1_790_000_000.9)
    const [py] = python([{ handler: '_get_shader_effects' }])
    const native = shaderEffectsRoute(path.join(root, 'shader_effects'))
    expect(py!.status).toBe(200)
    expect(native.status).toBe(200)
    expect(native.body).toEqual(py!.body)
    expect((native.body as any).effects.length).toBeGreaterThan(50)
    expect(JSON.stringify(native.body), 'same key order everywhere').toBe(JSON.stringify(py!.body))
  })

  it('a manifest the Python rejects: same 500, same message (and Python\'s True == 1 accepted alike)', () => {
    const dir = path.join(root, 'shader_effects')
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
    for (const id of ['a', 'b']) fs.writeFileSync(path.join(dir, `${id}.frag`), 'void main(){}')
    const eff = (params: unknown[], extra: Record<string, unknown> = {}) => ({ id: 'a', name: 'A', category: 'c', animated: false, passes: 1, textures: [], params, ...extra })
    const f = (extra: Record<string, unknown> = {}) => ({ uniform: 'u_x', label: 'X', type: 'float', default: 0.5, min: 0, max: 1, step: 0.1, ...extra })
    const manifests: unknown[] = [
      { version: 1, effects: [eff([f()]), eff([f()])] },
      { version: 1, effects: [{ ...eff([f()]), id: 'missing' }] },
      { version: 1, effects: [eff([f({ default: 2 })])] },
      { version: 1, effects: [eff([f({ type: 'enum', options: [{ value: 'x' }], default: 'y' })])] },
      { version: 1, effects: [eff([f({ type: 'enum', options: [], default: 'y' })])] },
      { version: 1, effects: [eff([f({ type: 'enum', options: [{ value: 1 }], default: true })])] },
      { version: 1, effects: [eff([f({ type: 'color', default: '#zzzzzz' })])] },
      { version: 1, effects: [eff([f({ type: 'color', default: '#0x1234' })])] },
      { version: 1, effects: [eff([f({ type: 'color', default: 5 })])] },
      { version: 1, effects: [eff([f({ type: 'gradient', default: [{ color: '#fff', pos: 0 }] })])] },
      { version: 1, effects: [eff([f({ type: 'gradient', maxStops: 2, default: [{ color: '#fff', pos: 0 }, { color: '#000', pos: 0.5 }, { color: '#000', pos: 1 }] })])] },
      { version: 1, effects: [eff([f({ type: 'gradient', default: [{ color: '#fff', pos: 0 }, { color: 'nope', pos: 1 }] })])] },
      { version: 1, effects: [eff([f({ type: 'gradient', default: [{ color: '#fff', pos: 0 }, { color: '#000', pos: 2 }] })])] },
      { version: 1, effects: [eff([f({ type: 'gradient', default: [{ color: '#fff', pos: 0 }, { color: '#000' }] })])] },
      { version: 1, effects: [eff([f({ type: 'gradient', default: [{ color: '#fff', pos: 0 }, { color: '#000', pos: 'abc' }] })])] },
      { version: 1, effects: [eff([f({ bogus: 1 })])] },
      { version: 1, effects: [eff([{ uniform: 'u' }])] },
      { version: 1, effects: [eff([{ uniform: 'u', label: 'l' }])] },
      { version: 1, effects: [{ id: 'a', params: [] }] },
      { version: 1 },
      { effects: [] },
    ]
    // One Python run: write each manifest, then ask for the catalog.
    const py = python(manifests.flatMap(m => [
      { handler: '__write__', file: 'shader_effects/manifest.json', text: JSON.stringify(m) },
      { handler: '_get_shader_effects' },
    ])).filter(Boolean)
    for (const [i, m] of manifests.entries()) {
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m))
      const native = shaderEffectsRoute(dir)
      expect({ status: native.status, body: native.body }, JSON.stringify(m)).toEqual({ status: py[i]!.status, body: py[i]!.body })
    }
  })

  it('valid edge cases: snake_case param keys, textures carrying their own v, dict order', () => {
    const dir = path.join(root, 'shader_effects')
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'z.frag'), 'x')
    fs.writeFileSync(path.join(dir, 'assets', 't.png'), 'png')
    fs.utimesSync(path.join(dir, 'assets', 't.png'), 1_790_000_000, 1_790_000_000)
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      version: 3,
      effects: [{
        id: 'z', name: 'Z', category: 'c', animated: true, passes: null, generative: true, followsShape: true, centerParam: ['u_a', 'u_b'],
        textures: [{ v: 'old', file: 't.png', uniform: 'u_t', extraUniforms: { k: 1 } }, { file: 'gone.png', uniform: 'u_g' }],
        params: [
          { max_stops: 3, show_when: { uniform: 'u', equals: 1 }, uniform: 'u_c', label: 'C', type: 'gradient', default: [{ color: '#abc', pos: 0 }, { color: '#abcdef80', pos: '1' }] },
          { uniform: 'u_e', label: 'E', type: 'enum', default: 1, options: [{ value: 1.0, label: 'one' }] },
        ],
      }],
    }))
    const [py] = python([{ handler: '_get_shader_effects' }])
    expect(py!.status).toBe(200)
    expect(catalogPayload(dir)).toEqual(py!.body)
  })
})

describe('Space Type presets and thumbnails', () => {
  it('a preset saved by either side reads back the same through both, byte-identical on disk', async () => {
    const scene = { text: 'Hé "quoted"\n', size: 12, nested: { a: [1, 2.5, null, true], emoji: '🌊' } }
    const [pySave] = python([{ handler: '_space_default_save', match_info: { effect_id: 'burst' }, body: JSON.stringify(scene) }])
    expect(pySave).toMatchObject({ status: 200, body: { ok: true } })
    const pyBytes = fs.readFileSync(path.join(bridge, 'scene_defaults', 'burst.json'))
    fs.rmSync(path.join(bridge, 'scene_defaults', 'burst.json'))

    expect(await spaceDefaultSaveRoute(bridge, 'burst', json(scene))).toEqual({ status: 200, body: { ok: true } })
    expect(fs.readFileSync(path.join(bridge, 'scene_defaults', 'burst.json'))).toEqual(pyBytes)

    python([{ handler: '_space_default_save', match_info: { effect_id: 'coil2' }, body: JSON.stringify({ x: 1 }) }])
    fs.writeFileSync(path.join(bridge, 'scene_defaults', 'broken.json'), '{nope')
    fs.writeFileSync(path.join(bridge, 'scene_defaults', 'Upper.json'), '{}')
    fs.writeFileSync(path.join(bridge, 'scene_defaults', 'notes.txt'), '{}')
    fs.mkdirSync(path.join(bridge, 'scene_defaults', 'dir.json'))
    const [pyList] = python([{ handler: '_space_defaults_list' }])
    const native = spaceDefaultsRoute(bridge)
    expect(native.body).toEqual(pyList!.body)
    expect(Object.keys(native.body as object)).toEqual(Object.keys(pyList!.body))
    expect(native.body).toEqual({ burst: scene, coil2: { x: 1 } })
  })

  it('the same refusals: bad id, bad JSON, a non-object scene', async () => {
    const cases: [string, string | null][] = [['Bad-Id', '{}'], ['x', '[1]'], ['x', '"s"'], ['x', 'null'], ['ok', '{bad'], ['ok', '']]
    const py = python(cases.map(([id, body]) => ({ handler: '_space_default_save', match_info: { effect_id: id }, body })))
    for (const [i, [id, body]] of cases.entries()) {
      let parsed: { ok: true, value: unknown } | { ok: false, result: any }
      try { parsed = { ok: true, value: JSON.parse(body ?? '') } }
      catch { parsed = { ok: false, result: { status: 400, body: { error: 'bad json: <detail>' } } } }
      const native = await spaceDefaultSaveRoute(bridge, id, async () => parsed)
      expect(native.status, `${id} ${body}`).toBe(py[i]!.status)
      if (native.status === 400 && String(py[i]!.body.error).startsWith('bad json')) expect(String((native.body as any).error)).toMatch(/^bad json: /)
      else expect(native.body, `${id} ${body}`).toEqual(py[i]!.body)
    }
    expect(fs.existsSync(path.join(bridge, 'scene_defaults', 'x.json'))).toBe(false)
  })

  it('thumbnails: save, list (URL with the whole-second mtime), get — either side reads the other', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex')
    const [pySave] = python([{ handler: '_space_thumbnail_save', match_info: { effect_id: 'ball' }, body_b64: png.toString('base64') }])
    expect(pySave!.body).toEqual({ ok: true })
    expect(await spaceThumbnailSaveRoute(bridge, 'coil', bytes(png))).toEqual({ status: 200, body: { ok: true } })
    fs.utimesSync(path.join(bridge, 'scene_thumbnails', 'ball.png'), 1_790_000_000.75, 1_790_000_000.75)
    fs.utimesSync(path.join(bridge, 'scene_thumbnails', 'coil.png'), 1_790_000_001, 1_790_000_001)
    fs.writeFileSync(path.join(bridge, 'scene_thumbnails', 'BAD.png'), png)

    const [pyList, pyGetCoil, pyGetBall, pyMissing, pyBad, pyEmpty, pyBadSave] = python([
      { handler: '_space_thumbnails_list' },
      { handler: '_space_thumbnail_get', match_info: { effect_id: 'coil' } },
      { handler: '_space_thumbnail_get', match_info: { effect_id: 'ball' } },
      { handler: '_space_thumbnail_get', match_info: { effect_id: 'nope' } },
      { handler: '_space_thumbnail_get', match_info: { effect_id: '../x' } },
      { handler: '_space_thumbnail_save', match_info: { effect_id: 'e' }, body_b64: '' },
      { handler: '_space_thumbnail_save', match_info: { effect_id: 'E!' }, body_b64: png.toString('base64') },
    ])
    expect(spaceThumbnailsRoute(bridge).body).toEqual(pyList!.body)
    expect((pyList!.body as any).ball).toBe('/sailor/space_thumbnail/ball?v=1790000000')

    const coil = spaceThumbnailGetRoute(bridge, 'coil')
    expect(pyGetCoil).toMatchObject({ status: 200, content_type: 'image/png', body: png.toString('base64') })
    expect(coil).toEqual({ status: 200, body: png, headers: { 'content-type': 'image/png' } })
    expect(spaceThumbnailGetRoute(bridge, 'ball').body).toEqual(Buffer.from(pyGetBall!.body, 'base64'))
    expect(spaceThumbnailGetRoute(bridge, 'nope')).toEqual({ status: pyMissing!.status, body: pyMissing!.body })
    expect(spaceThumbnailGetRoute(bridge, '../x')).toEqual({ status: pyBad!.status, body: pyBad!.body })
    expect(await spaceThumbnailSaveRoute(bridge, 'e', bytes(Buffer.alloc(0)))).toEqual({ status: pyEmpty!.status, body: pyEmpty!.body })
    expect(await spaceThumbnailSaveRoute(bridge, 'E!', bytes(png))).toEqual({ status: pyBadSave!.status, body: pyBadSave!.body })
  })

  it('no folders yet: both list nothing', () => {
    const [d, t] = python([{ handler: '_space_defaults_list' }, { handler: '_space_thumbnails_list' }])
    expect(spaceDefaultsRoute(bridge).body).toEqual(d!.body)
    expect(spaceThumbnailsRoute(bridge).body).toEqual(t!.body)
  })
})

describe('font_subset', () => {
  const ttf = path.join(FONTS, 'Aspekta', 'Aspekta-400.ttf')
  const otf = path.join(FONTS, 'Absans', 'Absans-Regular.otf')
  const hasFonts = fs.existsSync(ttf) && fs.existsSync(otf)

  it.skipIf(!hasFonts)('same shape; both are cut and hold every requested character (TTF and CFF/OTF)', async () => {
    const text = 'Wave «ç» 42 — é'
    for (const file of [ttf, otf]) {
      const b64 = fs.readFileSync(file).toString('base64')
      const [py] = python([{ handler: '_font_subset_route', body: JSON.stringify({ font: b64, text }) }])
      const native = await fontSubsetRoute({ font: b64, text }) as { status: number, body: any }
      expect(py!.status).toBe(200)
      expect(native.status).toBe(200)
      expect(Object.keys(native.body)).toEqual(Object.keys(py!.body))
      expect(native.body.before).toBe(py!.body.before)
      expect(py!.body.after).toBeLessThan(py!.body.before)
      expect(native.body.after, 'the native answer is cut').toBeLessThan(native.body.before)
      for (const out of [native.body.font, py!.body.font]) {
        const font = fontkit.create(Buffer.from(out, 'base64')) as any
        for (const ch of new Set([...text, ...Array.from({ length: 0x7F - 0x20 }, (_, i) => String.fromCodePoint(0x20 + i))])) {
          const cp = ch.codePointAt(0)!
          if (!(fontkit.create(fs.readFileSync(file)) as any).hasGlyphForCodePoint(cp)) continue
          expect(font.hasGlyphForCodePoint(cp), `${path.basename(file)} U+${cp.toString(16)}`).toBe(true)
        }
      }
    }
  })

  it('the same refusals, word for word where the Python\'s words are its own', async () => {
    const bodies: unknown[] = [
      {}, { font: '' }, { font: 5 }, { font: null, text: 'x' },
      { font: 'abc' }, { font: 'ab!c' }, { font: 'YW Jj' }, { font: 'YWJj=' }, { font: 'YWJj====' }, { font: 'é' },
      { font: '====' }, { font: 'YQ=a' }, { font: 'YWJjZ' }, { font: 'YWJjZA' }, { font: 'YWJjZA=' },
      [1, 2], 'str',
    ]
    const py = python(bodies.map(b => ({ handler: '_font_subset_route', body: JSON.stringify(b) })))
    for (const [i, b] of bodies.entries()) {
      let native: { status: number, body: unknown }
      try { native = await fontSubsetRoute(b) }
      catch { native = { status: 500, body: 'raised' } }
      expect(native.status, JSON.stringify(b)).toBe(py[i]!.status)
      if (native.status === 400) expect(native.body, JSON.stringify(b)).toEqual(py[i]!.body)
    }
  })

  it('bytes that are not a font: 400 on both sides (the parser\'s message differs)', async () => {
    const b64 = Buffer.from('not a font at all, just text').toString('base64')
    const [py] = python([{ handler: '_font_subset_route', body: JSON.stringify({ font: b64 }) }])
    const native = await fontSubsetRoute({ font: b64 })
    expect(py!.status).toBe(400)
    expect(native.status).toBe(400)
  })
})

describe('LoRA dataset captions and clearing', () => {
  it('save_captions writes the same sidecars and answers the same', () => {
    fs.mkdirSync(path.join(input, 'lora', 'set'), { recursive: true })
    const body = {
      folder: 'lora/set',
      captions: { 'one.png': 'a cat', 'dir/two.jpg': 'ünïcode\nline', '.hidden': 'h', 'noext': 'n', 'x/': 'skipped', 'bad.png': 3 },
    }
    const [py] = python([{ handler: '_save_captions', body: JSON.stringify(body) }])
    const pyFiles = Object.fromEntries(fs.readdirSync(path.join(input, 'lora', 'set')).map(f => [f, fs.readFileSync(path.join(input, 'lora', 'set', f), 'utf8')]))
    fs.rmSync(path.join(input, 'lora', 'set'), { recursive: true })
    fs.mkdirSync(path.join(input, 'lora', 'set'))
    const native = saveCaptionsRoute(input, body)
    const nativeFiles = Object.fromEntries(fs.readdirSync(path.join(input, 'lora', 'set')).map(f => [f, fs.readFileSync(path.join(input, 'lora', 'set', f), 'utf8')]))
    expect(native).toEqual({ status: py!.status, body: py!.body })
    expect(nativeFiles).toEqual(pyFiles)
    expect(Object.keys(nativeFiles).sort()).toEqual(['.hidden.txt', 'noext.txt', 'one.txt', 'two.txt'])
  })

  it('the same refusals for bad payloads and missing folders', () => {
    const bodies: unknown[] = [
      { folder: 5 }, { folder: 'x', captions: [1] }, { folder: 'missing', captions: {} }, { captions: { 'a.png': 't' } },
      { folder: '/abs/elsewhere' }, { folder: '', captions: [] },
    ]
    const py = python(bodies.map(b => ({ handler: '_save_captions', body: JSON.stringify(b) })))
    for (const [i, b] of bodies.entries()) {
      expect(saveCaptionsRoute(input, b), JSON.stringify(b)).toEqual({ status: py[i]!.status, body: py[i]!.body })
    }
    const [notDict] = python([{ handler: '_save_captions', body: '[1]' }])
    expect(notDict!.status).toBe(500)
    expect(() => saveCaptionsRoute(input, [1])).toThrow()
  })

  it('clear_dataset removes the same folder; refuses the same bad payloads', () => {
    for (const run of ['py', 'native'] as const) {
      fs.mkdirSync(path.join(input, 'lora', 'set', 'deep'), { recursive: true })
      fs.writeFileSync(path.join(input, 'lora', 'set', 'deep', 'a.png'), 'x')
      fs.writeFileSync(path.join(input, 'keep.png'), 'x')
      const r = run === 'py'
        ? (([p]) => ({ status: p!.status, body: p!.body }))(python([{ handler: '_clear_dataset', body: JSON.stringify({ folder: 'lora/set' }) }]))
        : clearDatasetRoute(input, { folder: 'lora/set' })
      expect(r, run).toEqual({ status: 200, body: { ok: true } })
      expect(fs.existsSync(path.join(input, 'lora', 'set')), run).toBe(false)
      expect(fs.existsSync(path.join(input, 'keep.png')), run).toBe(true)
    }
    const bodies: unknown[] = [{}, { folder: '' }, { folder: 7 }, { folder: 'never-there' }]
    const py = python(bodies.map(b => ({ handler: '_clear_dataset', body: JSON.stringify(b) })))
    for (const [i, b] of bodies.entries()) {
      expect(clearDatasetRoute(input, b), JSON.stringify(b)).toEqual({ status: py[i]!.status, body: py[i]!.body })
    }
  })

  it('DIVERGENCE (a Python hole, closed): a folder outside input/, or input/ itself, is refused natively', () => {
    fs.mkdirSync(path.join(root, 'output'))
    fs.writeFileSync(path.join(root, 'output', 'precious.png'), 'x')
    fs.writeFileSync(path.join(input, 'precious.png'), 'x')
    // The Python's commonpath check does not resolve `..`, so it accepts these —
    // proven here on a sacrificial copy, never on the real folders.
    const [pyEscape] = python([{ handler: '_save_captions', body: JSON.stringify({ folder: '../output', captions: { 'p.png': 'leak' } }) }])
    expect(pyEscape).toMatchObject({ status: 200, body: { written: 1 } })
    expect(fs.existsSync(path.join(root, 'output', 'p.txt'))).toBe(true)

    expect(saveCaptionsRoute(input, { folder: '../output', captions: { 'q.png': 'leak' } }))
      .toEqual({ status: 400, body: { error: 'folder escapes input directory' } })
    expect(saveCaptionsRoute(input, { folder: 'a/../../output', captions: { 'q.png': 'leak' } }).status).toBe(400)
    expect(fs.existsSync(path.join(root, 'output', 'q.txt'))).toBe(false)
    for (const folder of ['../output', '.', '/', 'a/..']) {
      expect(clearDatasetRoute(input, { folder }), folder).toEqual({ status: 400, body: { error: 'folder escapes input directory' } })
    }
    expect(fs.existsSync(path.join(root, 'output', 'precious.png'))).toBe(true)
    expect(fs.existsSync(path.join(input, 'precious.png'))).toBe(true)
    // Writing captions at the top of input/ stays allowed, as in the Python.
    expect(saveCaptionsRoute(input, { folder: '/', captions: { 'top.png': 't' } })).toEqual({ status: 200, body: { written: 1 } })
  })
})

describe('motion/cleanup_frames', () => {
  it('deletes exactly the same files and counts the same', () => {
    const names = [
      'slate_1_0001.png', 'slate_22_0002.png', 'slate_3_0003.png', 'slate_4_12345.png', 'slate_5_0001.jpg',
      'slate_٣_٠٠٠١.png', 'slate_9_0009.png\n', 'other.png', 'slate_7_0007.png',
    ]
    const setup = () => {
      fs.rmSync(input, { recursive: true, force: true })
      fs.mkdirSync(path.join(input, 'sub'), { recursive: true })
      for (const n of names) fs.writeFileSync(path.join(input, n), 'x')
      fs.writeFileSync(path.join(input, 'sub', 'slate_8_0008.png'), 'x')
      fs.mkdirSync(path.join(input, 'slate_6_0006.png'))
    }
    const body = {
      delete: [...names, 'sub/slate_8_0008.png', 'slate_6_0006.png', 'slate_1_9999.png', 7, null, 'slate_7_0007.png'],
      keep: ['elsewhere/slate_7_0007.png', 3],
    }
    const listing = () => fs.readdirSync(input).sort()
    setup()
    const [py] = python([{ handler: '_cleanup_motion_frames', body: JSON.stringify(body) }])
    const pyLeft = listing()
    setup()
    const native = cleanupFramesRoute(input, body)
    expect(native).toEqual({ status: py!.status, body: py!.body })
    expect(listing()).toEqual(pyLeft)
    expect(pyLeft).not.toContain('slate_1_0001.png')
    expect(pyLeft).not.toContain('slate_٣_٠٠٠١.png')
    expect(pyLeft).toContain('slate_7_0007.png')
  })

  it('the same refusals', () => {
    const bodies: unknown[] = [{}, { delete: 'x' }, { delete: [], keep: 'x' }, { delete: [], keep: null }, { delete: ['slate_1_0001.png'], keep: [] }]
    const py = python(bodies.map(b => ({ handler: '_cleanup_motion_frames', body: JSON.stringify(b) })))
    for (const [i, b] of bodies.entries()) expect(cleanupFramesRoute(input, b), JSON.stringify(b)).toEqual({ status: py[i]!.status, body: py[i]!.body })
  })
})
