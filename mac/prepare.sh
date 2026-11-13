#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf mac/app
mkdir -p mac/app
cp server.mjs mac/app/server.mjs
cp -R web mac/app/web
cp -R tools mac/app/tools
cat > mac/app/package.json <<'EOF'
{
  "name": "nalo-code-runtime",
  "private": true,
  "type": "module"
}
EOF
rm -rf mac/app/web/download mac/app/tools/__pycache__ 2>/dev/null || true
echo "prepared mac/app"
