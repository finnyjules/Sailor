#!/usr/bin/env bash
set -euo pipefail

# Runtime dirs live on the Fly volume mounted at /data so generated outputs,
# uploads, and user settings/workflows persist across deploys.
mkdir -p /data/output /data/input /data/temp /data/user

# Persist the model stores (per-user characters, LoRAs, voices + the training-
# jobs ledger) on the Fly volume. The container's own disk is EPHEMERAL — every
# redeploy ships a fresh image, so without this every user-trained LoRA, cloned
# voice, and cast character written under /app/models/ would vanish on deploy.
# Only runs when the volume is mounted (/data present); local/dev boxes have no
# /data and keep the repo's models/ dir exactly as-is (byte-identical). Must run
# BEFORE ComfyUI starts, since it also reads models/ (loras, etc.).
if [ -d /data ]; then
  mkdir -p /data/models/characters /data/models/loras /data/models/voices
  for d in characters loras voices; do
    # First boot: seed the volume with any curated content baked into the image
    # (operator-seeded LoRAs/characters ship read-only for everyone), then hand
    # the repo path to the volume via a symlink so all future writes land on
    # /data. On later boots /app/models/$d is already a symlink, so we skip the
    # seed and just re-point (ln -sfn is idempotent).
    # Gated on the copy actually succeeding: under `set -euo pipefail`, a
    # bare `|| true` would swallow a genuine mid-copy failure and the
    # unconditional rm that followed would still destroy the baked source —
    # symlinking a half-populated (or empty) volume dir and losing the
    # curated content for good. If the copy fails, leave the baked dir in
    # place unsymlinked rather than risk that.
    if [ -d "/app/models/$d" ] && [ ! -L "/app/models/$d" ]; then
      if cp -an "/app/models/$d/." "/data/models/$d/"; then
        rm -rf "/app/models/$d"
        ln -sfn "/data/models/$d" "/app/models/$d"
      else
        echo "[start] WARN: seed copy failed for $d, leaving baked dir in place" >&2
      fi
    else
      ln -sfn "/data/models/$d" "/app/models/$d"
    fi
  done
  # The training-jobs ledger is a single file — persist it the same way,
  # same success-gated seed as above.
  if [ -f /app/models/.training-jobs.json ] && [ ! -L /app/models/.training-jobs.json ]; then
    if cp -an /app/models/.training-jobs.json /data/models/.training-jobs.json; then
      rm -f /app/models/.training-jobs.json
      touch /data/models/.training-jobs.json
      ln -sfn /data/models/.training-jobs.json /app/models/.training-jobs.json
    else
      echo "[start] WARN: seed copy failed for .training-jobs.json, leaving baked file in place" >&2
    fi
  else
    touch /data/models/.training-jobs.json
    ln -sfn /data/models/.training-jobs.json /app/models/.training-jobs.json
  fi

  # I2 — the engine's input/ and output/ dirs live on the volume too. ComfyUI is
  # launched below with --input-directory /data/input / --output-directory
  # /data/output, but the Nitro writers resolve them at <repo-root>/{input,output}
  # (path.resolve(cwd,'..',<name>) === /app/{input,output}). Without this symlink
  # the two sides point at DIFFERENT dirs: moodboard/lipsync uploads written by
  # Nitro land in /app/input where the engine never looks (and .dockerignore
  # drops /input, so they're ephemeral), the character heal path can wipe
  # refImages once /app/input appears, and the input-upload disk check can never
  # resolve its engine root. Same seed-then-symlink, copy-gated discipline as
  # models/ above (defensive: .dockerignore keeps these out of the image, so on a
  # fresh container there's nothing to seed and we just create the symlink; the
  # gated seed covers the case where a real dir already exists).
  # user/ joins them for engine-free Phase A: Sailor now reads and writes
  # user/sailor/projects and user/sailor/spend.jsonl itself (server/native), so
  # <repo-root>/user must be the same /data/user the engine is launched with.
  # temp/ likewise: the engine runs with --temp-directory /data/temp and Sailor's
  # native /view?type=temp reads <repo-root>/temp, so the two must be one dir.
  # (.dockerignore drops /temp, so normally this just creates the symlink.)
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

# Stage 6 Task 8 — per-user settings + userdata. When SAILOR_ENGINE_MULTI_USER
# is set truthy, run ComfyUI with --multi-user so UserManager files each
# tenant's settings/userdata under user/<id>/, keyed off the `comfy-user`
# header the authenticated Nuxt proxy injects (server/middleware/comfyui-proxy.ts,
# handleHostedUserScoped). The SAME env gates the proxy's userScoped
# route-opening (deployMode.ts engineMultiUser()), so the flag and the header
# injection can never disagree. Local dev launches main.py directly (never this
# script) and always stays single-user.
#
# DANGER — leave this UNSET until an engine-user registration layer lands.
# Under --multi-user, get_request_user_id raises KeyError (→ 401) for any
# `comfy-user` id absent from user/users.json, INCLUDING `default`; Clerk ids
# are never registered there. See the Task 8 report for the open blockers.
MULTI_USER_ARG=""
case "$(printf '%s' "${SAILOR_ENGINE_MULTI_USER:-}" | tr '[:upper:]' '[:lower:]')" in
  ''|0|false) : ;;
  *) MULTI_USER_ARG="--multi-user" ;;
esac

# 1) ComfyUI backend (CPU-only) on :8188.
cd /app
python main.py \
  --listen 0.0.0.0 --port 8188 \
  --cpu --disable-auto-launch \
  ${MULTI_USER_ARG:+$MULTI_USER_ARG} \
  --output-directory /data/output \
  --input-directory /data/input \
  --temp-directory /data/temp \
  --user-directory /data/user \
  --database-url "sqlite:////data/comfyui.db" &
COMFY_PID=$!

# 2) Nuxt (Nitro) server on :3000. cwd MUST be /app/frontend so the
#    /api/loras-local route resolves ../models/loras correctly.
cd /app/frontend
node .output/server/index.mjs &
NUXT_PID=$!

# If either process dies, bring the whole container down so Fly restarts it.
wait -n "$COMFY_PID" "$NUXT_PID"
echo "[start.sh] a process exited; shutting down container." >&2
kill "$COMFY_PID" "$NUXT_PID" 2>/dev/null || true
exit 1
