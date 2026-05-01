#!/bin/bash
set -e

REMOTE=gmtech
REMOTE_DIR=/home/gmtech/priceTable-1/pricing-engine
FILES=(config.json config-largeformat.json)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TS=$(date +%Y%m%d-%H%M%S)

cd "$SCRIPT_DIR"
mkdir -p backups

for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    cp "$f" "backups/${f}.${TS}.bak"
  fi
  scp -q "$REMOTE:$REMOTE_DIR/$f" "$f"
  printf "%-30s %s\n" "$f" "$(wc -c <"$f") bytes"
done

echo
echo "Backed up previous to backups/*.${TS}.bak"
echo "Run: git diff ${FILES[*]}"
