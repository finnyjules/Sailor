"""
Parity oracle for tests/unit/native-media-parity.unit.spec.ts.

Runs the REAL media-library handlers from comfy_extras/nodes_timeline.py —
their source is lifted out of the module with `ast` (they are nested inside the
PromptServer try-block, so they can't be imported) and executed against a
temp engine root, with the real aiohttp `web` and a stub `folder_paths`.

stdin:  {"root": "<engine root>", "calls": [{"handler": "_x_route", "path": "/sailor/x?a=b",
         "match_info": {...}, "body": <json or null>}]}
stdout: [{"status": int, "content_type": str, "body": <parsed json | base64 bytes>}]
"""
import ast
import asyncio
import base64
import json
import os
import sys
import types
import uuid

from aiohttp import web
from PIL import Image as PILImage
from yarl import URL

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.normpath(os.path.join(HERE, '..', '..', '..', '..', 'comfy_extras', 'nodes_timeline.py'))

WANTED_FUNCS = {
    '_output_listing_route', '_input_listing_route', '_safe_resolve',
    '_input_file_delete_route', '_output_file_delete_route',
    '_assets_file', '_load_assets', '_save_assets', '_probe_media',
    '_assets_list_route', '_asset_import_route', '_asset_delete_route',
    '_thumb_cache_dir', '_thumb_height_px', '_gen_thumbnails',
    '_input_thumbnail_route', '_asset_thumbs_route',
}


def lift(root_dir: str) -> dict:
    tree = ast.parse(open(SOURCE).read())
    body = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in WANTED_FUNCS:
            node.decorator_list = []
            body.append(node)
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == '_MEDIA_EXTS' for t in node.targets):
            body.insert(0, node)
    found = {n.name for n in body if hasattr(n, 'name')}
    missing = WANTED_FUNCS - found
    if missing:
        raise SystemExit(f'handlers not found in nodes_timeline.py: {sorted(missing)}')
    module = ast.Module(body=body, type_ignores=[])
    ast.fix_missing_locations(module)
    folder_paths = types.SimpleNamespace(
        get_input_directory=lambda: os.path.join(root_dir, 'input'),
        get_output_directory=lambda: os.path.join(root_dir, 'output'),
        get_user_directory=lambda: os.path.join(root_dir, 'user'),
    )
    ns = {'os': os, 'json': json, 'uuid': uuid, 'web': web, 'asyncio': asyncio,
          'PILImage': PILImage, 'folder_paths': folder_paths}
    exec(compile(module, SOURCE, 'exec'), ns)
    return ns


class FakeRequest:
    def __init__(self, path: str, match_info: dict, body):
        self.query = URL('http://x' + path).query
        self.match_info = match_info or {}
        self._body = body

    async def json(self):
        if self._body is None:
            raise ValueError('Expecting value: line 1 column 1 (char 0)')
        return json.loads(self._body)


async def run(spec: dict) -> list:
    ns = lift(spec['root'])
    out = []
    for call in spec['calls']:
        req = FakeRequest(call['path'], call.get('match_info'), call.get('body'))
        res = await ns[call['handler']](req)
        raw = res.body if isinstance(res.body, (bytes, bytearray)) else (res.body._value if hasattr(res.body, '_value') else b'')
        ct = res.content_type
        if ct == 'application/json':
            body = json.loads(raw.decode('utf-8'))
        else:
            body = base64.b64encode(bytes(raw or b'')).decode()
        out.append({'status': res.status, 'content_type': ct, 'body': body,
                    'cache_control': res.headers.get('Cache-Control')})
    return out


if __name__ == '__main__':
    spec = json.loads(sys.stdin.read())
    print(json.dumps(asyncio.run(run(spec))))
