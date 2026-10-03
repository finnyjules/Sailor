/**
 * Step 4, C7 — Python leaves the repo.
 *
 * ComfyUI's Python tree, its config and every Python script are gone from git:
 * the repo tracks no `.py` file and none of ComfyUI's top-level folders or
 * files. (Untracked leftovers on a local disk, such as `.venv` or
 * `__pycache__`, are the user's to delete, item by item, in C9.)
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(__dirname, '..', '..', '..')
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  .split('\0').filter(Boolean)

/** No Python file is allowed anywhere; the list is empty on purpose. */
const PYTHON_ALLOWED: readonly string[] = []

const REMOVED_DIRS = [
  'comfy', 'comfy_api', 'comfy_api_nodes', 'comfy_config', 'comfy_execution', 'comfy_extras',
  'app', 'api_server', 'middleware', 'utils', 'alembic_db', 'custom_nodes', 'script_examples',
  'blueprints', 'tests', 'tests-unit', '.ci', 'models', 'scripts/bake-body-model',
]
const REMOVED_FILES = [
  'main.py', 'server.py', 'nodes.py', 'execution.py', 'folder_paths.py', 'comfyui_version.py',
  'hook_breaker_ac10a0.py', 'new_updater.py', 'requirements.txt', 'manager_requirements.txt',
  'pyproject.toml', 'pytest.ini', 'alembic.ini', 'QUANTIZATION.md', 'extra_model_paths.yaml.example',
  'CODEOWNERS', 'CONTRIBUTING.md', '.coderabbit.yaml',
]

describe('C7: the repo holds no Python', () => {
  it('git tracks files (the listing itself works)', () => {
    expect(tracked.length).toBeGreaterThan(1000)
    expect(tracked).toContain('frontend/package.json')
  })

  it('no tracked .py file, outside an empty allow-list', () => {
    const py = tracked.filter(f => /\.(py|pyi|pyc|pyw)$/i.test(f) && !PYTHON_ALLOWED.includes(f))
    expect(py).toEqual([])
  })

  it('none of ComfyUI\'s top-level folders or files is tracked', () => {
    for (const d of REMOVED_DIRS) expect(tracked.filter(f => f.startsWith(`${d}/`)), d).toEqual([])
    for (const f of REMOVED_FILES) expect(tracked, f).not.toContain(f)
  })

  it('no Python dependency list or test config is tracked anywhere', () => {
    const configs = tracked.filter(f => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|pytest\.ini|conftest\.py|Pipfile|uv\.lock)$/.test(f))
    expect(configs).toEqual([])
  })
})
