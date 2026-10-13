#!/bin/bash
# dsh-code-studio build: compile host (esm) + client (cjs) via tsdown.
# Self-contained: local devDependencies only, no DSH source checkout needed.
# (dsv-super-injector dev_build_plugin invokes this script.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -d node_modules ] || [ ! -x node_modules/.bin/tsdown ]; then
  echo "build: node_modules missing — run 'pnpm install' (or 'npm install') first" >&2
  exit 1
fi

echo "=== dsh-code-studio: clean lib ==="
npm run --silent prebuild

echo "=== dsh-code-studio: tsdown (host + client) ==="
npm run --silent build

echo "=== build complete (lib/index.js + lib/client.js) ==="
