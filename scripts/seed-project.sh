#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker run --rm --network host -v "$PWD:/project" -w /project \
  node:22-alpine node scripts/seed-project.mjs
