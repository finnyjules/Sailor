# Sailor

Sailor is a studio for making pictures, video, type and motion on one node canvas. Every node runs in Sailor's own runner, on the Nuxt server, or on a paid service (fal, Replicate).

## Run it

```sh
cd frontend
pnpm install
pnpm dev
```

The app opens on http://127.0.0.1:3002. That is the only server: Sailor needs no Python and no ComfyUI.

The video tools (ffmpeg and ffprobe) are built once with `scripts/media-tools/build.sh`; that build borrows a Python 3.10 or later for its build tools, and nothing else does (see `docs/deploy/media-tools.md`).

## Tests

```sh
cd frontend
pnpm vitest run
```

## Deploy

`Dockerfile` builds the image Fly runs (`fly.toml`); `start.sh` starts the server in it.

## Licence

See `LICENSE`.
