#!/usr/bin/env bash
# Builds self-contained Fusion comp scripts (one per command) from src/core.lua.
# Each output file works on its own: copy the NodeAlign folder into Scripts/Comp.
set -euo pipefail
cd "$(dirname "$0")"
out=NodeAlign
rm -rf "$out"; mkdir -p "$out"
while read -r name mode; do
  { cat src/core.lua; printf '\nNodeAlign.run("%s")\n' "$mode"; } > "$out/$name.lua"
done <<'LIST'
Align_Auto auto
Align_Horizontal horizontal
Align_Vertical vertical
Straighten_Row straighten_h
Straighten_Column straighten_v
Distribute_Horizontal distribute_h
Distribute_Vertical distribute_v
Spread spread
Tighten tighten
LIST
echo "built: $(ls "$out" | tr '\n' ' ')"
