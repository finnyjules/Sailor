"""
Parity oracle for tests/unit/native-small-routes-parity.unit.spec.ts.

Runs the REAL handlers behind Sailor's small /sailor routes — their source is
lifted out of the Python modules with `ast` (most are nested inside
PromptServer try-blocks, so they can't be imported) and executed against a
temp engine root, with the real aiohttp `web` and a stub `folder_paths`:

  nodes_shader_effects.py  catalog_payload / _get_shader_effects (+ the real
                           comfy_extras._shader_effects loader, CATALOG_DIR
                           pointed at <root>/shader_effects)
  nodes_timeline.py        the space_* handlers (scene dirs under
                           <root>/custom_nodes/sailor_bridge) and _font_subset_route
  _lora_training.py        _save_captions / _clear_dataset (+ _safe_folder)
  nodes_compositor.py      _cleanup_motion_frames (+ _SLATE_FRAME_RE)
  _model_downloads.py      _status_route, with every module's real
                           register_bundle(...) call replayed, and the real
                           folder_names_and_paths table from folder_paths.py

stdin:  {"root": "<engine root>", "calls": [{"handler": "_x", "path": "/sailor/x?a=b",
         "match_info": {...}, "body": "<raw body text>" | null, "body_b64": "<raw bytes>"}
         | {"handler": "__write__", "file": "<path under root>", "text": "..."}]}
Each handler group is lifted only when a call first needs it.
stdout: [{"status": int, "content_type": str, "body": <parsed json | base64 bytes>}]
"""
import ast
import asyncio
import base64
import io
import json
import logging
import os
import re
import shutil
import sys
import types

from aiohttp import web
from yarl import URL

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..', '..', '..', '..'))
EXTRAS = os.path.join(REPO, 'comfy_extras')
sys.path.insert(0, REPO)


def parse(name: str) -> ast.Module:
    return ast.parse(open(os.path.join(EXTRAS, name)).read())


def lift_defs(tree: ast.Module, names: set, source: str) -> list:
    body = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            node.decorator_list = []
            body.append(node)
        elif isinstance(node, ast.Assign) and any(getattr(t, 'id', None) in names for t in node.targets):
            body.insert(0, node)
    found = {getattr(n, 'name', None) or n.targets[0].id for n in body}
    missing = names - found
    if missing:
        raise SystemExit(f'not found in {source}: {sorted(missing)}')
    return body


def run_module(body: list, ns: dict, source: str) -> dict:
    module = ast.Module(body=body, type_ignores=[])
    ast.fix_missing_locations(module)
    exec(compile(module, source, 'exec'), ns)
    return ns


def folder_names_and_paths(models_dir: str) -> dict:
    """The real table from folder_paths.py (its module-level assignments), under a temp models dir."""
    tree = ast.parse(open(os.path.join(REPO, 'folder_paths.py')).read())
    ns = {'os': os, 'models_dir': models_dir, 'supported_pt_extensions': set(), 'folder_names_and_paths': {}}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Subscript) \
                and getattr(node.targets[0].value, 'id', None) == 'folder_names_and_paths':
            try:  # entries outside models/ (custom_nodes, output, ...) need names this stub lacks
                run_module([node], ns, 'folder_paths.py')
            except NameError:
                pass
    return ns['folder_names_and_paths']


def stub_folder_paths(root: str):
    input_dir = os.path.join(root, 'input')
    models_dir = os.path.join(root, 'models')
    table = folder_names_and_paths(models_dir)
    return types.SimpleNamespace(
        get_input_directory=lambda: input_dir,
        models_dir=models_dir,
        get_folder_paths=lambda name: table[name][0],
    )


def build_shader(root: str) -> dict:
    """The real loader, pointed at <root>/shader_effects."""
    import comfy_extras._shader_effects as se
    se.CATALOG_DIR = os.path.join(root, 'shader_effects')
    se.ASSETS_DIR = os.path.join(se.CATALOG_DIR, 'assets')
    se._catalog = None
    ns = {'os': os, 'web': web, 'load_catalog': se.load_catalog, 'ASSETS_DIR': se.ASSETS_DIR,
          '_PARAM_KEY_ALIASES': se._PARAM_KEY_ALIASES}
    run_module(lift_defs(parse('nodes_shader_effects.py'),
                         {'_PARAM_KEY_TO_MANIFEST', '_param_payload', '_texture_version', 'catalog_payload', '_get_shader_effects'},
                         'nodes_shader_effects.py'), ns, 'nodes_shader_effects.py')
    return {'_get_shader_effects': ns['_get_shader_effects']}


def build_timeline(root: str) -> dict:
    """Space presets + font subset; the scene dirs under <root>/custom_nodes/sailor_bridge."""
    ns = {'os': os, 're': re, 'json': json, 'io': io, 'base64': base64, 'web': web, 'asyncio': asyncio}
    run_module(lift_defs(parse('nodes_timeline.py'), {
        '_valid_effect_id', '_BASIC_LATIN_CODEPOINTS', 'MAX_FONT_SUBSET_BYTES', 'subset_font_bytes',
        '_space_defaults_list', '_space_default_save', '_space_thumbnails_list', '_space_thumbnail_save',
        '_space_thumbnail_get', '_font_subset_route',
    }, 'nodes_timeline.py'), ns, 'nodes_timeline.py')
    bridge = os.path.join(root, 'custom_nodes', 'sailor_bridge')
    ns['_scene_defaults_dir'] = lambda: os.path.join(bridge, 'scene_defaults')
    ns['_scene_thumbnails_dir'] = lambda: os.path.join(bridge, 'scene_thumbnails')
    return {h: ns[h] for h in ('_space_defaults_list', '_space_default_save', '_space_thumbnails_list',
                               '_space_thumbnail_save', '_space_thumbnail_get', '_font_subset_route')}


def build_lora(root: str) -> dict:
    ns = {'os': os, 'shutil': shutil, 'web': web, 'folder_paths': stub_folder_paths(root)}
    run_module(lift_defs(parse('_lora_training.py'), {'_safe_folder', '_save_captions', '_clear_dataset'},
                         '_lora_training.py'), ns, '_lora_training.py')
    return {'_save_captions': ns['_save_captions'], '_clear_dataset': ns['_clear_dataset']}


def build_compositor(root: str) -> dict:
    ns = {'os': os, '_re': re, 'web': web, 'folder_paths': stub_folder_paths(root), 'logging': logging}
    run_module(lift_defs(parse('nodes_compositor.py'), {'_SLATE_FRAME_RE', '_cleanup_motion_frames'},
                         'nodes_compositor.py'), ns, 'nodes_compositor.py')
    return {'_cleanup_motion_frames': ns['_cleanup_motion_frames']}


def build_models(root: str) -> dict:
    """The real registry: every module's register_bundle(...) call replayed."""
    import comfy_extras._model_downloads as md
    folder_paths = stub_folder_paths(root)
    md._REGISTRY.clear()
    for fname in sorted(os.listdir(EXTRAS)):
        if not fname.endswith('.py'):
            continue
        if fname == '_model_downloads.py' or 'register_bundle(' not in open(os.path.join(EXTRAS, fname)).read():
            continue
        tree = parse(fname)
        ns = {'os': os, 'folder_paths': folder_paths, 'ModelBundle': md.ModelBundle, 'ModelFile': md.ModelFile,
              'register_bundle': md.register_bundle, 'loader_cache': md.loader_cache}
        top = []
        for node in tree.body:  # _lora_training.py registers inside a top-level try block
            top.extend(node.body if isinstance(node, ast.Try) else [node])
        defs = [n for n in top if isinstance(n, (ast.FunctionDef, ast.Assign, ast.AnnAssign))]
        regs = [n for n in ast.walk(tree) if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)
                and getattr(n.value.func, 'id', None) == 'register_bundle']
        # Definitions and path constants first, each on its own (a constant that
        # needs torch/numpy simply stays undefined), then the registrations.
        for node in defs:
            try:
                run_module([node], ns, fname)
            except Exception:
                pass
        for node in regs:
            run_module([node], ns, fname)
    ns = {'web': web, 'bundle_status': md.bundle_status}
    run_module(lift_defs(parse('_model_downloads.py'), {'_status_route'}, '_model_downloads.py'), ns, '_model_downloads.py')
    return {'_status_route': ns['_status_route'], '__registry__': sorted(md._REGISTRY.keys())}


GROUPS = {
    '_get_shader_effects': build_shader,
    '_space_defaults_list': build_timeline, '_space_default_save': build_timeline, '_space_thumbnails_list': build_timeline,
    '_space_thumbnail_save': build_timeline, '_space_thumbnail_get': build_timeline, '_font_subset_route': build_timeline,
    '_save_captions': build_lora, '_clear_dataset': build_lora,
    '_cleanup_motion_frames': build_compositor,
    '_status_route': build_models, '__registry__': build_models,
}


class FakeRequest:
    def __init__(self, path: str, match_info: dict, body, body_b64):
        self.query = URL('http://x' + path).query
        self.match_info = match_info or {}
        self._raw = base64.b64decode(body_b64) if body_b64 is not None else (body.encode() if body is not None else b'')

    async def json(self):
        return json.loads(self._raw.decode('utf-8'))

    async def read(self):
        return self._raw


async def run(spec: dict) -> list:
    handlers: dict = {}
    out = []
    for call in spec['calls']:
        if call['handler'] == '__write__':  # set up a file between calls (e.g. the next manifest)
            with open(os.path.join(spec['root'], call['file']), 'w', encoding='utf-8') as f:
                f.write(call['text'])
            out.append(None)
            continue
        if call['handler'] not in handlers:
            handlers.update(GROUPS[call['handler']](spec['root']))
        if call['handler'] == '__registry__':
            out.append({'status': 0, 'content_type': '', 'body': handlers['__registry__']})
            continue
        req = FakeRequest(call['path'], call.get('match_info'), call.get('body'), call.get('body_b64'))
        try:
            res = await handlers[call['handler']](req)
        except Exception as e:  # aiohttp turns an unhandled exception into its 500 page
            out.append({'status': 500, 'content_type': 'text/plain', 'body': f'{type(e).__name__}: {e}'})
            continue
        raw = res.body if isinstance(res.body, (bytes, bytearray)) else (res.body._value if hasattr(res.body, '_value') else b'')
        ct = res.content_type
        body = json.loads(raw.decode('utf-8')) if ct == 'application/json' else base64.b64encode(bytes(raw or b'')).decode()
        out.append({'status': res.status, 'content_type': ct, 'body': body})
    return out


if __name__ == '__main__':
    spec = json.loads(sys.stdin.read())
    print(json.dumps(asyncio.run(run(spec))))
