#!/bin/bash
# Saves remote configs to local backups/ WITHOUT modifying local files.
# Used as a pre-deploy safety net so we always have a fresh remote snapshot
# before restarting the server.
#
# Compare with pull-configs.sh, which OVERWRITES local with remote (sync-down).
set -e

REMOTE=gmtech
REMOTE_DIR=/home/gmtech/priceTable-1/pricing-engine
FILES=(config.json config-largeformat.json)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TS=$(date +%Y%m%d-%H%M%S)

cd "$SCRIPT_DIR"
mkdir -p backups

for f in "${FILES[@]}"; do
  scp -q "$REMOTE:$REMOTE_DIR/$f" "backups/${f}.remote.${TS}.bak"
  printf "%-30s %s\n" "backups/${f}.remote.${TS}.bak" "$(wc -c <"backups/${f}.remote.${TS}.bak") bytes"
done

echo
echo "Remote configs snapshotted to backups/*.remote.${TS}.bak"
