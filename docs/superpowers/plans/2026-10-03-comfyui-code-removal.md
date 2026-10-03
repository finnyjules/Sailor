# Step 4: Remove ComfyUI's code from Sailor

> **For agentic workers:** use superpowers:subagent-driven-development. Ledger: `.superpowers/sdd/2026-09-26-engine-free-step3/progress.md`. The tasks are named C1–C9.

**Goal:** Sailor contains no ComfyUI code, no Python runtime and no local engine path. Every node runs on Sailor's runner or is retired with plain words. Behaviour is the same on the Mac and hosted.

**Why:** USER, 2026-10-03: "This is going to be an online product so I don't have a use for local generation."

**State at the start:**
- Step 3 is complete (divorce check passed, `docs/STATE.md` f5304ba8f).
- The local engine is still reachable, explicitly and by name, for:
  - decision-4 stock classes (`shared/runner/localOnly.ts`, 445 classes) and custom nodes;
  - the `NEEDS_LOCAL_ENGINE` list;
  - YouTube voice capture, which uses the repo `.venv`.
- On disk: `models/` (19 GB), `.venv` (2.1 GB) and ComfyUI's Python tree at the repo root.

## Global constraints
- The never-relaxed rules of step 3 still bind:
  - money rules;
  - hosted safety (ownership, caps, allow-lists, names before disk);
  - Stop leaves nothing running;
  - every refusal comes before the hold.
- Work in the main checkout. Other sessions share it: use private-index commits and task-only patches for dirty files.
- **Only git-tracked code is deleted by these tasks.** Anything outside git is deleted only with the user's go, item by item, at the end (C9): `models/`, `.venv`, `comfyui.log`, `__pycache__`, `temp/` contents.
- Keep the user's data: `user/` (projects), `input/`, `output/`, `Assets/`, `frontend/.data`.
- UI copy: sentence case, plain words, no identifiers.

## Tasks

### C1: Sailor finds its folders without ComfyUI
Today Sailor finds its data root locally by walking up to a folder that holds both `main.py` and `input/`; hosted uses `SAILOR_ENGINE_ROOT=/app`. Make the root explicit everywhere:
- `SAILOR_DATA_ROOT`, defaulting to the repo root, found by a marker that isn't Python (e.g. the `frontend/` sibling plus `user/`);
- the same folders as today.

Rename `SAILOR_ENGINE_ROOT` and keep the old name as an alias.

Test: the folders resolve with no `main.py` present.

### C2: Timeline data leaves `custom_nodes/`
Move `custom_nodes/sailor_bridge/` (Timeline scene defaults, thumbnails) into the frontend's own data or public assets. Update the readers, keep every path old projects use readable, and test it.

### C3: YouTube voice capture without the repo `.venv`
Use a standalone `yt-dlp` binary on the Mac (fetched like the media tools, or the user's PATH). Hosted keeps its plain refusal, unless the image can ship `yt-dlp` safely (decide; YouTube terms apply). Test it.

### C4: Retire the dead nodes and port the cheap ones
- **Retire:**
  - RenderType (Font Playground) and KineticType, which is migrated to Vector Type on open;
  - the 7 hidden per-model Replicate nodes (`DEPRECATED_NODES`).

  A saved project holding one shows a plain "This node was retired; use X" card and never fails to load.
- **Port:** Preview video, which is a temporary Save video.
- **Text card showing a LoRA log:** port it if cheap, else retire it with words.
- **Film a shot, the models the runner doesn't film:** port them, or refuse plainly by model.
- **Shader effect fed by a picture made in the same run:** refuse plainly ("Save the picture first, then use it here"), unless a mid-run bake is cheap.

### C5: The local engine path goes
Remove the explicit local route: R10.2's `toEngine` local branch, the main `/ws` socket, `/prompt`/`/queue`/`/interrupt`/`/history`-from-engine proxies, `/gate/resume`, `useDirectExecution`'s engine queue, `engineHealth` and the engine status UI. Stock classes and custom nodes then refuse plainly everywhere ("Sailor doesn't run this node"), and the node search never offers them, locally or hosted. The guards become "nothing names :8188 / /prompt" across the whole app.

### C6: The node catalogue is Sailor's own
`objectInfo.baseline.json.gz` and `/object_info` stop listing classes Sailor doesn't run, except retired classes that old projects need in order to render a card. The catalogue becomes Sailor's own data file, with no live engine read. Blueprints keep only the ones whose classes Sailor runs; drop the rest.

### C7: Python leaves the repo
Delete ComfyUI's tracked Python tree and config:
- `comfy*`, `app/`, `api_server/`, `middleware/`, `utils/`, `alembic*`, `custom_nodes/`, `script_examples/`;
- the root `*.py`, `requirements*.txt`, `pyproject.toml`, `pytest.ini`, `tests/` and `tests-unit/` (the Python ones);
- `QUANTIZATION.md`, `extra_model_paths.yaml.example`, `new_updater.py` and so on.

Check every reference first:
- Frontend specs that use Python as an oracle (e.g. `native-small-routes-python-oracle.py`, parity fixtures) keep their frozen fixtures but never run Python.
- `scripts/` keeps only Node or shell tools.
- `.dockerignore` and `Dockerfile` are simplified.

Test: a guard that the repo holds no `.py` outside an allow-list (expected: none), and the full unit suite green.

### C8: Docs, dev scripts, CLAUDE.md
- Update `CLAUDE.md`: no ComfyUI to start, one dev server.
- Update `dev.sh`, README, `docs/STATE.md` and memory.

### C9: Final check, then the user's go to delete untracked files
1. Run the app from a clean HEAD worktree with no Python on PATH: open the saved projects, run free graphs, and check that a retired-node project loads.
2. Run the full suite and the typecheck.
3. Ask the user, item by item, to delete:
   - `models/` (19 GB)
   - `.venv` (2.1 GB)
   - `__pycache__`
   - `comfyui.log`
   - `temp/` contents
   - the ComfyUI frontend package cache
