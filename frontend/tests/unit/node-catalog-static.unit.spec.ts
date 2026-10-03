/**
 * The shipped node catalogue (server/assets/nodeCatalog.json.gz) holds static
 * options only. Per-user lists (input uploads, LoRAs, cloned voices) are filled
 * at request time (server/native/objectInfo.ts, and for hosted
 * server/utils/engineGate.ts, which keeps only the caller's own), so nothing
 * of any user's may be baked into the file.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { MODEL_INPUT_LISTS, UPLOAD_INPUT_LISTS, findSpec } from '../../server/native/objectInfo'
import { MINIMAX_VOICES } from '#shared/runner/audioGen'

const FILE = path.resolve(__dirname, '../../server/assets/nodeCatalog.json.gz')
const catalog = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString()) as Record<string, any>

function strings(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') out.add(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out)
  return out
}

const all = strings(catalog)

describe('the shipped node catalogue holds no per-user value', () => {
  it('has no cloned-voice id (Replicate\'s R8_ ids)', () => {
    expect([...all].filter(s => /^R8_/.test(s))).toEqual([])
  })

  it('has no model weight or checkpoint file name', () => {
    expect([...all].filter(s => /\.(safetensors|ckpt|pt|pth|pt2|bin|pkl|sft)$/i.test(s))).toEqual([])
  })

  it('has no uploaded media file name', () => {
    expect([...all].filter(s => /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|mov|webm|mkv|wav|mp3|flac|m4a|ogg|glb|gltf|obj|fbx)$/i.test(s))).toEqual([])
  })

  it('has no timestamp-prefixed upload name (1779351890779_pasted-…)', () => {
    expect([...all].filter(s => /^\d{10,}_/.test(s))).toEqual([])
  })

  it('has no name from library/ (LoRAs, characters, voices) or input/ on this machine', () => {
    const root = path.resolve(__dirname, '../../..')
    const names = new Set<string>()
    for (const kind of ['loras', 'characters', 'voices']) {
      let entries: string[] = []
      try { entries = fs.readdirSync(path.join(root, 'library', kind)) } catch { /* not there */ }
      for (const n of entries) { names.add(n); names.add(n.replace(/\.[^.]+$/, '')) }
    }
    try {
      for (const e of fs.readdirSync(path.join(root, 'input'), { withFileTypes: true })) {
        if (e.isFile()) names.add(e.name)
      }
    }
    catch { /* not there */ }
    names.delete('')
    expect([...all].filter(s => names.has(s))).toEqual([])
  })

  it('lists only the preset voices for speech', () => {
    for (const node of ['GenerateSpeechNode', 'MiniMaxSpeechRemoteNode']) {
      expect(catalog[node].input.required.voice_id[1].options).toEqual([...MINIMAX_VOICES])
    }
  })

  it('keeps every file-list combo Sailor refills at request time empty or a placeholder', () => {
    for (const key of [...Object.keys(UPLOAD_INPUT_LISTS), ...Object.keys(MODEL_INPUT_LISTS)]) {
      const spec = findSpec(catalog, key) as any[] | undefined
      if (!spec) continue
      const list: string[] = Array.isArray(spec[0]) ? spec[0] : spec[1].options
      expect(list.filter(s => s !== '' && s !== '[None]' && s !== '(none)' && s !== '(no audio found)'), key).toEqual([])
    }
  })
})
