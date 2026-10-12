#!/bin/sh
# Builds the Chrome Web Store upload, redline-<version>.zip in the repo root,
# with only the files the extension loads.
set -e
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="redline-$version.zip"
rm -f "$out"
zip -qrX "$out" manifest.json LICENSE welcome.html welcome.js src icons -x '*.DS_Store'
echo "$out"
