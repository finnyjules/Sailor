# syntax=docker/dockerfile:1

# ONE base for the runtime and the video-tools build stage, pinned by digest so
# the tools are compiled against the same glibc they run on (Task R5.1a). Both
# stages read only this ARG: bumping it bumps both (docs/deploy/media-tools.md).
# python:3.12-slim's multi-arch index digest, read from Docker Hub on 2026-09-28.
ARG PYTHON_BASE=python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

###############################################################################
# Stage 1 — build the Nuxt frontend
###############################################################################
FROM node:22-slim AS web
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
# Stage 3 — runtime: ComfyUI (Python, CPU-only) + Nuxt server (Node)
###############################################################################
FROM ${PYTHON_BASE} AS runtime
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# System deps: Node 22 (to run the Nuxt server) + libs ComfyUI/torch need
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates git build-essential \
      libgl1 libglib2.0-0 libgomp1 \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps — CPU-only torch wheels first, then the rest of requirements.
# Installing torch from the CPU index avoids pulling ~2GB of unused CUDA libs.
COPY requirements.txt ./
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision torchaudio \
 && pip install -r requirements.txt

# opencv (cv2) is imported by comfy_extras nodes (subject_track, frame_interp, …) but isn't
# declared in requirements.txt. The headless
# build avoids GUI deps. Separate layer so the heavy torch layer stays cached.
RUN pip install opencv-python-headless

# The video tools, with their licences and sources (licenses/SOURCES.md) beside them.
COPY --from=media-tools /opt/media-tools /opt/media-tools
ENV NUXT_MEDIA_TOOLS_DIR=/opt/media-tools/bin

# ComfyUI source + the sailor bridge custom node + LoRA sidecars/covers.
# .dockerignore keeps models/loras/*.json + *.cover.* but drops the heavy
# .safetensors weights (inference runs on Replicate, not locally).
COPY . .

# Overlay the built Nuxt output from stage 1.
COPY --from=web /build/frontend/.output /app/frontend/.output

RUN chmod +x /app/start.sh
EXPOSE 3000 8188
CMD ["/app/start.sh"]
