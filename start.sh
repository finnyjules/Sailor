#!/usr/bin/env bash
set -euo pipefail

# Runtime dirs live on the Fly volume mounted at /data so generated outputs,
# uploads, and user settings/workflows persist across deploys. (A local smoke
# run of the image has no volume: this then makes /data on the container's disk.)
mkdir -p /data/output /data/input /data/temp /data/user

# Persist the user's library (per-user characters, LoRAs, voices + the
# training-jobs ledger) on the Fly volume. The container's own disk is
# EPHEMERAL — every redeploy ships a fresh image, so without this every
# user-trained LoRA, cloned voice, and cast character written under
# /app/library/ would vanish on deploy. Only runs when the volume is mounted
# (/data present); local/dev boxes have no /data and keep the repo's library/
# exactly as-is. Must run BEFORE the server starts, since it reads library/
# (frontend/server/utils/library.ts).
if [ -d /data ]; then
  mkdir -p /data/library
  # C6b — the library used to live in ComfyUI's model folder, /data/models/.
  # Move each piece once, on the same volume: mv to a new name is a rename,
  # nothing is copied, and a piece already in /data/library is never touched.
  for d in characters loras voices .training-jobs.json .training-jobs.json.bak; do
    if [ -e "/data/models/$d" ] && [ ! -e "/data/library/$d" ]; then
      mv "/data/models/$d" "/data/library/$d"
    fi
  done
  mkdir -p /data/library/characters /data/library/loras /data/library/voices /app/library
  for d in characters loras voices; do
    # First boot: seed the volume with any curated content baked into the image
    # (operator-seeded LoRAs/characters ship read-only for everyone), then hand
    # the repo path to the volume via a symlink so all future writes land on
    # /data. On later boots /app/library/$d is already a symlink, so we skip the
    # seed and just re-point (ln -sfn is idempotent).
    # Gated on the copy actually succeeding: under `set -euo pipefail`, a
    # bare `|| true` would swallow a genuine mid-copy failure and the
    # unconditional rm that followed would still destroy the baked source —
    # symlinking a half-populated (or empty) volume dir and losing the
    # curated content for good. If the copy fails, leave the baked dir in
    # place unsymlinked rather than risk that.
    if [ -d "/app/library/$d" ] && [ ! -L "/app/library/$d" ]; then
      if cp -an "/app/library/$d/." "/data/library/$d/"; then
        rm -rf "/app/library/$d"
        ln -sfn "/data/library/$d" "/app/library/$d"
      else
        echo "[start] WARN: seed copy failed for $d, leaving baked dir in place" >&2
      fi
    else
      ln -sfn "/data/library/$d" "/app/library/$d"
    fi
  done
  # The training-jobs ledger is a single file — persist it the same way,
  # same success-gated seed as above.
  if [ -f /app/library/.training-jobs.json ] && [ ! -L /app/library/.training-jobs.json ]; then
    if cp -an /app/library/.training-jobs.json /data/library/.training-jobs.json; then
      rm -f /app/library/.training-jobs.json
      touch /data/library/.training-jobs.json
      ln -sfn /data/library/.training-jobs.json /app/library/.training-jobs.json
    else
      echo "[start] WARN: seed copy failed for .training-jobs.json, leaving baked file in place" >&2
    fi
  else
    touch /data/library/.training-jobs.json
    ln -sfn /data/library/.training-jobs.json /app/library/.training-jobs.json
  fi

  # I2 — input/, output/, user/ and temp/ live on the volume too. Sailor reads
  # and writes them under its data root, SAILOR_ENGINE_ROOT=/app (Dockerfile):
  # uploads, run results, projects, the spend log and /view?type=temp. Without
  # these links they would sit on the container's ephemeral disk and vanish on
  # redeploy. Same seed-then-symlink, copy-gated discipline as library/ above
  # (defensive: .dockerignore keeps these out of the image, so on a fresh
  # container there's nothing to seed and we just create the symlink; the gated
  # seed covers the case where a real dir already exists).
  for d in input output user temp; do
    if [ -d "/app/$d" ] && [ ! -L "/app/$d" ]; then
      if cp -an "/app/$d/." "/data/$d/"; then
        rm -rf "/app/$d"
        ln -sfn "/data/$d" "/app/$d"
      else
        echo "[start] WARN: seed copy failed for $d, leaving baked dir in place" >&2
      fi
    else
      ln -sfn "/data/$d" "/app/$d"
    fi
  done

  # I3 — the flat JSON/asset stores (brand kits, moodboards, templates, template
  # fonts, .data secrets) relocate under SAILOR_DATA_DIR when it's set (see
  # fly.toml [env] + dataDir.ts storeDir). storeDir() mkdir's each subdir on
  # first use, but pre-create the root so a fresh volume is unambiguous.
  mkdir -p /data/sailor
fi

# The Nuxt (Nitro) server on :3000, the only process (step 3, R10.10: the image
# carries no ComfyUI and no Python). cwd is /app/frontend, the folder the
# server's own files are read from (the data root is SAILOR_DATA_ROOT=/app,
# Dockerfile). exec hands it PID 1's
# signals; if it exits, the container stops and Fly restarts it.
cd /app/frontend
exec node .output/server/index.mjs
