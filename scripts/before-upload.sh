#!/bin/sh
# DevTools upload hook: refresh the development address, then refuse uploads
# that still contain lab subpackages (use `npm run release:stage` instead).
set -e
sh "$(dirname "$0")/sync-dev-backend.sh"
exec sh "$(dirname "$0")/node.sh" scripts/check-upload-package.cjs
