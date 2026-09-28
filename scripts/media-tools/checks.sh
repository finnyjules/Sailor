# Checks used by build.sh, kept in their own file so the tests can run them
# against fixtures (frontend/tests/unit/media-tools.unit.spec.ts). Sourced, not
# run. Each check prints why on stderr and returns non-zero; none exits.
# Written for bash 3.2 (macOS's /bin/bash).

# ---------------------------------------------------------------------------
# The build environment
# ---------------------------------------------------------------------------

# Everything a compiler, linker, make, autoconf, meson or pkg-config reads from
# the environment. mt_clean_env unsets them all, then pins the ones the build needs.
MT_ENV_UNSET="CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH LIBRARY_PATH
CFLAGS CXXFLAGS CPPFLAGS OBJCFLAGS OBJCXXFLAGS LDFLAGS ASFLAGS
CC CXX LD AR AS NM RANLIB STRIP OBJC OBJCXX CPP
MAKEFLAGS MFLAGS GNUMAKEFLAGS MAKELEVEL CONFIG_SITE CONFIG_SHELL
PKG_CONFIG PKG_CONFIG_PATH PKG_CONFIG_LIBDIR PKG_CONFIG_SYSROOT_DIR
MACOSX_DEPLOYMENT_TARGET SDKROOT DEVELOPER_DIR
LD_LIBRARY_PATH LD_PRELOAD LD_RUN_PATH"

# The pinned values (also written to manifest.json).
MT_CC=cc
MT_CXX=c++
MT_AR=ar
MT_RANLIB=ranlib
MT_MACOSX_DEPLOYMENT_TARGET=13.0

mt_clean_env() { # os(darwin|linux) pkg-config-path
  local v
  for v in $MT_ENV_UNSET; do unset "$v"; done
  for v in $(env | awk -F= '/^DYLD_/ {print $1}'); do unset "$v"; done
  export LC_ALL=C TZ=UTC ZERO_AR_DATE=1
  export CC="$MT_CC" CXX="$MT_CXX" AR="$MT_AR" RANLIB="$MT_RANLIB"
  [ -n "${2:-}" ] && export PKG_CONFIG="$2"
  if [ "$1" = darwin ]; then export MACOSX_DEPLOYMENT_TARGET="$MT_MACOSX_DEPLOYMENT_TARGET"; fi
  return 0
}

# A Python for the build-tools venv: meson 1.12.1 needs 3.10 or later.
mt_python_ok() { # python -> true when it is 3.10 or later
  "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}
mt_find_python() { # prints the first Python 3.10+ on PATH, or fails
  local p
  for p in python3 python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$p" >/dev/null 2>&1 && mt_python_ok "$(command -v "$p")"; then command -v "$p"; return 0; fi
  done
  echo "meson needs Python 3.10 or later, and none is on PATH (python3 is $(python3 --version 2>&1 || echo missing)). On a Mac: brew install python, or use python.org's installer" >&2
  return 1
}

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

mt_check_signature_status() { # gpg-status-file fingerprint
  if grep -q "^\[GNUPG:\] VALIDSIG $2 " "$1"; then return 0; fi
  echo "the signature is not a valid signature by $2" >&2
  return 1
}

# ---------------------------------------------------------------------------
# The built programs
# ---------------------------------------------------------------------------

mt_check_version_line() { # line tool version tag
  case "$1" in
    "$2 version $3-$4 "*|"$2 version $3-$4") return 0 ;;
  esac
  echo "$2 says '$1', not $3-$4" >&2
  return 1
}

MT_FORBIDDEN_BUILDCONF="--enable-gpl --enable-version3 --enable-nonfree --enable-libx264 --enable-libx265"
mt_check_buildconf() { # file with -buildconf output
  local bad
  for bad in $MT_FORBIDDEN_BUILDCONF; do
    if grep -qx "[[:space:]]*$bad" "$1"; then echo "built with $bad" >&2; return 1; fi
  done
  return 0
}

# `-buildconf`'s configure arguments only: the `--…` lines after `configuration:`,
# trimmed. ffmpeg's output also has a leading blank line and a trailing
# "Exiting with exit code 0"; ffprobe's has neither. Those are not the build.
mt_buildconf_args() { # file -> one argument per line
  awk '/^[[:space:]]*configuration:[[:space:]]*$/ {f=1; next} f && /^[[:space:]]*--/ {sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print}' "$1"
}

mt_check_same_buildconf() { # ffmpeg-buildconf-file ffprobe-buildconf-file
  local a b
  a="$(mt_buildconf_args "$1")"
  b="$(mt_buildconf_args "$2")"
  if [ -z "$a" ]; then echo "no configure arguments in $1" >&2; return 1; fi
  if [ "$a" = "$b" ]; then return 0; fi
  echo "the two programs were configured differently:" >&2
  diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") >&2 || true
  return 1
}

mt_check_licence_text() { # file with -L output
  if ! grep -q 'Lesser General Public' "$1"; then echo "its licence text isn't the LGPL" >&2; return 1; fi
  if grep -q 'GNU General Public License' "$1"; then echo "its licence text is the GPL" >&2; return 1; fi
  if grep -qi 'nonfree' "$1"; then echo "it has nonfree parts" >&2; return 1; fi
  return 0
}

# Only the system's own C and C++ libraries may be linked dynamically. On macOS
# that is libSystem and libc++, plus exactly three frameworks: FFmpeg 8.0.3's
# configure links CoreFoundation, CoreMedia and CoreVideo into libavutil on
# every Darwin build (configure:6826-6829), even with every Apple feature off.
# They are system libraries (the LGPL's system-library exception) and, with
# mt_check_config_components holding VideoToolbox, AudioToolbox, CoreImage,
# AVFoundation, AppKit and Metal at 0, enable no codec path. No other framework.
mt_check_links() { # os file-with-otool-or-ldd-output work-folder
  local line ok=0
  if grep -Eq "${3:-/nonexistent-work}|/opt/homebrew|/usr/local|x264|x265|libz\.|libbz2|libiconv" "$2"; then
    echo "it links a library from outside the system:" >&2; cat "$2" >&2; return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|*:) continue ;; esac
    if [ "$1" = darwin ]; then
      printf '%s\n' "$line" | grep -Eq '^[[:space:]]*/usr/lib/(libSystem\.B|libc\+\+\.1)\.dylib \(' && continue
      printf '%s\n' "$line" | grep -Eq '^[[:space:]]*/System/Library/Frameworks/(CoreFoundation\.framework/Versions/A/CoreFoundation|CoreMedia\.framework/Versions/A/CoreMedia|CoreVideo\.framework/Versions/A/CoreVideo) \(' && continue
    else
      printf '%s\n' "$line" | grep -Eq '^[[:space:]]*(linux-vdso\.so\.1|linux-gate\.so\.1) ' && continue
      printf '%s\n' "$line" | grep -Eq '^[[:space:]]*/lib[^ ]*/ld-linux[^ ]* \(' && continue
      printf '%s\n' "$line" | grep -Eq '^[[:space:]]*(libc|libm|libstdc\+\+|libgcc_s|libpthread|libdl|librt)\.so\.[0-9]+ => /(usr/)?lib[^ ]* \(' && continue
    fi
    echo "it links something outside the system's C and C++ libraries: $line" >&2
    ok=1
  done < "$2"
  return $ok
}

# ---------------------------------------------------------------------------
# Allow-lists: the binary's demuxers, muxers and protocols equal configure.args's
# ---------------------------------------------------------------------------

# The names `ffmpeg -demuxers` / `-muxers` show where they differ from
# configure's component names (FFmpeg 8.0.3: mpegps is "mpeg", and the raw PCM
# formats drop their "pcm_" prefix). Encoders and protocols list as configured.
mt_display_name() { # kind configure-name
  case "$1:$2" in
    demuxer:mpegps) echo mpeg ;;
    demuxer:pcm_*|muxer:pcm_*) echo "${2#pcm_}" ;;
    *) echo "$2" ;;
  esac
}

mt_configured_names() { # configure.args kind(demuxer|muxer|encoder|protocol|filter) enable|disable -> configure names, one per line
  grep -E "^--$3-$2=" "$1" | cut -d= -f2- | tr ',' '\n' | grep -v '^$'
}

mt_expected_names() { # configure.args kind(demuxer|muxer|encoder|protocol) -> sorted listed names, one per line
  local n
  for n in $(mt_configured_names "$1" "$2" enable); do mt_display_name "$2" "$n"; done | LC_ALL=C sort -u
}

# `-demuxers` / `-muxers`: the first name of each line after the ' ---' rule.
mt_listed_formats() { # file -> sorted names
  awk 'f && NF >= 2 { n = ($1 ~ /^[DEd.]+$/) ? $2 : $1; sub(/,.*/, "", n); print n } /^ *--+ *$/ {f=1}' "$1" | LC_ALL=C sort -u
}

# `-encoders`: ` V....D name  description` lines after the ` ------` rule.
mt_listed_encoders() { # file -> sorted names
  awk 'f && $1 ~ /^[VAS][A-Z.][A-Z.][A-Z.][A-Z.][A-Z.]$/ {print $2} /^ *------ *$/ {f=1}' "$1" | LC_ALL=C sort -u
}

# `-protocols`: the names under Input: and Output:.
mt_listed_protocols() { # file -> sorted names
  awk '/^Input:/ || /^Output:/ {f=1; next} f && NF {print $1}' "$1" | LC_ALL=C sort -u
}

mt_check_same_names() { # what expected-names actual-names
  if [ "$2" = "$3" ]; then return 0; fi
  echo "its $1 are not exactly configure.args's. Expected: $(printf '%s' "$2" | tr '\n' ' ') Listed: $(printf '%s' "$3" | tr '\n' ' ')" >&2
  return 1
}

# Right after configure, before the long compile: every component configure.args
# enables must be `#define CONFIG_<NAME>_<KIND> 1` in config_components.h, and
# every filter it disables must exist and be 0. A misspelt or renamed component
# enables (or disables) nothing, silently; this catches it.
# Apple features that would give the Mac a different decode path from Fly's.
# All must be 0 in config.h (the frameworks above stay link-only).
MT_APPLE_OFF="VIDEOTOOLBOX AUDIOTOOLBOX COREIMAGE AVFOUNDATION APPKIT METAL"

mt_check_config_components() { # config_components.h configure.args [config.h, default: beside config_components.h]
  local kind n up bad=0 line
  local config_h="${3:-$(dirname "$1")/config.h}"
  if [ ! -f "$config_h" ]; then echo "no config.h at $config_h" >&2; return 1; fi
  for n in $MT_APPLE_OFF; do
    line="$(grep -E "^#define CONFIG_${n} [01]\$" "$config_h" || true)"
    if [ -z "$line" ]; then echo "config.h has no CONFIG_${n}" >&2; bad=1
    elif [ "$line" != "#define CONFIG_${n} 0" ]; then echo "CONFIG_${n} is on: the Mac would decode differently from Fly" >&2; bad=1; fi
  done
  for kind in demuxer muxer encoder protocol; do
    for n in $(mt_configured_names "$2" "$kind" enable); do
      up="$(printf '%s_%s' "$n" "$kind" | tr 'a-z' 'A-Z')"
      line="$(grep -E "^#define CONFIG_${up} [01]\$" "$1" || true)"
      if [ -z "$line" ]; then echo "configure has no $kind called '$n' (no CONFIG_${up})" >&2; bad=1
      elif [ "$line" != "#define CONFIG_${up} 1" ]; then echo "the $kind '$n' was not enabled (CONFIG_${up} is 0)" >&2; bad=1; fi
    done
  done
  for n in $(mt_configured_names "$2" filter disable); do
    up="$(printf '%s_FILTER' "$n" | tr 'a-z' 'A-Z')"
    line="$(grep -E "^#define CONFIG_${up} [01]\$" "$1" || true)"
    if [ -z "$line" ]; then echo "configure has no filter called '$n' (no CONFIG_${up})" >&2; bad=1
    elif [ "$line" != "#define CONFIG_${up} 0" ]; then echo "the filter '$n' is still enabled" >&2; bad=1; fi
  done
  return $bad
}
