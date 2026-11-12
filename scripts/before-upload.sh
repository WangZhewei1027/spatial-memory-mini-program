#!/bin/sh
# DevTools upload hook: refresh the development address, then refuse uploads
# with missing production resources or references to archived experiments.
set -e
sh "$(dirname "$0")/sync-dev-backend.sh"
exec sh "$(dirname "$0")/node.sh" scripts/check-upload-package.cjs
