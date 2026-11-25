#!/usr/bin/env bash
# Ringside: build, deploy to Solana devnet and run the smoke test.
# Run from the repo root in Linux, macOS or WSL (Ubuntu) on Windows:
#   bash scripts/devnet.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ANCHOR_VERSION=0.31.1
NEED_SOL=7   # two program deploys (~3 SOL each) plus test transactions
RPC=${RPC_URL:-https://api.devnet.solana.com}

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- Toolchain ---------------------------------------------------------------
if [ "$(uname -s)" = Linux ] && have apt-get && ! dpkg -s libudev-dev >/dev/null 2>&1; then
  say "Installing build packages (needs sudo)"
  sudo apt-get update -y && sudo apt-get install -y build-essential pkg-config libudev-dev libssl-dev curl git
fi
if ! have cargo; then
  say "Installing Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
# shellcheck disable=SC1091
. "$HOME/.cargo/env"
if ! have solana; then
  say "Installing the Solana CLI (Agave stable)"
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
if ! have anchor || ! anchor --version | grep -q "$ANCHOR_VERSION"; then
  say "Installing Anchor $ANCHOR_VERSION (compiles once, takes a few minutes)"
  have avm || cargo install --git https://github.com/solana-foundation/anchor avm --force
  avm install "$ANCHOR_VERSION" && avm use "$ANCHOR_VERSION"
fi
if ! have node || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "Installing Node.js 22 (needs sudo)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
solana --version; anchor --version

# --- Wallet and SOL ------------------------------------------------------------
solana config set --url "$RPC" >/dev/null
WALLET="$HOME/.config/solana/id.json"
if [ ! -f "$WALLET" ]; then
  say "Creating a devnet wallet at $WALLET"
  solana-keygen new --no-bip39-passphrase -o "$WALLET"
fi
ADDR=$(solana address)
balance() { solana balance --lamports | awk '{print int($1/1000000000)}'; }
say "Wallet $ADDR has $(balance) SOL on devnet"
tries=0
while [ "$(balance)" -lt "$NEED_SOL" ] && [ $tries -lt 5 ]; do
  solana airdrop 2 >/dev/null 2>&1 && echo "  airdropped 2 SOL" || { echo "  airdrop refused (rate limit)"; sleep 8; }
  tries=$((tries + 1))
done
if [ "$(balance)" -lt "$NEED_SOL" ]; then
  echo
  echo "Need about $NEED_SOL devnet SOL and have $(balance)."
  echo "Get more at https://faucet.solana.com for address: $ADDR"
  echo "Then run this script again; it picks up where it left off."
  exit 1
fi

# --- Build and deploy ------------------------------------------------------------
say "Generating program keys (first run) and syncing program IDs"
anchor keys sync
say "Building (SBF)"
anchor build
say "Running unit and integration tests"
cargo test --quiet
say "Deploying to devnet"
anchor deploy --provider.cluster devnet

LAUNCH_ID=$(solana address -k target/deploy/ringside_launch-keypair.json)
PERPS_ID=$(solana address -k target/deploy/ringside_perps-keypair.json)
echo "  ringside_launch  $LAUNCH_ID"
echo "  ringside_perps   $PERPS_ID"

# --- Smoke test on devnet ------------------------------------------------------------
say "Bootstrapping and running the devnet smoke test"
cd client
npm install --silent
ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" npx tsx scripts/bootstrap-devnet.ts

cat <<MSG

Deployed. To run the services against devnet:
  cd client
  PERPS_PROGRAM_ID=$PERPS_ID RPC_URL=$RPC KEEPER_KEY=<base58 secret> USDC_MINT=<from devnet-deployment.json> npm run keeper
  PERPS_PROGRAM_ID=$PERPS_ID RPC_URL=$RPC RELAYER_KEY=<base58 secret> npm run relayer
MSG
