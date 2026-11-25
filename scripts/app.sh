#!/usr/bin/env bash
# Starts everything for the Ringside devnet web app: keeper, relayer, faucet and the app itself.
# Keep this window open while you use the app.
set -euo pipefail
. "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."
RPC=${RPC_URL:-https://api.devnet.solana.com}
LOG=${LOG_DIR:-/mnt/c/Users/glyde/Documents/ringside-logs}
mkdir -p "$LOG"

SKIP_TEST=1 bash scripts/services.sh

cd client
pkill -f "scripts/devnet-faucet.ts" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
echo "▸ Starting the devnet faucet on :8788 (logs: $LOG/faucet.log)"
FAUCET_KEYPAIR="$HOME/.config/solana/id.json" RPC_URL=$RPC nohup npx tsx scripts/devnet-faucet.ts > "$LOG/faucet.log" 2>&1 &
sleep 3
echo
echo "▸ Ringside is running at  http://localhost:5173"
echo "  Keep this window open while you use it. Close it to stop the app."
echo
npx vite --host --clearScreen false
