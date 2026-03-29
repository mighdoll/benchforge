#!/bin/bash
# Assemble the hosted static viewer into dist/hosted/
# Requires: pnpm build:plots to have run first (produces dist/browser/)
set -euo pipefail

out=dist/hosted
rm -rf "$out"
mkdir -p "$out/speedscope"

# HTML — rewrite /viewer/ and /speedscope/ to relative paths
sed -e 's|/viewer/||g' -e 's|/speedscope/|speedscope/|g' \
  src/viewer/shell.html > "$out/index.html"

# CSS
cp src/viewer/shell.css "$out/"
cp src/viewer/report.css "$out/"

# JS bundles (shell, plots, shiki chunk files)
cp dist/browser/*.js "$out/"

# Speedscope
cp -r vendor/speedscope/* "$out/speedscope/"

size=$(du -sh "$out" | cut -f1)
echo "Hosted viewer built to $out/ ($size)"
