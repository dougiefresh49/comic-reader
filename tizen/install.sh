#!/bin/bash
# Push the signed .wgt to the TV over the network: sdb connects to the TV's IP on
# port 26101, so a reinstall needs no thumb drive. Runs from any cwd.
#
#   tizen/install.sh <tv-ip>
#
# The TV must be in Developer Mode with this Mac's IP set as the host, and on
# the same network. See docs/tizen.md.
set -euo pipefail

TV_IP="${1:-}"
[ -n "$TV_IP" ] || { echo "usage: $0 <tv-ip>" >&2; exit 1; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WGT="$(find "$DIR/.build/.buildResult" -name '*.wgt' 2>/dev/null | head -1)"
[ -n "$WGT" ] && [ -f "$WGT" ] || { echo "error: no .wgt found -- run CERT_PROFILE=<profile> tizen/build.sh first" >&2; exit 1; }

command -v sdb >/dev/null || { echo "error: sdb not found -- add ~/tizen-studio/tools to PATH (see docs/tizen.md)" >&2; exit 1; }
command -v tizen >/dev/null || { echo "error: tizen CLI not found -- add ~/tizen-studio/tools/ide/bin to PATH (see docs/tizen.md)" >&2; exit 1; }

# One attempt. If it fails, the usual cause is the host-IP trap in docs/tizen.md,
# which retrying does not fix.
echo "connecting to $TV_IP"
sdb connect "$TV_IP:26101"

# Name the target explicitly: sdb happily lists a stale device and installs nowhere.
TARGET="$(sdb devices | awk -v ip="$TV_IP" '$0 ~ ip { print $NF; exit }')"
[ -n "$TARGET" ] || { echo "error: TV did not appear in 'sdb devices' -- is Developer Mode on, with this Mac's IP as host?" >&2; exit 1; }

# tizen install, never sdb install: the latter pushes the file, reports success,
# and installs nothing.
echo "installing $(basename "$WGT") to $TARGET"
tizen install -n "$WGT" -t "$TARGET"

echo
echo "installed. Launch Comic Reader on the TV."
