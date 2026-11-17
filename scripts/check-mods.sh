#!/bin/sh
# `npm run check:mods`: every bdc Herdr mod must load (spec §12.5). It assembles the mods from
# this checkout into a throwaway Herdr home and runs `herdr-app check` on each, so neither the
# person's Herdr home nor their window is touched.
set -e
cd "$(dirname "$0")/.."
if [ ! -f dist/cli/bin.js ]; then
  npm run build
fi
exec node dist/cli/bin.js herdr check
