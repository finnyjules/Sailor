# syntax=docker/dockerfile:1

# The video tools are compiled against the glibc they run on (Task R5.1a), so the
# tools stage and the runtime stage must sit on the SAME Debian release. Both
# bases are pinned by their multi-arch index digest; bump them together
# (docs/deploy/media-tools.md). The runtime's own `ffmpeg -version` step below
# fails the build if they ever drift apart.
#
# PYTHON_BASE builds the tools only (meson and ninja come from a pinned venv);
# no Python reaches the runtime image (step 3, R10.10).
# python:3.12-slim's multi-arch index digest, read from Docker Hub on 2026-09-28
# (Debian trixie, snapshot @1789689600).
ARG PYTHON_BASE=python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
# node:22-trixie-slim's multi-arch index digest, read from Docker Hub on
# 2026-10-02 (Node 22.23.3, Debian trixie, the same snapshot @1789689600).
# Used by both the build stage and the runtime, so native modules are
# installed on the system they run on.
ARG NODE_BASE=node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4

###############################################################################
# Stage 1 — build the Nuxt frontend
###############################################################################
FROM ${NODE_BASE} AS web
WORKDIR /build/frontend

# Pin pnpm to match the lockfile. We install it directly with npm instead of via
# corepack: corepack's default-version resolution and signature verification are
# unreliable inside slim CI images and were failing the install step.
RUN npm install -g pnpm@10.30.3

# Install deps first for better layer caching
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build the app → produces /build/frontend/.output (self-contained Nitro server).
# Nuxt/Nitro's build exceeds Node's ~2GB default heap, so raise the limit.
COPY frontend/ ./
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm build

###############################################################################
# Stage 2 — the video tools: ffmpeg + ffprobe, LGPL-only FFmpeg 8.0.3 with
# OpenH264, LAME, Opus, dav1d and zlib, built from pinned, sha256-checked sources by
# the same script a Mac uses (scripts/media-tools/, docs/deploy/media-tools.md).
# meson and ninja come from a pinned venv the script makes itself.
###############################################################################
FROM ${PYTHON_BASE} AS media-tools
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config nasm \
      curl ca-certificates xz-utils gnupg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/media-tools/ scripts/media-tools/
RUN MEDIA_TOOLS_WORK=/tmp/media-tools-work scripts/media-tools/build.sh /opt/media-tools \
 && rm -rf /tmp/media-tools-work

###############################################################################
# Stage 2b — Lens · Depth of field's depth model (step 3, R7.9): Depth Anything
# V2 Small's ONNX files (99.1 MB) at a pinned revision, each checked against its
# sha256 (frontend/server/utils/depthModel.ts DEPTH_MODEL_FILES holds the same).
# Fetched here at build time only: the server reads them from
# NUXT_DEPTH_MODEL_DIR and never downloads a model at run time in hosted.
###############################################################################
FROM ${PYTHON_BASE} AS depth-model
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG DEPTH_MODEL_REV=4472b7362082ad9968fee890ca0f1e5aca36b93d
WORKDIR /opt/depth-model/onnx-community/depth-anything-v2-small
RUN set -eu; \
    base="https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/${DEPTH_MODEL_REV}"; \
    mkdir -p onnx; \
    curl -fsSL "$base/config.json" -o config.json; \
    curl -fsSL "$base/preprocessor_config.json" -o preprocessor_config.json; \
    curl -fsSL "$base/onnx/model.onnx" -o onnx/model.onnx; \
    printf '%s  %s\n' \
      3aee5b9bc4f711ee885c2526d871f0c8c6c8c4b26b8e04253d0167f6a83264f5 config.json \
      03576db3c13dd0471fdf5f5e1428befcb95de063fe699879150b293dc9e0a2c6 preprocessor_config.json \
      afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c onnx/model.onnx \
      | sha256sum -c -

###############################################################################
# Stage 3 — runtime: the Nuxt (Nitro) server on Node 22, Sailor's video tools and
# the depth model. No Python, no ComfyUI, no torch, opencv or PyAV (step 3,
# R10.10): every node runs in Sailor's runner or on a paid service.
###############################################################################
FROM ${NODE_BASE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# The video tools, with their licences and sources (licenses/SOURCES.md) beside them.
COPY --from=media-tools /opt/media-tools /opt/media-tools
ENV NUXT_MEDIA_TOOLS_DIR=/opt/media-tools/bin
# Proves the tools run on this base (a glibc mismatch fails the build here, not
# the first video job).
RUN /opt/media-tools/bin/ffmpeg -hide_banner -version \
 && /opt/media-tools/bin/ffprobe -hide_banner -version

# Lens · Depth of field's depth model (R7.9), read only from here (never downloaded at run time).
COPY --from=depth-model /opt/depth-model /opt/depth-model
ENV NUXT_DEPTH_MODEL_DIR=/opt/depth-model

# Sailor's data folders and files beside the server: LoRA sidecars and covers,
# blueprints, shader_effects, custom_nodes/sailor_bridge's Timeline scene
# defaults, and the frontend's own data the server reads by path
# (server/runner/video/fonts/ for captions, server/runner/effects/asciiGlyphs.bin
# for Ascii, the stored node list). .dockerignore keeps ComfyUI's Python source,
# requirements and every *.py out of the image.
COPY . .

# Overlay the built Nuxt output from stage 1.
COPY --from=web /build/frontend/.output /app/frontend/.output

# The data root Sailor reads input/, output/, temp/ and user/ under. Named
# explicitly because there is no main.py for the cwd walk to find
# (server/utils/inputUploads.ts computeEngineRoot); start.sh links these
# folders to the Fly volume.
ENV SAILOR_ENGINE_ROOT=/app

RUN chmod +x /app/start.sh
EXPOSE 3000
CMD ["/app/start.sh"]
