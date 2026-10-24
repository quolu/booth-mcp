#!/bin/sh
# Register the Chrome native host for the current macOS user.
set -eu
sync_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js 18 or later is required. Install Node, then run this script again.' >&2
  exit 1
fi
exec node "$sync_dir/install-macos.mjs" "$@"
