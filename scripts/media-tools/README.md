# Sailor's video tools

`build.sh` builds the `ffmpeg` and `ffprobe` that Sailor's server uses for video and sound
(`frontend/server/media/`). It builds FFmpeg 8.0.3 with LGPL parts only, plus OpenH264
(H.264), LAME (MP3), Opus, dav1d (AV1 decoding) and zlib (PNG and other deflate codecs). Every part comes from its pinned
source and is checked by sha256. The same script and the same switches are used on a Mac
and in the Fly image.

| File | What it holds |
|---|---|
| `versions.env` | Each part's version, source URL and sha256; FFmpeg's signature URL and signing-key fingerprint; the build time stamp |
| `configure.args` | FFmpeg's configure switches, one per line |
| `buildtools.txt` | meson and ninja for dav1d's build, pinned with pip hashes; installed into a venv in the work folder, never into Homebrew or the system |
| `build.sh` | Downloads, checks, builds, checks the result, writes the output folder |

## Building on a Mac

You need Xcode's command-line tools (`xcode-select --install`), `pkg-config`, and a Python
3.10 or later on PATH (meson 1.12 needs it). The command-line tools' own `/usr/bin/python3`
is 3.9 and is **not** enough; `brew install python` or python.org's installer is. The
script looks for `python3`, then `python3.14` down to `python3.10`, and says plainly when
none is new enough. It checks for the rest too and names any that are missing. meson and
ninja are not installed anywhere: the script makes a venv in its work folder
(`frontend/.media-tools/.work/buildtools-venv`) and installs the versions pinned in
`buildtools.txt` there, hash-checked. It never links a Homebrew or system library.

The build runs in a cleaned environment: every compiler, linker, make, autoconf, meson and
pkg-config variable (`CC`, `CFLAGS`, `LDFLAGS`, `MAKEFLAGS`, `CONFIG_SITE`, `PKG_CONFIG*`,
`SDKROOT`, `MACOSX_DEPLOYMENT_TARGET`, `DYLD_*`, `LD_LIBRARY_PATH`…, the list is
`MT_ENV_UNSET` in `checks.sh`) is unset, then `CC=cc CXX=c++ AR=ar RANLIB=ranlib`,
`PKG_CONFIG` and, on a Mac, `MACOSX_DEPLOYMENT_TARGET=13.0` are set. `manifest.json`
records them. The checks the script runs on its own result live in `checks.sh`, which the
unit tests run against fixtures.

```sh
cd /path/to/Sailor
scripts/media-tools/build.sh
```

It downloads about 25 MB and compiles for about 10 minutes. The output goes to
`frontend/.media-tools/<platform>-<arch>/`, for example `darwin-arm64/`, which git ignores:

```
bin/ffmpeg  bin/ffprobe  licenses/  manifest.json
```

Downloads and build logs are kept in `frontend/.media-tools/.work/`. Delete that folder
to free the space; the next build downloads again. The server finds the tools on its next
start. `NUXT_MEDIA_TOOLS=off` hides them.

## Bumping a version

1. Change the part's `_VERSION` and `_URL` in `versions.env`, and set its `_SHA256` to
   `TODO-VERIFY`.
2. Run `build.sh`. It downloads the new file, prints its sha256 and stops. For FFmpeg it
   also checks the release signature against the pinned key, if `gpg` is installed, and
   prints `signature: good`.
3. Check the sha256 against the project's own published checksum, where it has one.
   Then paste it into `versions.env` and run `build.sh` again.
4. An FFmpeg bump also changes `MEDIA_TOOLS_VERSION` in `frontend/server/media/tools.ts`,
   and needs the media parity fixtures run again. Stay on the branch PyAV uses.

Never add `--enable-gpl`, `--enable-version3`, `--enable-nonfree`, x264 or x265. The build
script, the server and the tests all refuse them.
