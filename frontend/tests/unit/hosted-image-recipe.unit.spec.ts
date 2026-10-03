/**
 * Step 3, R10.10 — the Fly image without Python.
 *
 * Docker can't run here, so this is a static check of the image recipe: the
 * repo-root Dockerfile, start.sh, .dockerignore and fly.toml. The runtime stage
 * is Node only (no pip, no ComfyUI, no main.py, no :8188); it copies in Sailor's
 * video tools and the depth model; start.sh starts only the Nitro server and
 * keeps the volume links; .dockerignore keeps ComfyUI's Python out while the
 * data files the server reads by path (caption font, Ascii glyphs, the stored
 * node list, blueprints, shader effects, Timeline scene defaults) still ship.
 * A real `docker build` and a smoke run are owed on a machine with Docker.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const dockerfile = read('Dockerfile')
const startSh = read('start.sh')
const dockerignore = read('.dockerignore')
const flyToml = read('fly.toml')

/** Lines that are instructions, not comments. */
const code = (src: string) => src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')

/** The Dockerfile's stages by name: the text from each `FROM … AS name` to the next FROM. */
function stages(src: string): Map<string, { base: string, body: string }> {
  const out = new Map<string, { base: string, body: string }>()
  const lines = code(src).split('\n')
  let cur: { name: string, base: string, body: string[] } | null = null
  const flush = () => { if (cur) out.set(cur.name, { base: cur.base, body: cur.body.join('\n') }) }
  for (const l of lines) {
    const m = /^FROM\s+(\S+)\s+AS\s+(\S+)/i.exec(l.trim())
    if (m) { flush(); cur = { name: m[2]!, base: m[1]!, body: [] }; continue }
    if (/^FROM\s/i.test(l.trim())) throw new Error(`unnamed stage: ${l}`)
    cur?.body.push(l)
  }
  flush()
  return out
}

/**
 * Whether a context path is left out of the build by .dockerignore (Docker's
 * rules: patterns anchored at the context root, `**` any depth, a matching
 * parent folder excludes everything under it, the last matching line wins, `!`
 * re-includes).
 */
function ignored(rel: string): boolean {
  const rules = dockerignore.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const toRe = (p: string) => {
    let re = ''
    for (let i = 0; i < p.length; i++) {
      const c = p[i]!
      if (c === '*' && p[i + 1] === '*') {
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2 }
        else { re += '.*'; i += 1 }
      }
      else if (c === '*') re += '[^/]*'
      else if (c === '?') re += '[^/]'
      else if (c === '[') { const j = p.indexOf(']', i); re += p.slice(i, j + 1); i = j }
      else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
    }
    return new RegExp(`^${re}$`)
  }
  const parts = rel.split('/')
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
  let out = false
  for (const raw of rules) {
    const neg = raw.startsWith('!')
    const pat = (neg ? raw.slice(1) : raw).replace(/^\/+/, '').replace(/\/+$/, '')
    const re = toRe(pat)
    if (neg ? re.test(rel) : candidates.some(c => re.test(c))) out = !neg
  }
  return out
}

describe('the Dockerfile', () => {
  const s = stages(dockerfile)
  const runtime = s.get('runtime')!

  it('has the build, tools, depth-model and runtime stages, the runtime last', () => {
    expect([...s.keys()]).toEqual(['web', 'media-tools', 'depth-model', 'runtime'])
  })

  it('both bases are pinned by digest; the runtime and the build stage are Node 22 on one base', () => {
    const arg = (name: string) => new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile)?.[1]
    expect(arg('PYTHON_BASE')).toMatch(/^python:3\.12-slim@sha256:[0-9a-f]{64}$/)
    expect(arg('NODE_BASE')).toMatch(/^node:22-[a-z]+-slim@sha256:[0-9a-f]{64}$/)
    expect(runtime.base).toBe('${NODE_BASE}')
    expect(s.get('web')!.base).toBe('${NODE_BASE}')
    // Python builds the video tools only (meson, ninja); the depth model stage just downloads.
    expect(s.get('media-tools')!.base).toBe('${PYTHON_BASE}')
  })

  it('the tools base and the runtime base name the same Debian release', () => {
    const release = /^ARG NODE_BASE=node:22-([a-z]+)-slim@/m.exec(dockerfile)?.[1]
    expect(release).toBeTruthy()
    // The Python tag doesn't carry its release, so the pin's comment must state it.
    const pyComment = dockerfile.slice(0, dockerfile.indexOf('ARG PYTHON_BASE='))
    expect(pyComment).toMatch(new RegExp(`Debian ${release}`))
    // And the build proves it: the tools must run on the runtime's glibc.
    expect(runtime.body).toMatch(/RUN \/opt\/media-tools\/bin\/ffmpeg -hide_banner -version/)
  })

  it('the runtime has no Python: no pip, no requirements, no ComfyUI, no torch, opencv or PyAV', () => {
    for (const bad of [/\bpip\b/, /requirements\.txt/, /main\.py/, /\bpython3?\b/i, /PYTHON/, /torch/, /opencv/, /\bav\b/, /comfy/i]) {
      expect(runtime.body, String(bad)).not.toMatch(bad)
    }
    // Nowhere in the file is a pip install or main.py left.
    expect(code(dockerfile)).not.toMatch(/pip install|main\.py|requirements\.txt/)
  })

  it('copies in the video tools and the depth model and points the server at them', () => {
    expect(runtime.body).toMatch(/^COPY --from=media-tools \/opt\/media-tools \/opt\/media-tools$/m)
    expect(runtime.body).toMatch(/^ENV NUXT_MEDIA_TOOLS_DIR=\/opt\/media-tools\/bin$/m)
    expect(runtime.body).toMatch(/^COPY --from=depth-model \/opt\/depth-model \/opt\/depth-model$/m)
    expect(runtime.body).toMatch(/^ENV NUXT_DEPTH_MODEL_DIR=\/opt\/depth-model$/m)
    expect(runtime.body).toMatch(/^COPY --from=web \/build\/frontend\/\.output \/app\/frontend\/\.output$/m)
  })

  it('names the data root, since there is no main.py for the walk to find', () => {
    expect(runtime.body).toMatch(/^ENV SAILOR_ENGINE_ROOT=\/app$/m)
  })

  it('exposes only the server port, never the engine port (review L2)', () => {
    const exposed = [...code(dockerfile).matchAll(/^EXPOSE\s+(.+)$/gm)].flatMap(m => m[1]!.trim().split(/\s+/))
    expect(exposed).toEqual(['3000'])
    expect(code(dockerfile)).not.toMatch(/8188/)
    expect(runtime.body).toMatch(/^CMD \["\/app\/start\.sh"\]$/m)
  })
})

describe('start.sh', () => {
  const body = code(startSh)

  it('starts only the Nitro server: no Python, no ComfyUI, no engine port (review L2)', () => {
    expect(body).not.toMatch(/python|main\.py|8188|--listen|--multi-user|COMFY_PID/i)
    expect(body.trim().split('\n').slice(-2)).toEqual(['cd /app/frontend', 'exec node .output/server/index.mjs'])
    expect(body.match(/\bnode\s/g)).toHaveLength(1)
  })

  it('keeps the volume links for models, data folders and the stores', () => {
    expect(body).toMatch(/mkdir -p \/data\/output \/data\/input \/data\/temp \/data\/user/)
    expect(body).toMatch(/for d in characters loras voices; do/)
    expect(body).toMatch(/ln -sfn "\/data\/models\/\$d" "\/app\/models\/\$d"/)
    expect(body).toMatch(/\.training-jobs\.json/)
    expect(body).toMatch(/for d in input output user temp; do/)
    expect(body).toMatch(/ln -sfn "\/data\/\$d" "\/app\/\$d"/)
    expect(body).toMatch(/mkdir -p \/data\/sailor/)
  })
})

describe('.dockerignore', () => {
  it('keeps ComfyUI\'s Python source and requirements out of the image', () => {
    for (const p of [
      'main.py', 'server.py', 'nodes.py', 'execution.py', 'folder_paths.py', 'requirements.txt', 'pyproject.toml',
      'comfy/model_base.py', 'comfy_extras/nodes_mask.py', 'comfy_api_nodes/nodes_kling.py', 'comfy_execution/graph.py',
      'comfy_api/latest/__init__.py', 'app/user_manager.py', 'api_server/routes/x.py', 'utils/json_util.py',
      'middleware/cache_middleware.py', 'alembic_db/env.py', 'custom_nodes/sailor_bridge/__init__.py', 'scripts/clip_key.py',
      '.venv/bin/python',
    ]) {
      expect(ignored(p), p).toBe(true)
    }
  })

  it('still ships every file the server reads by path', () => {
    for (const p of [
      'start.sh',
      'frontend/server/runner/video/fonts/DejaVuSans-Bold.ttf',
      'frontend/server/runner/effects/asciiGlyphs.bin',
      'frontend/server/native/objectInfo.baseline.json.gz',
      'frontend/app/data/house-styles.json',
      'frontend/server/utils/inputUploads.ts',
      'blueprints/Brightness and Contrast.json',
      'shader_effects/aurora.frag',
      'custom_nodes/sailor_bridge/scene_defaults/a.json',
      'models/loras/x.json',
    ]) {
      expect(ignored(p), p).toBe(false)
    }
    // A LoRA's weights stay out; the frontend is rebuilt inside the image.
    expect(ignored('models/loras/x.safetensors')).toBe(true)
    expect(ignored('frontend/.output/server/index.mjs')).toBe(true)
    expect(ignored('frontend/.media-tools/darwin-arm64/bin/ffmpeg')).toBe(true)
  })

  it('the caption font and the Ascii glyph atlas exist in the repo (R6.8)', () => {
    for (const p of ['frontend/server/runner/video/fonts/DejaVuSans-Bold.ttf', 'frontend/server/runner/effects/asciiGlyphs.bin']) {
      expect(fs.statSync(path.join(ROOT, p)).size, p).toBeGreaterThan(0)
    }
  })
})

describe('fly.toml', () => {
  it('serves only :3000 and keeps the VM size until measured (ruling (l))', () => {
    const body = code(flyToml)
    expect(body).not.toMatch(/8188/)
    expect([...body.matchAll(/internal_port\s*=\s*(\d+)/g)].map(m => m[1])).toEqual(['3000'])
    expect(body).toMatch(/size = "shared-cpu-4x"/)
    expect(body).toMatch(/memory = "8gb"/)
  })
})
