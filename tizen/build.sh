#!/bin/bash
# Build the Comic Reader Tizen .wgt: a launcher whose index.html redirects to the
# hosted reader. Runs from any cwd.
#
#   tizen/build.sh                              # unsigned build, proves the toolchain
#   CERT_PROFILE=<profile> tizen/build.sh       # signed .wgt, ready for install.sh
#
# See docs/tizen.md for the one-time setup and which profile to use.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$DIR/.build"
RESULT="$BUILD/.buildResult"

fail() { echo "error: $*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
# Fail on the missing prerequisite by name rather than midway through a build.
command -v tizen >/dev/null || fail "tizen CLI not found -- add ~/tizen-studio/tools/ide/bin to PATH (see docs/tizen.md)"
java -version >/dev/null 2>&1 || fail "no Java runtime -- the Tizen CLI needs JDK 17 on PATH (see docs/tizen.md)"

# --- stage -----------------------------------------------------------------
# Only the app files go in, so nothing else in tizen/ (scripts, old builds)
# ends up inside the package.
rm -rf "$BUILD"
mkdir -p "$BUILD"
cp "$DIR/config.xml" "$DIR/index.html" "$DIR/app.js" "$DIR/app.css" "$DIR/icon.png" "$BUILD/"
# The Smart Hub Preview service and its packaged cover (config.xml's <tizen:service>).
cp -R "$DIR/service" "$BUILD/service"

tizen build-web -- "$BUILD"
[ -d "$RESULT" ] || fail "tizen build-web produced no $RESULT"

# Signing needs a Samsung certificate profile from Tizen Studio's Certificate
# Manager; the distributor cert binds to the TV's device ID.
if [ -z "${CERT_PROFILE:-}" ]; then
  echo
  echo "built, unsigned; set CERT_PROFILE=<profile>"
  exit 0
fi

tizen package -t wgt -s "$CERT_PROFILE" -- "$RESULT"

PACKAGED="$(find "$RESULT" -name '*.wgt' | head -1)"
[ -n "$PACKAGED" ] || fail "packaging finished but produced no .wgt"

# tizen package names the file after <name>, "Comic Reader.wgt", and the TV's
# installer fails on the space with no log line. Ship it without one.
WGT="$RESULT/ComicReader.wgt"
mv "$PACKAGED" "$WGT"

echo
echo "built: $WGT"
echo "next:  tizen/install.sh <tv-ip>"
