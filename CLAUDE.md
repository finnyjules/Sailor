# Sailor

## Architecture
- **App**: Nuxt 4 (Vue 3 + TypeScript + Tailwind) at `frontend/`. One server, `127.0.0.1:3002`. There is no ComfyUI, no Python and no `:8188` any more (removed 2026-10)
- **Runner**: Sailor runs its own nodes in `frontend/server/runner`, on the Nuxt server, or on paid providers (fal, Replicate). A node the runner does not take is refused in plain words, naming it
- **Canvas**: the node canvas is the frontend's own Vue Flow canvas (`frontend/app/components/vue-canvas/VueNodeCanvas.vue`). The frontend builds the API prompt itself (`frontend/app/lib/graph/graphToPrompt.ts`) and the runner runs it; events come back through `useRunnerEvents`
- **Node catalogue**: `/object_info` is served from `frontend/server/assets/nodeCatalog.json.gz`. It holds static options only; per-user lists (uploads, LoRAs) are filled at request time
- **Data**: folders under the repo root, found by `SAILOR_DATA_ROOT` (else walked up from `frontend/`): `user/`, `input/`, `output/`, `temp/`, `library/{loras,characters,voices}`, `scenes/`
- Names containing "bridge" in the frontend (`handleBridgeEvent`, the `sailor-bridge` message envelope) are the live internal pipe for run events — legacy names, not dead code

## Development
- `cd frontend && pnpm dev` (port 3002; `./dev.sh` does the same and frees the port first)
- Tests: `cd frontend && pnpm vitest run <path>`

## Working style

**Work directly in the main checkout.** No git worktree and no feature branch unless I ask
for one, or the task genuinely cannot be done in place. This overrides any skill or workflow
that treats "create a worktree" as a standard first step — including `superpowers`'
`using-git-worktrees`. Several sessions often share this checkout at once, so: stage only your
own hunks by exact path, never `git stash` (the stash stack is shared), and leave files you
did not write alone even when they look broken.

Worktrees are expensive here, not free: they accumulate, they hold uncommitted work nobody
dares delete, and as of 2026-09-06 there were 57 of them using 9.3 GB.

**One dev server per checkout.** Before starting a server, check what is already listening
(`lsof -nP -iTCP -sTCP:LISTEN | grep node`) and confirm which checkout each one serves
(`lsof -a -p <pid> -d cwd`). If a server for this checkout already exists:

- healthy → use it;
- broken (a Nuxt 500, or `The service is no longer running` from esbuild) → say so and offer to
  restart it **on its own port**.

Do not start an extra server on a new port to sidestep a broken one — that is how this machine
ended up with four. `:3002` is the conventional port for the main checkout. Nuxt does **not**
fail when a port is taken, it silently picks another, so always grep the log for `Local:` and
confirm the port you actually got.

## UI lives in Vue
All UI/UX is in the Vue frontend. There is no other canvas or iframe to fall back to.
