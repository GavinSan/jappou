#!/bin/bash
# YouTube changes often - if downloads start failing, run this to update yt-dlp.
cd "$(dirname "$0")" || exit 1
source .venv/bin/activate
pip install -U "yt-dlp[default]"
echo
echo "yt-dlp updated."
read -r -p "Press Enter to close..."
