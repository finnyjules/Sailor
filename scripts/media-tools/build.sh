#!/usr/bin/env bash
# Build Sailor's video tools (ffmpeg + ffprobe) from pinned, checked sources.
# LGPL-only FFmpeg 8.0.3 with OpenH264, LAME, Opus, dav1d and zlib, all
# linked statically. The same script runs on a Mac and in the Fly image's
# `media-tools` build stage (Dockerfile). Task R5.1a; see README.md.
#
#   scripts/media-tools/build.sh [OUT_DIR]
#
# OUT_DIR defaults to frontend/.media-tools/<platform>-<arch>, the folder the
# server looks in (frontend/server/media/tools.ts). It receives:
#   bin/ffmpeg  bin/ffprobe  licenses/  manifest.json
#
# Environment (all optional):
#   MEDIA_TOOLS_WORK   downloads + build folder (default frontend/.media-tools/.work)
#   MEDIA_TOOLS_JOBS   parallel compile jobs (default: the machine's CPU count)
#   SOURCE_DATE_EPOCH  build time stamp (default: versions.env's)
#
# meson and ninja (dav1d's build tools) come from a throwaway venv in the work
# folder, pinned by buildtools.txt; nothing is installed into Homebrew or the system.
#
# Written for bash 3.2 (macOS's /bin/bash).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

say() { printf '[media-tools] %s\n' "$*" >&2; }
die() { printf '[media-tools] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pins
# ---------------------------------------------------------------------------
# shellcheck source=versions.env
. "$HERE/versions.env"
# shellcheck source=checks.sh
. "$HERE/checks.sh"
BUILD_TAG=sailor1 # --extra-version in configure.args; MEDIA_TOOLS_BUILD_TAG in server/media/tools.ts

PARTS="ZLIB OPENH264 LAME OPUS DAV1D FFMPEG" # also the build order

CONFIGURE_ARGS=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  case "$line" in ''|'#'*) continue ;; esac
  CONFIGURE_ARGS+=("$line")
done < "$HERE/configure.args"

for a in "${CONFIGURE_ARGS[@]}"; do
  case "$a" in
    --enable-gpl|--enable-version3|--enable-nonfree|--enable-libx264|--enable-libx265)
      die "configure.args holds $a, which would make a GPL or non-free build" ;;
  esac
done
case " ${CONFIGURE_ARGS[*]} " in *" --extra-version=$BUILD_TAG "*) ;; *) die "configure.args doesn't mark the build --extra-version=$BUILD_TAG" ;; esac

# ---------------------------------------------------------------------------
# Machine
# ---------------------------------------------------------------------------
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) die "unsupported system $(uname -s)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) die "unsupported processor $(uname -m)" ;;
esac

OUT="${1:-$REPO/frontend/.media-tools/$OS-$ARCH}"
case "$OUT" in /*) ;; *) OUT="$(pwd)/$OUT" ;; esac
WORK="${MEDIA_TOOLS_WORK:-$REPO/frontend/.media-tools/.work}"
if [ -z "${MEDIA_TOOLS_JOBS:-}" ]; then
  MEDIA_TOOLS_JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
fi

missing=""
need() { command -v "$1" >/dev/null 2>&1 || missing="$missing $1"; }
if [ "$OS" = darwin ]; then
  xcode-select -p >/dev/null 2>&1 || missing="$missing xcode-command-line-tools"
fi
need cc; need c++; need make; need pkg-config; need curl; need tar
[ "$OS" = linux ] && need xz
[ "$ARCH" = x64 ] && need nasm
if command -v sha256sum >/dev/null 2>&1; then :; else need shasum; fi
PYTHON="$(mt_find_python 2>/dev/null)" || missing="$missing python3.10+"
if [ -n "$missing" ]; then
  say "missing build tools:$missing"
  if [ "$OS" = darwin ]; then
    say "on a Mac: 'xcode-select --install' for the command-line tools; pkg-config and a Python 3.10+ from 'brew install pkg-config python'"
    say "(the command-line tools' own python3 is 3.9, older than the build tools need)"
  else
    say "on Debian: apt-get install build-essential pkg-config nasm curl ca-certificates xz-utils (python3 is the base image's)"
  fi
  exit 2
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
lower() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

# A clean, repeatable environment: nothing from the machine leaks in. Every
# compiler, linker, make, autoconf, meson and pkg-config variable is unset
# (checks.sh's MT_ENV_UNSET, DYLD_* too), then the few the build needs are
# pinned: CC=cc CXX=c++ AR=ar RANLIB=ranlib, PKG_CONFIG, and on a Mac
# MACOSX_DEPLOYMENT_TARGET=13.0 (ZERO_AR_DATE=1: no time stamps in archives).
PKG_CONFIG_BIN="$(command -v pkg-config)"
mt_clean_env "$OS" "$PKG_CONFIG_BIN"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$MEDIA_TOOLS_SOURCE_DATE_EPOCH}"
umask 022

DL="$WORK/downloads"
SRC="$WORK/src"
PREFIX="$WORK/prefix"
mkdir -p "$DL"
rm -rf "$SRC" "$PREFIX"
mkdir -p "$SRC" "$PREFIX"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" # only our own .pc files, never Homebrew's or the system's

say "building for $OS-$ARCH into $OUT (work folder $WORK, $MEDIA_TOOLS_JOBS jobs)"

# ---------------------------------------------------------------------------
# meson + ninja, pinned, in a venv of the work folder's own
# ---------------------------------------------------------------------------
VENV="$WORK/buildtools-venv"
MESON_PIN="$(awk -F'==' '/^meson==/{sub(/ .*/,"",$2); print $2}' "$HERE/buildtools.txt")"
NINJA_PIN="$(awk -F'==' '/^ninja==/{sub(/ .*/,"",$2); print $2}' "$HERE/buildtools.txt")"
venv_has() { # name version -> true when the venv holds exactly that distribution version
  [ -x "$VENV/bin/python" ] && [ "$("$VENV/bin/python" -c "import importlib.metadata as m, sys; print(m.version(sys.argv[1]))" "$1" 2>/dev/null)" = "$2" ]
}
if ! venv_has meson "$MESON_PIN" || ! venv_has ninja "$NINJA_PIN" || [ ! -x "$VENV/bin/meson" ] || [ ! -x "$VENV/bin/ninja" ]; then
  say "making the build-tools venv (meson $MESON_PIN, ninja $NINJA_PIN) in $VENV"
  rm -rf "$VENV"
  "$PYTHON" -m venv "$VENV" || die "$PYTHON can't make a venv (on Debian: apt-get install python3-venv)"
  PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 "$VENV/bin/python" -m pip install --quiet \
    --require-hashes --only-binary=:all: --no-deps -r "$HERE/buildtools.txt" \
    || die "could not install the pinned meson and ninja into $VENV"
fi
venv_has meson "$MESON_PIN" || die "the venv's meson isn't $MESON_PIN"
venv_has ninja "$NINJA_PIN" || die "the venv's ninja isn't $NINJA_PIN"
MESON="$VENV/bin/meson"
NINJA="$VENV/bin/ninja"

# ---------------------------------------------------------------------------
# Download and check
# ---------------------------------------------------------------------------
fetch() { # url dest
  if [ ! -s "$2" ]; then
    say "downloading $1"
    curl -fL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 -o "$2.part" "$1"
    mv "$2.part" "$2"
  fi
}

check_ffmpeg_signature() { # tarball -> prints good|unchecked, dies on bad
  if ! command -v gpg >/dev/null 2>&1; then echo unchecked; return; fi
  fetch "$FFMPEG_SIG_URL" "$DL/$(basename "$FFMPEG_SIG_URL")"
  fetch "$FFMPEG_KEY_URL" "$DL/ffmpeg-devel.asc"
  local gh; gh="$(mktemp -d)"
  GNUPGHOME="$gh" gpg --batch --quiet --import "$DL/ffmpeg-devel.asc" >/dev/null 2>&1 \
    || { rm -rf "$gh"; die "could not read FFmpeg's signing key"; }
  local fprs; fprs="$(GNUPGHOME="$gh" gpg --batch --with-colons --fingerprint 2>/dev/null | awk -F: '/^fpr/{print $10}')"
  if ! printf '%s\n' "$fprs" | grep -qx "$FFMPEG_KEY_FINGERPRINT"; then
    rm -rf "$gh"; die "FFmpeg's signing key doesn't have the pinned fingerprint $FFMPEG_KEY_FINGERPRINT"
  fi
  GNUPGHOME="$gh" gpg --batch --status-fd 1 --verify "$DL/$(basename "$FFMPEG_SIG_URL")" "$1" >"$WORK/ffmpeg-gpg-status.txt" 2>/dev/null || true
  rm -rf "$gh"
  if mt_check_signature_status "$WORK/ffmpeg-gpg-status.txt" "$FFMPEG_KEY_FINGERPRINT"; then echo good
  else die "FFmpeg's signature does not verify: $1"; fi
}

todo=""
for P in $PARTS; do
  eval "url=\$${P}_URL; want=\$${P}_SHA256"
  file="$DL/$(printf '%s' "$P" | tr 'A-Z' 'a-z')-$(basename "$url")"
  fetch "$url" "$file"
  got="$(sha256_of "$file")"
  sig=""
  if [ "$P" = FFMPEG ]; then sig="$(check_ffmpeg_signature "$file")"; say "FFmpeg signature: $sig"; fi
  if [ "$want" = TODO-VERIFY ]; then
    say "$P has no pinned sha256 yet. Downloaded: $file"
    say "  sha256 $got${sig:+ (signature: $sig)}"
    todo="$todo $P"
    continue
  fi
  if [ "$(lower "$got")" != "$(lower "$want")" ]; then
    rm -f "$file"
    die "$P's download has sha256 $got, not the pinned $want (file removed)"
  fi
  eval "${P}_FILE=\$file"
done
if [ -n "$todo" ]; then
  say "stopping: check the sha256 above for$todo, paste it into scripts/media-tools/versions.env, and run again"
  exit 3
fi

unpack() { # PART -> prints the source folder
  local P="$1" f dir
  eval "f=\$${P}_FILE"
  dir="$SRC/$(printf '%s' "$P" | tr 'A-Z' 'a-z')"
  mkdir -p "$dir"
  tar -xf "$f" -C "$dir"
  local top; top="$(find "$dir" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [ -n "$top" ] || die "$P's archive is empty"
  printf '%s' "$top"
}

# ---------------------------------------------------------------------------
# Build, in a fixed order
# ---------------------------------------------------------------------------
J="-j$MEDIA_TOOLS_JOBS"

say "zlib $ZLIB_VERSION"
ZLIB_SRC="$(unpack ZLIB)"
( cd "$ZLIB_SRC" && ./configure --prefix="$PREFIX" --static && make $J && make install ) >"$WORK/zlib.log" 2>&1 \
  || { tail -40 "$WORK/zlib.log" >&2; die "zlib failed to build (log: $WORK/zlib.log)"; }

say "OpenH264 $OPENH264_VERSION"
OPENH264_SRC="$(unpack OPENH264)"
make -C "$OPENH264_SRC" $J PREFIX="$PREFIX" BUILDTYPE=Release install-static >"$WORK/openh264.log" 2>&1 \
  || { tail -40 "$WORK/openh264.log" >&2; die "OpenH264 failed to build (log: $WORK/openh264.log)"; }

say "LAME $LAME_VERSION"
LAME_SRC="$(unpack LAME)"
( cd "$LAME_SRC" \
  && ./configure --prefix="$PREFIX" --enable-static --disable-shared --disable-frontend \
       --disable-decoder --disable-debug --disable-dependency-tracking \
  && make $J && make install ) >"$WORK/lame.log" 2>&1 \
  || { tail -40 "$WORK/lame.log" >&2; die "LAME failed to build (log: $WORK/lame.log)"; }

say "Opus $OPUS_VERSION"
OPUS_SRC="$(unpack OPUS)"
( cd "$OPUS_SRC" \
  && ./configure --prefix="$PREFIX" --enable-static --disable-shared --disable-doc \
       --disable-extra-programs --disable-dependency-tracking \
  && make $J && make install ) >"$WORK/opus.log" 2>&1 \
  || { tail -40 "$WORK/opus.log" >&2; die "Opus failed to build (log: $WORK/opus.log)"; }

say "dav1d $DAV1D_VERSION"
DAV1D_SRC="$(unpack DAV1D)"
( cd "$DAV1D_SRC" \
  && PATH="$VENV/bin:$PATH" "$MESON" setup build --prefix="$PREFIX" --libdir=lib --buildtype=release \
       --default-library=static -Denable_tools=false -Denable_tests=false -Denable_examples=false \
  && "$NINJA" -C build $J && PATH="$VENV/bin:$PATH" "$MESON" install -C build ) >"$WORK/dav1d.log" 2>&1 \
  || { tail -40 "$WORK/dav1d.log" >&2; die "dav1d failed to build (log: $WORK/dav1d.log)"; }

say "FFmpeg $FFMPEG_VERSION"
FFMPEG_SRC="$(unpack FFMPEG)"
FULL_ARGS=(
  "--cc=$CC"
  "--cxx=$CXX"
  --pkg-config-flags=--static
  "--extra-cflags=-I$PREFIX/include"
  "--extra-ldflags=-L$PREFIX/lib"
  "${CONFIGURE_ARGS[@]}"
)
( cd "$FFMPEG_SRC" && ./configure "${FULL_ARGS[@]}" ) >"$WORK/ffmpeg-configure.log" 2>&1 \
  || { tail -60 "$WORK/ffmpeg-configure.log" >&2; die "FFmpeg's configure failed (log: $WORK/ffmpeg-configure.log; configure's own log: $FFMPEG_SRC/ffbuild/config.log)"; }
# Before the long compile: every component configure.args names really exists
# and is on (or, for the filters it disables, off). A misspelt name does nothing.
mt_check_config_components "$FFMPEG_SRC/config_components.h" "$HERE/configure.args" || die "configure.args names a component FFmpeg $FFMPEG_VERSION doesn't have or didn't enable (see above)"
( cd "$FFMPEG_SRC" && make $J ffmpeg ffprobe ) >"$WORK/ffmpeg.log" 2>&1 \
  || { tail -60 "$WORK/ffmpeg.log" >&2; die "FFmpeg failed to build (log: $WORK/ffmpeg.log)"; }

# ---------------------------------------------------------------------------
# Check the result before it goes anywhere
# ---------------------------------------------------------------------------
STAGE="$OUT.partial"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/licenses"
cp "$FFMPEG_SRC/ffmpeg" "$FFMPEG_SRC/ffprobe" "$STAGE/bin/"
chmod 755 "$STAGE/bin/ffmpeg" "$STAGE/bin/ffprobe"

FF="$STAGE/bin/ffmpeg"
CHK="$WORK/checks"
rm -rf "$CHK"; mkdir -p "$CHK"
EXPECTED_DEMUXERS="$(mt_expected_names "$HERE/configure.args" demuxer)"
EXPECTED_MUXERS="$(mt_expected_names "$HERE/configure.args" muxer)"
EXPECTED_PROTOCOLS="$(mt_expected_names "$HERE/configure.args" protocol)"
EXPECTED_ENCODERS="$(mt_expected_names "$HERE/configure.args" encoder)"

# Both programs get every check: ffprobe is the first to open an upload.
for TOOL in ffmpeg ffprobe; do
  T="$STAGE/bin/$TOOL"
  "$T" -hide_banner -version >"$CHK/$TOOL-version.txt"
  "$T" -hide_banner -buildconf >"$CHK/$TOOL-buildconf.txt"
  "$T" -hide_banner -L >"$CHK/$TOOL-L.txt"
  "$T" -hide_banner -protocols >"$CHK/$TOOL-protocols.txt"
  "$T" -hide_banner -demuxers >"$CHK/$TOOL-demuxers.txt"
  "$T" -hide_banner -muxers >"$CHK/$TOOL-muxers.txt"
  "$T" -hide_banner -encoders >"$CHK/$TOOL-encoders.txt"
  mt_check_version_line "$(head -1 "$CHK/$TOOL-version.txt")" "$TOOL" "$FFMPEG_VERSION" "$BUILD_TAG" || die "the new $TOOL has the wrong version"
  mt_check_buildconf "$CHK/$TOOL-buildconf.txt" || die "the new $TOOL's build line is refused"
  mt_check_licence_text "$CHK/$TOOL-L.txt" || die "the new $TOOL's licence is refused"
  mt_check_same_names protocols "$EXPECTED_PROTOCOLS" "$(mt_listed_protocols "$CHK/$TOOL-protocols.txt")" || die "the new $TOOL's protocols are refused"
  mt_check_same_names demuxers "$EXPECTED_DEMUXERS" "$(mt_listed_formats "$CHK/$TOOL-demuxers.txt")" || die "the new $TOOL's demuxers are refused"
  mt_check_same_names muxers "$EXPECTED_MUXERS" "$(mt_listed_formats "$CHK/$TOOL-muxers.txt")" || die "the new $TOOL's muxers are refused"
  mt_check_same_names encoders "$EXPECTED_ENCODERS" "$(mt_listed_encoders "$CHK/$TOOL-encoders.txt")" || die "the new $TOOL's encoders are refused"
  if [ "$OS" = darwin ]; then otool -L "$T" >"$CHK/$TOOL-links.txt"; else ldd "$T" >"$CHK/$TOOL-links.txt" 2>&1 || true; fi
  mt_check_links "$OS" "$CHK/$TOOL-links.txt" "$WORK" || die "the new $TOOL links a library from outside the system"
done
mt_check_same_buildconf "$CHK/ffmpeg-buildconf.txt" "$CHK/ffprobe-buildconf.txt" || die "ffmpeg and ffprobe have different build lines"
VERSION_LINE="$(head -1 "$CHK/ffmpeg-version.txt")"

# ---------------------------------------------------------------------------
# Licences, sources, manifest
# ---------------------------------------------------------------------------
copy_licence() { # part-folder-name src-dir file...
  local name="$1" dir="$2"; shift 2
  mkdir -p "$STAGE/licenses/$name"
  local f
  for f in "$@"; do
    [ -f "$dir/$f" ] || die "$name's licence file $f is missing from its source"
    cp "$dir/$f" "$STAGE/licenses/$name/$f"
  done
}
copy_licence ffmpeg "$FFMPEG_SRC" COPYING.LGPLv2.1 LICENSE.md
copy_licence openh264 "$OPENH264_SRC" LICENSE
copy_licence lame "$LAME_SRC" COPYING LICENSE
copy_licence opus "$OPUS_SRC" COPYING
copy_licence dav1d "$DAV1D_SRC" COPYING
copy_licence zlib "$ZLIB_SRC" LICENSE

CC_VERSION="$(cc --version | head -1)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CONFIGURE_LINE="./configure"
for a in "${FULL_ARGS[@]}"; do CONFIGURE_LINE="$CONFIGURE_LINE $a"; done

licence_of() {
  case "$1" in
    FFMPEG) echo "LGPL 2.1 or later" ;; OPENH264) echo "BSD 2-clause" ;; LAME) echo "LGPL 2" ;;
    OPUS) echo "BSD 3-clause" ;; DAV1D) echo "BSD 2-clause" ;; ZLIB) echo "zlib licence" ;;
  esac
}
title_of() {
  case "$1" in FFMPEG) echo FFmpeg ;; OPENH264) echo OpenH264 ;; LAME) echo LAME ;; OPUS) echo Opus ;; DAV1D) echo dav1d ;; ZLIB) echo zlib ;; esac
}

{
  echo "# Sources of this ffmpeg and ffprobe"
  echo
  echo "Sailor runs these two programs by their path; it does not link them. FFmpeg is"
  echo "unmodified and built with LGPL parts only. Licence texts are in the folders beside this file."
  echo
  echo "| Part | Version | Licence | Source | sha256 |"
  echo "|---|---|---|---|---|"
  for P in FFMPEG OPENH264 LAME OPUS DAV1D ZLIB; do
    eval "v=\$${P}_VERSION; u=\$${P}_URL; s=\$${P}_SHA256"
    echo "| $(title_of "$P") | $v | $(licence_of "$P") | $u | $(lower "$s") |"
  done
  echo
  echo "FFmpeg's release signature: $FFMPEG_SIG_URL (key $FFMPEG_KEY_FINGERPRINT)."
  echo
  echo "## FFmpeg's configure line"
  echo
  echo '```'
  echo "$CONFIGURE_LINE"
  echo '```'
  echo
  echo "Built on $OS-$ARCH with: $CC_VERSION. SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH."
  echo "dav1d was configured with meson $MESON_PIN and ninja $NINJA_PIN (scripts/media-tools/buildtools.txt)."
  echo "Build script: scripts/media-tools/build.sh in Sailor's repository."
} > "$STAGE/licenses/SOURCES.md"

json_str() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }
{
  echo "{"
  echo "  \"ffmpegVersion\": $(json_str "$FFMPEG_VERSION"),"
  echo "  \"versionLine\": $(json_str "$VERSION_LINE"),"
  echo "  \"platform\": $(json_str "$OS"),"
  echo "  \"arch\": $(json_str "$ARCH"),"
  echo "  \"compiler\": $(json_str "$CC_VERSION"),"
  echo "  \"environment\": {\"CC\": $(json_str "$CC"), \"CXX\": $(json_str "$CXX"), \"AR\": $(json_str "$AR"), \"RANLIB\": $(json_str "$RANLIB"), \"PKG_CONFIG\": $(json_str "$PKG_CONFIG"), \"MACOSX_DEPLOYMENT_TARGET\": $(json_str "${MACOSX_DEPLOYMENT_TARGET:-}"), \"python\": $(json_str "$("$PYTHON" --version 2>&1)"), \"meson\": $(json_str "$MESON_PIN"), \"ninja\": $(json_str "$NINJA_PIN")},"
  echo "  \"sourceDateEpoch\": $SOURCE_DATE_EPOCH,"
  echo "  \"builtAt\": $(json_str "$BUILT_AT"),"
  echo "  \"parts\": ["
  sep=""
  for P in FFMPEG OPENH264 LAME OPUS DAV1D ZLIB; do
    eval "v=\$${P}_VERSION; u=\$${P}_URL; s=\$${P}_SHA256"
    printf '%s    {"name": %s, "version": %s, "licence": %s, "url": %s, "sha256": %s}' \
      "$sep" "$(json_str "$(title_of "$P")")" "$(json_str "$v")" "$(json_str "$(licence_of "$P")")" "$(json_str "$u")" "$(json_str "$(lower "$s")")"
    sep=$',\n'
  done
  echo
  echo "  ],"
  printf '  "configure": ['
  sep=""
  for a in "${FULL_ARGS[@]}"; do printf '%s%s' "$sep" "$(json_str "$a")"; sep=', '; done
  echo "],"
  echo "  \"binaries\": {"
  echo "    \"ffmpeg\": {\"sha256\": $(json_str "$(sha256_of "$STAGE/bin/ffmpeg")")},"
  echo "    \"ffprobe\": {\"sha256\": $(json_str "$(sha256_of "$STAGE/bin/ffprobe")")}"
  echo "  }"
  echo "}"
} > "$STAGE/manifest.json"

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
mv "$STAGE" "$OUT"
say "done: $OUT"
say "  $VERSION_LINE"
say "  size: $(du -sh "$OUT" | cut -f1)"
