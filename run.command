#!/bin/bash
# 執譜機 - start the app (double-click in Finder)
cd "$(dirname "$0")" || exit 1
if [ ! -x ".venv/bin/python" ]; then
  echo "Please run install.command first."
  read -r -p "Press Enter to close..."
  exit 1
fi
source .venv/bin/activate
# python.org Python on macOS has no root certificates: use certifi's (model downloads need it)
CA="$(python -c 'import certifi; print(certifi.where())' 2>/dev/null)"
[ -n "$CA" ] && export SSL_CERT_FILE="$CA" REQUESTS_CA_BUNDLE="$CA"
export PATH="$HOME/.deno/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "Starting... the app opens at http://localhost:8765"
echo "Keep this window open while you use the app. Close it to stop."
python backend/app.py
read -r -p "Press Enter to close..."
