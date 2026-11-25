#!/usr/bin/env bash
# Starts the Ringside keeper (SOL/USD from Pyth) and relayer against devnet, then runs the
# sponsored-order test. Logs go to Documents/ringside-logs on Windows.
set -euo pipefail
. "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd "$(dirname "$0")/.."
KEYFILE=${HELIUS_KEY_FILE:-/mnt/c/Users/glyde/Documents/helius-key.txt}
if [ -z "${RPC_URL:-}" ] && [ -f "$KEYFILE" ]; then
  KEY=$(python3 -c "import re,sys;t=open(sys.argv[1],encoding='utf-8-sig').read().strip();m=re.search(r'api-key=([A-Za-z0-9-]+)',t);print(m.group(1) if m else t)" "$KEYFILE")
  RPC_URL="https://devnet.helius-rpc.com/?api-key=$KEY"
  echo "▸ Using your Helius devnet RPC"
fi
RPC=${RPC_URL:-https://api.devnet.solana.com}
# Optional Pyth API key (Hermes needs one since Aug 2026); without it devnet uses the sponsored feed.
PYTH_KEY_FILE=${PYTH_KEY_FILE:-/mnt/c/Users/glyde/Documents/pyth-key.txt}
if [ -z "${PYTH_API_KEY:-}" ] && [ -f "$PYTH_KEY_FILE" ]; then
  export PYTH_API_KEY=$(python3 -c "import sys;print(open(sys.argv[1],encoding='utf-8-sig').read().strip())" "$PYTH_KEY_FILE")
  echo "▸ Using your Pyth API key"
fi
LOG=${LOG_DIR:-/mnt/c/Users/glyde/Documents/ringside-logs}
mkdir -p "$LOG"

PERPS=$(solana address -k target/deploy/ringside_perps-keypair.json)
USDC=$(node -p "require('./devnet-deployment.json').usdcMint")
WALLET="$HOME/.config/solana/id.json"
RELAYER_KP="$HOME/.config/solana/relayer.json"

[ -f "$RELAYER_KP" ] || solana-keygen new --no-bip39-passphrase --silent -o "$RELAYER_KP"
REL=$(solana address -k "$RELAYER_KP")
if [ "$(solana balance "$REL" --url "$RPC" --lamports | awk '{print $1}')" -lt 300000000 ]; then
  echo "▸ Funding the relayer with 0.5 SOL from your wallet"
  solana transfer --url "$RPC" --allow-unfunded-recipient "$REL" 0.5 >/dev/null
fi

cd client
npm install --silent
npm run build --silent

pkill -f "node dist/keeper.js" 2>/dev/null || true
pkill -f "node dist/relayer.js" 2>/dev/null || true
echo "▸ Starting keeper (logs: $LOG/keeper.log)"
PYTH_API_KEY=${PYTH_API_KEY:-} PERPS_PROGRAM_ID=$PERPS RPC_URL=$RPC KEEPER_KEYPAIR=$WALLET USDC_MINT=$USDC KEEPER_INTERVAL_MS=3000 \
  ALERT_WEBHOOK_URL=${ALERT_WEBHOOK_URL:-} KEEPER_HEALTH_PORT=8789 RELAYER_ADDRESS=$(solana-keygen pubkey "$RELAYER_KP" 2>/dev/null) \
  MONITOR_IGNORE_MARKETS=${MONITOR_IGNORE_MARKETS:-} \
  nohup node dist/keeper.js > "$LOG/keeper.log" 2>&1 &
echo "▸ Starting relayer on :8787 (logs: $LOG/relayer.log)"
PINATA_JWT=${PINATA_JWT:-} PUBLIC_URL=${PUBLIC_URL:-http://localhost:5173/relayer} METADATA_DIR=$HOME/ringside-metadata \
  PERPS_PROGRAM_ID=$PERPS RPC_URL=$RPC RELAYER_KEYPAIR=$RELAYER_KP PORT=8787 \
  nohup node dist/relayer.js > "$LOG/relayer.log" 2>&1 &
sleep 4
curl -sf localhost:8787/health >/dev/null && echo "  relayer is up" || { echo "relayer did not start:"; cat "$LOG/relayer.log"; exit 1; }

if [ "${SKIP_TEST:-0}" = 1 ]; then echo "  keeper and relayer running"; exit 0; fi
echo "▸ Running the sponsored-order test"
ANCHOR_PROVIDER_URL=$RPC ANCHOR_WALLET=$WALLET RELAYER_URL=http://localhost:8787 \
  npx tsx scripts/sponsored-order-devnet.ts 2>&1 | tee "$LOG/sponsored-test.log"
echo
echo "Keeper and relayer keep running in the background. Stop them with:"
echo "  pkill -f 'node dist/keeper.js'; pkill -f 'node dist/relayer.js'"
