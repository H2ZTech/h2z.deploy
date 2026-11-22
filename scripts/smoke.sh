#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Use host networking only for this one-shot HTTP verifier, not the resident services.
docker run --rm --network host -v "$PWD:/project" -w /project \
  -v /var/run/docker.sock:/var/run/docker.sock docker:28-cli sh -c \
  'apk add --no-cache nodejs >/dev/null && node scripts/smoke.mjs "$@"' verifier "$@"
