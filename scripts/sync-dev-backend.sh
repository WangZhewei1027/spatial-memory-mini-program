#!/bin/sh
# DevTools compile/preview hook: refresh the generated development address.
exec sh "$(dirname "$0")/node.sh" scripts/sync-dev-backend.cjs
