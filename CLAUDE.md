# Sailor

## Architecture
- **Frontend**: Nuxt 4 (Vue 3 + TypeScript + Tailwind) at `frontend/`
- **Backend**: ComfyUI Python server at root, runs on `127.0.0.1:8188`
- **Bridge**: `custom_nodes/sailor_bridge/js/bridge.js` — injected into the ComfyUI iframe, communicates with the frontend via `postMessage`
- The canvas runs inside a cross-origin iframe; the frontend wraps it with tabs, toolbar, and panels

## Development
- Frontend: `cd frontend && npm run dev`
- ComfyUI: `cd /Users/julien/Documents/GitHub/Sailor && .venv/bin/python main.py --listen 127.0.0.1 --port 8188`
- Bridge changes require restarting ComfyUI (not hot-reloaded)

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

**Killing a Nuxt server can take ComfyUI with it** (shared parent that reaps on exit). After any
frontend restart, check `127.0.0.1:8188/system_stats` and relaunch ComfyUI if it has gone.

## UI Change Priority
When making UI/UX changes, **Vue (frontend) has priority over LiteGraph (bridge/iframe)**. Make changes in the Vue frontend when possible. LiteGraph/bridge modifications are acceptable as a fallback when Vue can't reach the target (e.g., canvas rendering, context menus inside the iframe).
