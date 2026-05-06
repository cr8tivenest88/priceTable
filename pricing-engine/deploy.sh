#!/bin/bash
# Deploy: snapshot remote configs → ship code → npm install → restart with
# rotated logging → healthcheck. Aborts (and dumps the tail of the new
# server log) if the server isn't responding on :3000 within HEALTHCHECK_TIMEOUT
# seconds. Configs (config.json, config-largeformat.json) are NEVER shipped —
# the remote is the source of truth for prices. Use `npm run deploy:push-config`
# for the rare case of pushing a local config upstream.
set -e

REMOTE=gmtech
REMOTE_DIR=/home/gmtech/priceTable-1/pricing-engine
HEALTHCHECK_TIMEOUT=15
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> 1/4  Snapshotting remote configs..."
bash ./backup-remote.sh

echo
echo "==> 2/4  Shipping code to $REMOTE..."
scp -q server.js engine.js engine-largeformat.js package.json "$REMOTE:$REMOTE_DIR/"
scp -qr client "$REMOTE:$REMOTE_DIR/"

echo
echo "==> 3/4  Installing deps and restarting..."
# Heredoc: $REMOTE_DIR expands locally; \$ defers to the remote shell.
# nohup.out is rotated into logs/ so 'tail -f nohup.out' still works after
# each deploy (the moved file keeps its inode, so any in-flight tails on the
# OLD server continue uninterrupted; the new server gets a fresh nohup.out).
# < /dev/null on nohup closes stdin so the SSH session can exit cleanly.
ssh "$REMOTE" bash <<EOF
set -e
cd "$REMOTE_DIR"
npm install --production --silent
mkdir -p logs
[ -f nohup.out ] && mv nohup.out "logs/nohup-\$(date +%Y%m%d-%H%M%S).out"
if pid=\$(lsof -t -i:3000 2>/dev/null); then
  kill \$pid 2>/dev/null || true
  sleep 0.5
fi
nohup node server.js > nohup.out 2>&1 < /dev/null &
disown
EOF

echo
echo "==> 4/4  Health-checking $REMOTE:3000/api/health..."
deadline=$(( $(date +%s) + HEALTHCHECK_TIMEOUT ))
while true; do
  if ssh -o ConnectTimeout=3 "$REMOTE" "curl -fsS --max-time 2 http://localhost:3000/api/health >/dev/null"; then
    echo "OK — server responded."
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo
    echo "ERROR: server did not respond within ${HEALTHCHECK_TIMEOUT}s."
    echo "Last 40 lines of remote nohup.out:"
    echo "----"
    ssh "$REMOTE" "tail -n 40 $REMOTE_DIR/nohup.out" || true
    echo "----"
    exit 1
  fi
  sleep 1
done
