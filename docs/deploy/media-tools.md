# Video tools on Fly

The Fly image carries Sailor's own `ffmpeg` and `ffprobe` in `/opt/media-tools/`. They are
built from pinned sources in the Dockerfile's `media-tools` stage by
`scripts/media-tools/build.sh`, the same script a Mac uses. The runtime stage copies the
folder in and sets `NUXT_MEDIA_TOOLS_DIR=/opt/media-tools/bin`.

- **What:** FFmpeg 8.0.3 with LGPL parts only, plus OpenH264 2.5.1, LAME 3.100, Opus 1.6.1,
  dav1d 1.5.1 and zlib 1.3.2, all linked statically. The versions, URLs and sha256 values are
  in `scripts/media-tools/versions.env`. dav1d's build tools (meson, ninja) come from a
  pinned, hash-checked venv the script makes itself (`scripts/media-tools/buildtools.txt`).
- **Bases (both pinned):** the tools stage is `FROM ${PYTHON_BASE}` (Python only for
  the build's meson and ninja) and the runtime is `FROM ${NODE_BASE}` (Node 22, no Python,
  step 3 R10.10). Both are pinned by multi-arch digest and must sit on the **same Debian
  release** (trixie today), so the tools run on the glibc they were compiled against. The
  runtime stage runs `ffmpeg -version` and `ffprobe -version`, so a mismatch fails the build.
- **Build time:** about 10 minutes on a cold cache. The stage only reruns when
  `scripts/media-tools/` or the base changes.
- **Size added to the image:** not measured yet. The controller measures it at the first
  `docker build --target media-tools` and records it here; the expected size is under 80 MB.

## Bumping the base image

1. Read the new digest of the multi-arch tag (not a single-architecture image):
   `docker buildx imagetools inspect python:3.12-slim` (the top `Digest:` line), or Docker
   Hub's `https://hub.docker.com/v2/repositories/library/python/tags/3.12-slim` (`digest`).
2. Change the `ARG PYTHON_BASE=` line in the Dockerfile, and `ARG NODE_BASE=` with it when
   the Debian release changes (read `node:22-<release>-slim`'s digest the same way). The two
   must name the same release.
3. Build and deploy. The tools are rebuilt on the new base (about 10 minutes), and the new
   `manifest.json` records the compiler. A one-off test can use
   `docker build --build-arg PYTHON_BASE=python:3.12-slim@sha256:<digest> …`, which moves
   both stages together.
4. A new Debian release under the tag also changes the runtime's system libraries: check
   the Nuxt server runs (and a video effect and a caption render) before deploying.

## Checking a running machine

```sh
fly ssh console -C "/opt/media-tools/bin/ffmpeg -hide_banner -version"
fly ssh console -C "/opt/media-tools/bin/ffmpeg -hide_banner -buildconf"
fly ssh console -C "/opt/media-tools/bin/ffmpeg -hide_banner -protocols"
fly ssh console -C "/opt/media-tools/bin/ffmpeg -hide_banner -demuxers"
fly ssh console -C "ls -R /opt/media-tools/licenses"
fly ssh console -C "cat /opt/media-tools/licenses/SOURCES.md"
fly ssh console -C "cat /opt/media-tools/manifest.json"
```

Expect `8.0.3-sailor1`, no `--enable-gpl`, `--enable-version3` or `--enable-nonfree` in the
build line, only `file` and `pipe` as protocols, and exactly the demuxers and muxers of
`scripts/media-tools/configure.args`: single-file formats only, no `concat`, `hls`, `dash`,
`imf`, `image2`, `vobsub`, `sdp` or anything else that follows references to other files or
addresses. The server refuses a build whose ffmpeg **or** ffprobe lists anything else (its
lists are allow-lists), and so does the build script. Filters that open or write files by
name (`movie`, `amovie`, `sendcmd`, `asendcmd`, LUT, curve, mask, model, stats and metadata
files) are not built. The licence folder holds FFmpeg's
`COPYING.LGPLv2.1` and `LICENSE.md`, the licence files of OpenH264, LAME, Opus, dav1d and zlib,
and `SOURCES.md`, which lists each source's address and sha256 and the configure line.

If the server refuses the tools, its log has a `media.tools.refused` line that says why. It
then leaves video and sound work to the engine. `NUXT_MEDIA_TOOLS=off` switches the tools
off without a rebuild.

## What the media module must enforce

The build can't do these; `frontend/server/media/` (R5.1b onwards) must, on every job:

- **Every input, in both ffmpeg and ffprobe:**
  - `-protocol_whitelist file,pipe`;
  - `-f <demuxer>` named from the file's first bytes (`mediaFormat`). MPEG-PS is `-f mpeg` at run time;
  - `file:<absolute path>`. Outputs are `file:` paths too, so a name like `pipe:1` or `-x` is never misread as an option or a pipe.
- **Every invocation:** `-nostdin` with stdio `ignore` for stdin, `-max_alloc 536870912`, and `-probesize` / `-analyzeduration` caps on probes.
- **Never pass:**
  - `-enable_drefs 1` or `-use_absolute_path 1` (on mov inputs, pass `-enable_drefs 0` explicitly as a belt and braces);
  - `-dump_attachment`, which writes files named by the input;
  - `-report`;
  - `-filter_script`, `-/filter` or any filtergraph built from user text. User text is never interpolated into a filtergraph.
- **Environment:** spawn with a minimal environment, as `tools.ts` does, so `FFREPORT` and `AV_LOG_FORCE_*` can't leak in. Arguments go as a list, never through a shell.
- **Outputs:** `-y` only inside the run's own temporary folder. The result is moved into the store afterwards.
- **Metadata over about 100 KiB** (a large workflow JSON): write it to an ffmetadata file and pass that file, never argv. Linux caps one argument at 128 KiB (`MAX_ARG_STRLEN`), so it would fail with E2BIG.
- **Raw frames and samples** go in through a pipe with `-f rawvideo` / `-f f32le` and explicit `-pix_fmt`, `-s`, `-r` / `-ar`, `-ac`. Nothing about the stream is guessed.

## Bumping a version

Follow `scripts/media-tools/README.md`, then deploy. The image build fails if a download's
sha256 doesn't match its pin.

## Licence notes

- On macOS, FFmpeg 8.0.3's configure always links CoreFoundation, CoreMedia and CoreVideo
  (configure:6826-6829), even with every Apple feature off. They are system libraries,
  covered by the LGPL's system-library exception, and the build check allows exactly those
  three next to libSystem and libc++. The check also refuses a configure with VideoToolbox,
  AudioToolbox, CoreImage, AVFoundation, AppKit or Metal on, so the Mac decodes the way
  Fly (Linux, no frameworks) does.

- Sailor runs `ffmpeg` as a separate program by its path; it never links it. FFmpeg is
  unmodified, and its notices sit beside it.
- The LGPL asks for the source only when the program is given to someone. Sailor runs it on
  its own server, so the image carries the licence texts, the exact source addresses and
  checksums, and the build line. If the image is ever handed to anyone, add the source
  archives too (ruling n).
- OpenH264 built from source is covered by its BSD licence. Cisco's patent grant covers only
  Cisco's own binaries downloaded by an end user. H.264 encoding in hosted is on by the
  user's own decision (2026-09-28); the patent question is recorded there (ruling b).
- Since R10.10 the image carries no ComfyUI and no PyAV, so it no longer contains PyAV's
  GPL x264 and x265 (ruling o).
