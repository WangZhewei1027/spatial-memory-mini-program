#!/bin/sh
# Runs a Node.js script from DevTools hooks. DevTools launched from Finder does
# not inherit the terminal's PATH, so look in common install locations too.
# Usage: sh scripts/node.sh scripts/<name>.cjs
set -e
cd "$(dirname "$0")/.."

if command -v node >/dev/null 2>&1; then
  exec node "$@"
fi

for miniapp_node in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$miniapp_node" ]; then
    exec "$miniapp_node" "$@"
  fi
done

miniapp_nvm_dir="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$miniapp_nvm_dir/nvm.sh" ]; then
  . "$miniapp_nvm_dir/nvm.sh" --no-use
  nvm use --silent default >/dev/null
  exec node "$@"
fi

echo '[miniapp] 找不到 Node.js；请安装 Node.js 或将其加入开发者工具的 PATH。' >&2
exit 127
