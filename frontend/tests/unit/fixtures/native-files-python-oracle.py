"""
Parity oracle for tests/unit/native-files-parity.unit.spec.ts.

Runs the REAL /upload/image, /upload/mask and /view handlers from server.py —
their source is lifted out with `ast` (they are nested inside
PromptServer.__init__, so they can't be imported) together with
folder_paths.annotated_filepath / get_directory_by_type, and served by a real
aiohttp app over a temp engine root.

stdin:  {"root": "<engine root>", "calls": [{"method": "POST", "path": "/upload/image",
         "headers": {...}, "body": "<base64>"}]}
stdout: [{"status": int, "headers": {lower-case name: value}, "body": "<base64>"}]
"""
import ast
import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import os
import sys
import types
from io import BytesIO

from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer
from PIL import Image
from PIL.PngImagePlugin import PngInfo

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..', '..', '..', '..'))
SERVER = os.path.join(REPO, 'server.py')
FOLDER_PATHS = os.path.join(REPO, 'folder_paths.py')

SERVER_FUNCS = {'get_dir_by_type', 'compare_image_hash', 'image_upload', 'upload_image', 'upload_mask', 'view_image'}
FOLDER_FUNCS = {'annotated_filepath', 'get_directory_by_type'}


def lift(source: str, wanted: set) -> list:
    tree = ast.parse(open(source).read())
    found = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted:
            node.decorator_list = []
            found.append(node)
    missing = wanted - {n.name for n in found}
    if missing:
        raise SystemExit(f'not found in {source}: {sorted(missing)}')
    return found


def namespace(root: str) -> dict:
    fp = types.SimpleNamespace(
        get_input_directory=lambda: os.path.join(root, 'input'),
        get_output_directory=lambda: os.path.join(root, 'output'),
        get_temp_directory=lambda: os.path.join(root, 'temp'),
    )
    fp_mod = ast.Module(body=lift(FOLDER_PATHS, FOLDER_FUNCS), type_ignores=[])
    ast.fix_missing_locations(fp_mod)
    fp_ns = dict(vars(fp))
    exec(compile(fp_mod, FOLDER_PATHS, 'exec'), fp_ns)
    fp.annotated_filepath = fp_ns['annotated_filepath']
    fp.get_directory_by_type = fp_ns['get_directory_by_type']

    mod = ast.Module(body=lift(SERVER, SERVER_FUNCS), type_ignores=[])
    ast.fix_missing_locations(mod)
    ns = {
        'os': os, 'json': json, 'web': web, 'Image': Image, 'PngInfo': PngInfo, 'BytesIO': BytesIO,
        'mimetypes': mimetypes, 'logging': logging, 'folder_paths': fp,
        'args': types.SimpleNamespace(enable_assets=False),
        'node_helpers': types.SimpleNamespace(hasher=lambda: hashlib.sha256),
        'self': types.SimpleNamespace(user_manager=None),
        'resolve_hash_to_path': lambda *a, **k: None,
        'register_file_in_place': None,
    }
    exec(compile(mod, SERVER, 'exec'), ns)
    return ns


async def run(spec: dict) -> list:
    ns = namespace(spec['root'])
    app = web.Application(client_max_size=100 * 1024 * 1024)
    app.router.add_post('/upload/image', ns['upload_image'])
    app.router.add_post('/upload/mask', ns['upload_mask'])
    app.router.add_get('/view', ns['view_image'])
    server = TestServer(app)
    await server.start_server()
    out = []
    try:
        async with ClientSession() as session:
            for call in spec['calls']:
                body = base64.b64decode(call.get('body') or '')
                async with session.request(call['method'], server.make_url(call['path']),
                                           headers=call.get('headers') or {}, data=body or None) as res:
                    raw = await res.read()
                    out.append({'status': res.status,
                                'headers': {k.lower(): v for k, v in res.headers.items()},
                                'body': base64.b64encode(raw).decode()})
    finally:
        await server.close()
    return out


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    spec = json.loads(sys.stdin.read())
    print(json.dumps(asyncio.run(run(spec))))
